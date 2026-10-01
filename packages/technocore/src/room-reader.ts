/**
 * The shared room reader: six rooms, one reader, a bounded number of sockets.
 *
 * "Do not create an unbounded long-poll connection per room" is a hard
 * requirement. This reads every room with `READ_CONCURRENCY` slots and a hard cap
 * on requests in flight.
 *
 * Two ways to drive it:
 *
 *   - `tick()` — one pass, caller-driven. Tests use it, and the scheduler uses it
 *     for the *dynamic* owner rooms, whose read is bounded and off the critical
 *     path.
 *   - `startContinuous()` — the fixed rooms get their own long-lived loop, one
 *     per room, each re-reading the moment its previous read returns. This is
 *     what production runs: a room that grows faster than one `limit`-sized page
 *     per scheduler tick would otherwise be read with a permanent gap between
 *     pages, and every gap is a real, recorded loss. The orchestrator supplies
 *     `onRead` so the durable evidence a read produces is written the moment it
 *     happens rather than on the next tick.
 *
 * A room's loop never has more than one request in flight, the whole reader never
 * exceeds `READ_CONCURRENCY`, and the client's `MAX_INFLIGHT` caps the process.
 *
 * Per room it keeps cursor, generation, first_seq, last_seq, gap and room_reset.
 * A gap or a reset is recorded and puts the process into conservative mode; the
 * reader itself never stops, because reading is how the problem is discovered to
 * be over.
 *
 * Every message is classified and — for anything signed — signature-checked
 * before it is stored. Unsigned chatter is stored as `chatter` and is never
 * acted on. Nothing in a message is treated as an instruction.
 */
import type { Repositories, SqliteDatabase } from '@flop/storage';
import { classifyMessage } from '@flop/close-call';
import { verifyRoomSignatureForRoom } from '@flop/identity';
import { TechnocoreClient } from './client.js';
import { cursorHealth, SqliteCursorStore, type CursorHealth, type CursorRecord, type CursorStore } from './cursor-store.js';
import { advanceCursor } from './protocol.js';
import type { RoomMessage, TechnocoreLogger } from './protocol.js';
import type { RefereeObservation } from './referee-verifier.js';
import { RefereeVerifier } from './referee-verifier.js';
import { Semaphore, sleep } from './retry.js';

export interface RoomReaderOptions {
  client: TechnocoreClient;
  db: SqliteDatabase;
  repositories: Repositories;
  verifier: RefereeVerifier;
  logger: TechnocoreLogger;
  /** Rooms to read: the five referee rooms and the trading room. */
  rooms: string[];
  /**
   * A dynamic room list, re-read on every pass.
   *
   * The fixed reader keeps `rooms`; the bounded dynamic reader supplies this so
   * a discovered owner room can join and leave the set without rebuilding the
   * reader. It is always evaluated inside the same concurrency cap, so a room
   * appearing mid-pass can never spawn an extra socket.
   */
  roomsProvider?: () => string[];
  /** Max concurrent room reads. Below the fixed-room count it is raised: see the header. */
  readConcurrency?: number;
  /** Long-poll hold, seconds. Clamped to 0..10 by the service. */
  waitSeconds?: number;
  /** Messages per read, clamped to the server's own limit (200 unless discovered otherwise). */
  limit?: number;
  /**
   * The largest `limit` the service will accept, as discovered or assumed.
   *
   * 200 is the documented assumption; `TechnocoreClient.serviceConfig()` can raise
   * it when the service publishes a bigger number. It is never exceeded, because a
   * `limit` the service refuses would turn every read into a 400.
   */
  serverLimit?: number;
  /**
   * The page size to use while a room is behind, when the server allows more than
   * the normal limit. Falls back to `limit`.
   */
  catchingUpLimit?: number;
  /** Ceiling on a single room's read rate while it is catching up, per second. */
  catchingUpMaxRequestsPerSecond?: number;
  /** How long a room may go unread before a fairness warning is recorded. */
  fairnessMaxSilenceMs?: number;
  /**
   * How long a room may stay in `catching_up` before the reader stops calling it
   * a temporary state. 0 disables the bound (the two-window rule still applies).
   */
  catchingUpMaxSeconds?: number;
  /**
   * Per-room page sizes, for a room that needs a different page from the rest.
   *
   * The trading room is the reason this exists: it is the one room that grows
   * faster than a scheduler tick, so it gets its own read and catch-up limits.
   * Every value is still clamped to `serverLimit`.
   */
  limitsByRoom?: Record<string, { limit?: number; catchingUpLimit?: number }>;
  /**
   * How long a continuous room loop waits after a failed read before trying
   * again. A successful read does not wait at all: the long poll is the pacing.
   */
  retryDelayMs?: number;
  /** Local DIDs, so the reader can flag messages that are ours. */
  localDids?: () => Set<string>;
  /**
   * Called with the outcome of every read a *continuous* room loop completes.
   *
   * The orchestrator uses it to persist what a read produced the moment it
   * happened: referee snapshots, flow/price anomalies and the local-message
   * ledger. Without it a gap-free continuous reader would advance cursors while
   * never writing the durable evidence, which is precisely the reader-owned work
   * that must not wait for the scheduler's cadence.
   *
   * It is deliberately not called from `tick()`: the caller-driver already owns
   * the summary `tick()` returns, and firing it twice would double-persist.
   */
  onRead?: (outcome: RoomReadOutcome) => void;
  now?: () => Date;
}

/** What one room read produced, before the caller decides what to do with it. */
export interface RoomReadOutcome {
  tick: RoomTick;
  inserted: number;
  observations: RefereeObservation[];
  localMessages: Array<{ room: string; message: RoomMessage }>;
  error?: string;
}

export interface RoomTick {
  room: string;
  readCount: number;
  inserted: number;
  cursor: CursorRecord;
  advanceReason: string;
  degraded: boolean;
  error?: string;
}

export interface TickSummary {
  at: string;
  rooms: RoomTick[];
  inserted: number;
  observations: RefereeObservation[];
  /** Messages from local DIDs, keyed by room, for the trade ledger. */
  localMessages: Array<{ room: string; message: RoomMessage }>;
  health: CursorHealth;
  errors: number;
}

/**
 * What one room is doing, as the status report and the readiness gate see it.
 *
 * Every rate is measured over a sealed 60-second window from the room's own
 * reads, never inferred from a request count:
 *
 *   - `producerRate` is the room's own growth, taken from the *retained ring's*
 *     `last_seq` (which advances with the room, independently of what we read);
 *   - `consumerRate` is what we actually persisted and advanced the cursor over;
 *   - `netBacklogRate` is the difference. A positive value over two consecutive
 *     windows is the only honest statement of "we are falling behind".
 */
export type RoomMode =
  | 'stopped'
  | 'normal_long_poll'
  | 'catching_up'
  | 'upstream_gap'
  | 'fully_caught_up';

export interface RoomThroughput {
  room: string;
  mode: RoomMode;
  /** The room's own growth, messages/minute, from the ring's `last_seq`. */
  producerRate: number;
  /** Messages persisted and cursor-advanced per minute. */
  consumerRate: number;
  /** `producerRate - consumerRate`. Positive means the gap is widening. */
  netBacklogRate: number;
  readsPerMinute: number;
  messagesPerMinute: number;
  requestsPerMinute: number;
  saturatedPagesPerMinute: number;
  cursorDeltaPerMinute: number;
  gapDeltaPerMinute: number;
  firstSeqDeltaPerMinute: number;
  lastSeqDeltaPerMinute: number;
  avgRequestDurationMs: number;
  p95RequestDurationMs: number;
  /** The last read came back with exactly `limit` messages, so there was more. */
  pageSaturated: boolean;
  /** The ring's newest seq minus our cursor, from the last read. */
  cursorLag: number | null;
  /** Consecutive completed windows with `netBacklogRate > 0`. */
  positiveBacklogWindows: number;
  /** How long since this room last completed a successful read. */
  silenceMs: number;
  /** How long this room has been in `catching_up` without a break. */
  catchingUpForMs: number;
}

/** The reader-wide view: the per-room figures plus what they add up to. */
export interface ReaderThroughputStats {
  continuousMode: boolean;
  running: boolean;
  fixedRoomCount: number;
  activeRequests: number;
  completedReads: number;
  failedReads: number;
  messagesRead: number;
  lastSuccessAt: string | null;
  lastSuccessByRoom: Record<string, string>;
  maxReadDurationMs: number;
  lastError: string | null;
  lastErrorAt: string | null;
  /**
   * Whether the *most recent* page was saturated.
   *
   * Kept for compatibility, and deliberately narrow: it is a statement about one
   * page, never about health. A room with an unresolved gap and a short page is
   * `pageSaturated: false` and still unhealthy — do not read this as "caught up".
   */
  backlogObserved: boolean;
  /** Alias of `backlogObserved` under its unambiguous name. */
  pageSaturated: boolean;
  /**
   * True while any fixed room carries a gap that is not operationally closed.
   *
   * Deliberately stronger than the durable `gap_resolved_at` flag. That flag is
   * set by the first contiguous read, which proves the *cursor* is contiguous
   * again — it says nothing about whether the room is level. A room that resumed
   * reading while still hundreds of messages behind is not resolved in any sense
   * an operator cares about, so this field requires the full caught-up test.
   */
  unresolvedGap: boolean;
  /** The rooms behind `unresolvedGap`. */
  unresolvedGapRooms: string[];
  /**
   * True only when every fixed room satisfies the full caught-up test: no
   * unresolved gap, a contiguous last read, a short page, no widening backlog,
   * the cursor at the retained head, and two clean read cycles behind it.
   */
  fullyCaughtUp: boolean;
  /** Two consecutive 60-second windows with a positive net backlog rate. */
  netBacklogIncreasing: boolean;
  /** `normal` | `catching_up` | `unattainable` | `fully_caught_up`. */
  catchupState: 'normal' | 'catching_up' | 'unattainable' | 'fully_caught_up';
  /** Times a room resumed contiguous reading after a recorded gap. */
  contiguousResumeCount: number;
  /** Times a room passed the full caught-up test after a recorded gap. */
  gapRecoveryCount: number;
  lastGapRecoveredAt: string | null;
  /** Summed over the fixed rooms, messages/minute. */
  estimatedProducerRate: number;
  estimatedConsumerRate: number;
  estimatedBacklogRate: number;
  /** Reads that moved a cursor forward, i.e. that actually made progress. */
  cursorAdvances: number;
  readsPerMinute: number;
  messagesPerMinute: number;
  cursorAdvancesPerMinute: number;
  /** The page size we send, and the largest the service is believed to accept. */
  limit: number;
  serverLimit: number;
  /** The reader's own read concurrency, and the per-process request cap. */
  concurrency: number;
  /** Fixed rooms that have gone longer than the fairness bound without a read. */
  silentRooms: string[];
  lastReturnedCountByRoom: Record<string, number>;
  lastReturnedFirstSeqByRoom: Record<string, number | null>;
  lastReturnedLastSeqByRoom: Record<string, number | null>;
  lastCursorByRoom: Record<string, number>;
  lastGapFromByRoom: Record<string, number | null>;
  lastGapToByRoom: Record<string, number | null>;
  modeByRoom: Record<string, RoomMode>;
  rooms: RoomThroughput[];
}

/** One second of read activity, for the rolling per-minute rates. */
interface RateBucket {
  reads: number;
  messages: number;
  advances: number;
}

/**
 * One room's accounting: the window being accumulated, the last sealed window,
 * and the bookkeeping the room's mode is derived from.
 *
 * The rates are only ever taken from a *sealed* window, never extrapolated from
 * a partial one. A window that has just opened reports the previous window's
 * figures until it has enough elapsed time to mean something, which is what
 * keeps a burst of reads from being read as a permanent rate.
 */
interface RoomStats {
  room: string;
  mode: RoomMode;
  // ---- the window being accumulated right now ----
  windowStartedAtMs: number;
  windowReads: number;
  windowMessages: number;
  windowSaturated: number;
  /** Request durations in this window, for the average and the p95. */
  windowDurations: number[];
  /** The retained ring's `last_seq` when this window opened. */
  windowLastSeqStart: number | null;
  windowFirstSeqStart: number | null;
  windowCursorStart: number | null;
  windowGapStart: number | null;
  // ---- what the last sealed window produced ----
  producerRate: number;
  consumerRate: number;
  netBacklogRate: number;
  readsPerMinute: number;
  messagesPerMinute: number;
  requestsPerMinute: number;
  saturatedPagesPerMinute: number;
  cursorDeltaPerMinute: number;
  gapDeltaPerMinute: number;
  firstSeqDeltaPerMinute: number;
  lastSeqDeltaPerMinute: number;
  avgRequestDurationMs: number;
  p95RequestDurationMs: number;
  /** Consecutive sealed windows whose `netBacklogRate` was positive. */
  positiveBacklogWindows: number;
  // ---- the most recent read ----
  lastReturnedCount: number;
  lastReturnedFirstSeq: number | null;
  lastReturnedLastSeq: number | null;
  lastCursor: number;
  lastCursorGap: number;
  lastGapFrom: number | null;
  lastGapTo: number | null;
  /** The ring's newest seq as of the last read; the producer's position. */
  lastRingLastSeq: number | null;
  lastRingFirstSeq: number | null;
  /** The page size the last read asked for. */
  lastLimitUsed: number;
  lastReadAtMs: number | null;
  lastRequestStartedAtMs: number;
  pageSaturated: boolean;
  cursorLag: number | null;
  /** Consecutive contiguous reads that came back short of the page size. */
  consecutiveShortPages: number;
  /** A contiguous read has resumed since this room's latest recorded gap. */
  contiguousResumeEmitted: boolean;
  /** The latest gap has already been reported as fully recovered. */
  fullyRecoveredEmitted: boolean;
  /** The fairness warning for the current silence has already been logged. */
  fairnessWarned: boolean;
  /** When this room entered `catching_up`; null while it is not behind. */
  catchingUpSinceMs: number | null;
}

const RATE_WINDOW_SECONDS = 60;
const RATE_WINDOW_MS = RATE_WINDOW_SECONDS * 1_000;
/** How often the continuous loop recomputes cursor health, in milliseconds. */
const HEALTH_INTERVAL_MS = 1_000;
/** How many completed windows in a row must show a widening backlog. */
const UNATTAINABLE_WINDOWS = 2;
/** A room this far behind the retained head is catching up, in messages. */
const CATCHING_UP_LAG_FACTOR = 2;
/**
 * Clean, short, contiguous reads in a row before a gap counts as fully closed.
 *
 * One read is not enough: it is the read that *closed* the gap, and the page
 * behind it is the proof that the room is genuinely at rest rather than simply
 * between two bursts.
 */
const RECOVERY_CLEAN_READS = 2;

/** Two decimal places: these are rates read by a human, not an accounting ledger. */
function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

/** The nearest-rank percentile; 0 for an empty sample rather than NaN. */
function percentile(values: number[], fraction: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(fraction * sorted.length) - 1));
  return sorted[index] ?? 0;
}

export class RoomReader {
  private readonly client: TechnocoreClient;
  private readonly cursorStore: CursorStore;
  private readonly verifier: RefereeVerifier;
  private readonly logger: TechnocoreLogger;
  private readonly repositories: Repositories;
  private readonly rooms: string[];
  private readonly roomsProvider: (() => string[]) | null;
  private readonly waitSeconds: number;
  private readonly limit: number;
  private readonly serverLimit: number;
  private readonly catchingUpLimit: number;
  private readonly catchingUpMaxRequestsPerSecond: number;
  private readonly fairnessMaxSilenceMs: number;
  private readonly catchingUpMaxSeconds: number;
  private readonly limitsByRoom: Map<string, { limit: number; catchingUpLimit: number }>;
  private readonly retryDelayMs: number;
  private readonly semaphore: Semaphore;
  private readonly localDids: () => Set<string>;
  private readonly onRead: ((outcome: RoomReadOutcome) => void) | null;
  private readonly now: () => Date;
  private stopped = false;
  private lastSummary: TickSummary | null = null;
  private ticks = 0;
  private lastHealth: CursorHealth = cursorHealth([]);

  // ---- continuous mode ----------------------------------------------------
  private continuous = false;
  private abort: AbortController | null = null;
  /** Resolves when every room loop has exited. Null while stopped. */
  private stopping: Promise<void> | null = null;
  private lastHealthCheckMs = 0;
  /** When the continuous loops were started; 0 while they are not running. */
  private continuousStartedAtMs = 0;
  private readonly throughput = {
    activeRequests: 0,
    completedReads: 0,
    failedReads: 0,
    messagesRead: 0,
    maxReadDurationMs: 0,
    lastSuccessAt: null as string | null,
    lastError: null as string | null,
    lastErrorAt: null as string | null,
    pageSaturated: false,
    cursorAdvances: 0,
    contiguousResumeCount: 0,
    gapRecoveryCount: 0,
    lastGapRecoveredAt: null as string | null,
  };
  private readonly lastSuccessByRoom = new Map<string, string>();
  private readonly rateBuckets = new Map<number, RateBucket>();
  /**
   * Per-room accounting: the sealed windows that `producerRate`/`consumerRate`
   * come from, the current mode, and the bookkeeping the mode is derived from.
   */
  private readonly roomStats = new Map<string, RoomStats>();

  constructor(options: RoomReaderOptions) {
    this.client = options.client;
    this.repositories = options.repositories;
    this.verifier = options.verifier;
    this.logger = options.logger;
    this.rooms = [...options.rooms];
    this.roomsProvider = options.roomsProvider ?? null;
    this.waitSeconds = Math.min(10, Math.max(0, options.waitSeconds ?? 10));
    this.serverLimit = Math.max(1, options.serverLimit ?? 200);
    this.limit = Math.max(1, Math.min(this.serverLimit, options.limit ?? 50));
    this.catchingUpLimit = Math.max(this.limit, Math.min(this.serverLimit, options.catchingUpLimit ?? this.limit));
    this.limitsByRoom = new Map(
      Object.entries(options.limitsByRoom ?? {}).map(([room, limits]) => {
        const limit = Math.max(1, Math.min(this.serverLimit, limits.limit ?? this.limit));
        return [
          room,
          {
            limit,
            catchingUpLimit: Math.max(limit, Math.min(this.serverLimit, limits.catchingUpLimit ?? limit)),
          },
        ];
      }),
    );
    this.catchingUpMaxRequestsPerSecond = Math.max(0, options.catchingUpMaxRequestsPerSecond ?? 0);
    this.fairnessMaxSilenceMs = Math.max(0, options.fairnessMaxSilenceMs ?? 120_000);
    this.catchingUpMaxSeconds = Math.max(0, options.catchingUpMaxSeconds ?? 0);
    this.retryDelayMs = Math.max(0, options.retryDelayMs ?? 2_000);
    // The pool is exactly what was asked for; it is not silently widened. The
    // production default is one slot per fixed room (see `READ_CONCURRENCY`),
    // which is what keeps a busy room from queueing behind the five long-polling
    // referee rooms. A pool smaller than the room count is a real starvation
    // risk, so `checkFairness()` watches for it rather than the constructor
    // quietly overriding the operator. `MAX_INFLIGHT` on the client is still the
    // hard cap on real requests.
    this.semaphore = new Semaphore(Math.max(1, options.readConcurrency ?? 2));
    this.localDids = options.localDids ?? (() => new Set<string>());
    this.onRead = options.onRead ?? null;
    this.now = options.now ?? (() => new Date());
    this.cursorStore = new SqliteCursorStore({
      db: options.db,
      repositories: options.repositories,
      mapMessage: (room, message) => this.classify(room, message),
    });
  }

  /** The classifier the cursor store uses: kind plus signature verdict. */
  private classify(
    room: string,
    message: RoomMessage,
  ): { senderDid: string | null; nonce: string | null; sig: string | null; kind: string; signatureValid: boolean | null } {
    const kind = classifyMessage(message.text);
    const senderDid = message.from ?? null;
    const nonce = message.nonce === undefined ? null : String(message.nonce);
    const sig = message.sig ?? null;
    // No sig means the record predates the signing lane: "not re-verifiable",
    // never "invalid". We store it and decline to trust it.
    const signatureValid =
      sig !== null && senderDid !== null ? verifyRoomSignatureForRoom(senderDid, nonce ?? '', message.text, sig, room) : null;
    return { senderDid, nonce, sig, kind, signatureValid };
  }

  get summary(): TickSummary | null {
    return this.lastSummary;
  }

  get tickCount(): number {
    return this.ticks;
  }

  /** The most recent cursor-health verdict, from whichever loop computed it. */
  health(): CursorHealth {
    return this.lastHealth;
  }

  get continuousMode(): boolean {
    return this.continuous;
  }

  get concurrency(): number {
    return this.semaphore.limit;
  }

  async start(): Promise<void> {
    this.stopped = false;
  }

  async stop(): Promise<void> {
    this.stopped = true;
    await this.stopContinuous();
  }

  // -------------------------------------------------------------------------
  // continuous mode
  // -------------------------------------------------------------------------

  /**
   * Start one long-lived loop per fixed room.
   *
   * Idempotent: a second call while running is a no-op. The loops share the
   * reader's semaphore, so the per-room loops can never exceed `READ_CONCURRENCY`
   * requests in flight, and the client's own cap bounds the whole process.
   */
  startContinuous(): void {
    if (this.continuous || this.rooms.length === 0) return;
    this.stopped = false;
    this.continuous = true;
    this.continuousStartedAtMs = this.now().getTime();
    this.abort = new AbortController();
    const signal = this.abort.signal;
    const loops = this.rooms.map((room) => this.roomLoop(room, signal));
    // `allSettled`, so one room's unexpected throw can never reject the stop path
    // and leave the process unable to shut down.
    this.stopping = Promise.allSettled(loops).then(() => {
      this.stopping = null;
    });
    this.logger.event({
      level: 'info',
      source: 'room-reader',
      code: 'reader_continuous_started',
      message:
        `continuous reader started: ${this.rooms.length} fixed rooms, ` +
        `read concurrency ${this.concurrency}, long poll ${this.waitSeconds}s, ` +
        `retry delay ${this.retryDelayMs}ms`,
      data: {
        rooms: [...this.rooms],
        readConcurrency: this.concurrency,
        waitSeconds: this.waitSeconds,
        limit: this.limit,
        retryDelayMs: this.retryDelayMs,
      },
    });
  }

  /**
   * Abort every in-flight long poll and wait for the loops to exit.
   *
   * The abort is what makes this fast: without it a shutdown would wait out the
   * full `wait` hold on every room, which is exactly the shutdown-timeout hazard
   * a systemd `TimeoutStopSec` is there to punish.
   */
  async stopContinuous(): Promise<void> {
    if (this.continuous) {
      this.continuous = false;
      this.continuousStartedAtMs = 0;
      this.abort?.abort();
      for (const stats of this.roomStats.values()) stats.mode = 'stopped';
      this.logger.event({
        level: 'info',
        source: 'room-reader',
        code: 'reader_continuous_stopped',
        message: 'continuous reader stopping: aborting in-flight reads',
        data: { activeRequests: this.throughput.activeRequests },
      });
    }
    await this.waitForStopped();
  }

  /** Resolves once every room loop has exited. Safe to call when stopped. */
  async waitForStopped(): Promise<void> {
    const stopping = this.stopping;
    if (stopping) await stopping;
  }

  /**
   * One room's continuous loop.
   *
   * A successful read is followed immediately by the next one — the long poll is
   * the pacing, and a page that came back saturated means there is more waiting.
   * Only a failure waits, and only for `retryDelayMs`.
   */
  private async roomLoop(room: string, signal: AbortSignal): Promise<void> {
    while (!signal.aborted) {
      // A room in catch-up reads back to back, but its own request rate is
      // capped: without the cap one saturated room would spend the whole
      // `MAX_INFLIGHT` budget and the five referee rooms would starve, which is
      // the fairness failure this reader exists to prevent. The cap is on the
      // room, not on the reader, so the referee rooms stay unthrottled.
      const stats = this.statsFor(room);
      if (stats.mode === 'catching_up' && this.catchingUpMaxRequestsPerSecond > 0) {
        const minIntervalMs = 1_000 / this.catchingUpMaxRequestsPerSecond;
        const sinceLast = this.now().getTime() - stats.lastRequestStartedAtMs;
        if (sinceLast < minIntervalMs) await this.pause(minIntervalMs - sinceLast, signal);
        if (signal.aborted) return;
      }

      let error: string | undefined;
      try {
        const result = await this.semaphore.run(() => this.readRoom(room, this.localDids(), signal));
        error = result.error;
        // Persist what the read produced the instant it happened. This is the
        // reader-owned half of the work (snapshots, anomalies, the local-message
        // ledger) and it must not wait for the scheduler's 60-second cadence.
        if (this.onRead !== null && error === undefined) this.onRead(result);
      } catch (caught) {
        error = caught instanceof Error ? caught.message : String(caught);
      }

      if (signal.aborted) return; // stopping: this read is neither success nor failure

      if (error === undefined) {
        this.throughput.completedReads += 1;
      } else {
        this.throughput.failedReads += 1;
        this.throughput.lastError = error;
        this.throughput.lastErrorAt = this.now().toISOString();
        await this.pause(this.retryDelayMs, signal);
      }
    }
  }

  /** Abortable pause, so a stop never waits out a retry delay. */
  private async pause(ms: number, signal: AbortSignal): Promise<void> {
    if (ms <= 0 || signal.aborted) return;
    try {
      await sleep(ms, { signal });
    } catch {
      /* aborted: the loop's own `signal.aborted` check ends it */
    }
  }

  /**
   * One pass over every room, with at most `readConcurrency` reads in flight.
   *
   * Caller-driven: kept for the tests and for the bounded dynamic-room pass.
   * Production reads the fixed rooms through `startContinuous()`.
   */
  async tick(): Promise<TickSummary> {
    const at = this.now().toISOString();
    const localDids = this.localDids();
    // The dynamic set is resolved once per pass: every room in it is read inside
    // the same semaphore, so it cannot widen the socket budget.
    const rooms = this.roomsProvider ? this.roomsProvider() : this.rooms;
    const results = await Promise.all(
      rooms.map((room) => this.semaphore.run(() => this.readRoom(room, localDids))),
    );

    const observations: RefereeObservation[] = [];
    const localMessages: Array<{ room: string; message: RoomMessage }> = [];
    let inserted = 0;
    let errors = 0;
    for (const result of results) {
      inserted += result.inserted;
      if (result.error) errors += 1;
      observations.push(...result.observations);
      localMessages.push(...result.localMessages);
    }

    this.refreshHealth();

    this.ticks += 1;
    const summary: TickSummary = {
      at,
      rooms: results.map((result) => result.tick),
      inserted,
      observations,
      localMessages,
      health: this.lastHealth,
      errors,
    };
    this.lastSummary = summary;
    return summary;
  }

  /**
   * Recompute cursor health and put the verifier into conservative mode when it
   * is not clean. Called from both drive modes; throttled in continuous mode so
   * a fast drain does not re-query the cursor table per page.
   */
  private refreshHealth(force = false): CursorHealth {
    const nowMs = this.now().getTime();
    if (!force && this.continuous && nowMs - this.lastHealthCheckMs < HEALTH_INTERVAL_MS) {
      return this.lastHealth;
    }
    this.lastHealthCheckMs = nowMs;
    const health = cursorHealth(this.cursorStore.all());
    this.lastHealth = health;
    if (!health.healthy) {
      this.verifier.enterConservative('cursor_health', health.reasons.join('; '));
    }
    this.checkFairness(nowMs);
    this.verifier.reconcileSweeps();
    return health;
  }

  /**
   * Fairness: no fixed room may go unread while another room spends the budget.
   *
   * The catch-up rate cap and the semaphore floor already make starvation
   * unlikely — which is exactly why it has to be *observed* rather than assumed.
   * A referee room that has quietly stopped being read is indistinguishable from
   * a quiet one until its gap appears, and by then the messages are already
   * gone. One warning per silence episode; a successful read clears it.
   */
  private checkFairness(nowMs: number): void {
    if (!this.continuous || this.fairnessMaxSilenceMs <= 0) return;
    for (const room of this.rooms) {
      const stats = this.statsFor(room);
      const baseline = stats.lastReadAtMs ?? (this.continuousStartedAtMs || stats.windowStartedAtMs);
      const silenceMs = Math.max(0, nowMs - baseline);
      if (silenceMs <= this.fairnessMaxSilenceMs || stats.fairnessWarned) continue;
      stats.fairnessWarned = true;
      this.logger.event({
        level: 'warn',
        source: 'room-reader',
        code: 'reader_fairness_warning',
        message:
          `${room} has not been read for ${Math.round(silenceMs / 1000)}s, over the ` +
          `${Math.round(this.fairnessMaxSilenceMs / 1000)}s fairness bound; a room that is behind ` +
          'must not starve the rest of the fixed set',
        data: { room, silenceMs, boundMs: this.fairnessMaxSilenceMs, mode: stats.mode },
      });
    }
  }

  /**
   * Read every room in the dynamic set, once.
   *
   * Deliberately separate from `tick()`: the scheduler drives this on its own
   * cadence while the fixed rooms are owned by their continuous loops, so a
   * discovered owner room still costs exactly one bounded pass.
   */
  async tickDynamic(): Promise<{
    inserted: number;
    errors: number;
    rooms: RoomTick[];
  }> {
    if (this.roomsProvider === null) return { inserted: 0, errors: 0, rooms: [] };
    const localDids = this.localDids();
    const rooms = this.roomsProvider();
    const results = await Promise.all(
      rooms.map((room) => this.semaphore.run(() => this.readRoom(room, localDids))),
    );
    let inserted = 0;
    let errors = 0;
    for (const result of results) {
      inserted += result.inserted;
      if (result.error) errors += 1;
    }
    return { inserted, errors, rooms: results.map((result) => result.tick) };
  }

  private async readRoom(
    room: string,
    localDids: Set<string>,
    signal?: AbortSignal,
  ): Promise<RoomReadOutcome> {
    // Accounting wraps the actual HTTP read, so `activeRequests` counts requests
    // in flight rather than callers queued on the semaphore.
    this.throughput.activeRequests += 1;
    const startedAt = Date.now();
    try {
      return await this.performRead(room, localDids, signal);
    } finally {
      this.throughput.activeRequests -= 1;
      this.throughput.maxReadDurationMs = Math.max(
        this.throughput.maxReadDurationMs,
        Date.now() - startedAt,
      );
    }
  }

  private async performRead(
    room: string,
    localDids: Set<string>,
    signal?: AbortSignal,
  ): Promise<RoomReadOutcome> {
    const previous = this.cursorStore.load(room);
    const stats = this.statsFor(room);
    // A room that is behind asks for a bigger page when the service allows one.
    const limitUsed = this.pageSizeFor(room);
    const observations: RefereeObservation[] = [];
    const localMessages: Array<{ room: string; message: RoomMessage }> = [];
    let advance = advanceCursor(
      previous,
      { room, count: 0, first_seq: null, last_seq: null, messages: [] },
      previous.generation,
    );
    let read: RoomMessage[] = [];
    let degraded = false;
    let error: string | undefined;
    let durationMs = 0;

    stats.lastRequestStartedAtMs = this.now().getTime();
    const startedAt = Date.now();
    try {
      const result = await this.client.readRoom(room, {
        since: previous.cursor > 0 ? previous.cursor : undefined,
        limit: limitUsed,
        // Catch-up must never hold. The long poll is what paces a reader that is
        // keeping up; a reader that is behind is paced by the queue in front of
        // it, so asking the service to wait would only add latency to a room
        // that has real work queued. A room we have never read holds no cursor
        // either, so its first read returns immediately too.
        waitSeconds:
          stats.mode === 'catching_up' ? 0 : previous.cursor > 0 ? this.waitSeconds : 0,
        ...(signal === undefined ? {} : { signal }),
      });
      durationMs = Date.now() - startedAt;
      read = result.read.messages;
      degraded = result.degraded;
      advance = advanceCursor(previous, result.read, previous.generation);
    } catch (caught) {
      durationMs = Date.now() - startedAt;
      if (signal?.aborted === true) {
        // A read cancelled by shutdown is not a read error: recording it would
        // inflate the error streak and could trip conservative mode on exit.
        return {
          tick: {
            room,
            readCount: 0,
            inserted: 0,
            cursor: previous,
            advanceReason: 'aborted',
            degraded: false,
          },
          inserted: 0,
          observations: [],
          localMessages: [],
        };
      }
      error = String(caught);
      this.cursorStore.recordError(room, error, this.now().toISOString());
    }

    const inserted = error
      ? 0
      : this.cursorStore.commit(room, read, advance, this.now().toISOString());

    // Read the cursor back after the commit: `gap_resolved_at` is decided inside
    // that transaction, and it is the durable answer to "is this room's gap
    // still open".
    const cursor = this.cursorStore.load(room);
    if (!error) {
      this.noteRead(room, stats, {
        returnedCount: read.length,
        pageFirstSeq: read[0]?.seq ?? null,
        pageLastSeq: read[read.length - 1]?.seq ?? null,
        ringFirstSeq: advance.firstSeq,
        ringLastSeq: advance.lastSeq,
        cursor,
        limitUsed,
        durationMs,
        reason: advance.reason,
      });
      for (const message of read) {
        // Referee posts are the only messages with a state machine attached.
        if (room.startsWith('d-')) {
          const observation = this.verifier.observe(room, message);
          if (observation) observations.push(observation);
        }
        if (message.from !== undefined && localDids.has(message.from)) {
          localMessages.push({ room, message });
        }
      }
      if (advance.reason === 'bootstrap_truncated') {
        // Fires exactly once per room: the reason can only be
        // `bootstrap_truncated` on the read that lifts the cursor off zero.
        this.logger.event({
          level: 'warn',
          source: 'room-reader',
          code: 'bootstrap_truncated',
          message:
            `${room} opened with truncated history: the retained window starts at seq ${advance.firstSeq}, ` +
            `so seq ${advance.missedFrom}..${advance.missedTo} were never available to this process`,
          data: {
            room,
            firstSeq: advance.firstSeq,
            missedFrom: advance.missedFrom,
            missedTo: advance.missedTo,
          },
        });
      }
      if (advance.reason === 'gap') {
        // A new gap re-opens the room. The contiguous-resume and fully-recovered
        // markers both describe *this* gap, so both start again.
        stats.contiguousResumeEmitted = false;
        stats.fullyRecoveredEmitted = false;
        stats.consecutiveShortPages = 0;
        this.logger.event({
          level: 'warn',
          source: 'room-reader',
          code: 'cursor_gap',
          message: `cursor gap in ${room}: messages ${advance.missedFrom}..${advance.missedTo} were not read`,
          data: {
            room,
            from: advance.missedFrom,
            to: advance.missedTo,
            totalGap: advance.gap,
            generation: advance.generation,
            observedAt: this.now().toISOString(),
            // One alert per distinct range: a gap repeated by a polling loop is
            // the same fact, while a new range is a new loss.
            dedupKey: `${room}:${advance.missedFrom}-${advance.missedTo}:g${advance.generation}`,
          },
        });
      }
      if (
        (advance.reason === 'ok' || advance.reason === 'empty') &&
        previous.gapCount > 0 &&
        !stats.contiguousResumeEmitted
      ) {
        // What counts is a read that skipped nothing: either a page that carried
        // messages continuously from where we were, or a quiet read that had
        // nothing to skip. Either way the reader is inside the retained window
        // again, which is all this event claims.
        //
        // This event says exactly one thing: contiguous reading resumed. It does
        // *not* say the room is level with its head, it does not clear the
        // recorded gap, and it does not lift conservative mode. Reporting
        // "caught up again" from this alone is what made a permanently-gapping
        // room look recovered, so the two are separated: `..._fully_recovered`
        // below is the only event that claims the room is level.
        stats.contiguousResumeEmitted = true;
        this.throughput.contiguousResumeCount += 1;
        this.logger.event({
          level: 'info',
          source: 'room-reader',
          code: 'cursor_gap_contiguous_resume',
          message:
            `${room} resumed contiguous reading after the recorded gap ` +
            `${previous.lastGapFrom ?? '?'}..${previous.lastGapTo ?? '?'}; the gap stays on the record ` +
            'and the room is not yet known to be at its head',
          data: {
            room,
            resumedAt: this.now().toISOString(),
            lastGapFrom: previous.lastGapFrom,
            lastGapTo: previous.lastGapTo,
            gapCount: previous.gapCount,
          },
        });
      }
      if (!stats.fullyRecoveredEmitted && this.isFullyRecovered(stats, advance.reason, cursor)) {
        stats.fullyRecoveredEmitted = true;
        this.throughput.gapRecoveryCount += 1;
        this.throughput.lastGapRecoveredAt = this.now().toISOString();
        this.logger.event({
          level: 'info',
          source: 'room-reader',
          code: 'cursor_gap_fully_recovered',
          message:
            `${room} is fully caught up: no unresolved gap, a contiguous short page, the cursor at the ` +
            `retained head (${cursor.cursor} >= ${stats.lastRingLastSeq ?? '?'}) and ` +
            `${stats.consecutiveShortPages} clean read cycle(s) behind it`,
          data: {
            room,
            recoveredAt: this.throughput.lastGapRecoveredAt,
            cursor: cursor.cursor,
            ringLastSeq: stats.lastRingLastSeq,
            cursorLag: stats.cursorLag,
            cleanReads: stats.consecutiveShortPages,
            netBacklogRate: stats.netBacklogRate,
          },
        });
      }
      if (advance.reason === 'room_reset') {
        this.logger.event({
          level: 'warn',
          source: 'room-reader',
          code: 'room_reset',
          message: `${room} was recreated: generation ${previous.generation} -> ${advance.generation}`,
          data: {
            room,
            previousGeneration: previous.generation,
            generation: advance.generation,
            dedupKey: `${room}:reset:g${advance.generation}`,
          },
        });
      }
      if (degraded) {
        this.logger.event({
          level: 'warn',
          source: 'room-reader',
          code: 'room_read_degraded',
          message: `${room} returned the text view; senders are not recoverable from it`,
          data: { room },
        });
      }
    }

    // Health is cheap but not free (a cursor-table read); in continuous mode it
    // is throttled, and in tick mode it was already computed once per pass.
    if (this.continuous) this.refreshHealth();

    return {
      tick: {
        room,
        readCount: read.length,
        inserted,
        cursor,
        advanceReason: advance.reason,
        degraded,
        ...(error === undefined ? {} : { error }),
      },
      inserted,
      observations,
      localMessages,
      ...(error === undefined ? {} : { error }),
    };
  }

  /** The per-room accounting record, created the first time a room is touched. */
  private statsFor(room: string): RoomStats {
    const existing = this.roomStats.get(room);
    if (existing !== undefined) return existing;
    const created: RoomStats = {
      room,
      mode: this.continuous ? 'normal_long_poll' : 'stopped',
      windowStartedAtMs: this.continuousStartedAtMs || this.now().getTime(),
      windowReads: 0,
      windowMessages: 0,
      windowSaturated: 0,
      windowDurations: [],
      windowLastSeqStart: null,
      windowFirstSeqStart: null,
      windowCursorStart: null,
      windowGapStart: null,
      producerRate: 0,
      consumerRate: 0,
      netBacklogRate: 0,
      readsPerMinute: 0,
      messagesPerMinute: 0,
      requestsPerMinute: 0,
      saturatedPagesPerMinute: 0,
      cursorDeltaPerMinute: 0,
      gapDeltaPerMinute: 0,
      firstSeqDeltaPerMinute: 0,
      lastSeqDeltaPerMinute: 0,
      avgRequestDurationMs: 0,
      p95RequestDurationMs: 0,
      positiveBacklogWindows: 0,
      lastReturnedCount: 0,
      lastReturnedFirstSeq: null,
      lastReturnedLastSeq: null,
      lastCursor: 0,
      lastCursorGap: 0,
      lastGapFrom: null,
      lastGapTo: null,
      lastRingLastSeq: null,
      lastRingFirstSeq: null,
      lastLimitUsed: this.baseLimitFor(room),
      lastReadAtMs: null,
      lastRequestStartedAtMs: 0,
      catchingUpSinceMs: null,
      pageSaturated: false,
      cursorLag: null,
      consecutiveShortPages: 0,
      contiguousResumeEmitted: false,
      fullyRecoveredEmitted: false,
      fairnessWarned: false,
    };
    this.roomStats.set(room, created);
    return created;
  }

  /**
   * The page size this room's next read should ask for.
   *
   * Only a room that is behind asks for more, and never for more than the
   * service's own limit: a `limit` the service refuses turns every read into a
   * 400, which is a worse failure than a small page.
   */
  private pageSizeFor(room: string): number {
    const limits = this.limitsByRoom.get(room);
    const catchingUp = this.roomStats.get(room)?.mode === 'catching_up';
    if (limits !== undefined) return catchingUp ? limits.catchingUpLimit : limits.limit;
    return catchingUp ? this.catchingUpLimit : this.limit;
  }

  /** The page size a room asks for when it is not behind. */
  private baseLimitFor(room: string): number {
    return this.limitsByRoom.get(room)?.limit ?? this.limit;
  }

  /**
   * Which of the five states a room is in.
   *
   * The order matters. `catching_up` is decided first, because being behind is
   * the fact that governs how the room is read; `upstream_gap` second, because a
   * room whose gap no read can close (the ring already dropped it) is a
   * different problem from one that is merely slow; `fully_caught_up` only from
   * the clean-page evidence below.
   */
  private resolveMode(stats: RoomStats, cursor: CursorRecord): RoomMode {
    if (!this.continuous) return 'stopped';
    const lagThreshold = this.catchingUpLimit * CATCHING_UP_LAG_FACTOR;
    if (stats.pageSaturated) return 'catching_up';
    if (stats.positiveBacklogWindows >= UNATTAINABLE_WINDOWS) return 'catching_up';
    if (stats.cursorLag !== null && stats.cursorLag > lagThreshold) return 'catching_up';
    if (cursor.gapCount > 0 && cursor.gapResolvedAt === null) return 'upstream_gap';
    if (stats.consecutiveShortPages >= RECOVERY_CLEAN_READS) return 'fully_caught_up';
    return 'normal_long_poll';
  }

  /**
   * The full caught-up test — the only thing in this file allowed to say
   * "recovered".
   *
   * Each clause rules out a different way of being wrong. A gap with no
   * contiguous read past it is still open. A saturated page means there is more
   * behind it. A widening backlog means we are losing ground even if this page
   * came back short. A cursor short of the retained head means we are not level
   * however small the page was. And fewer than two clean cycles means the short
   * page may simply be the lull between two bursts.
   */
  private isFullyRecovered(stats: RoomStats, reason: string, cursor: CursorRecord): boolean {
    // A read that skipped nothing. `gap` and `room_reset` are the two that did.
    if (reason !== 'ok' && reason !== 'empty') return false;
    if (!stats.contiguousResumeEmitted) return false;
    if (cursor.gapCount === 0) return false;
    if (cursor.gapResolvedAt === null) return false;
    if (stats.pageSaturated) return false;
    if (stats.positiveBacklogWindows > 0) return false;
    if (stats.cursorLag === null || stats.cursorLag > 0) return false;
    return stats.consecutiveShortPages >= RECOVERY_CLEAN_READS;
  }

  /**
   * Record one successful read: the per-room window, the reader-wide rolling
   * rates, and the room's mode.
   *
   * `producerRate` deliberately comes from the ring's own `last_seq` rather than
   * from what we read. The two are different facts, and conflating them is what
   * made a room losing ~870 messages a minute look healthy: `messagesRead` is
   * what we *consumed*, and a producer that outruns us produces the same
   * consumption figure as one that does not.
   */
  private noteRead(
    room: string,
    stats: RoomStats,
    input: {
      returnedCount: number;
      pageFirstSeq: number | null;
      pageLastSeq: number | null;
      ringFirstSeq: number | null;
      ringLastSeq: number | null;
      cursor: CursorRecord;
      limitUsed: number;
      durationMs: number;
      reason: string;
    },
  ): void {
    const nowMs = this.now().getTime();
    const at = this.now().toISOString();
    this.throughput.lastSuccessAt = at;
    this.lastSuccessByRoom.set(room, at);
    this.throughput.messagesRead += input.returnedCount;

    // A cursor that moved is a cursor that made progress: those are the only
    // reads that count as consumption.
    const advanced = input.cursor.cursor > stats.lastCursor;
    if (advanced) this.throughput.cursorAdvances += 1;

    stats.lastReturnedCount = input.returnedCount;
    stats.lastReturnedFirstSeq = input.pageFirstSeq;
    stats.lastReturnedLastSeq = input.pageLastSeq;
    stats.lastCursor = input.cursor.cursor;
    stats.lastCursorGap = input.cursor.gap;
    stats.lastGapFrom = input.cursor.lastGapFrom;
    stats.lastGapTo = input.cursor.lastGapTo;
    stats.lastRingFirstSeq = input.ringFirstSeq;
    stats.lastRingLastSeq = input.ringLastSeq;
    stats.lastLimitUsed = input.limitUsed;
    stats.lastReadAtMs = nowMs;
    stats.fairnessWarned = false;
    // A saturated page is a statement about *this page*: the service had at
    // least `limitUsed` to give, so there is more behind it. It is never a
    // statement about the room's health.
    stats.pageSaturated = input.returnedCount >= input.limitUsed;
    stats.cursorLag =
      input.ringLastSeq === null ? null : input.ringLastSeq - input.cursor.cursor;

    // A contiguous read that came back short is the only evidence the room is at
    // rest rather than between two bursts. `empty` counts: nothing to read is
    // the strongest form of "at rest". A new gap or a reset is not clean.
    const contiguous = input.cursor.lastOkAt !== null && input.cursor.consecutiveErrors === 0;
    if (contiguous && (input.reason === 'ok' || input.reason === 'empty')) {
      stats.consecutiveShortPages = stats.pageSaturated
        ? 0
        : Math.min(RECOVERY_CLEAN_READS, stats.consecutiveShortPages + 1);
    } else {
      stats.consecutiveShortPages = 0;
    }

    stats.mode = this.resolveMode(stats, input.cursor);
    // How long the room has been behind without a break, which is what turns
    // "catching up" into the honest `unattainable` once it outstays its bound.
    if (stats.mode === 'catching_up') {
      stats.catchingUpSinceMs ??= nowMs;
    } else {
      stats.catchingUpSinceMs = null;
    }

    // ---- window accumulation ------------------------------------------------
    const windowIsNew = stats.windowLastSeqStart === null;
    if (windowIsNew) {
      stats.windowLastSeqStart = input.ringLastSeq;
      stats.windowFirstSeqStart = input.ringFirstSeq;
      stats.windowCursorStart = input.cursor.cursor;
      stats.windowGapStart = input.cursor.gap;
    }
    stats.windowReads += 1;
    stats.windowMessages += input.returnedCount;
    if (stats.pageSaturated) stats.windowSaturated += 1;
    stats.windowDurations.push(input.durationMs);
    // Keep the first read's own baseline rather than the pre-read one, so a
    // window opened mid-stream does not charge the room for messages it had
    // already consumed.
    if (windowIsNew) {
      stats.windowCursorStart = input.cursor.cursor;
      stats.windowGapStart = input.cursor.gap;
    }

    this.throughput.pageSaturated = stats.pageSaturated;
    this.sealWindowIfDue(stats);

    const second = Math.floor(nowMs / 1000);
    const bucket = this.rateBuckets.get(second) ?? { reads: 0, messages: 0, advances: 0 };
    bucket.reads += 1;
    bucket.messages += input.returnedCount;
    if (advanced) bucket.advances += 1;
    this.rateBuckets.set(second, bucket);
    if (this.rateBuckets.size > RATE_WINDOW_SECONDS + 2) {
      for (const key of this.rateBuckets.keys()) {
        if (key < second - RATE_WINDOW_SECONDS) this.rateBuckets.delete(key);
      }
    }
  }

  /**
   * Seal a room's window once a full minute has elapsed, then reopen it.
   *
   * Nothing here is extrapolated from a partial window: a rate is only published
   * once a whole window supports it, so a burst of reads cannot be read as a
   * permanent figure and a quiet minute cannot be hidden by a busy one.
   *
   * A positive `netBacklogRate` is carried forward as a *streak* — the count of
   * consecutive sealed windows that showed the producer outrunning us. Two in a
   * row is the threshold, and it is deliberately not "wait until the gap grows":
   * by the time the loss is visible in `gap`, the messages are already gone.
   */
  private sealWindowIfDue(stats: RoomStats): void {
    const nowMs = this.now().getTime();
    const elapsedMs = nowMs - stats.windowStartedAtMs;
    if (elapsedMs < RATE_WINDOW_MS) return;
    const minutes = elapsedMs / 60_000;
    const perMinute = (delta: number | null): number =>
      delta === null || delta <= 0 ? 0 : Math.round((delta / minutes) * 100) / 100;

    stats.producerRate = perMinute(
      stats.windowLastSeqStart === null || stats.lastRingLastSeq === null
        ? null
        : stats.lastRingLastSeq - stats.windowLastSeqStart,
    );
    stats.consumerRate = perMinute(
      stats.windowCursorStart === null ? null : stats.lastCursor - stats.windowCursorStart,
    );
    stats.netBacklogRate = Math.round((stats.producerRate - stats.consumerRate) * 100) / 100;
    stats.cursorDeltaPerMinute = stats.consumerRate;
    stats.lastSeqDeltaPerMinute = stats.producerRate;
    stats.firstSeqDeltaPerMinute = perMinute(
      stats.windowFirstSeqStart === null || stats.lastRingFirstSeq === null
        ? null
        : stats.lastRingFirstSeq - stats.windowFirstSeqStart,
    );
    stats.gapDeltaPerMinute = perMinute(
      stats.windowGapStart === null ? null : stats.lastCursorGap - stats.windowGapStart,
    );
    stats.readsPerMinute = Math.round((stats.windowReads / minutes) * 100) / 100;
    stats.messagesPerMinute = Math.round((stats.windowMessages / minutes) * 100) / 100;
    stats.requestsPerMinute = stats.readsPerMinute;
    stats.saturatedPagesPerMinute = Math.round((stats.windowSaturated / minutes) * 100) / 100;
    const durations = stats.windowDurations;
    stats.avgRequestDurationMs =
      durations.length === 0
        ? 0
        : Math.round(durations.reduce((sum, value) => sum + value, 0) / durations.length);
    stats.p95RequestDurationMs = percentile(durations, 0.95);

    stats.positiveBacklogWindows =
      stats.netBacklogRate > 0 ? stats.positiveBacklogWindows + 1 : 0;

    stats.windowStartedAtMs = nowMs;
    stats.windowReads = 0;
    stats.windowMessages = 0;
    stats.windowSaturated = 0;
    stats.windowDurations = [];
    stats.windowLastSeqStart = stats.lastRingLastSeq;
    stats.windowFirstSeqStart = stats.lastRingFirstSeq;
    stats.windowCursorStart = stats.lastCursor;
    stats.windowGapStart = stats.lastCursorGap;
  }

  private rates(): { readsPerMinute: number; messagesPerMinute: number; cursorAdvancesPerMinute: number } {
    const second = Math.floor(this.now().getTime() / 1000);
    let reads = 0;
    let messages = 0;
    let advances = 0;
    for (const [key, bucket] of this.rateBuckets) {
      if (key < second - RATE_WINDOW_SECONDS || key > second) continue;
      reads += bucket.reads;
      messages += bucket.messages;
      advances += bucket.advances;
    }
    return { readsPerMinute: reads, messagesPerMinute: messages, cursorAdvancesPerMinute: advances };
  }

  /** One room's sealed-window view, for `throughputStats()`. */
  private roomThroughput(room: string): RoomThroughput {
    const stats = this.statsFor(room);
    this.sealWindowIfDue(stats);
    const nowMs = this.now().getTime();
    const baseline = stats.lastReadAtMs ?? (this.continuousStartedAtMs || stats.windowStartedAtMs);
    return {
      room,
      mode: this.continuous ? stats.mode : 'stopped',
      producerRate: stats.producerRate,
      consumerRate: stats.consumerRate,
      netBacklogRate: stats.netBacklogRate,
      readsPerMinute: stats.readsPerMinute,
      messagesPerMinute: stats.messagesPerMinute,
      requestsPerMinute: stats.requestsPerMinute,
      saturatedPagesPerMinute: stats.saturatedPagesPerMinute,
      cursorDeltaPerMinute: stats.cursorDeltaPerMinute,
      gapDeltaPerMinute: stats.gapDeltaPerMinute,
      firstSeqDeltaPerMinute: stats.firstSeqDeltaPerMinute,
      lastSeqDeltaPerMinute: stats.lastSeqDeltaPerMinute,
      avgRequestDurationMs: stats.avgRequestDurationMs,
      p95RequestDurationMs: stats.p95RequestDurationMs,
      pageSaturated: stats.pageSaturated,
      cursorLag: stats.cursorLag,
      positiveBacklogWindows: stats.positiveBacklogWindows,
      silenceMs: Math.max(0, nowMs - baseline),
      catchingUpForMs: stats.catchingUpSinceMs === null ? 0 : Math.max(0, nowMs - stats.catchingUpSinceMs),
    };
  }

  /**
   * The reader-wide state the report and the live gate read.
   *
   * `catchupState` distinguishes the three honest descriptions of a reader that
   * is not level, and never calls any of them "catching up" once the backlog has
   * been shown to be widening across two whole windows.
   */
  private catchupState(
    rooms: RoomThroughput[],
    unattainable: boolean,
  ): ReaderThroughputStats['catchupState'] {
    if (!this.continuous) return 'normal';
    if (unattainable) return 'unattainable';
    if (rooms.some((row) => row.mode === 'catching_up')) return 'catching_up';
    if (rooms.length > 0 && rooms.every((row) => row.mode === 'fully_caught_up')) {
      return 'fully_caught_up';
    }
    return 'normal';
  }

  /** The reader's own throughput view, for `status()` and the report. */
  throughputStats(): ReaderThroughputStats {
    const rates = this.rates();
    const cursors = this.cursorStore.all();
    const recorded = cursors.filter((cursor) => cursor.gap > 0 || cursor.gapCount > 0);
    const rooms = this.rooms.map((room) => this.roomThroughput(room));
    // A gap is only closed once the room has passed the full caught-up test, not
    // the moment a contiguous read touches it: the durable `gap_resolved_at` flag
    // answers "is the cursor contiguous again", which is a weaker question.
    const recovered = new Set(
      rooms.filter((row) => row.mode === 'fully_caught_up').map((row) => row.room),
    );
    const unresolvedGapRooms = recorded
      .filter((cursor) => !recovered.has(cursor.room))
      .map((cursor) => cursor.room);
    const silentRooms =
      this.fairnessMaxSilenceMs <= 0
        ? []
        : rooms.filter((row) => row.silenceMs > this.fairnessMaxSilenceMs).map((row) => row.room);
    const estimatedProducerRate = round2(rooms.reduce((sum, row) => sum + row.producerRate, 0));
    const estimatedConsumerRate = round2(rooms.reduce((sum, row) => sum + row.consumerRate, 0));
    const netBacklogIncreasing = rooms.some(
      (row) => row.positiveBacklogWindows >= UNATTAINABLE_WINDOWS,
    );
    // A room that has been continuously behind past its bound and whose *most
    // recent* sealed window still showed a widening backlog. `positiveBacklogWindows
    // >= 1` is exactly that: the counter resets to zero on any window that was not
    // widening, so a single window there means the last one was. This catches the
    // room that alternates wide-and-not, which never reaches two in a row and
    // would otherwise be reported as "catching up" indefinitely.
    const outOfTime = rooms.some(
      (row) =>
        this.catchingUpMaxSeconds > 0 &&
        row.mode === 'catching_up' &&
        row.catchingUpForMs > this.catchingUpMaxSeconds * 1_000 &&
        row.positiveBacklogWindows >= 1,
    );

    const lastReturnedCountByRoom: Record<string, number> = {};
    const lastReturnedFirstSeqByRoom: Record<string, number | null> = {};
    const lastReturnedLastSeqByRoom: Record<string, number | null> = {};
    const lastCursorByRoom: Record<string, number> = {};
    const lastGapFromByRoom: Record<string, number | null> = {};
    const lastGapToByRoom: Record<string, number | null> = {};
    const modeByRoom: Record<string, RoomMode> = {};
    for (const row of rooms) {
      const stats = this.statsFor(row.room);
      lastReturnedCountByRoom[row.room] = stats.lastReturnedCount;
      lastReturnedFirstSeqByRoom[row.room] = stats.lastReturnedFirstSeq;
      lastReturnedLastSeqByRoom[row.room] = stats.lastReturnedLastSeq;
      lastGapFromByRoom[row.room] = stats.lastGapFrom;
      lastGapToByRoom[row.room] = stats.lastGapTo;
      modeByRoom[row.room] = row.mode;
    }
    // The durable cursor wins over the read-time copy: it is what is actually
    // stored, and it is still right for a room whose last read failed.
    for (const cursor of cursors) lastCursorByRoom[cursor.room] = cursor.cursor;

    return {
      continuousMode: this.continuous,
      running: this.continuous && this.stopping !== null,
      fixedRoomCount: this.rooms.length,
      activeRequests: this.throughput.activeRequests,
      completedReads: this.throughput.completedReads,
      failedReads: this.throughput.failedReads,
      messagesRead: this.throughput.messagesRead,
      lastSuccessAt: this.throughput.lastSuccessAt,
      lastSuccessByRoom: Object.fromEntries(this.lastSuccessByRoom),
      maxReadDurationMs: this.throughput.maxReadDurationMs,
      lastError: this.throughput.lastError,
      lastErrorAt: this.throughput.lastErrorAt,
      backlogObserved: this.throughput.pageSaturated,
      pageSaturated: this.throughput.pageSaturated,
      unresolvedGap: unresolvedGapRooms.length > 0,
      unresolvedGapRooms,
      fullyCaughtUp:
        this.continuous &&
        unresolvedGapRooms.length === 0 &&
        rooms.length > 0 &&
        rooms.every((row) => row.mode === 'fully_caught_up'),
      netBacklogIncreasing,
      catchupState: this.catchupState(rooms, netBacklogIncreasing || outOfTime),
      contiguousResumeCount: this.throughput.contiguousResumeCount,
      gapRecoveryCount: this.throughput.gapRecoveryCount,
      lastGapRecoveredAt: this.throughput.lastGapRecoveredAt,
      estimatedProducerRate,
      estimatedConsumerRate,
      estimatedBacklogRate: round2(estimatedProducerRate - estimatedConsumerRate),
      cursorAdvances: this.throughput.cursorAdvances,
      readsPerMinute: rates.readsPerMinute,
      messagesPerMinute: rates.messagesPerMinute,
      cursorAdvancesPerMinute: rates.cursorAdvancesPerMinute,
      limit: this.limit,
      serverLimit: this.serverLimit,
      concurrency: this.concurrency,
      silentRooms,
      lastReturnedCountByRoom,
      lastReturnedFirstSeqByRoom,
      lastReturnedLastSeqByRoom,
      lastCursorByRoom,
      lastGapFromByRoom,
      lastGapToByRoom,
      modeByRoom,
      rooms,
    };
  }

  /** True once the reader has completed a pass over every room it owns. */
  get warmedUp(): boolean {
    if (this.continuous) return this.rooms.every((room) => this.lastSuccessByRoom.has(room));
    return this.ticks > 0;
  }

  get isStopped(): boolean {
    return this.stopped;
  }

  /**
   * Per-room cursor state for the status report.
   *
   * `gaps` is the run-time finding (a mid-run loss) and is what enters
   * conservative mode; `bootstrap` is the permanent record of a room whose
   * retained history did not reach back to our start, which is not a loss this
   * process suffered and must not be reported as one.
   */
  gaps(): {
    total: number;
    rooms: string[];
    resets: string[];
    bootstrap: string[];
    /**
     * Rooms whose latest gap is still open — no contiguous read has resumed past
     * it. This is the "are we still losing messages" set, and it is what the live
     * gate names; `rooms` is the permanent record and is never cleared.
     */
    unresolved: string[];
    /** Rooms whose latest gap was closed by a contiguous read; still recorded. */
    recovered: string[];
    states: Array<{
      room: string;
      state: CursorRecord['bootstrapState'];
      gapCount: number;
      lastGapFrom: number | null;
      lastGapTo: number | null;
      firstObservedSeq: number | null;
      lastObservedSeq: number | null;
      gapResolvedAt: string | null;
    }>;
  } {
    const cursors = this.cursorStore.all();
    const recorded = cursors.filter((cursor) => cursor.gap > 0 || cursor.gapCount > 0);
    return {
      total: cursors.reduce((sum, cursor) => sum + cursor.gap, 0),
      rooms: cursors.filter((cursor) => cursor.gap > 0).map((cursor) => cursor.room),
      resets: cursors
        .filter((cursor) => cursor.bootstrapState === 'cursor_reset')
        .map((cursor) => cursor.room),
      bootstrap: cursors
        .filter((cursor) => cursor.bootstrapState === 'bootstrap_truncated')
        .map((cursor) => cursor.room),
      unresolved: recorded.filter((cursor) => cursor.gapResolvedAt === null).map((cursor) => cursor.room),
      recovered: recorded.filter((cursor) => cursor.gapResolvedAt !== null).map((cursor) => cursor.room),
      states: cursors.map((cursor) => ({
        room: cursor.room,
        state: cursor.bootstrapState,
        gapCount: cursor.gapCount,
        lastGapFrom: cursor.lastGapFrom,
        lastGapTo: cursor.lastGapTo,
        firstObservedSeq: cursor.firstObservedSeq,
        lastObservedSeq: cursor.lastObservedSeq,
        gapResolvedAt: cursor.gapResolvedAt,
      })),
    };
  }
}
