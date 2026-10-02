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
import {
  cursorHealth,
  SqliteCursorStore,
  type CommitResult,
  type CursorHealth,
  type CursorRecord,
  type CursorStore,
} from './cursor-store.js';
import { advanceCursor, MAX_PAGE_SIZE, RoomMessageSchema } from './protocol.js';
import type { CursorAdvance, RoomMessage, TechnocoreLogger } from './protocol.js';
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
   * Allow export-assisted recovery after a recorded gap.
   *
   * Off unless an operator turns it on. The export is a *snapshot of the retained
   * ring*, not a replay: it can pull a large backlog in one round trip, and it can
   * never bring back a message the ring already dropped. It is therefore a
   * throughput lever, never a way to un-lose a gap.
   */
  exportRecovery?: boolean;
  /** Byte ceiling for one export. The ring is ~10 MiB; this keeps it bounded. */
  exportMaxBytes?: number;
  /** Most JSONL records one export will be parsed for. */
  exportMaxLines?: number;
  /** Wall-clock ceiling for one export, on top of the client's own timeout. */
  exportTimeoutMs?: number;
  /**
   * The minimum interval between export attempts for the same room.
   *
   * A gap that repeats on every poll is one fact, not a stream of new ones, and
   * the export endpoint is the most expensive read the service offers. Without a
   * cooldown a permanently-gapping room would export on every single gap read.
   */
  exportCooldownMs?: number;
  /**
   * The trading room's name, for the effective-config block.
   *
   * The reader does not act on this — it only needs to say, in `/status`, which
   * room the `close1*` limits belong to.
   */
  tradingRoom?: string;
  /**
   * The configured `CLOSE1_GAP_POLICY`, echoed into the effective-config block.
   *
   * The reader is not the component that enforces the policy; it is the component
   * that reports which policy is in force, so an operator can see it without
   * reading the unit file.
   */
  close1GapPolicy?: string;
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
  /**
   * What the commit actually did.
   *
   * `returned` and `inserted` are separate on purpose: the difference is
   * duplicates, and only `inserted` is consumption. A re-read of a page already
   * stored returns the same messages and persists none of them.
   */
  commit: CommitResult;
  /** The service's long-poll verdict, or null when it does not apply. */
  waitHeld: boolean | null;
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
 * reads, never inferred from a request count. Three of them are deliberately
 * separate figures, because conflating them is how a reader that is losing
 * ground comes to look healthy:
 *
 *   - `producerRate` is the room's own growth, taken from the *retained ring's*
 *     `last_seq`, which advances whether or not we read anything;
 *   - `persistedRate` is what actually reached SQLite. This, and only this, is
 *     consumption: a re-read of a page already stored persists nothing;
 *   - `cursorAdvanceRate` is how far the cursor *number* moved. It is a protocol
 *     invariant worth watching, and it is explicitly not a measure of work done —
 *     a cursor can step over a range nobody stored.
 *
 * `netPersistBacklogRate` is producer minus persisted. A positive value across
 * two consecutive windows is the only honest statement of "we are falling behind".
 */
export type RoomMode =
  | 'stopped'
  | 'normal'
  | 'catching_up'
  | 'contiguous_resume'
  | 'fully_caught_up'
  | 'upstream_gap'
  | 'unattainable';

export interface RoomThroughput {
  room: string;
  mode: RoomMode;
  /** The room's own growth, messages/minute, from the ring's `last_seq`. */
  producerRate: number;
  /** Messages written to SQLite per minute. The consumer figure. */
  persistedRate: number;
  /** How far the cursor number moved per minute. Not a consumption figure. */
  cursorAdvanceRate: number;
  /** Messages the ring dropped unread, per minute. */
  lostGapRate: number;
  /** `producerRate - persistedRate`. Positive means the backlog is widening. */
  netPersistBacklogRate: number;
  readsPerMinute: number;
  returnedPerMinute: number;
  saturatedPagesPerMinute: number;
  avgRequestDurationMs: number;
  p95RequestDurationMs: number;
  /** The last read came back with exactly its page size, so there was more. */
  pageSaturated: boolean;
  /** The ring's newest seq minus our cursor, from the last read. */
  cursorLag: number | null;
  /**
   * The long-poll hold the last read asked for, in seconds.
   *
   * Reported per room because it is the lever that separates "waiting for the
   * room to speak" from "draining a queue": a behind room asks for `0` so the
   * queue in front of it is what paces it, and an operator needs to see which
   * of the two a given room is doing.
   */
  waitSeconds: number;
  /** The page size the last read asked for, after clamping. */
  lastLimitUsed: number;
  /** Messages the last read returned. */
  lastReturnedCount: number;
  /** The retained ring's oldest seq as of the last read. */
  lastRingFirstSeq: number | null;
  /** The retained ring's newest seq as of the last read; the producer's position. */
  lastRingLastSeq: number | null;
  /** Consecutive contiguous reads that came back short of the page size. */
  consecutiveShortPages: number;
  /** Consecutive completed windows with `netPersistBacklogRate > 0`. */
  positiveBacklogWindows: number;
  /** How long since this room last completed a successful read. */
  silenceMs: number;
  /** How long this room has been in `catching_up` without a break. */
  catchingUpForMs: number;
  /** When this room last started a request. */
  lastRequestStartedAt: number | null;
  /** When this room last completed a successful read. */
  lastSuccessAt: string | null;
  /** How long this room may stay unread before a fairness warning. */
  fairnessBudgetMs: number;
  /** Whether a fairness warning is currently outstanding for this room. */
  fairnessWarning: boolean;
  // ---- running totals for the life of the process -------------------------
  /** Messages the service returned to this room's reads. */
  returnedMessages: number;
  /** Messages actually written to SQLite. */
  persistedMessages: number;
  /** Returned messages whose seq was already stored. */
  duplicateMessages: number;
  /** Returned messages neither stored nor recognised as duplicates. */
  rejectedMessages: number;
  /** Stored messages whose room signature verified. */
  signedMessages: number;
  /** Returned messages carrying a signature that did not verify. */
  invalidSignatureMessages: number;
  /** How far the cursor number has moved in total. A protocol metric only. */
  cursorSequenceAdvance: number;
  /** Messages the ring dropped unread, in total. Never part of the persisted count. */
  gapMessages: number;
}

/**
 * What export-assisted recovery has done.
 *
 * The export endpoint serves the retained ring as JSONL, which makes it a read
 * with an unbounded page: the one lever that can close a backlog faster than
 * `limit` messages per round trip. It is emphatically *not* a replay — a range
 * the ring already dropped is not in the snapshot, so this can recover a tail
 * and can never un-lose a gap.
 */
export interface ExportRecoveryStats {
  /** Whether export-assisted recovery is on at all; false means it never runs. */
  enabled: boolean;
  /**
   * Why the most recent gap did *not* trigger an export.
   *
   * `null` once an attempt has been made. A gap in a process with this on must
   * always be explained: an operator looking at an unresolved gap and no
   * `room_export_*` event needs to know whether the export was off, inside its
   * cooldown, or never reached.
   */
  skippedReason: 'disabled' | 'cooldown' | 'not_attempted' | null;
  /** Attempts made this process. */
  attempts: number;
  /** Attempts that returned a usable snapshot. */
  succeeded: number;
  /** Attempts that failed (transport, non-200, refused generation). */
  failed: number;
  /** Attempts refused because the snapshot's generation was not ours. */
  generationMismatch: number;
  lastAttemptAt: string | null;
  lastError: string | null;
  /** When the most recent attempt succeeded, if any. */
  lastSuccessAt: string | null;
  /** Messages the last successful snapshot produced across every attempt. */
  recoveredMessages: number;
  /** JSONL records the last attempt could not parse. */
  malformedRecords: number;
  /** The last snapshot hit the caller's byte ceiling and was cut. */
  lastTruncated: boolean;
  lastGeneration: number | null;
  lastLines: number;
  /** The minimum interval between export attempts, in milliseconds. */
  cooldownMs: number;
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
  /**
   * Rooms the arithmetic has given up on.
   *
   * A room lands here when its producer outran what reached SQLite across two
   * whole windows, when its catch-up outstayed its bound while still losing
   * ground, or when the retained ring rolled past its cursor twice. It is a
   * statement about capacity, not about effort: the reader keeps reading.
   */
  unattainableRooms: string[];
  /** `normal` | `catching_up` | `unattainable` | `fully_caught_up`. */
  catchupState: 'normal' | 'catching_up' | 'unattainable' | 'fully_caught_up';
  /** Times a room resumed contiguous reading after a recorded gap. */
  contiguousResumeCount: number;
  /** Times a room passed the full caught-up test after a recorded gap. */
  gapRecoveryCount: number;
  lastGapRecoveredAt: string | null;
  /** Summed over the fixed rooms, messages/minute. */
  estimatedProducerRate: number;
  /** What we actually stored, summed over the fixed rooms. The consumer rate. */
  estimatedPersistedRate: number;
  /**
   * How far the cursor numbers moved, summed over the fixed rooms.
   *
   * Reported next to the persisted rate on purpose: when the two diverge, the
   * cursor is stepping over messages nobody stored, which is precisely the
   * failure that a cursor-only metric hides.
   */
  estimatedCursorAdvanceRate: number;
  /** `estimatedProducerRate - estimatedPersistedRate`. */
  estimatedBacklogRate: number;
  /** Messages the ring dropped unread, summed over the fixed rooms, per minute. */
  estimatedLostGapRate: number;
  // ---- the same figures under the names an operator is told to look for ----
  //
  // The `estimated*` names above are the ones the report and the tests use; the
  // names below are the contract in the runbook. They are the same numbers, and
  // they exist so that a field named in the runbook is *present* in `/status`
  // rather than the operator having to know its alias. A missing field reads as
  // zero to a monitoring script, which is the failure this whole section is
  // about, so the aliases are emitted explicitly.
  /** Alias of `estimatedProducerRate`: the rooms' own growth, messages/minute. */
  producerRate: number;
  /**
   * The consumer figure: messages/minute that actually reached SQLite.
   *
   * Deliberately the *persisted* rate and never the cursor-advance rate. When a
   * room is gapping, the cursor steps over messages nobody stored; using it as
   * consumption is what made a losing reader look like a keeping-up one. The
   * cursor figure is still reported, under `cursorAdvancePerMinute`, as a
   * diagnostic.
   */
  consumerRate: number;
  /** Alias of `consumerRate`, under the name the two-window rule is written with. */
  persistedConsumerRate: number;
  /** Alias of `estimatedBacklogRate`: `producerRate - persistedConsumerRate`. */
  netBacklogRate: number;
  /** Messages the ring dropped unread, per minute; alias of `estimatedLostGapRate`. */
  lostGapRate: number;
  /** Messages the service returned, per minute; alias of `returnedPerMinute`. */
  messagesPerMinute: number;
  /** Messages written to SQLite, per minute; alias of `persistedConsumerRate`. */
  persistedMessagesPerMinute: number;
  /** How far the cursor numbers moved, per minute. A protocol metric only. */
  cursorAdvancePerMinute: number;
  /** Alias of `cursorAdvancePerMinute`, spelling out that it is the seq delta. */
  cursorSequenceAdvancePerMinute: number;
  /** Messages the ring dropped unread, per minute; alias of `lostGapRate`. */
  gapMessagesPerMinute: number;
  /** Reads that moved a cursor forward, i.e. that actually made progress. */
  cursorAdvances: number;
  readsPerMinute: number;
  /** Messages the service returned, per minute. Not consumption. */
  returnedPerMinute: number;
  cursorAdvancesPerMinute: number;
  /** Running totals across the fixed rooms, for the life of the process. */
  returnedMessages: number;
  persistedMessages: number;
  duplicateMessages: number;
  rejectedMessages: number;
  signedMessages: number;
  invalidSignatureMessages: number;
  cursorSequenceAdvance: number;
  gapMessages: number;
  /** The service's own pacing signals. */
  budgetRemaining: number | null;
  budgetLimit: number | null;
  throttledReads: number;
  timeoutReads: number;
  waitNotHeld: number;
  lastRetryAfterSeconds: number | null;
  /** Export-assisted recovery: what it tried and what it achieved. */
  exportRecovery: ExportRecoveryStats;
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
  /** The retained ring's oldest seq per room, from the last read. */
  lastRingFirstSeqByRoom: Record<string, number | null>;
  /** The retained ring's newest seq per room, from the last read. */
  lastRingLastSeqByRoom: Record<string, number | null>;
  /** `lastRingLastSeqByRoom - lastCursorByRoom`, per room; null if unknown. */
  cursorLagByRoom: Record<string, number | null>;
  lastGapFromByRoom: Record<string, number | null>;
  lastGapToByRoom: Record<string, number | null>;
  modeByRoom: Record<string, RoomMode>;
  /**
   * The fewest clean short reads any fixed room has behind it.
   *
   * The reader-level view of a per-room fact: the caught-up test needs two clean
   * cycles *per room*, so the minimum is the honest reader-wide figure. Reporting
   * a sum, or the best room's count, would let one busy room hide behind five
   * quiet ones.
   */
  consecutiveShortPages: number;
  /**
   * The effective reader configuration, non-secret and as resolved.
   *
   * The startup log carries the same block; it is repeated in `/status` so a
   * running process can be asked what it is actually doing without reading its
   * journal.
   */
  effectiveConfig: EffectiveReaderConfig;
  /**
   * A read-only probe of the live service contract.
   *
   * Never a write, and never anything that advances a cursor: it is a `limit`
   * probe plus a look at the response's own headers. `null` until it has run.
   */
  serverContract: ServerContractProbe | null;
  /** The reader metric contract this payload conforms to. */
  readerMetricsVersion: number;
  /** The `/status` document contract this payload belongs to. */
  statusSchemaVersion: number;
  /** Fixed rooms the reader owns, in read order; `modeByRoom` is keyed by these. */
  rooms: RoomThroughput[];
}

/**
 * The reader configuration as it was actually resolved, for the startup log and
 * `/status`.
 *
 * Every value here is a decision the code made (a clamp, a default, a fallback),
 * not an environment variable echoed back: `EXPORT_RECOVERY_MAX_BYTES=2` becomes
 * `1024` because that is the floor the code enforces. A value is never included
 * because it is configured — only because it is what the process will use.
 *
 * Nothing here is a secret. There is no key, no seed, no token and no URL with
 * credentials in it, and there must never be.
 */
export interface EffectiveReaderConfig {
  exportRecoveryEnabled: boolean;
  exportMaxBytes: number;
  exportTimeoutMs: number;
  exportCooldownMs: number;
  close1GapPolicy: string;
  close1Room: string;
  serverLimit: number;
  readLimit: number;
  close1ReadLimit: number;
  close1CatchupLimit: number;
  readConcurrency: number;
  maxInflight: number;
  waitSeconds: number;
  retryDelayMs: number;
  catchupMaxRequestsPerSecond: number;
  catchupMaxSeconds: number;
  fairnessMaxSilenceMs: number;
}

/**
 * What a read-only probe of the live service contract found.
 *
 * The probe exists because the contract is the one thing the reader cannot infer
 * from its own success: a `limit` the service clamps rather than refuses, a
 * `wait_held` it never sets, a generation header it omits — each is invisible in
 * a cursor that keeps advancing. It sends no write, moves no cursor, and records
 * only the response's own metadata.
 */
export interface ServerContractProbe {
  room: string;
  at: string;
  status: number;
  /** The `limit` the probe asked for, which is the documented maximum. */
  requestedLimit: number;
  /** How many messages the response carried, which is not the limit. */
  returnedCount: number;
  /** The service's own `last_seq`, present even on an empty page. */
  lastSeq: number | null;
  firstSeq: number | null;
  /** The `wait_held` verdict, when the probe's read volunteered one. */
  waitHeld: boolean | null;
  /** The response content type, which distinguishes JSON from the text fallback. */
  contentType: string;
  /** Whether an `x-room-generation` header was present at all. */
  generationHeader: boolean;
  /** Whether the probe's own export HEAD-style check saw a generation. */
  exportGeneration: number | null;
  /** A bounded, non-secret description of any failure. */
  error: string | null;
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
  /** Messages the service returned in this window. */
  windowReturned: number;
  /** Messages actually written to SQLite in this window. */
  windowPersisted: number;
  windowSaturated: number;
  /** Request durations in this window, for the average and the p95. */
  windowDurations: number[];
  /** The retained ring's `last_seq` when this window opened. */
  windowLastSeqStart: number | null;
  windowFirstSeqStart: number | null;
  windowCursorStart: number | null;
  windowGapStart: number | null;
  // ---- what the last sealed window produced ----
  /** The ring's own growth, messages/minute. Not our throughput. */
  producerRate: number;
  /** What reached SQLite, messages/minute. This, and only this, is consumption. */
  persistedRate: number;
  /** How far the cursor number moved, messages/minute. A protocol metric only. */
  cursorAdvanceRate: number;
  /** Messages the ring dropped unread, per minute. */
  lostGapRate: number;
  /** `producerRate - persistedRate`. Positive means we are losing ground. */
  netPersistBacklogRate: number;
  readsPerMinute: number;
  returnedPerMinute: number;
  saturatedPagesPerMinute: number;
  avgRequestDurationMs: number;
  p95RequestDurationMs: number;
  /** Consecutive sealed windows whose `netPersistBacklogRate` was positive. */
  positiveBacklogWindows: number;
  // ---- running totals for the life of the process ----
  returnedMessages: number;
  persistedMessages: number;
  duplicateMessages: number;
  rejectedMessages: number;
  signedMessages: number;
  invalidSignatureMessages: number;
  cursorSequenceAdvance: number;
  gapMessages: number;
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
  /** The long-poll hold the last read asked for, in seconds. */
  lastWaitSeconds: number;
  lastReadAtMs: number | null;
  lastSuccessAt: string | null;
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
  /** How many times the retained ring has rolled past our cursor. */
  ringPasses: number;
}

const RATE_WINDOW_SECONDS = 60;
const RATE_WINDOW_MS = RATE_WINDOW_SECONDS * 1_000;
/** How often the continuous loop recomputes cursor health, in milliseconds. */
const HEALTH_INTERVAL_MS = 1_000;

/**
 * The version of the reader's metric contract.
 *
 * Bump this whenever a field of `ReaderThroughputStats` is added, renamed or
 * changes meaning. It travels in `/status.reader`, so an operator looking at a
 * deployed process can tell *which* contract they are reading — and a field that
 * a build does not emit is then visibly absent rather than silently zero.
 */
export const READER_METRICS_VERSION = 2;

/**
 * The version of the whole `/status` document.
 *
 * Bump this when the shape of the status payload changes anywhere, not just in
 * the reader block. Together with the build commit it is how a stale deployment
 * is recognised from the outside: a process reporting an older schema version
 * than the source is a process running an older bundle.
 */
export const STATUS_SCHEMA_VERSION = 2;
/** How many completed windows in a row must show a widening backlog. */
const UNATTAINABLE_WINDOWS = 2;
/** The longest a failed read may park a room, in milliseconds. */
const MAX_BACKOFF_MS = 60_000;
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

/**
 * Parse the export's JSONL, one record at a time.
 *
 * A malformed line is counted and skipped, never fatal: the export is a snapshot
 * of a room anyone can write to, so refusing the whole batch over one bad record
 * would turn a stranger's typo into our outage. The cap is a ceiling on how much
 * of a large snapshot is even looked at, and hitting it is reported rather than
 * silently absorbing the cost.
 */
export function parseExportJsonl(
  jsonl: string,
  room: string,
  maxLines: number,
): { messages: RoomMessage[]; malformed: number; cappedLines: number } {
  const messages: RoomMessage[] = [];
  let malformed = 0;
  let cappedLines = 0;
  let seen = 0;
  for (const line of jsonl.split('\n')) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    seen += 1;
    if (seen > maxLines) {
      cappedLines += 1;
      continue;
    }
    try {
      const parsed = RoomMessageSchema.safeParse(JSON.parse(trimmed));
      if (!parsed.success) {
        malformed += 1;
        continue;
      }
      messages.push({ ...parsed.data, room } as RoomMessage);
    } catch {
      malformed += 1;
    }
  }
  // A snapshot's records are in ring order, but nothing guarantees it; the caller
  // only ever walks a strictly increasing, contiguous run.
  messages.sort((a, b) => a.seq - b.seq);
  return { messages, malformed, cappedLines };
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
  private readonly exportRecoveryEnabled: boolean;
  private readonly exportMaxBytes: number;
  private readonly exportMaxLines: number;
  private readonly exportTimeoutMs: number;
  private readonly exportCooldownMs: number;
  private readonly gapPolicy: string;
  private readonly tradingRoom: string;
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
  /** What export-assisted recovery has tried and what it achieved. */
  private readonly exportStats: ExportRecoveryStats = {
    enabled: false,
    skippedReason: null,
    attempts: 0,
    succeeded: 0,
    failed: 0,
    generationMismatch: 0,
    lastAttemptAt: null,
    lastError: null,
    lastSuccessAt: null,
    recoveredMessages: 0,
    malformedRecords: 0,
    lastTruncated: false,
    lastGeneration: null,
    lastLines: 0,
    cooldownMs: 0,
  };
  /** The last export attempt per room, for the cooldown. */
  private readonly lastExportAttemptMs = new Map<string, number>();
  /** The most recent read-only contract probe, or null before it has run. */
  private serverContractProbe: ServerContractProbe | null = null;

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
    this.exportRecoveryEnabled = options.exportRecovery === true;
    this.exportMaxBytes = Math.max(1_024, options.exportMaxBytes ?? 12 * 1_024 * 1_024);
    this.exportMaxLines = Math.max(1, options.exportMaxLines ?? 200_000);
    this.exportTimeoutMs = Math.max(1_000, options.exportTimeoutMs ?? 20_000);
    this.exportCooldownMs = Math.max(0, options.exportCooldownMs ?? 60_000);
    this.gapPolicy = options.close1GapPolicy ?? 'block';
    this.tradingRoom = options.tradingRoom ?? 'close1';
    // The stats literal is created before the constructor runs, so the two
    // resolved values it carries are stamped here, once, rather than left at
    // their placeholders.
    this.exportStats.enabled = this.exportRecoveryEnabled;
    this.exportStats.cooldownMs = this.exportCooldownMs;
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

  /**
   * The reader configuration as it was actually resolved.
   *
   * Reported rather than config-derived on purpose: every value here has been
   * through the same clamp the reader applies, so `EXPORT_RECOVERY_MAX_BYTES=2`
   * shows as `1024`, and a limit above the service's own maximum shows as the
   * maximum. It is what the process will use, not what an operator typed.
   */
  effectiveConfig(): EffectiveReaderConfig {
    const close1 = this.limitsByRoom.get(this.tradingRoom);
    return {
      exportRecoveryEnabled: this.exportRecoveryEnabled,
      exportMaxBytes: this.exportMaxBytes,
      exportTimeoutMs: this.exportTimeoutMs,
      exportCooldownMs: this.exportCooldownMs,
      close1GapPolicy: this.gapPolicy,
      close1Room: this.tradingRoom,
      serverLimit: this.serverLimit,
      readLimit: this.limit,
      close1ReadLimit: close1?.limit ?? this.limit,
      close1CatchupLimit: close1?.catchingUpLimit ?? this.catchingUpLimit,
      readConcurrency: this.semaphore.limit,
      maxInflight: this.client.stats().maxInflight,
      waitSeconds: this.waitSeconds,
      retryDelayMs: this.retryDelayMs,
      catchupMaxRequestsPerSecond: this.catchingUpMaxRequestsPerSecond,
      catchupMaxSeconds: this.catchingUpMaxSeconds,
      fairnessMaxSilenceMs: this.fairnessMaxSilenceMs,
    };
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
    // The effective configuration, in the log, at the moment it starts mattering.
    // Every field is a resolved value and none of them is a secret: an operator
    // reading this can tell whether export recovery is on, which limits are in
    // force, and which gap policy governs `close1`, without opening the unit
    // file or the source.
    this.logger.event({
      level: 'info',
      source: 'room-reader',
      code: 'reader_effective_config',
      message:
        `effective reader config: export recovery ` +
        `${this.exportRecoveryEnabled ? `on (cooldown ${this.exportCooldownMs}ms)` : 'off'}, ` +
        `limits ${this.limit} (close1 ${this.limitsByRoom.get(this.tradingRoom)?.limit ?? this.limit}` +
        `/${this.limitsByRoom.get(this.tradingRoom)?.catchingUpLimit ?? this.catchingUpLimit}) of ${this.serverLimit}, ` +
        `close1 gap policy ${this.gapPolicy}`,
      data: { ...this.effectiveConfig() },
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
   * Only a failure waits, and then only a bounded, escalating delay: a 429 that
   * says "wait 3s" is honoured, an unexplained failure backs off exponentially,
   * and the delay is capped so a room can never be parked forever.
   */
  private async roomLoop(room: string, signal: AbortSignal): Promise<void> {
    let consecutiveFailures = 0;
    while (!signal.aborted) {
      // A room in catch-up reads back to back, but its own request rate is
      // capped: without the cap one saturated room would spend the whole
      // `MAX_INFLIGHT` budget and the five referee rooms would starve, which is
      // the fairness failure this reader exists to prevent. The cap is on the
      // room, not on the reader, so the referee rooms stay unthrottled.
      const stats = this.statsFor(room);
      if (this.isBehind(stats) && this.catchingUpMaxRequestsPerSecond > 0) {
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
        // A long poll the service declined to hold is not an error, but it did
        // return immediately: re-reading at once would just spin. Sleep about the
        // wait we asked for instead — the contract's own advice.
        if (error === undefined && result.waitHeld === false && this.waitSeconds > 0) {
          await this.pause(this.waitSeconds * 1_000, signal);
          if (signal.aborted) return;
        }
      } catch (caught) {
        error = caught instanceof Error ? caught.message : String(caught);
      }

      if (signal.aborted) return; // stopping: this read is neither success nor failure

      if (error === undefined) {
        consecutiveFailures = 0;
        this.throughput.completedReads += 1;
      } else {
        consecutiveFailures += 1;
        this.throughput.failedReads += 1;
        this.throughput.lastError = error;
        this.throughput.lastErrorAt = this.now().toISOString();
        await this.pause(this.backoffMs(consecutiveFailures), signal);
      }
    }
  }

  /**
   * How long to wait after a failed read.
   *
   * Bounded in both directions: it escalates with the failure streak so a room
   * the service is throttling is not hammered, and it is capped so a room can
   * never be parked indefinitely. A `retry-after` the service volunteered wins
   * over the streak, because it is the authority on our own budget.
   */
  private backoffMs(consecutiveFailures: number): number {
    const retryAfter = this.client.pacing().retryAfterSeconds;
    if (retryAfter !== null && retryAfter > 0) {
      return Math.min(MAX_BACKOFF_MS, Math.max(this.retryDelayMs, retryAfter * 1_000));
    }
    const exponential = this.retryDelayMs * 2 ** Math.min(6, consecutiveFailures - 1);
    return Math.min(MAX_BACKOFF_MS, Math.max(this.retryDelayMs, exponential));
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
    // `cursor_health` is a statement about the cursor *now*, so it has to be able
    // to leave conservative mode as well as enter it. Without this the flag is a
    // one-way latch: a gap that happened once, was provably resumed past, and is
    // now only a line in the audit would hold every upstream gate back forever.
    // Only this one reason is touched — a bad signature, a wrong referee DID or a
    // package that drifted are current facts and are never cleared here.
    if (!health.healthy) {
      this.verifier.enterConservative('cursor_health', health.reasons.join('; '));
    } else {
      this.verifier.clearConservative('cursor_health');
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
    let waitHeld: boolean | null = null;
    const nothing: CommitResult = {
      returned: 0,
      inserted: 0,
      duplicates: 0,
      signed: 0,
      invalidSignature: 0,
      rejected: 0,
    };

    stats.lastRequestStartedAtMs = this.now().getTime();
    const startedAt = Date.now();
    // Catch-up must never hold. The long poll is what paces a reader that is
    // keeping up; a reader that is behind is paced by the queue in front of it,
    // so asking the service to wait would only add latency to a room that has
    // real work queued. A room we have never read holds no cursor either, so its
    // first read returns immediately too.
    const waitUsed = this.isBehind(stats) ? 0 : previous.cursor > 0 ? this.waitSeconds : 0;
    try {
      const result = await this.client.readRoom(room, {
        // Always a cursor. `since=0` means "everything retained"; a bare fetch is
        // the documented shape that "often returns cached bytes".
        since: previous.cursor,
        limit: limitUsed,
        waitSeconds: waitUsed,
        ...(signal === undefined ? {} : { signal }),
      });
      durationMs = Date.now() - startedAt;
      read = result.read.messages;
      degraded = result.degraded;
      waitHeld = result.waitHeld;
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
          commit: nothing,
          waitHeld: null,
        };
      }
      error = String(caught);
      this.cursorStore.recordError(room, error, this.now().toISOString());
      this.logReadFailure(room, error);
    }

    let commit: CommitResult = nothing;
    if (error === undefined) {
      commit = this.cursorStore.commit(room, read, advance, this.now().toISOString());
      if (advance.reason === 'gap') stats.ringPasses += 1;
    }

    // Read the cursor back after the commit: `gap_resolved_at` is decided inside
    // that transaction, and it is the durable answer to "is this room's gap
    // still open".
    if (error === undefined) {
      // Export-assisted recovery, after the ordinary read. It is a *throughput*
      // lever: it can pull a retained backlog in one round trip, and it can never
      // bring back a range the ring already dropped — which is why it runs after
      // the gap is recorded and never in place of recording it.
      //
      // Every gap leaves an explanation in `exportRecovery.skippedReason`. A gap
      // that repeats on each poll is one fact, not a stream of them, so the
      // cooldown is what keeps a permanently-gapping room from exporting on every
      // read; and an operator seeing an open gap with no `room_export_*` event
      // must be able to tell "off" from "cooling down".
      if (advance.reason === 'gap') {
        if (!this.exportRecoveryEnabled) {
          this.exportStats.skippedReason = 'disabled';
        } else if (this.exportCoolingDown(room)) {
          this.exportStats.skippedReason = 'cooldown';
        } else {
          this.exportStats.skippedReason = null;
          const recovered = await this.recoverFromExport(room, advance, signal);
          if (recovered > 0) commit = { ...commit, inserted: commit.inserted + recovered };
        }
      }
    }
    const cursor = this.cursorStore.load(room);
    if (error === undefined) {
      this.noteRead(room, stats, {
        returnedCount: read.length,
        pageFirstSeq: read[0]?.seq ?? null,
        pageLastSeq: read[read.length - 1]?.seq ?? null,
        ringFirstSeq: advance.firstSeq,
        ringLastSeq: advance.lastSeq,
        cursor,
        commit,
        limitUsed,
        waitSeconds: waitUsed,
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
            netPersistBacklogRate: stats.netPersistBacklogRate,
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
        inserted: commit.inserted,
        cursor,
        advanceReason: advance.reason,
        degraded,
        ...(error === undefined ? {} : { error }),
      },
      inserted: commit.inserted,
      observations,
      localMessages,
      commit,
      waitHeld,
      ...(error === undefined ? {} : { error }),
    };
  }

  /** Whether a room is behind, which is what turns the long poll off. */
  private isBehind(stats: RoomStats): boolean {
    return stats.mode === 'catching_up' || stats.mode === 'unattainable';
  }

  /**
   * Record a failed read, with the request metadata and never the body.
   *
   * The query is the only thing worth logging about a failed read: it carries the
   * cursor and the cache-buster, so a repeated URL — the one shape that can be
   * answered from a stale cache — is visible in the log. The messages are not
   * logged, ever.
   */
  private logReadFailure(room: string, error: string): void {
    const pacing = this.client.pacing();
    this.logger.event({
      level: 'warn',
      source: 'room-reader',
      code: 'reader_read_failed',
      message: `${room} read failed: ${error}`,
      data: {
        room,
        retryAfterSeconds: pacing.retryAfterSeconds,
        budgetRemaining: pacing.budget?.remaining ?? null,
        budgetLimit: pacing.budget?.limit ?? null,
        requests: pacing.requests,
      },
    });
  }

  /** Whether this room's export cooldown is still running. */
  private exportCoolingDown(room: string): boolean {
    const last = this.lastExportAttemptMs.get(room);
    if (last === undefined) return false;
    return this.now().getTime() - last < this.exportCooldownMs;
  }

  /**
   * Pull the retained ring in one request and store whatever extends our cursor.
   *
   * This is not a replay. The export is a *snapshot of what is retained right
   * now*: a range the ring already dropped is not in it, and no export can bring
   * it back. What it can do is close a backlog faster than `limit` messages per
   * round trip, which is the one lever the read endpoint does not offer.
   *
   * The rules it obeys, in order:
   *
   *   - the snapshot's generation must match the cursor's, or every seq in it is
   *     meaningless and it is refused;
   *   - records are parsed one at a time, and a malformed line is counted and
   *     skipped rather than failing the batch;
   *   - only messages that continue our cursor exactly are kept, so the cursor can
   *     never be advanced over a hole;
   *   - the messages and the cursor move in one transaction, through the same
   *     commit the ordinary read uses;
   *   - it never touches the gap: the gap is a fact about what the ring dropped,
   *     and a snapshot cannot un-drop it. The gap is cleared only if the message
   *     repository proves the whole recorded range is present after all.
   */
  private async recoverFromExport(
    room: string,
    advance: CursorAdvance,
    signal?: AbortSignal,
  ): Promise<number> {
    const stats = this.exportStats;
    stats.attempts += 1;
    stats.lastAttemptAt = this.now().toISOString();
    this.lastExportAttemptMs.set(room, this.now().getTime());
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error('export timeout')), this.exportTimeoutMs);
    const onAbort = () => controller.abort();
    signal?.addEventListener('abort', onAbort, { once: true });
    try {
      const result = await this.client.exportRoom(room, {
        maxBytes: this.exportMaxBytes,
        signal: controller.signal,
      });
      stats.lastGeneration = result.generation;
      stats.lastLines = result.lines;
      stats.lastTruncated = result.truncated;
      // Only a generation we actually hold can be contradicted. The service
      // announces a generation when a room is rebuilt and not otherwise, so a
      // cursor at generation 0 means "we have never seen this room rebuilt" —
      // there is nothing for the snapshot to disagree with, and `advanceCursor`
      // applies exactly the same rule to an ordinary read.
      const ourGeneration = this.cursorStore.load(room).generation;
      if (result.generation !== null && ourGeneration > 0 && result.generation !== ourGeneration) {
        stats.generationMismatch += 1;
        stats.failed += 1;
        stats.lastError =
          `export generation ${result.generation} does not match the cursor generation ${ourGeneration}`;
        this.logger.event({
          level: 'warn',
          source: 'room-reader',
          code: 'room_export_generation_mismatch',
          message:
            `${room} export was taken in generation ${result.generation} but our cursor is generation ` +
            `${ourGeneration}; refusing a snapshot of a different room`,
          data: { room, exportGeneration: result.generation, cursorGeneration: ourGeneration },
        });
        return 0;
      }

      const { messages, malformed } = parseExportJsonl(result.jsonl, room, this.exportMaxLines);
      stats.malformedRecords = malformed;
      const cursorNow = this.cursorStore.load(room);
      // Only a message that continues the cursor exactly may be kept, and only in
      // increasing seq order. Anything else is a hole, and a hole is not ours to
      // step over.
      const kept: RoomMessage[] = [];
      let expected = cursorNow.cursor + 1;
      for (const message of messages) {
        if (message.seq < expected) continue; // already stored, or behind us
        if (message.seq > expected) break; // a hole: stop at the last contiguous seq
        kept.push(message);
        expected += 1;
      }
      if (kept.length === 0) {
        stats.succeeded += 1;
        stats.lastSuccessAt = this.now().toISOString();
        return 0;
      }
      const exportAdvance: CursorAdvance = {
        cursor: kept[kept.length - 1]!.seq,
        // The snapshot's own epoch, when it stamped one: it is newer knowledge
        // than ours and was just checked against what we hold.
        generation: result.generation ?? advance.generation,
        firstSeq: messages[0]?.seq ?? null,
        lastSeq: advance.lastSeq,
        gap: advance.gap,
        roomReset: false,
        // A dedicated reason, so the ordinary path's "a contiguous read closed the
        // gap" rule cannot fire from an export: this is a snapshot, not a read.
        reason: 'export_recovery',
      };
      const committed = this.cursorStore.commit(room, kept, exportAdvance, this.now().toISOString());
      stats.succeeded += 1;
      stats.recoveredMessages += committed.inserted;
      stats.lastSuccessAt = this.now().toISOString();
      this.logger.event({
        level: 'info',
        source: 'room-reader',
        code: 'room_export_recovery',
        message:
          `${room} export recovered ${committed.inserted} retained message(s) from seq ` +
          `${kept[0]!.seq} to ${kept[kept.length - 1]!.seq}; the recorded gap is untouched`,
        data: {
          room,
          generation: result.generation,
          lines: result.lines,
          truncated: result.truncated,
          malformed,
          recovered: committed.inserted,
          duplicates: committed.duplicates,
          gapFrom: advance.missedFrom,
          gapTo: advance.missedTo,
        },
      });
      // The one thing that can clear a gap is data: proof that the whole recorded
      // range is present. A ring that dropped those messages can never supply it,
      // so in the ordinary case this stays false and the gap stays open.
      this.resolveGapIfProven(room);
      return committed.inserted;
    } catch (caught) {
      stats.failed += 1;
      stats.lastError = caught instanceof Error ? caught.message : String(caught);
      this.logger.event({
        level: 'warn',
        source: 'room-reader',
        code: 'room_export_failed',
        message: `${room} export-assisted recovery failed: ${stats.lastError}`,
        data: { room, attempts: stats.attempts, failed: stats.failed },
      });
      return 0;
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    }
  }

  /**
   * Clear a room's open gap only when the stored messages prove the whole range.
   *
   * The gap range is a fact we recorded; the only thing that closes it is finding
   * every seq in that range in our own store. Normally that is impossible — the
   * ring deleted them, which is what made it a gap — so this normally does
   * nothing, and the gap stays on the record exactly as the rules require.
   */
  private resolveGapIfProven(room: string): void {
    const cursor = this.cursorStore.load(room);
    if (cursor.gapCount === 0 || cursor.gapResolvedAt !== null) return;
    const from = cursor.lastGapFrom;
    const to = cursor.lastGapTo;
    if (from === null || to === null || to < from) return;
    const expected = to - from + 1;
    const present = this.repositories.messages.inRange(room, from, to, expected);
    if (present.length < expected) return;
    this.cursorStore.markGapResolved(room, this.now().toISOString());
    this.logger.event({
      level: 'info',
      source: 'room-reader',
      code: 'cursor_gap_resolved_by_evidence',
      message:
        `${room} gap ${from}..${to} was proven complete: all ${expected} message(s) are stored, ` +
        'so the range was never actually lost',
      data: { room, from, to, present: present.length },
    });
  }

  /** The per-room accounting record, created the first time a room is touched. */
  private statsFor(room: string): RoomStats {
    const existing = this.roomStats.get(room);
    if (existing !== undefined) return existing;
    const created: RoomStats = {
      room,
      mode: this.continuous ? 'normal' : 'stopped',
      windowStartedAtMs: this.continuousStartedAtMs || this.now().getTime(),
      windowReads: 0,
      windowReturned: 0,
      windowPersisted: 0,
      windowSaturated: 0,
      windowDurations: [],
      windowLastSeqStart: null,
      windowFirstSeqStart: null,
      windowCursorStart: null,
      windowGapStart: null,
      producerRate: 0,
      persistedRate: 0,
      cursorAdvanceRate: 0,
      lostGapRate: 0,
      netPersistBacklogRate: 0,
      readsPerMinute: 0,
      returnedPerMinute: 0,
      saturatedPagesPerMinute: 0,
      avgRequestDurationMs: 0,
      p95RequestDurationMs: 0,
      positiveBacklogWindows: 0,
      returnedMessages: 0,
      persistedMessages: 0,
      duplicateMessages: 0,
      rejectedMessages: 0,
      signedMessages: 0,
      invalidSignatureMessages: 0,
      cursorSequenceAdvance: 0,
      gapMessages: 0,
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
      lastWaitSeconds: 0,
      lastReadAtMs: null,
      lastSuccessAt: null,
      lastRequestStartedAtMs: 0,
      catchingUpSinceMs: null,
      pageSaturated: false,
      cursorLag: null,
      consecutiveShortPages: 0,
      contiguousResumeEmitted: false,
      fullyRecoveredEmitted: false,
      fairnessWarned: false,
      ringPasses: 0,
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
   * Which of the seven states a room is in.
   *
   * The order is the order of the claims, strongest first. `unattainable` is
   * not a worse page — it is arithmetic, and it outranks everything; a room
   * whose producer has outrun its persisted rate for two whole windows is not
   * "catching up" whatever the page in front of it looks like. `catching_up` is
   * decided next, because being behind is the fact that governs how the room is
   * read. `upstream_gap` follows: an open gap is the one state that no amount of
   * reading can close. Only then may `fully_caught_up` be claimed, and it is
   * claimed only by the full test below.
   */
  private resolveMode(stats: RoomStats, cursor: CursorRecord): RoomMode {
    if (!this.continuous) return 'stopped';
    if (this.isUnattainable(stats)) return 'unattainable';
    if (stats.pageSaturated) return 'catching_up';
    if (stats.netPersistBacklogRate > 0) return 'catching_up';
    if (stats.cursorLag !== null && stats.cursorLag > 0) return 'catching_up';
    if (cursor.gapCount > 0 && cursor.gapResolvedAt === null) return 'upstream_gap';
    if (this.meetsCaughtUpTest(stats, cursor)) return 'fully_caught_up';
    // A recorded gap that is no longer open, on a room that is not yet level: the
    // reader is reading contiguously again, and that is all this says.
    if (cursor.gapCount > 0) return 'contiguous_resume';
    return 'normal';
  }

  /**
   * Whether the arithmetic says we cannot win, whatever the page shows.
   *
   * Three independent ways to be unable to catch up, and no one of them alone is
   * enough: a producer that outran what reached SQLite across two whole sealed
   * windows; a catch-up that has outstayed its bound while still losing ground;
   * or a retained ring that has rolled past our cursor more than once, which is
   * the case where the history we are chasing keeps being deleted underneath us.
   */
  private isUnattainable(stats: RoomStats): boolean {
    if (
      stats.positiveBacklogWindows >= UNATTAINABLE_WINDOWS &&
      stats.producerRate > stats.persistedRate &&
      stats.netPersistBacklogRate > 0
    ) {
      return true;
    }
    if (
      this.catchingUpMaxSeconds > 0 &&
      stats.catchingUpSinceMs !== null &&
      this.now().getTime() - stats.catchingUpSinceMs > this.catchingUpMaxSeconds * 1_000 &&
      stats.positiveBacklogWindows >= 1
    ) {
      return true;
    }
    return stats.ringPasses >= 2;
  }

  /**
   * The full caught-up test — the only thing in this file allowed to say a room
   * is level.
   *
   * Each clause rules out a different way of being wrong. An open gap is still
   * open. A saturated page means there is more behind it. A widening backlog
   * means we are losing ground even if this page came back short. A cursor short
   * of the retained head means we are not level however small the page was. And
   * fewer than two clean cycles means the short page may simply be the lull
   * between two bursts.
   */
  private meetsCaughtUpTest(stats: RoomStats, cursor: CursorRecord): boolean {
    if (cursor.gapCount > 0 && cursor.gapResolvedAt === null) return false;
    if (stats.consecutiveShortPages < RECOVERY_CLEAN_READS) return false;
    // `null` means the room has never held a message at all, so there is no head
    // to be behind. A known head we are short of is the only disqualifying case.
    if (stats.cursorLag !== null && stats.cursorLag > 0) return false;
    if (stats.pageSaturated) return false;
    if (stats.netPersistBacklogRate > 0) return false;
    if (stats.positiveBacklogWindows > 0) return false;
    return true;
  }

  /**
   * Whether this read is the one that closes the room's latest gap.
   *
   * Strictly narrower than `meetsCaughtUpTest` on purpose: it additionally
   * requires a measured gap to exist and a contiguous read to have resumed past
   * it, because the event it gates claims that a *specific* loss was overcome.
   */
  private isFullyRecovered(stats: RoomStats, reason: string, cursor: CursorRecord): boolean {
    // A read that skipped nothing. `gap` and `room_reset` are the two that did.
    if (reason !== 'ok' && reason !== 'empty') return false;
    if (!stats.contiguousResumeEmitted) return false;
    if (cursor.gapCount === 0) return false;
    return this.meetsCaughtUpTest(stats, cursor);
  }

  /**
   * Record one successful read: the per-room window, the reader-wide rolling
   * rates, and the room's mode.
   *
   * Three figures are kept deliberately apart, because conflating them is how a
   * reader that is losing ground comes to look healthy:
   *
   *   - `producerRate` comes from the ring's own `last_seq`, which advances
   *     whether or not we read anything;
   *   - `persistedRate` counts rows that actually reached SQLite. This, and only
   *     this, is consumption — a re-read of a page already stored returns the
   *     same messages and persists none of them;
   *   - `cursorAdvanceRate` counts how far the cursor *number* moved. It is a
   *     protocol invariant worth watching and it is explicitly not work done: a
   *     cursor steps over a gap nobody stored.
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
      commit: CommitResult;
      limitUsed: number;
      waitSeconds: number;
      durationMs: number;
      reason: string;
    },
  ): void {
    const nowMs = this.now().getTime();
    const at = this.now().toISOString();
    this.throughput.lastSuccessAt = at;
    this.lastSuccessByRoom.set(room, at);
    this.throughput.messagesRead += input.returnedCount;

    const cursorStep = Math.max(0, input.cursor.cursor - stats.lastCursor);
    const gapStep = Math.max(0, input.cursor.gap - stats.lastCursorGap);
    // A cursor that moved is a cursor that made protocol progress. It is counted
    // as an advance and never as consumption.
    const advanced = input.cursor.cursor > stats.lastCursor;
    if (advanced) this.throughput.cursorAdvances += 1;

    // ---- per-room running totals -------------------------------------------
    stats.returnedMessages += input.commit.returned;
    stats.persistedMessages += input.commit.inserted;
    stats.duplicateMessages += input.commit.duplicates;
    stats.rejectedMessages += input.commit.rejected;
    stats.signedMessages += input.commit.signed;
    stats.invalidSignatureMessages += input.commit.invalidSignature;
    stats.cursorSequenceAdvance += cursorStep;
    stats.gapMessages += gapStep;

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
    stats.lastWaitSeconds = input.waitSeconds;
    stats.lastReadAtMs = nowMs;
    stats.lastSuccessAt = at;
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

    // ---- window accumulation ------------------------------------------------
    const windowIsNew = stats.windowLastSeqStart === null;
    if (windowIsNew) {
      stats.windowLastSeqStart = input.ringLastSeq;
      stats.windowFirstSeqStart = input.ringFirstSeq;
      stats.windowCursorStart = input.cursor.cursor;
      stats.windowGapStart = input.cursor.gap;
    }
    stats.windowReads += 1;
    stats.windowReturned += input.commit.returned;
    // Only what reached SQLite is consumption. A duplicate is returned, counted
    // as a duplicate, and contributes nothing here.
    stats.windowPersisted += input.commit.inserted;
    if (stats.pageSaturated) stats.windowSaturated += 1;
    stats.windowDurations.push(input.durationMs);

    this.throughput.pageSaturated = stats.pageSaturated;
    // The window is sealed before the mode is resolved, so the mode sees the
    // freshly published rate rather than the previous window's.
    this.sealWindowIfDue(stats);

    stats.mode = this.resolveMode(stats, input.cursor);
    // How long the room has been behind without a break, which is what turns
    // "catching up" into the honest `unattainable` once it outstays its bound.
    if (stats.mode === 'catching_up' || stats.mode === 'unattainable') {
      stats.catchingUpSinceMs ??= nowMs;
    } else {
      stats.catchingUpSinceMs = null;
    }

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
    // Unsigned: how much of a thing arrived. A negative delta is not a rate.
    const perMinute = (delta: number | null): number =>
      delta === null || delta <= 0 ? 0 : Math.round((delta / minutes) * 100) / 100;

    // The room's own growth, from the ring's head. It moves whether we read or not.
    stats.producerRate = perMinute(
      stats.windowLastSeqStart === null || stats.lastRingLastSeq === null
        ? null
        : stats.lastRingLastSeq - stats.windowLastSeqStart,
    );
    // What reached SQLite in this window. Not the cursor delta, which also counts
    // the ranges a gap stepped over.
    stats.persistedRate = perMinute(stats.windowPersisted);
    // How far the cursor number moved. Reported next to the persisted rate so the
    // two can be compared; when they diverge, the cursor is stepping over
    // messages nobody stored.
    stats.cursorAdvanceRate = perMinute(
      stats.windowCursorStart === null ? null : stats.lastCursor - stats.windowCursorStart,
    );
    stats.lostGapRate = perMinute(
      stats.windowGapStart === null ? null : stats.lastCursorGap - stats.windowGapStart,
    );
    stats.netPersistBacklogRate = Math.round((stats.producerRate - stats.persistedRate) * 100) / 100;
    stats.readsPerMinute = Math.round((stats.windowReads / minutes) * 100) / 100;
    stats.returnedPerMinute = Math.round((stats.windowReturned / minutes) * 100) / 100;
    stats.saturatedPagesPerMinute = Math.round((stats.windowSaturated / minutes) * 100) / 100;
    const durations = stats.windowDurations;
    stats.avgRequestDurationMs =
      durations.length === 0
        ? 0
        : Math.round(durations.reduce((sum, value) => sum + value, 0) / durations.length);
    stats.p95RequestDurationMs = percentile(durations, 0.95);

    stats.positiveBacklogWindows =
      stats.netPersistBacklogRate > 0 ? stats.positiveBacklogWindows + 1 : 0;

    // One line per sealed window for a room that is behind. Catch-up is the one
    // question the reader cannot answer by reading its own status quickly — the
    // rates only mean something once a whole window supports them — so the
    // direction is stated here, next to the inputs it was derived from. It is
    // never emitted for a room that is level: a quiet room has nothing to report
    // and a log line per room per minute would bury the one that matters.
    if (this.continuous && (stats.mode === 'catching_up' || stats.mode === 'unattainable')) {
      const growing = stats.netPersistBacklogRate > 0;
      this.logger.event({
        level: growing ? 'warn' : 'info',
        source: 'room-reader',
        code: 'reader_catchup_window',
        message:
          `${stats.room} ${stats.mode}: producer ${stats.producerRate}/min vs persisted ` +
          `${stats.persistedRate}/min (cursor-adv ${stats.cursorAdvanceRate}/min, lost-gap ` +
          `${stats.lostGapRate}/min) -> net ${growing ? 'INCREASING' : 'decreasing'} ` +
          `${stats.netPersistBacklogRate}/min over ${stats.positiveBacklogWindows} window(s); ` +
          `wait ${stats.lastWaitSeconds}s, limit ${stats.lastLimitUsed}, ` +
          `returned ${stats.lastReturnedCount}, saturated ${stats.pageSaturated}, ` +
          `cursor lag ${stats.cursorLag ?? 'unknown'}, exports ${this.exportRecoveryEnabled ? 'on' : 'off'}`,
        data: {
          room: stats.room,
          mode: stats.mode,
          producerRate: stats.producerRate,
          persistedRate: stats.persistedRate,
          cursorAdvanceRate: stats.cursorAdvanceRate,
          lostGapRate: stats.lostGapRate,
          netPersistBacklogRate: stats.netPersistBacklogRate,
          positiveBacklogWindows: stats.positiveBacklogWindows,
          waitSeconds: stats.lastWaitSeconds,
          lastLimitUsed: stats.lastLimitUsed,
          lastReturnedCount: stats.lastReturnedCount,
          pageSaturated: stats.pageSaturated,
          cursorLag: stats.cursorLag,
          exportRecoveryEnabled: this.exportRecoveryEnabled,
        },
      });
    }

    stats.windowStartedAtMs = nowMs;
    stats.windowReads = 0;
    stats.windowReturned = 0;
    stats.windowPersisted = 0;
    stats.windowSaturated = 0;
    stats.windowDurations = [];
    stats.windowLastSeqStart = stats.lastRingLastSeq;
    stats.windowFirstSeqStart = stats.lastRingFirstSeq;
    stats.windowCursorStart = stats.lastCursor;
    stats.windowGapStart = stats.lastCursorGap;
  }

  private rates(): {
    readsPerMinute: number;
    returnedPerMinute: number;
    cursorAdvancesPerMinute: number;
  } {
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
    return { readsPerMinute: reads, returnedPerMinute: messages, cursorAdvancesPerMinute: advances };
  }

  /** One room's sealed-window view, for `throughputStats()`. */
  private roomThroughput(room: string): RoomThroughput {
    const stats = this.statsFor(room);
    this.sealWindowIfDue(stats);
    // A window can seal between two reads, which changes the rates without a
    // `noteRead` to re-derive the mode. Recomputing it here is what keeps the
    // reported mode and the reported rates describing the same moment — otherwise
    // the report shows last window's state next to this window's figures.
    if (this.continuous) stats.mode = this.resolveMode(stats, this.cursorStore.load(room));
    const nowMs = this.now().getTime();
    const baseline = stats.lastReadAtMs ?? (this.continuousStartedAtMs || stats.windowStartedAtMs);
    const silenceMs = Math.max(0, nowMs - baseline);
    return {
      room,
      mode: this.continuous ? stats.mode : 'stopped',
      producerRate: stats.producerRate,
      persistedRate: stats.persistedRate,
      cursorAdvanceRate: stats.cursorAdvanceRate,
      lostGapRate: stats.lostGapRate,
      netPersistBacklogRate: stats.netPersistBacklogRate,
      readsPerMinute: stats.readsPerMinute,
      returnedPerMinute: stats.returnedPerMinute,
      saturatedPagesPerMinute: stats.saturatedPagesPerMinute,
      avgRequestDurationMs: stats.avgRequestDurationMs,
      p95RequestDurationMs: stats.p95RequestDurationMs,
      pageSaturated: stats.pageSaturated,
      cursorLag: stats.cursorLag,
      waitSeconds: stats.lastWaitSeconds,
      lastLimitUsed: stats.lastLimitUsed,
      lastReturnedCount: stats.lastReturnedCount,
      lastRingFirstSeq: stats.lastRingFirstSeq,
      lastRingLastSeq: stats.lastRingLastSeq,
      consecutiveShortPages: stats.consecutiveShortPages,
      positiveBacklogWindows: stats.positiveBacklogWindows,
      silenceMs,
      catchingUpForMs: stats.catchingUpSinceMs === null ? 0 : Math.max(0, nowMs - stats.catchingUpSinceMs),
      lastRequestStartedAt: stats.lastRequestStartedAtMs > 0 ? stats.lastRequestStartedAtMs : null,
      lastSuccessAt: stats.lastSuccessAt,
      fairnessBudgetMs: this.fairnessMaxSilenceMs,
      // The warning is a statement about the present: a room inside its bound is
      // not warned, whatever it was a minute ago.
      fairnessWarning: this.fairnessMaxSilenceMs > 0 && silenceMs > this.fairnessMaxSilenceMs,
      returnedMessages: stats.returnedMessages,
      persistedMessages: stats.persistedMessages,
      duplicateMessages: stats.duplicateMessages,
      rejectedMessages: stats.rejectedMessages,
      signedMessages: stats.signedMessages,
      invalidSignatureMessages: stats.invalidSignatureMessages,
      cursorSequenceAdvance: stats.cursorSequenceAdvance,
      gapMessages: stats.gapMessages,
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
    const estimatedPersistedRate = round2(rooms.reduce((sum, row) => sum + row.persistedRate, 0));
    const estimatedCursorAdvanceRate = round2(
      rooms.reduce((sum, row) => sum + row.cursorAdvanceRate, 0),
    );
    const estimatedLostGapRate = round2(rooms.reduce((sum, row) => sum + row.lostGapRate, 0));
    const netBacklogIncreasing = rooms.some(
      (row) => row.positiveBacklogWindows >= UNATTAINABLE_WINDOWS,
    );
    const unattainableRooms = rooms.filter((row) => row.mode === 'unattainable').map((row) => row.room);
    const clientStats = this.client.stats();
    const pacing = this.client.pacing();
    const readerTotals = rooms.reduce(
      (sum, row) => ({
        returned: sum.returned + row.returnedMessages,
        persisted: sum.persisted + row.persistedMessages,
        duplicates: sum.duplicates + row.duplicateMessages,
        rejected: sum.rejected + row.rejectedMessages,
        signed: sum.signed + row.signedMessages,
        invalidSignature: sum.invalidSignature + row.invalidSignatureMessages,
        cursorSequenceAdvance: sum.cursorSequenceAdvance + row.cursorSequenceAdvance,
        gap: sum.gap + row.gapMessages,
      }),
      {
        returned: 0,
        persisted: 0,
        duplicates: 0,
        rejected: 0,
        signed: 0,
        invalidSignature: 0,
        cursorSequenceAdvance: 0,
        gap: 0,
      },
    );

    const lastReturnedCountByRoom: Record<string, number> = {};
    const lastReturnedFirstSeqByRoom: Record<string, number | null> = {};
    const lastReturnedLastSeqByRoom: Record<string, number | null> = {};
    const lastCursorByRoom: Record<string, number> = {};
    const lastRingFirstSeqByRoom: Record<string, number | null> = {};
    const lastRingLastSeqByRoom: Record<string, number | null> = {};
    const cursorLagByRoom: Record<string, number | null> = {};
    const lastGapFromByRoom: Record<string, number | null> = {};
    const lastGapToByRoom: Record<string, number | null> = {};
    const modeByRoom: Record<string, RoomMode> = {};
    for (const row of rooms) {
      const stats = this.statsFor(row.room);
      lastReturnedCountByRoom[row.room] = stats.lastReturnedCount;
      lastReturnedFirstSeqByRoom[row.room] = stats.lastReturnedFirstSeq;
      lastReturnedLastSeqByRoom[row.room] = stats.lastReturnedLastSeq;
      lastRingFirstSeqByRoom[row.room] = stats.lastRingFirstSeq;
      lastRingLastSeqByRoom[row.room] = stats.lastRingLastSeq;
      lastGapFromByRoom[row.room] = stats.lastGapFrom;
      lastGapToByRoom[row.room] = stats.lastGapTo;
      modeByRoom[row.room] = row.mode;
    }
    // The reader-level clean-read count is the *worst* room's: the caught-up test
    // is per room, so a single room with fewer clean cycles is the honest bound.
    const consecutiveShortPages =
      rooms.length === 0 ? 0 : Math.min(...rooms.map((row) => row.consecutiveShortPages));
    // The durable cursor wins over the read-time copy: it is what is actually
    // stored, and it is still right for a room whose last read failed.
    for (const cursor of cursors) lastCursorByRoom[cursor.room] = cursor.cursor;
    // The lag is the ring's head minus the cursor, per room. Derived from the
    // durable cursor and the last observed head rather than copied from the read,
    // so it stays meaningful for a room whose last read failed.
    for (const row of rooms) {
      const head = lastRingLastSeqByRoom[row.room] ?? null;
      const cursor = lastCursorByRoom[row.room];
      cursorLagByRoom[row.room] = head === null || cursor === undefined ? null : head - cursor;
    }

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
      catchupState: this.catchupState(rooms, unattainableRooms.length > 0),
      unattainableRooms,
      contiguousResumeCount: this.throughput.contiguousResumeCount,
      gapRecoveryCount: this.throughput.gapRecoveryCount,
      lastGapRecoveredAt: this.throughput.lastGapRecoveredAt,
      estimatedProducerRate,
      estimatedPersistedRate,
      estimatedCursorAdvanceRate,
      estimatedBacklogRate: round2(estimatedProducerRate - estimatedPersistedRate),
      estimatedLostGapRate,
      // The runbook names, as the same figures. `consumerRate` is the persisted
      // rate and never the cursor-advance rate: the cursor steps over gaps, and a
      // consumption figure that counted them would report a losing reader as a
      // keeping-up one.
      producerRate: estimatedProducerRate,
      consumerRate: estimatedPersistedRate,
      persistedConsumerRate: estimatedPersistedRate,
      netBacklogRate: round2(estimatedProducerRate - estimatedPersistedRate),
      lostGapRate: estimatedLostGapRate,
      messagesPerMinute: rates.returnedPerMinute,
      persistedMessagesPerMinute: estimatedPersistedRate,
      cursorAdvancePerMinute: estimatedCursorAdvanceRate,
      cursorSequenceAdvancePerMinute: estimatedCursorAdvanceRate,
      gapMessagesPerMinute: estimatedLostGapRate,
      cursorAdvances: this.throughput.cursorAdvances,
      readsPerMinute: rates.readsPerMinute,
      returnedPerMinute: rates.returnedPerMinute,
      cursorAdvancesPerMinute: rates.cursorAdvancesPerMinute,
      returnedMessages: readerTotals.returned,
      persistedMessages: readerTotals.persisted,
      duplicateMessages: readerTotals.duplicates,
      rejectedMessages: readerTotals.rejected,
      signedMessages: readerTotals.signed,
      invalidSignatureMessages: readerTotals.invalidSignature,
      cursorSequenceAdvance: readerTotals.cursorSequenceAdvance,
      gapMessages: readerTotals.gap,
      budgetRemaining: pacing.budget?.remaining ?? null,
      budgetLimit: pacing.budget?.limit ?? null,
      throttledReads: clientStats.throttled,
      timeoutReads: clientStats.timeouts,
      waitNotHeld: clientStats.waitNotHeld,
      lastRetryAfterSeconds: pacing.retryAfterSeconds,
      exportRecovery: { ...this.exportStats },
      limit: this.limit,
      serverLimit: this.serverLimit,
      concurrency: this.concurrency,
      silentRooms,
      lastReturnedCountByRoom,
      lastReturnedFirstSeqByRoom,
      lastReturnedLastSeqByRoom,
      lastCursorByRoom,
      lastRingFirstSeqByRoom,
      lastRingLastSeqByRoom,
      cursorLagByRoom,
      lastGapFromByRoom,
      lastGapToByRoom,
      modeByRoom,
      consecutiveShortPages,
      effectiveConfig: this.effectiveConfig(),
      serverContract: this.serverContractProbe,
      readerMetricsVersion: READER_METRICS_VERSION,
      statusSchemaVersion: STATUS_SCHEMA_VERSION,
      rooms,
    };
  }

  /** One room's throughput row, or null when this reader does not own it. */
  readerThroughputFor(room: string): RoomThroughput | null {
    if (!this.rooms.includes(room)) return null;
    return this.roomThroughput(room);
  }

  /** The most recent contract probe, or null before one has run. */
  get serverContract(): ServerContractProbe | null {
    return this.serverContractProbe;
  }

  /**
   * Probe the live service contract, read-only.
   *
   * The reader's own success is not evidence about the contract: a service that
   * silently clamps `limit`, never sets `wait_held`, or omits the generation
   * header looks exactly like one that honours the documented shape, from inside
   * a cursor that keeps advancing. This sends no write and commits nothing — it
   * is one bounded read plus a look at the response's own metadata, so it can
   * never advance a cursor or store a message.
   *
   * The room defaults to the trading room, which is the one whose contract
   * actually matters, and only the response's metadata is recorded: no message
   * body, no key, no token.
   */
  async contractProbe(room?: string): Promise<ServerContractProbe> {
    const target = room ?? this.tradingRoom;
    const probe: ServerContractProbe = {
      room: target,
      at: this.now().toISOString(),
      status: 0,
      requestedLimit: Math.min(MAX_PAGE_SIZE, this.serverLimit),
      returnedCount: 0,
      lastSeq: null,
      firstSeq: null,
      waitHeld: null,
      contentType: '',
      generationHeader: false,
      exportGeneration: null,
      error: null,
    };
    try {
      // `since=0` is the documented "everything retained" read; `wait=0` keeps the
      // probe from holding a long-poll slot. Nothing here is committed.
      const result = await this.client.readRoom(target, {
        since: 0,
        limit: probe.requestedLimit,
        waitSeconds: 0,
      });
      probe.status = result.status;
      probe.returnedCount = result.read.messages.length;
      probe.firstSeq = result.read.first_seq ?? null;
      probe.lastSeq = result.read.last_seq ?? null;
      probe.waitHeld = result.waitHeld;
      probe.contentType = result.contentType;
      probe.generationHeader = result.generationHeader;
    } catch (caught) {
      probe.error = caught instanceof Error ? caught.message : String(caught);
    }
    if (probe.error === null) {
      try {
        // The export's own generation header, from a bounded body we do not parse.
        // A snapshot's generation is what an export-based recovery would check
        // our cursor against, so its presence is contract evidence too.
        const exported = await this.client.exportRoom(target, { maxBytes: 4_096 });
        probe.exportGeneration = exported.generation;
      } catch (caught) {
        probe.error = caught instanceof Error ? caught.message : String(caught);
      }
    }
    this.serverContractProbe = probe;
    this.logger.event({
      level: 'info',
      source: 'room-reader',
      code: 'server_contract_probe',
      message:
        `${target} contract probe: status ${probe.status}, limit ${probe.requestedLimit}, ` +
        `last_seq ${probe.lastSeq ?? 'absent'}, wait_held ${probe.waitHeld === null ? 'n/a' : probe.waitHeld}, ` +
        `generation ${probe.exportGeneration ?? 'absent'}`,
      data: { ...probe },
    });
    return probe;
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
