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
  /** Max concurrent room reads. Two by default: see the header. */
  readConcurrency?: number;
  /** Long-poll hold, seconds. Clamped to 0..10 by the service. */
  waitSeconds?: number;
  /** Messages per read, clamped to 200 by the service. */
  limit?: number;
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
 * What the reader is actually doing, for the status report.
 *
 * `backlogObserved` is the honest backlog signal: it is set when a read came back
 * *saturated* (the service returned exactly `limit` messages, so there was more
 * to give). It is cleared by the next read that came back short. It is never
 * derived from the cursor gap: a recorded gap is historical evidence and clearing
 * it is not something this process will ever do.
 */
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
  backlogObserved: boolean;
  /** Reads that moved a cursor forward, i.e. that actually made progress. */
  cursorAdvances: number;
  /** Times the reader observed a contiguous read resume after a recorded gap. */
  gapRecoveries: number;
  lastGapRecoveredAt: string | null;
  readsPerMinute: number;
  messagesPerMinute: number;
  cursorAdvancesPerMinute: number;
}

/** One second of read activity, for the rolling per-minute rates. */
interface RateBucket {
  reads: number;
  messages: number;
  advances: number;
}

const RATE_WINDOW_SECONDS = 60;
/** How often the continuous loop recomputes cursor health, in milliseconds. */
const HEALTH_INTERVAL_MS = 1_000;

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
  private readonly throughput = {
    activeRequests: 0,
    completedReads: 0,
    failedReads: 0,
    messagesRead: 0,
    maxReadDurationMs: 0,
    lastSuccessAt: null as string | null,
    lastError: null as string | null,
    lastErrorAt: null as string | null,
    backlogObserved: false,
    cursorAdvances: 0,
    gapRecoveries: 0,
    lastGapRecoveredAt: null as string | null,
  };
  private readonly lastSuccessByRoom = new Map<string, string>();
  private readonly rateBuckets = new Map<number, RateBucket>();
  /** Rooms with a recorded gap that has not yet been observed to be caught up. */
  private readonly pendingGapRecovery = new Set<string>();

  constructor(options: RoomReaderOptions) {
    this.client = options.client;
    this.repositories = options.repositories;
    this.verifier = options.verifier;
    this.logger = options.logger;
    this.rooms = [...options.rooms];
    this.roomsProvider = options.roomsProvider ?? null;
    this.waitSeconds = Math.min(10, Math.max(0, options.waitSeconds ?? 10));
    this.limit = Math.min(200, Math.max(1, options.limit ?? 50));
    this.retryDelayMs = Math.max(0, options.retryDelayMs ?? 2_000);
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
      this.abort?.abort();
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
    this.verifier.reconcileSweeps();
    return health;
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

    try {
      const result = await this.client.readRoom(room, {
        since: previous.cursor > 0 ? previous.cursor : undefined,
        limit: this.limit,
        // A room we have never read holds no cursor, so there is nothing to wait
        // for: the first read must return immediately.
        waitSeconds: previous.cursor > 0 ? this.waitSeconds : 0,
        ...(signal === undefined ? {} : { signal }),
      });
      read = result.read.messages;
      degraded = result.degraded;
      advance = advanceCursor(previous, result.read, previous.generation);
    } catch (caught) {
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

    if (!error) {
      this.noteRead(room, read.length, advance.cursor > previous.cursor);
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
        this.pendingGapRecovery.add(room);
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
      if (advance.reason === 'ok' && this.pendingGapRecovery.delete(room)) {
        // A contiguous page, which is the only thing that proves we are inside
        // the retained window again. An empty read does not: nothing arriving is
        // not the same as being caught up. The historical gap is never cleared —
        // this only records that the reader is no longer adding to it.
        this.throughput.gapRecoveries += 1;
        this.throughput.lastGapRecoveredAt = this.now().toISOString();
        this.logger.event({
          level: 'info',
          source: 'room-reader',
          code: 'cursor_gap_recovered',
          message: `${room} is caught up again: a contiguous read resumed after the recorded gap`,
          data: { room, recoveredAt: this.throughput.lastGapRecoveredAt },
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
        cursor: this.cursorStore.load(room),
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

  /** Record one read in the rolling per-minute window. */
  private noteRead(room: string, messages: number, advanced: boolean): void {
    const at = this.now().toISOString();
    this.throughput.lastSuccessAt = at;
    this.lastSuccessByRoom.set(room, at);
    this.throughput.messagesRead += messages;
    // Saturated page: the service had at least `limit` to give, so there is more.
    this.throughput.backlogObserved = messages >= this.limit;
    if (advanced) this.throughput.cursorAdvances += 1;

    const second = Math.floor(this.now().getTime() / 1000);
    const bucket = this.rateBuckets.get(second) ?? { reads: 0, messages: 0, advances: 0 };
    bucket.reads += 1;
    bucket.messages += messages;
    if (advanced) bucket.advances += 1;
    this.rateBuckets.set(second, bucket);
    if (this.rateBuckets.size > RATE_WINDOW_SECONDS + 2) {
      for (const key of this.rateBuckets.keys()) {
        if (key < second - RATE_WINDOW_SECONDS) this.rateBuckets.delete(key);
      }
    }
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

  /** The reader's own throughput view, for `status()` and the report. */
  throughputStats(): ReaderThroughputStats {
    const rates = this.rates();
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
      backlogObserved: this.throughput.backlogObserved,
      cursorAdvances: this.throughput.cursorAdvances,
      gapRecoveries: this.throughput.gapRecoveries,
      lastGapRecoveredAt: this.throughput.lastGapRecoveredAt,
      readsPerMinute: rates.readsPerMinute,
      messagesPerMinute: rates.messagesPerMinute,
      cursorAdvancesPerMinute: rates.cursorAdvancesPerMinute,
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
