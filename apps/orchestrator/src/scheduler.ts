/**
 * The conductor: everything that happens on a timer happens here.
 *
 * There is exactly one scheduler and one process. Every tick walks the same
 * fixed order, and the order is the design:
 *
 *   1. sample the load guard, so every later step can be shed by tier;
 *   2. read the rooms — reads are never shed, because reading is how the
 *      process finds out the problem is over;
 *   3. reconcile participation: every agent gets a signed owner registration
 *      and a readback (ParticipationService);
 *   4. reconcile settlement: apply the referee's flow, mints and outcomes
 *      (SettlementService);
 *   5. run each group's slice of agents through its deterministic strategy,
 *      validate risk, then post a trade — but only past the validator, the
 *      local caps and the load guard, and never in dry-run (TradingService);
 *   6. reconcile the missed-message repost queue (RecoveryService);
 *   7. persist status, then run the background operations — watchdog, Lark
 *      report, model review, upstream check (OperationsService).
 *
 * Steps 1-6 are the trading path. Step 7 is deliberately outside it: each
 * background task is bounded by a timeout, isolated in its own try/catch, and
 * can neither reorder a trade nor take the tick down. The five groups above are
 * marked in the body as section headers; they are the only acceptable place to
 * add work, and the tick order is fixed.
 *
 * Two properties this class deliberately holds:
 *
 *   - **the participation pipeline is idempotent.** A registration is only
 *     posted once per agent (`participation_records` is the ledger), a readback
 *     only recorded once, and a status never moves backwards. A restart in the
 *     middle of the 150 registrations resumes rather than repeating.
 *   - **`mint_unknown` is not a failure.** A sweep that posted a price but no
 *     flow leaves its mints unknown; that is recorded as `mint_unknown` and the
 *     reader goes conservative. Nothing here may ever downgrade it to `failed`.
 */
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import {
  Decimal,
  RiskAccount,
  buildTerms,
  generateTradeId,
  parseTradeMessage,
  withinLimits,
  withinPublishedLimits,
  type MarketSnapshot,
  type Rules,
  type TradeTerms,
} from '@flop/close-call';
import {
  countersignOffer,
  signTrade,
  validateExternalOffer,
  type SignedTrade,
} from '@flop/close-call';
import type { AgentKeyStore } from '@flop/identity';
import { STRATEGY_GROUPS, signRoomMessage } from '@flop/identity';
import type {
  ParticipationRow,
  ParticipationStatus,
  Repositories,
  SqliteDatabase,
  TradeRow,
  TradeSource,
} from '@flop/storage';
import { fileBytes } from '@flop/storage';
import {
  GroupRunner,
  LATE_START_OBSERVATIONS_REQUIRED,
  asDecimals,
  fallbackParams,
  lateStartSignal,
  type GatedAction,
  type LateStartSignal,
  type RunOutcome,
  type StrategyGroupName,
} from '@flop/strategy';
import { READER_METRICS_VERSION, STATUS_SCHEMA_VERSION } from '@flop/technocore';
import type {
  EffectiveReaderConfig,
  ExportRecoveryStats,
  RoomMode,
  ServerContractProbe,
  TechnocoreClient,
} from '@flop/technocore';
import type { ArchiveMaintenance } from './archive-maintenance.js';
import { LATE_START_MAX_STALE_SWEEPS } from './config.js';
import type { Config } from './config.js';
import type { DeepSeekBudget, DeepSeekScheduler, ParameterOptimiser } from './llm.js';
import { localDateKey } from './llm.js';
import { messageHash } from './hashing.js';
import type { LarkStack } from './lark.js';
import type { LoadGuard, LoadTier } from './load-guard.js';
import type { Logger } from './logger.js';
import type { Close1Coverage, OrchestratorReader, ReaderStatus } from './reader.js';
import {
  lateStartFeedBlockerReasons,
  lateStartFeedReadiness,
  lateStartRegistrationReadiness,
  lateStartTradingReadiness,
  lockState,
  marketSnapshotReadiness,
  refereeFeedBlockerReasons,
  refereeFeedReadiness,
  registrationGateReason,
  registrationReadiness,
  tradingReadiness,
  type LockState,
  type Readiness,
} from './readiness.js';
import { runtimeEventSummary, type RuntimeEventNotifier } from './runtime-events.js';
import { ownerRegistrationText, type OrchestratorWriter } from './writer.js';
import type { UpstreamMonitor } from './upstream-monitor.js';

/** A trade is only valid until this many sweeps from now, and never past lock. */
export const DEFAULT_TRADE_HORIZON_SWEEPS = 24;

/**
 * Status precedence. Higher wins, and a status is never replaced by a lower one.
 * `failed` is deliberately below `created`: a permanent refusal is retried on a
 * later tick rather than being final. `registration_closed` outranks `posted`:
 * once the lock has passed with no readback, the miss is terminal and must not
 * be walked back into "still in flight" by a later tick.
 */
const PARTICIPATION_RANK: Record<ParticipationStatus, number> = {
  failed: -1,
  created: 0,
  posted: 1,
  readback_confirmed: 2,
  before_lock_confirmed: 3,
  registration_closed: 4,
  mint_unknown: 5,
  mint_observed: 6,
};

function advanceStatus(
  current: ParticipationStatus,
  next: ParticipationStatus,
): ParticipationStatus {
  return PARTICIPATION_RANK[next] > PARTICIPATION_RANK[current] ? next : current;
}

/**
 * A stable correlation id for one POST of ours.
 *
 * The service's own reply does not carry a request id, so the identity of the
 * write has to come from what we control: the room, the signer and the nonce the
 * writer reserved immediately before signing. Those three are exactly what makes
 * the write distinct, and a later readback — or a gap that might have swallowed
 * it — can be reconciled against this string without guessing.
 */
function localPostRequestId(room: string, did: string, nonce: string): string {
  return `${room}|${did}|${nonce}`;
}

/**
 * The id of a participation trade: deterministic in the pair and the sweep.
 *
 * A trade id settles at most once, so the id must be reproducible: a retry of
 * the same pair in the same sweep has to collide with the first attempt rather
 * than create a second trade. `generation` is what separates a *retry* from a
 * *re-issue*: a refused attempt keeps generation 0 and reuses its id, while a
 * trade the referee reported missed moves to the next generation and therefore
 * to a fresh id — which is what the rules require, because the original may
 * already have been read as another sweep's copy.
 */
function participationTradeId(
  makerDid: string,
  takerDid: string,
  forSweep: number,
  generation: number,
): string {
  const digest = createHash('sha256')
    .update(`${makerDid}|${takerDid}|${forSweep}|${generation}`, 'utf8')
    .digest('hex');
  return `pl${digest.slice(0, 24)}`;
}

/** The trade statuses a local retry may rewrite in place: none ever took effect. */
const REWRITABLE_TRADE_STATUS: ReadonlySet<string> = new Set(['refused', 'dry_run', 'failed']);

/**
 * How long a background task may run before the tick gives up on it.
 *
 * Background work — the report pass, the watchdog, the model review, the
 * upstream check — is never allowed to hold the tick open indefinitely. A task
 * that overruns is abandoned; whatever it was going to do simply happens on a
 * later tick, from durable state.
 */
const BACKGROUND_TIMEOUT_MS = 120_000;

/**
 * Race `work` against a timeout.
 *
 * The abandoned promise is explicitly drained so a late rejection cannot surface
 * as an unhandled rejection after the timeout already won the race.
 */
async function withTimeout<T>(work: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} exceeded ${ms}ms`)), ms);
  });
  try {
    return await Promise.race([work, timeout]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    void work.catch(() => undefined);
  }
}

/** One trade the referee named in a flow post's `settled`/`void` list. */
interface RefereeOutcomeEntry {
  id: string;
  reason: string;
}

/**
 * Read a `settled`/`void` list, whatever shape it arrived in.
 *
 * The published schema types both as `unknown` and the live referee has been
 * seen using a bare id list and `{id, reason}` rows, so both — and an id→reason
 * map — are accepted. An entry without a usable id is dropped rather than
 * guessed at, and a missing reason becomes the list's default (`settled` or
 * `void`), never a verdict.
 */
function parseOutcomeList(value: unknown, defaultReason: string): RefereeOutcomeEntry[] {
  const entries: RefereeOutcomeEntry[] = [];
  const add = (id: unknown, reason: unknown): void => {
    if (typeof id !== 'string' || id.length === 0) return;
    entries.push({
      id,
      reason: typeof reason === 'string' && reason.length > 0 ? reason : defaultReason,
    });
  };
  if (Array.isArray(value)) {
    for (const item of value) {
      if (typeof item === 'string') {
        add(item, null);
        continue;
      }
      if (typeof item !== 'object' || item === null) continue;
      const row = item as Record<string, unknown>;
      add(row.id ?? row.tid ?? row.trade_id ?? row.trade, row.reason ?? row.why);
    }
  } else if (typeof value === 'object' && value !== null) {
    for (const [id, reason] of Object.entries(value as Record<string, unknown>)) {
      add(id, typeof reason === 'string' ? reason : null);
    }
  }
  return entries;
}

/** The trade id inside a stored trade message, or null when it is not one. */
function tradeIdOf(text: string): string | null {
  const parsed = parseTradeMessage(text);
  return parsed === null ? null : parsed.terms.id;
}

/**
 * True when the missed entry's trade id agrees with the message we hold.
 *
 * A `missed` entry that names no trade id cannot disagree, so it matches; an
 * entry that names one must name the same one, or the message is not the one the
 * referee missed and must not be re-posted.
 */
function tradeIdMatches(entry: Record<string, unknown>, tradeId: string | null): boolean {
  const raw = entry.tid ?? entry.trade_id ?? entry.trade ?? entry.id;
  if (raw === undefined || raw === null) return true;
  if (tradeId === null) return false;
  return String(raw) === tradeId;
}

export interface ParticipationOutcome {
  /** Registrations confirmed present on the room this pass. */
  readback: number;
  /** Registrations posted for the first time this pass. */
  posted: number;
  /** Registrations still missing a readback. */
  pending: number;
  /** Permanent refusals recorded this pass. */
  failed: number;
  /** Rows advanced to `mint_observed` by this pass. */
  minted: number;
  /** Rows advanced to `mint_unknown` by this pass. */
  unknown: number;
}

export interface TickReport {
  at: string;
  tier: LoadTier;
  sweep: number;
  reference: string | null;
  locked: boolean;
  conservative: boolean;
  rooms: { inserted: number; readErrors: number; gaps: number };
  participation: ParticipationOutcome;
  runs: { agents: number; candidates: number; failures: number };
  trades: { dryRun: number; posted: number; refused: number };
  /**
   * The late-start participation fallback, separately from the strategy's own
   * trades. The pairing is deterministic, so "posted 75" is the whole fleet
   * participating rather than a market event, and the two counts must never be
   * read as one.
   */
  participationTrades: { pairs: number; posted: number; skipped: number; refused: number };
  repost: { queued: number; posted: number; failed: number; skipped: number };
  watchdog: { ran: boolean; backfilled: number };
  lark: { delivered: string[]; maintenance: boolean };
  deepseek: { attempted: string[]; refused: number };
  upstream: { checked: boolean; drift: boolean };
}

export interface StatusSnapshot {
  at: string;
  /**
   * The `/status` document contract this payload conforms to.
   *
   * Together with `commit` it is how a stale deployment is recognised from the
   * outside: a process reporting an older schema version than the source is a
   * process running an older bundle, which is exactly the failure that made
   * metrics present in the source appear absent from a live `/status`.
   */
  statusSchemaVersion: number;
  /** The reader metric contract inside `reader`. */
  readerMetricsVersion: number;
  /** The build commit, when the environment supplies one; null otherwise. */
  commit: string | null;
  /** Which operating profile the process was started under. */
  profile: 'lite' | 'full';
  mode: 'dry-run' | 'live';
  liveArmed: boolean;
  tier: LoadTier;
  tierReasons: string[];
  paused: Record<string, boolean>;
  sweep: number | null;
  reference: string | null;
  limits: { low: string; high: string } | null;
  locked: boolean;
  conservative: boolean;
  conservativeReasons: string[];
  packageHash: string | null;
  expectedPackageHash: string | null;
  packageDrift: boolean;
  refereeDid: string | null;
  /** The DID pinned at launch, so a mismatch is a finding rather than a guess. */
  expectedRefereeDid: string | null;
  /**
   * How the seed this process is running on was obtained.
   *
   * `referee_room` (read off the wire) or `official_signed_bootstrap` (the same
   * envelope, replayed from the launch record because the room's retained ring no
   * longer reaches back to it). Null before a seed is accepted. Never the text.
   */
  seedSource: string | null;
  /** True once a seed has been accepted, whichever way it arrived. */
  seedVerified: boolean;
  /**
   * Whether the contest record was replayed from its opening seed.
   *
   * False in a late start, and *never* set to true to make a seedless run look
   * complete: the whole point of the mode is that it participates on a different
   * anchor — the pinned referee's current, signed price post — and the two must
   * stay distinguishable in the payload.
   */
  historicalReplayComplete: boolean;
  /** True when a late start is running without the seed it cannot reach. */
  historicalReplayUnavailable: boolean;
  /** The launch configuration pins both the referee DID and the package hash. */
  launchPinVerified: boolean;
  /** `LATE_START_MODE` confirmed and in force. */
  lateStartMode: boolean;
  /** The seedless feed gate: identity, signature and pin, without the seed. */
  lateStartFeedReady: boolean;
  /** A current, signed, well-formed price post that may price a new trade. */
  marketSnapshotReady: boolean;
  /** The sweep the current published limits apply to — the price post's `for`. */
  tradeUntilSweep: number | null;
  /** Why `LATE_START_MODE` did not take effect, or null when it is not a factor. */
  lateStartBlockedReason: string | null;
  /** The late-start trading gate. Distinct from the strict `readiness.tradingReady`. */
  lateStartTradingReady: boolean;
  /** The first reason a late-start trade is refused, or null when none is. */
  tradeBlockedReason: string | null;
  /**
   * The contest's own wall-clock lock, reported beside the referee's own.
   *
   * `lockedByReferee` is the sweep-derived lock; `lockedByWallClock` is the
   * published deadline. They are separate because a silent feed can leave the
   * first false while the second is true, and an operator has to be able to see
   * which one closed the contest.
   */
  wallClockBeforeLock: boolean;
  lockedByReferee: boolean;
  lockedByWallClock: boolean;
  /**
   * The owner-registration gate the trading path reads before any trade.
   *
   * `registrationReady` requires every expected owner to have a seq-bearing
   * registration — never a mint. The layers below it are the same facts
   * `/status.registration` splits, repeated here because the trading gate is the
   * consumer that decides whether a trade may be written.
   */
  registrationReady: boolean;
  registrationExpected: number;
  registrationPostAcked: number;
  registrationRoomEchoed: number;
  registrationMintConfirmed: number;
  registrationMintUncertain: number;
  /**
   * The participation fallback, measured rather than assumed.
   *
   * `expected` is the number of pairs the fleet forms; `posted` counts the
   * participation trades actually written; `agentsCovered` is how many distinct
   * owners appear in at least one of them.
   */
  participationTradesExpected: number;
  participationTradesPosted: number;
  participationAgentsCovered: number;
  /**
   * The late-start strategy path.
   *
   * `strategyGateMode` names which decision is running — the five group profiles
   * or the late-start bootstrap — and `lateStartSignal` is the direction the
   * bootstrap read from the referee's own closes. Both are reported whether or
   * not the strategy switch is armed, so "off" is visible instead of absent.
   */
  strategyGateMode: 'group' | 'late_start_bootstrap';
  lateStartStrategyTradingReady: boolean;
  strategyBlockedReason: string | null;
  lateStartObservationCount: number;
  lateStartSignal: LateStartSignal | 'insufficient';
  strategyTradesPosted: number;
  bootstrapStrategyTradesPosted: number;
  /**
   * The three registration layers, kept apart on purpose.
   *
   * A POST the service acknowledged is not a room echo, and a room echo is not a
   * mint: the referee's own flow is the only thing that says it minted. Counting
   * them together is how "150 posted" comes to be read as "150 funded".
   */
  registration: {
    total: number;
    postAcked: number;
    roomEchoConfirmed: number;
    mintConfirmed: number;
    mintUncertain: number;
  };
  /**
   * The trading layers, kept apart on purpose.
   *
   * A room seq is not a settlement. `tradeUnknown` is written-but-unruled and is
   * never folded into `tradeSettled`.
   */
  trading: {
    eligibleAgents: number;
    tradeAttempts: number;
    tradePosted: number;
    tradeEchoConfirmed: number;
    tradeSettled: number;
    tradeUnknown: number;
  };
  /**
   * The audit view of the contest record, alongside the trading view above.
   *
   * It reports what a late start cannot claim — a replayed history — and what it
   * still holds. It is never a precondition of the trading view: an audit that
   * cannot be completed is reported, not used to refuse a legal trade.
   */
  lateStartAudit: {
    room: string;
    coverage: Close1Coverage;
    gaps: number;
    firstSeq: number | null;
    lastSeq: number | null;
    generation: number | null;
    historicalReplayComplete: boolean;
  };
  agents: {
    total: number;
    enabled: number;
    byGroup: Record<string, number>;
    staleCount: number;
    staleSample: string[];
    lastRunAt: string | null;
    /** Individual agent strategy failures, from the alert trail. */
    failures: number;
  };
  participation: Record<string, number> & { total: number; readback: number };
  runs: {
    /** Durable agent-run rows since local midnight; spans restarts. */
    today: number;
    /** Durable agent-run rows inside the rolling 7x24h window; spans restarts. */
    window: number;
    /** Agent strategy evaluations this process has performed since startup. */
    sinceStartup: number;
    /** Scheduler ticks this process has completed. */
    schedulerTicks: number;
    /** Distinct agents this process has evaluated since startup. */
    uniqueAgents: number;
    /** Times the whole fleet has been evaluated once since startup. */
    fullFleetCycles: number;
    /** Weekly watchdog passes this process has actually run. */
    watchdogRuns: number;
    /** Agents evaluated in the most recent tick. */
    agentsInCurrentTick: number;
    lastTickAt: string | null;
    nextTickAt: string | null;
  };
  trades: Record<string, number>;
  /**
   * Trades counted by the sweep they were written at, plus the duplicate-id
   * refusals. `afterLock` should stay at zero: the lock gate is what holds it.
   */
  tradeSweeps: { inCurrent: number; afterLock: number; duplicateAttempts: number };
  /** The immediate-alert trail (critical + warning), as recorded locally. */
  runtimeEvents: {
    total: number;
    critical: number;
    warning: number;
    delivered: number;
    pending: number;
    failed: number;
    recentCodes: string[];
  };
  /** The referee's named reasons, and how its `funds` verdicts are labelled. */
  funds: {
    officialReasons: Record<string, number>;
    fundsVerdicts: number;
    localInferred: number;
  };
  /** Missed-message re-posts, by status. */
  repost: Record<string, number> & { total: number };
  /** The published sweep archive, as the monitor last saw it. */
  archive: {
    latestIndexSweep: number | null;
    latestVerifiedSweep: number | null;
    lagSweeps: number | null;
    fullVerified: number;
    redactedVerified: number;
    unavailable: number;
    hashMismatch: number;
    lastCheckAt: string | null;
    lastError: string | null;
  };
  rooms: {
    scope: 'close1_only' | 'registered_rooms_plus_close1';
    fixed: string[];
    dynamic: string[];
    cap: number;
    /** Rooms whose retained history did not reach back to our first read. */
    bootstrap: string[];
    /** Rooms with a genuine mid-run cursor gap. */
    gaps: string[];
    registrationReady: boolean;
    tradingReady: boolean;
  };
  /** Which operating posture the process is in, derived from the arming flags. */
  operatingMode: OperatingMode;
  /**
   * The three readiness gates, strongest last.
   *
   * `refereeFeedReady` is about the five structured rooms being provable,
   * `registrationReady` adds what posting 150 registrations needs, and
   * `tradingReady` adds what pricing and writing a trade needs. Each carries the
   * reasons it failed, so a report never has to guess why something was refused
   * — and so `registrationReady` can never be read as `tradingReady`.
   */
  readiness: {
    refereeFeedReady: boolean;
    registrationReady: boolean;
    tradingReady: boolean;
    refereeFeedReasons: string[];
    registrationReasons: string[];
    tradingReasons: string[];
  };
  /**
   * The `close1` policy surface: what the room's coverage is, which switches are
   * set, and — when trading is refused — why.
   */
  close1: {
    coverage: Close1Coverage;
    gapPolicy: 'block' | 'degraded_readonly';
    registrationPolicy: { allowWithClose1Gap: boolean };
    tradingPolicy: {
      allowWithClose1Gap: boolean;
      override: { operator: string; reason: string; at: string } | null;
    };
    /** Our own seqs that provably fall inside the recorded band. */
    localMessagesInGap: number[];
    /** Agents whose registration seq is inside the band. */
    localAgentsInGap: string[];
    unresolvedGapRooms: string[];
    /** Registrations posted but not yet read back. */
    registrationPending: number;
    registrationReadback: { completed: number; pending: number; total: number };
    /** The first reason trading is refused, or null when it is not. */
    tradeBlockedReason: string | null;
  };
  cors: { gaps: number; gapRooms: string[]; resets: string[]; bootstrap: string[] };
  /**
   * The reader's own throughput and health.
   *
   * Reported separately from the agent scheduler on purpose: the reader is no
   * longer paced by `TICK_SECONDS`, so "how fast are we draining `close1`" is a
   * question about this block, not about the tick rate.
   */
  reader: ReaderStatus;
  technocore: Record<string, number>;
  llm: { normal: number; retries: number; total: number; blocked: number; tokens: number };
  lark: { connected: boolean; state: string; heartbeatStale: boolean; outbox: Record<string, number> };
  upstream: { checkedAt: string | null; drift: boolean };
  system: {
    rssBytes: number;
    heapUsedBytes: number;
    /**
     * Process CPU over the last tick interval, as a percentage of one core.
     *
     * `null` until two samples exist: a figure derived from the process's
     * cumulative CPU time divided by its uptime is not a rate and must never be
     * presented as one.
     */
    cpuPercent: number | null;
    cpuState: 'warming_up' | 'ok';
    uptimeSeconds: number;
    diskUsedPercent: number;
    /** Last zero-delay timer reading, off the trade path. */
    eventLoopLagMs: number;
  };
  storage: {
    dbBytes: number;
    archiveBytes: number;
    walBytes: number;
    /** Writes waiting behind the current one; a bounded, in-process queue. */
    writerQueueDepth: number;
  };
}

/**
 * The field acceptance view of the reader: what it is doing, room by room.
 *
 * Built from the same facts `status()` reports, arranged so an operator on a VPS
 * can answer "is close1 catching up, falling behind, or unable to catch up"
 * without reading the whole status document. Every number here has a definition:
 * `persistedConsumerRate` is what reached SQLite, `cursorAdvanceRate` is how far
 * the cursor number moved and is never consumption, and `netBacklogRate` is the
 * difference. Nothing secret is in it — no key, no seed, no token, no message
 * body — and it is served from `/reader-report`.
 */
export interface ReaderReport {
  at: string;
  commit: string | null;
  statusSchemaVersion: number;
  readerMetricsVersion: number;
  mode: 'continuous' | 'scheduler_tick';
  running: boolean;
  catchupState: ReaderStatus['catchupState'];
  fullyCaughtUp: boolean;
  netBacklogIncreasing: boolean;
  pageSaturated: boolean;
  consecutiveShortPages: number;
  effectiveConfig: EffectiveReaderConfig;
  rooms: Array<{
    room: string;
    mode: RoomMode;
    /** The room's own growth, messages/minute, from the ring's head. */
    producerRate: number;
    /** What reached SQLite, messages/minute. The consumer figure. */
    persistedConsumerRate: number;
    /** How far the cursor number moved, messages/minute. A protocol metric only. */
    cursorAdvanceRate: number;
    /** Messages the ring dropped unread, per minute. */
    lostGapRate: number;
    /** `producerRate - persistedConsumerRate`. */
    netPersistBacklogRate: number;
    cursorLag: number | null;
    waitSeconds: number;
    lastLimitUsed: number;
    lastReturnedCount: number;
    pageSaturated: boolean;
    catchingUpForMs: number;
    lastSuccessAt: string | null;
    silenceMs: number;
  }>;
  totals: {
    producerRate: number;
    persistedConsumerRate: number;
    cursorAdvanceRate: number;
    lostGapRate: number;
    netBacklogRate: number;
    persistedMessages: number;
    duplicateMessages: number;
    gapMessages: number;
  };
  exportRecovery: ExportRecoveryStats;
  unresolvedGapRooms: string[];
  operatingMode: OperatingMode;
  close1Coverage: Close1Coverage;
  registrationPolicy: { allowWithClose1Gap: boolean };
  tradingPolicy: {
    allowWithClose1Gap: boolean;
    override: { operator: string; reason: string; at: string } | null;
  };
  /** Our own registration seqs that provably fell inside the recorded band. */
  localMessagesInGap: number[];
  registrationPending: number;
  registrationReadback: { completed: number; pending: number; total: number };
  tradeBlockedReason: string | null;
  readiness: {
    refereeFeedReady: boolean;
    registrationReady: boolean;
    tradingReady: boolean;
    refereeFeedReasons: string[];
    registrationReasons: string[];
    tradingReasons: string[];
  };
  /**
   * The seedless participation view, alongside the strict gates above.
   *
   * Carried on the field-acceptance report as well as `/status` so an operator on
   * a VPS can answer "is the late start participating, and if not why" from the
   * same document that carries the reader's throughput.
   */
  lateStart: {
    mode: boolean;
    blockedReason: string | null;
    feedReady: boolean;
    marketSnapshotReady: boolean;
    launchPinVerified: boolean;
    seedVerified: boolean;
    historicalReplayComplete: boolean;
    historicalReplayUnavailable: boolean;
    currentSweep: number | null;
    tradeUntilSweep: number | null;
    reference: string | null;
    limits: { low: string; high: string } | null;
    registration: StatusSnapshot['registration'];
    trading: StatusSnapshot['trading'];
    tradingReady: boolean;
    tradeBlockedReason: string | null;
    /** The contest's own wall clock, and which lock closed the contest. */
    wallClockBeforeLock: boolean;
    lockedByReferee: boolean;
    lockedByWallClock: boolean;
    /** The owner-registration gate the trading path reads before any trade. */
    registrationReady: boolean;
    registrationExpected: number;
    registrationPostAcked: number;
    registrationRoomEchoed: number;
    registrationMintConfirmed: number;
    registrationMintUncertain: number;
    /** The participation fallback's own coverage. */
    participationTradesExpected: number;
    participationTradesPosted: number;
    participationAgentsCovered: number;
    /** The late-start strategy path: which decision, and what it reads. */
    strategyGateMode: 'group' | 'late_start_bootstrap';
    lateStartStrategyTradingReady: boolean;
    strategyBlockedReason: string | null;
    lateStartObservationCount: number;
    lateStartSignal: LateStartSignal | 'insufficient';
    strategyTradesPosted: number;
    bootstrapStrategyTradesPosted: number;
    audit: StatusSnapshot['lateStartAudit'];
  };
  serverContract: ServerContractProbe | null;
}

/**
 * The five postures the process can be in.
 *
 * `late_start_*` is deliberately not folded into `live_trading` /
 * `live_registration_only`: the difference the operator has to see is *what the
 * feed is trusted for*, and a seedless start is trusted for something narrower.
 */
export type OperatingMode =
  | 'dry_run'
  | 'live_registration_only'
  | 'live_trading'
  | 'late_start_registration_only'
  | 'late_start_full_participation';

/**
 * The seedless participation gates, computed in every mode.
 *
 * `feed` / `registration` / `trading` are the *effective* gates when the mode is
 * armed. When it is not, they are still computed and still honest — they simply
 * have `late-start mode is not armed` as their first reason, which is what makes
 * `/status` able to say "asked for, and here is exactly what is missing".
 */
/**
 * Owner-registration progress, as the trading path reads it.
 *
 * The counts are kept apart exactly as `status().registration` keeps them: a
 * POST the service acknowledged, a row the room echoed and a mint the referee
 * named are three different facts, and only the first is a precondition of a
 * trade. `mintConfirmed` is deliberately *not* part of `ready`.
 */
export interface RegistrationProgress {
  ready: boolean;
  expected: number;
  postAcked: number;
  pending: number;
  failed: number;
  roomEchoed: number;
  mintConfirmed: number;
  mintUncertain: number;
  /** A queued owner re-post is still owing work, so registration is not settled. */
  unresolvedMissed: boolean;
  /** Why it is not ready, phrased for the gate, `/status` and the report alike. */
  reason: string | null;
}

export interface LateStartGates {
  feed: Readiness;
  registration: Readiness;
  trading: Readiness;
  marketSnapshot: Readiness;
  /** The launch configuration pins both the referee DID and the package hash. */
  launchPinVerified: boolean;
  /** Something signed by the pinned referee has been accepted. */
  refereeSeen: boolean;
  /** The contest's own wall-clock lock, independent of the referee's sweep. */
  lock: LockState;
  /** Owner-registration progress, shared by the trading gate and `/status`. */
  registrationProgress: RegistrationProgress;
}

export interface SchedulerOptions {
  config: Config;
  logger: Logger;
  repositories: Repositories;
  db: SqliteDatabase;
  keyStore: AgentKeyStore;
  rules: Rules;
  client: TechnocoreClient;
  reader: OrchestratorReader;
  writer: OrchestratorWriter;
  runner: GroupRunner;
  loadGuard: LoadGuard;
  budget: DeepSeekBudget;
  optimiser: ParameterOptimiser;
  deepSeek?: DeepSeekScheduler;
  lark?: LarkStack;
  maintenance?: ArchiveMaintenance;
  upstream?: UpstreamMonitor;
  /** The immediate-alert channel; optional so a test can omit it. */
  notifier?: RuntimeEventNotifier;
  now?: () => Date;
}

/** One CPU reading: cumulative CPU microseconds plus the wall clock. */
export interface CpuSample {
  cpuUs: number;
  wallMs: number;
}

/**
 * The build commit, read from the environment.
 *
 * The bundle is not rebuilt with the commit baked in, so this is whatever the
 * supervisor exported. `null` when nothing did — an unknown commit is reported
 * as unknown rather than as a plausible-looking hash, which is what keeps
 * "which bundle is running" answerable instead of guessable.
 */
export function buildCommit(env: NodeJS.ProcessEnv = process.env): string | null {
  const value = env.GIT_COMMIT ?? env.SOURCE_COMMIT ?? env.BUILD_COMMIT;
  return value !== undefined && value.trim().length > 0 ? value.trim() : null;
}

/**
 * Process CPU over the interval between two samples, as a percentage of one
 * core.
 *
 * `process.cpuUsage()` counts microseconds and the wall clock counts
 * milliseconds, so the rate is `(cpuUsDelta / 1000) / wallDeltaMs * 100`. Either
 * half of that being wrong is what turns a 2% process into a 2182% report, which
 * is why this is a named, tested function rather than an inline expression.
 *
 * Returns null when the interval cannot support a rate: no wall time passed, or
 * the CPU counter went backwards (which only happens if it was reset).
 */
export function processCpuPercent(previous: CpuSample, current: CpuSample): number | null {
  const wallDeltaMs = current.wallMs - previous.wallMs;
  const cpuDeltaMs = (current.cpuUs - previous.cpuUs) / 1000;
  if (wallDeltaMs <= 0 || cpuDeltaMs < 0) return null;
  return Number(((cpuDeltaMs / wallDeltaMs) * 100).toFixed(2));
}

export class OrchestratorScheduler {
  private readonly config: Config;
  private readonly logger: Logger;
  private readonly repositories: Repositories;
  private readonly db: SqliteDatabase;
  private readonly keyStore: AgentKeyStore;
  private readonly rules: Rules;
  private readonly client: TechnocoreClient;
  private readonly reader: OrchestratorReader;
  private readonly writer: OrchestratorWriter;
  private readonly runner: GroupRunner;
  private readonly loadGuard: LoadGuard;
  private readonly budget: DeepSeekBudget;
  private readonly optimiser: ParameterOptimiser;
  private readonly deepSeek: DeepSeekScheduler | undefined;
  private readonly lark: LarkStack | undefined;
  private readonly maintenance: ArchiveMaintenance | undefined;
  private readonly upstream: UpstreamMonitor | undefined;
  private readonly notifier: RuntimeEventNotifier | undefined;
  private readonly now: () => Date;

  private timer: ReturnType<typeof setInterval> | null = null;
  private inFlight: Promise<TickReport> | null = null;
  private tickCount = 0;
  private lastWatchdogDay: string | null = null;
  private lastMaintenanceDay: string | null = null;
  private lastUpstreamCheckMs = 0;
  private lastTickReport: TickReport | null = null;
  /** The last event-loop lag the background step measured, in milliseconds. */
  private lastEventLoopLagMs = 0;
  /**
   * The CPU sampler: cumulative CPU microseconds and the wall clock at the last
   * tick. A rate needs two points in time, so the first tick can only seed this.
   */
  private cpuSample: { cpuUs: number; wallMs: number; percent: number | null } | null = null;
  /**
   * What *this process* has done, as opposed to what the durable tables hold.
   *
   * `agent_runs` survives restarts, so a raw "runs today" mixes every process
   * that ran today; a 151-second-old process reporting thousands of runs is the
   * confusion this accounting exists to prevent. Both numbers are now printed,
   * and they are never conflated.
   */
  private readonly runStats = {
    evaluated: 0,
    uniqueAgents: new Set<string>(),
    cycleSeen: new Set<string>(),
    fleetCycles: 0,
    watchdogRuns: 0,
    agentsInCurrentTick: 0,
  };
  /** Per-agent mirror of cash and open lots; rebuilt from the referee's mints. */
  private readonly riskBook: Map<string, RiskAccount> = new Map();
  /** DID -> agent id, built once, for matching a missed message back to its agent. */
  private readonly didIndex: Map<string, string> = new Map();
  private readonly startedAt = Date.now();

  constructor(options: SchedulerOptions) {
    this.config = options.config;
    this.logger = options.logger;
    this.repositories = options.repositories;
    this.db = options.db;
    this.keyStore = options.keyStore;
    this.rules = options.rules;
    this.client = options.client;
    this.reader = options.reader;
    this.writer = options.writer;
    this.runner = options.runner;
    this.loadGuard = options.loadGuard;
    this.budget = options.budget;
    this.optimiser = options.optimiser;
    this.deepSeek = options.deepSeek;
    this.lark = options.lark;
    this.maintenance = options.maintenance;
    this.upstream = options.upstream;
    this.notifier = options.notifier;
    this.now = options.now ?? (() => new Date());
    this.bootstrapRiskBook();
  }

  get tickNumber(): number {
    return this.tickCount;
  }

  get lastReport(): TickReport | null {
    return this.lastTickReport;
  }

  /** Start the single interval that drives everything. */
  start(): void {
    if (this.timer) return;
    const configured = this.config.scheduling.tickSeconds;
    const effectiveSeconds = Math.max(5, configured);
    if (configured < 5) {
      // The floor is real and silent: a TICK_SECONDS below it would otherwise
      // look configured while the process ran at 5s, which is exactly the kind of
      // mismatch that makes a run-rate figure impossible to reason about.
      this.logger.event({
        level: 'warn',
        source: 'scheduler',
        code: 'tick_interval_clamped',
        message: `TICK_SECONDS=${configured} is below the 5s floor; running at ${effectiveSeconds}s`,
        data: { configured, effectiveSeconds },
      });
    }
    this.logger.event({
      level: 'info',
      source: 'scheduler',
      code: 'scheduler_cadence',
      message: `ticking every ${effectiveSeconds}s, up to ${this.config.scheduling.agentsPerTick} agents per group per tick`,
      data: {
        tickSeconds: effectiveSeconds,
        agentsPerTick: this.config.scheduling.agentsPerTick,
        groups: STRATEGY_GROUPS.length,
      },
    });
    const periodMs = effectiveSeconds * 1000;
    this.timer = setInterval(() => {
      void this.runTick().catch((error: unknown) => {
        // An unhandled rejection here would take the process down. One failed
        // tick must never do that: the next tick retries from durable state.
        this.logger.event({
          level: 'error',
          source: 'scheduler',
          code: 'tick_failed',
          message: 'scheduler tick threw; continuing',
          data: { error: error instanceof Error ? error.message : String(error) },
        });
      });
    }, periodMs);
    this.timer.unref?.();
    void this.runTick().catch(() => undefined);
  }

  /**
   * Stop the timer and wait for the tick that is already running.
   *
   * Waiting matters: a tick writes to SQLite, and a shutdown that closed the
   * database underneath it would turn an orderly stop into an error storm.
   */
  async stop(): Promise<void> {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    const inFlight = this.inFlight;
    if (inFlight) {
      try {
        await inFlight;
      } catch {
        /* the tick's own failure was already recorded */
      }
    }
  }

  /**
   * One full pass, single-flighted.
   *
   * A caller that arrives while a tick is already running joins that tick rather
   * than starting a second one. This matters because `start()` fires an immediate
   * tick and the interval can land on top of it: two concurrent ticks would each
   * try to post the 150 registrations, double the write rate and — on a real
   * service — breach the per-IP limit for no benefit.
   */
  async runTick(): Promise<TickReport> {
    const existing = this.inFlight;
    if (existing) return existing;
    const run = (async (): Promise<TickReport> => {
      const report = await this.tickOnce();
      this.tickCount += 1;
      this.lastTickReport = report;
      return report;
    })();
    // Assigned before the first await, so a concurrent caller always sees it.
    this.inFlight = run;
    try {
      return await run;
    } finally {
      this.inFlight = null;
    }
  }

  /**
   * One full pass. The order below is the design and is fixed:
   *
   *   read → verify → reconcile participation → reconcile settlement →
   *   run local strategies → validate risk → post trades →
   *   reconcile repost queue → persist status → return report
   *
   * Nothing may be inserted between "validate risk" and "post trades", and
   * background work (DeepSeek, upstream, the Lark report, the watchdog) is run
   * only *after* the trade path has closed for this tick — it can delay itself
   * but never reorder or block a trade posting.
   */
  private async tickOnce(): Promise<TickReport> {
    const at = this.now();
    // One CPU sample per tick, before any work: the reading the report prints is
    // the load of the interval that just ended, not a lifetime average.
    this.sampleProcessCpu();
    const state = this.loadGuard.poll();

    // read → verify: never shed, because reading is how we learn the problem is over.
    //
    // Under the continuous reader the fixed rooms are read by their own loops the
    // whole time, so this pass is not what makes the process keep up with `close1`
    // — it only reads the bounded dynamic set and republishes the derived state.
    const tick = await this.reader.schedulerPass();
    this.seedRiskBook();

    // reconcile participation (ParticipationService)
    const participation = await this.ensureParticipation();

    // reconcile settlement (SettlementService)
    const reconciled = this.reconcileMints();
    this.reconcileRefereeSettlements();

    // run local strategies → validate risk → post trades (TradingService)
    const runOutcome = this.runAgentSlices();
    this.recordRunStats(runOutcome.outcomes.map((outcome) => outcome.agentId));
    const trades = await this.executeActions(runOutcome.outcomes);
    // The participation fallback runs *after* the strategy, so an agent the
    // strategy already traded for is skipped rather than given a second trade.
    const participationTrades = await this.ensureParticipationTrades();

    // reconcile repost queue (RecoveryService)
    const repost = await this.reconcileReposts();

    // persist status → background operations (OperationsService), fully isolated
    const background = await this.runBackgroundOperations(at);
    const pin = this.repositories.upstream.getPin();

    return {
      at: at.toISOString(),
      tier: state.tier,
      sweep: tick.snapshot.sweep,
      reference: tick.snapshot.reference?.toString() ?? null,
      locked: tick.snapshot.locked,
      conservative: this.reader.verifier.state.conservative,
      rooms: {
        inserted: tick.inserted,
        readErrors: tick.errors,
        gaps: tick.health.reasons.length,
      },
      participation: {
        ...participation,
        minted: reconciled.minted,
        unknown: reconciled.unknown,
      },
      runs: {
        agents: runOutcome.outcomes.length,
        candidates: runOutcome.outcomes.filter((outcome) => outcome.action.intent !== 'NO_TRADE')
          .length,
        failures: runOutcome.failures.length,
      },
      trades,
      participationTrades,
      repost,
      watchdog: background.watchdog,
      lark: background.lark,
      deepseek: background.deepseek,
      upstream: {
        checked: background.upstream,
        drift: Number(pin?.drift ?? 0) === 1,
      },
    };
  }

  /**
   * Background operations (OperationsService).
   *
   * Everything that must never block, reorder or slow a trade posting: the
   * weekly watchdog, the Lark report and its maintenance pass, the model
   * parameter review and the upstream package check. Each one is:
   *
   *   - bounded by a timeout;
   *   - wrapped in its own try/catch, so a failure is a warning and not a tick;
   *   - recorded as a status/last_error event for the operator;
   *   - unable to mutate the market snapshot or change the referee's verdict.
   *
   * The trading path has already finished by the time this runs, so a hang here
   * costs a report, never a trade.
   */
  private async runBackgroundOperations(at: Date): Promise<{
    watchdog: { ran: boolean; backfilled: number };
    lark: { delivered: string[]; maintenance: boolean };
    deepseek: { attempted: string[]; refused: number };
    upstream: boolean;
  }> {
    let watchdog: { ran: boolean; backfilled: number } = { ran: false, backfilled: 0 };
    let lark: { delivered: string[]; maintenance: boolean } = { delivered: [], maintenance: false };
    let deepseek: { attempted: string[]; refused: number } = { attempted: [], refused: 0 };
    let upstream = false;

    // A cheap liveness reading for the status report, taken off the trade path.
    await this.measureEventLoopLag();

    // Alerts first: a critical event recorded this tick should not wait behind a
    // daily report that may be building. The outbox owns the retry.
    if (this.notifier) {
      try {
        await this.notifier.flush(25);
      } catch (error) {
        this.backgroundFailure('runtime_alert_flush_failed', error);
      }
    }

    try {
      watchdog = await withTimeout(this.maybeRunWatchdog(at), BACKGROUND_TIMEOUT_MS, 'watchdog');
      // A watchdog pass is not an ordinary tick: it backfills the agents a tick
      // slice skipped, and its runs are recorded under their own source. Counting
      // it here keeps the two out of each other's totals.
      if (watchdog.ran) this.runStats.watchdogRuns += 1;
    } catch (error) {
      this.backgroundFailure('watchdog_failed', error);
    }

    try {
      lark = await withTimeout(this.maybeReport(at), BACKGROUND_TIMEOUT_MS, 'lark_report');
    } catch (error) {
      this.backgroundFailure('lark_report_failed', error);
    }

    if (this.deepSeek && this.loadGuard.allow('llm')) {
      try {
        const result = await withTimeout(
          this.deepSeek.runOnce(at),
          BACKGROUND_TIMEOUT_MS,
          'deepseek',
        );
        deepseek = { attempted: result.attempted, refused: result.refused.length };
      } catch (error) {
        this.backgroundFailure('deepseek_slot_failed', error);
      }
    }

    // Lite does the package check once, at startup, and never again per tick: the
    // upstream repo is an audit source, and a periodic GitHub request has no
    // business sitting inside the contest loop.
    if (this.config.profile === 'full') {
      try {
        upstream = await withTimeout(
          this.maybeCheckUpstream(at),
          BACKGROUND_TIMEOUT_MS,
          'upstream_check',
        );
      } catch (error) {
        this.backgroundFailure('upstream_check_failed', error);
      }
    }

    return { watchdog, lark, deepseek, upstream };
  }

  /**
   * Sample process CPU over the interval since the previous tick.
   *
   * `process.cpuUsage()` is microseconds and `Date.now()` is milliseconds, so
   * the rate is `(cpuUsDelta / 1000) / wallMsDelta * 100`. The earlier version
   * divided the process's *lifetime* CPU time by its uptime and multiplied by
   * 100 without the `/1000`, which is a unit error, not a clamp problem: a
   * mostly-idle process reported 2182%.
   *
   * The first sample can only seed the baseline, so `percent` stays null until
   * the second tick. Nothing here clamps the result: a process genuinely using
   * more than one core may legitimately exceed 100%, and hiding that would be
   * the same class of mistake in the other direction.
   */
  private sampleProcessCpu(): void {
    const wallMs = Date.now();
    const cpu = process.cpuUsage();
    const cpuUs = cpu.user + cpu.system;
    const previous = this.cpuSample;
    const percent = previous === null ? null : processCpuPercent(previous, { cpuUs, wallMs });
    this.cpuSample = { cpuUs, wallMs, percent };
  }

  /** The last tick's process CPU percentage, or null while warming up. */
  private get processCpuPercent(): number | null {
    return this.cpuSample?.percent ?? null;
  }

  /**
   * Account for the agents this process actually evaluated.
   *
   * A "full fleet cycle" is every agent evaluated once; the cycle set is cleared
   * when it reaches the fleet size, so a restart at a different slice offset
   * still counts cycles rather than accumulating a partial one forever.
   */
  private recordRunStats(agentIds: string[]): void {
    this.runStats.agentsInCurrentTick = agentIds.length;
    this.runStats.evaluated += agentIds.length;
    const fleetSize = Math.max(1, this.keyStore.size);
    for (const agentId of agentIds) {
      this.runStats.uniqueAgents.add(agentId);
      this.runStats.cycleSeen.add(agentId);
    }
    if (this.runStats.cycleSeen.size >= fleetSize) {
      this.runStats.fleetCycles += 1;
      this.runStats.cycleSeen.clear();
    }
  }

  /** The predicted wall clock of the next tick, from the last one and the period. */
  private nextTickAt(): string | null {
    const last = this.lastTickReport?.at;
    if (last === undefined || last === null) return null;
    const periodMs = Math.max(5, this.config.scheduling.tickSeconds) * 1000;
    return new Date(Date.parse(last) + periodMs).toISOString();
  }

  /** Time a zero-delay timer: how long the loop took to come back to us. */
  private async measureEventLoopLag(): Promise<void> {
    const start = performance.now();
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 0);
    });
    this.lastEventLoopLagMs = Number((performance.now() - start).toFixed(2));
  }

  /** Record a background-task failure without letting it reach the tick. */
  private backgroundFailure(code: string, error: unknown): void {
    this.logger.event({
      level: 'warn',
      source: 'scheduler',
      code,
      message: 'background task failed; the trading path is unaffected',
      data: { error: error instanceof Error ? error.message : String(error) },
    });
  }

  // -------------------------------------------------------------------------
  // risk mirror
  // -------------------------------------------------------------------------

  /**
   * Seed the local account mirror from the mints the referee has confirmed.
   *
   * An account is only created for a DID the referee has actually minted. A
   * fabricated balance would let us post a trade the referee voids for `funds`,
   * which is worse than not trading.
   */
  private seedRiskBook(): void {
    for (const did of this.mintedDids()) {
      if (this.riskBook.has(did)) continue;
      this.riskBook.set(did, RiskAccount.withMint(did, this.rules.mint));
    }
  }

  private bootstrapRiskBook(): void {
    for (const row of this.repositories.participation.all()) {
      if (row.status === 'mint_observed' && !this.riskBook.has(row.did)) {
        this.riskBook.set(row.did, RiskAccount.withMint(row.did, this.rules.mint));
      }
    }
  }

  /** Every DID the referee has confirmed minted, from the persisted flow posts. */
  mintedDids(): Set<string> {
    const mints = new Set<string>();
    for (const row of this.repositories.referee.snapshotsSince('flow', 0)) {
      let payload: unknown;
      try {
        payload = JSON.parse(row.payload);
      } catch {
        continue;
      }
      const list = (payload as { mints?: unknown }).mints;
      if (!Array.isArray(list)) continue;
      for (const did of list) if (typeof did === 'string') mints.add(did);
    }
    for (const did of this.reader.verifier.observedMints()) mints.add(did);
    return mints;
  }

  /**
   * Every DID the referee's own `state` listing carries.
   *
   * The `owners` field of a state post is not shape-pinned by the published
   * schema, so this reads it defensively — an array of DIDs, an object keyed by
   * DID, or nested strings — and claims nothing when it cannot read it. A DID it
   * cannot find is simply absent, which is the honest outcome: no evidence
   * rather than assumed evidence.
   */
  stateListedDids(): Set<string> {
    const listed = new Set<string>();
    const visit = (value: unknown, depth: number): void => {
      if (depth > 4) return;
      if (typeof value === 'string') {
        if (value.startsWith('did:')) listed.add(value);
        return;
      }
      if (Array.isArray(value)) {
        for (const item of value) visit(item, depth + 1);
        return;
      }
      if (typeof value === 'object' && value !== null) {
        for (const [key, item] of Object.entries(value)) {
          if (key.startsWith('did:')) listed.add(key);
          visit(item, depth + 1);
        }
      }
    };
    for (const row of this.repositories.referee.snapshotsSince('state', 0)) {
      let payload: unknown;
      try {
        payload = JSON.parse(row.payload);
      } catch {
        continue;
      }
      visit((payload as { owners?: unknown }).owners, 0);
    }
    return listed;
  }

  /** Sweeps that produced a price but no flow: their mints are unknown, not zero. */
  sweepsWithMissingFlow(): number[] {
    const priceSweeps = new Set<number>();
    for (const row of this.repositories.referee.snapshotsSince('price', 0)) {
      if (row.sweep !== null && row.signature_valid === 1) priceSweeps.add(row.sweep);
    }
    const flowSweeps = new Set<number>();
    for (const row of this.repositories.referee.snapshotsSince('flow', 0)) {
      if (row.sweep !== null && row.signature_valid === 1) flowSweeps.add(row.sweep);
    }
    const current = this.reader.verifier.state.currentSweep ?? 0;
    return [...priceSweeps].filter((sweep) => sweep < current && !flowSweeps.has(sweep)).sort((a, b) => a - b);
  }

  // -------------------------------------------------------------------------
  // ParticipationService — owner registration, readback, mint status, lock
  // -------------------------------------------------------------------------

  /**
   * The contest's own wall-clock lock, read from the injected clock.
   *
   * Computed afresh on every write path rather than cached, so the three of
   * them cannot disagree and a lock that took effect mid-tick is seen by the
   * next write rather than the one before it.
   */
  private contestLock(): LockState {
    return lockState(this.now(), this.rules);
  }

  /**
   * Whether one agent's owner registration is on the register.
   *
   * The fact that matters is the room's own acknowledgement — a `technocore_seq`
   * from the POST — on a row that reached at least `posted`. A row that only
   * reached `created` or `failed` has no seq and has not registered, while a
   * `before_lock_confirmed` or `mint_observed` row is strictly past that point;
   * both the seq and the status rank are required so neither a shed write nor a
   * walk-back can pass.
   */
  private hasPostedRegistration(agentId: string): boolean {
    const row = this.repositories.participation.get(agentId);
    if (row === undefined) return false;
    if (row.technocore_seq === null) return false;
    return PARTICIPATION_RANK[row.status] >= PARTICIPATION_RANK.posted;
  }

  /**
   * Owner registration, counted the way the trading gate reads it.
   *
   * `ready` asks one question: does every expected owner have a persisted row
   * whose POST the room acknowledged with a seq, with no owner re-post still
   * owing work. It does *not* ask whether the referee minted — a mint is a
   * later, separate fact, and a sweep whose flow was omitted leaves mints
   * unknown rather than failed. Requiring a mint here would hold every trade on
   * evidence the referee may simply not have published, which is exactly the
   * conflation the layered counts exist to prevent.
   */
  private registrationProgress(): RegistrationProgress {
    const agents = [...this.keyStore.agentIds];
    const expected = agents.length;
    let postAcked = 0;
    let pending = 0;
    let failed = 0;
    for (const agentId of agents) {
      const row = this.repositories.participation.get(agentId);
      if (row !== undefined && row.technocore_seq !== null) {
        postAcked += 1;
      } else if (row?.status === 'failed') {
        failed += 1;
      } else {
        pending += 1;
      }
    }
    const counts = this.repositories.participation.outcomeCounts();
    const unresolvedMissed = this.repositories.reposts.unresolved('owner') > 0;
    const ready = postAcked === expected && !unresolvedMissed;
    return {
      ready,
      expected,
      postAcked,
      pending,
      failed,
      roomEchoed: counts.roomEchoConfirmed,
      mintConfirmed: counts.mintConfirmed,
      mintUncertain: counts.mintUncertain,
      unresolvedMissed,
      reason: ready
        ? null
        : registrationGateReason({
            registrationPostAcked: postAcked,
            registrationExpected: expected,
            registrationPending: pending,
            registrationFailed: failed,
            registrationUnresolvedMissed: unresolvedMissed,
          }),
    };
  }

  /**
   * Drive every agent to `readback_confirmed` (and beyond, as the referee
   * confirms mints). Idempotent: the ledger is `participation_records`.
   */
  async ensureParticipation(): Promise<ParticipationOutcome> {
    const outcome: ParticipationOutcome = {
      readback: 0,
      posted: 0,
      pending: 0,
      failed: 0,
      minted: 0,
      unknown: 0,
    };
    const room = this.rules.tradingRoom;
    const verifierState = this.reader.verifier.state;

    // 1. Readback first: a registration already echoed back needs nothing else.
    const echoed = this.reader.ownOwnerRegistrations();
    for (const agentId of this.keyStore.agentIds) {
      const did = this.keyStore.did(agentId);
      const seen = echoed.get(did);
      if (!seen) continue;
      const existing = this.repositories.participation.get(agentId);
      const confirmed: ParticipationStatus =
        verifierState.currentSweep === null || verifierState.currentSweep <= this.rules.lockSweep
          ? 'before_lock_confirmed'
          : 'readback_confirmed';
      // The room echoing our exact bytes is ground truth: it settles the row even
      // if a previous tick had already written it off as `registration_closed`.
      const next =
        existing?.status === 'registration_closed'
          ? confirmed
          : advanceStatus(existing?.status ?? 'created', confirmed);
      if (existing?.status === next && existing.readback_at !== null) continue;
      this.recordReadback(agentId, did, seen, existing, next);
      outcome.readback += 1;
    }

    // 2. The lock is a hard stop for owner registrations. Past it a registration
    // cannot mint, so posting one is pure noise on a contest room — and a row
    // still waiting for a readback is not "in flight", it is a terminal miss.
    const sweep = verifierState.currentSweep;
    if (sweep !== null && sweep > this.rules.lockSweep) {
      const closed = this.closeUnregistered();
      outcome.pending = 0;
      // Only the tick that actually closes rows says anything: past the lock
      // every tick takes this branch, and a once-a-minute line would be noise.
      if (closed > 0) {
        this.logger.event({
          level: 'warn',
          source: 'scheduler',
          code: 'registration_closed',
          message: `the lock passed at sweep ${this.rules.lockSweep}; ${closed} agent(s) never got a readback`,
          data: { sweep, lockSweep: this.rules.lockSweep, closed },
        });
      }
      return outcome;
    }

    // 3. Post anything that has not been seen on the room yet.
    //
    // A late start that was asked for and did not arm is held here rather than at
    // the live gate: its confirmations are missing, so nothing it wrote would be
    // trustworthy, and it must not become a live process by looking like one.
    if (this.lateStartMisconfigured) {
      this.logger.event({
        level: 'error',
        source: 'scheduler',
        code: 'late_start_not_armed',
        message:
          'LATE_START_MODE was requested but did not arm; owner registrations are held: ' +
          `${this.config.lateStartBlockedReason ?? 'unknown reason'}`,
        data: {
          blockedReason: this.config.lateStartBlockedReason,
          allowRegistration: this.config.allowRegistration,
        },
      });
      return outcome;
    }
    if (!this.config.allowRegistration) {
      this.logger.event({
        level: 'info',
        source: 'scheduler',
        code: 'registration_disabled',
        message: 'FLOP_ALLOW_REGISTRATION is off; owner registrations are not posted',
        data: { agents: this.keyStore.size },
      });
      return outcome;
    }
    if (this.loadGuard.state.paused.readsOnly) {
      this.logger.event({
        level: 'warn',
        source: 'scheduler',
        code: 'registration_skipped_readonly',
        message: 'read-only protection mode: no writes, including registrations',
        data: {},
      });
      return outcome;
    }
    // Live only: a registration is a signed commitment to a referee we have not
    // yet proven. Until the seed, the pin and the stored history all agree,
    // posting one is noise at best and a forged-referee exposure at worst.
    if (this.config.liveArmed) {
      const gates = this.readiness();
      // A late start is asked a different question, and `registration` already
      // carries it: the late-start registration gate nests the late-start feed
      // gate, whose first clause is the pin rather than the seed. Consulting the
      // strict gate here instead would demand a seed a late start cannot reach,
      // and the 150 registrations would be held forever.
      const blocked = this.config.lateStartArmed
        ? !gates.registration.ready
        : !gates.refereeFeed.ready || !gates.registration.ready;
      // The feed gate and the registration gate are named separately: the referee
      // can be perfectly provable while our own write lane is not, and an operator
      // needs to know which of the two is holding the 150 registrations.
      if (blocked) {
        const reasons = this.config.lateStartArmed
          ? [...gates.registration.reasons]
          : [...gates.refereeFeed.reasons, ...gates.registration.reasons];
        this.logger.event({
          level: 'error',
          source: 'scheduler',
          code: 'registration_blocked',
          message: `registration is not ready; owner registrations are held: ${reasons.join('; ')}`,
          data: {
            refereeFeedReady: gates.refereeFeed.ready,
            registrationReady: gates.registration.ready,
            reasons,
          },
        });
        return outcome;
      }
    }

    for (const agentId of this.keyStore.agentIds) {
      const did = this.keyStore.did(agentId);
      if (echoed.has(did)) continue;
      const existing = this.repositories.participation.get(agentId);
      if (existing && existing.technocore_seq !== null) continue;
      const result = await this.postRegistration(agentId, did, room);
      if (result.posted) outcome.posted += 1;
      else if (result.failed) outcome.failed += 1;
    }

    outcome.pending = this.repositories.participation.all().filter((row) => row.readback_at === null)
      .length;
    return outcome;
  }

  /**
   * Write off every row that was attempted but never read back, once the lock
   * has passed. `registration_closed` is terminal and outranks `posted`, so a
   * later tick cannot resurrect the row as if it were still in flight.
   *
   * Rows with no recorded attempt are left alone: they were never posted, so
   * "closed" would misreport what happened.
   */
  private closeUnregistered(): number {
    let closed = 0;
    for (const row of this.repositories.participation.all()) {
      if (row.readback_at !== null) continue;
      if (row.attempts === 0) continue;
      if (row.status === 'registration_closed') continue;
      this.repositories.participation.upsert({
        ...row,
        status: 'registration_closed',
        last_error: row.last_error ?? 'lock_passed_without_readback',
        updated_at: this.now().toISOString(),
      });
      closed += 1;
      this.logger.event({
        level: 'warn',
        source: 'scheduler',
        code: 'owner_registration_closed',
        message: `${row.agent_id} never got a readback before the lock`,
        data: { agentId: row.agent_id, attempts: row.attempts, previous: row.status },
      });
    }
    return closed;
  }

  private async postRegistration(
    agentId: string,
    did: string,
    room: string,
  ): Promise<{ posted: boolean; failed: boolean }> {
    const text = ownerRegistrationText(did);
    const attempts = (this.repositories.participation.get(agentId)?.attempts ?? 0) + 1;
    try {
      const result = await this.writer.postOwnerRegistration(agentId, room);
      // The writer signs `<room>|<nonce>|<text>` with the agent's key and returns
      // the nonce it used. Re-deriving the envelope reproduces the exact bytes
      // that were sent, which is what the evidence row must contain.
      const envelope = result.ok
        ? this.keyStore.withSeed(agentId, (seed, agentDid) =>
            signRoomMessage(agentDid, seed, room, result.nonce, text),
          )
        : null;
      const status: ParticipationStatus =
        result.ok && result.seq !== undefined ? 'posted' : result.shed === true ? 'created' : 'failed';
      this.repositories.participation.upsert({
        agent_id: agentId,
        did,
        season: this.rules.season,
        registration_text: text,
        registration_nonce: result.nonce,
        registration_signature: envelope?.sig ?? '',
        room,
        technocore_seq: result.seq ?? null,
        technocore_ts: null,
        posted_at: result.ok ? this.now().toISOString() : null,
        readback_at: null,
        package_hash: this.reader.verifier.state.packageHash ?? this.pinnedPackageHash() ?? '',
        referee_did: this.reader.verifier.state.refereeDid,
        status,
        attempts,
        last_error: result.ok ? null : (result.reason ?? `status ${result.status ?? 0}`),
        updated_at: this.now().toISOString(),
        // The local half of "was this write actually recorded": the POST's own
        // correlation id and a hash of the exact body, so a room echo can be
        // matched to the write that produced it rather than assumed.
        post_request_id: localPostRequestId(room, did, result.nonce),
        message_hash: messageHash(text),
        post_sweep: this.reader.verifier.state.currentSweep,
        flow_evidence_at: null,
        state_evidence_at: null,
      });
      if (result.ok) {
        this.logger.event({
          level: 'info',
          source: 'scheduler',
          code: 'owner_registration_posted',
          message: `posted the owner registration for ${agentId}`,
          data: { agentId, seq: result.seq ?? null, room },
        });
      }
      return { posted: result.ok, failed: !result.ok && status === 'failed' };
    } catch (error) {
      this.repositories.participation.upsert({
        agent_id: agentId,
        did,
        season: this.rules.season,
        registration_text: text,
        registration_nonce: '',
        registration_signature: '',
        room,
        technocore_seq: null,
        technocore_ts: null,
        posted_at: null,
        readback_at: null,
        package_hash: this.pinnedPackageHash() ?? '',
        referee_did: this.reader.verifier.state.refereeDid,
        status: 'failed',
        attempts,
        last_error: error instanceof Error ? error.message : String(error),
        updated_at: this.now().toISOString(),
        // No POST was accepted, so there is nothing to reconcile: a failed write
        // leaves no request id and no body hash behind.
        post_request_id: null,
        message_hash: null,
        post_sweep: this.reader.verifier.state.currentSweep,
        flow_evidence_at: null,
        state_evidence_at: null,
      });
      this.logger.event({
        level: 'error',
        source: 'scheduler',
        code: 'owner_registration_failed',
        message: `owner registration for ${agentId} threw`,
        data: { agentId, error: error instanceof Error ? error.message : String(error) },
      });
      return { posted: false, failed: true };
    }
  }

  /**
   * Store the readback evidence: the room's own seq and timestamp for our exact
   * bytes. This is the row the contest's minimum participation record consists of.
   */
  private recordReadback(
    agentId: string,
    did: string,
    seen: { seq: number; ts: string; text: string },
    existing: ParticipationRow | undefined,
    status: ParticipationStatus,
  ): void {
    const at = this.now().toISOString();
    const nonce = existing?.registration_nonce ?? '';
    const signature = existing?.registration_signature ?? '';
    const packageHash = this.reader.verifier.state.packageHash ?? this.pinnedPackageHash() ?? '';
    const refereeDid = this.reader.verifier.state.refereeDid;

    this.repositories.participation.upsert({
      agent_id: agentId,
      did,
      season: this.rules.season,
      registration_text: existing?.registration_text ?? ownerRegistrationText(did),
      registration_nonce: nonce,
      registration_signature: signature,
      room: this.rules.tradingRoom,
      technocore_seq: seen.seq,
      technocore_ts: seen.ts,
      posted_at: existing?.posted_at ?? null,
      readback_at: at,
      package_hash: packageHash,
      referee_did: refereeDid,
      status,
      attempts: existing?.attempts ?? 1,
      last_error: null,
      updated_at: at,
      // The readback is the room echoing our bytes: it does not invent a request
      // id, so whatever the POST recorded is carried through untouched.
      post_request_id: existing?.post_request_id ?? null,
      message_hash: existing?.message_hash ?? messageHash(existing?.registration_text ?? ownerRegistrationText(did)),
      post_sweep: existing?.post_sweep ?? null,
      flow_evidence_at: existing?.flow_evidence_at ?? null,
      state_evidence_at: existing?.state_evidence_at ?? null,
    });

    // The durable evidence copy. INSERT OR IGNORE on agent_id: the first
    // readback is the one that counts and it is never rewritten.
    this.repositories.participation.upsertOwnerRegistration({
      agent_id: agentId,
      did,
      season: this.rules.season,
      registration_text: existing?.registration_text ?? ownerRegistrationText(did),
      registration_nonce: nonce,
      registration_signature: signature,
      room: this.rules.tradingRoom,
      technocore_seq: seen.seq,
      technocore_ts: seen.ts,
      readback_at: at,
      package_hash: packageHash,
      referee_did: refereeDid,
      raw_record: JSON.stringify({
        room: this.rules.tradingRoom,
        seq: seen.seq,
        ts: seen.ts,
        text: seen.text,
      }),
    });

    this.logger.event({
      level: 'info',
      source: 'scheduler',
      code: 'owner_registration_readback',
      message: `readback confirmed for ${agentId} at seq ${seen.seq}`,
      data: { agentId, seq: seen.seq, ts: seen.ts, status },
    });
  }

  /**
   * Move participation rows forward as the referee's flow posts arrive.
   *
   * `mint_observed` when our DID appears in a flow's mints; `mint_unknown` when
   * a sweep's flow was omitted entirely. The second is never a failure and never
   * becomes one.
   */
  reconcileMints(): { minted: number; unknown: number } {
    const mints = this.mintedDids();
    const missingFlow = this.sweepsWithMissingFlow();
    const stateListed = this.stateListedDids();
    const current = this.reader.verifier.state.currentSweep;
    const at = this.now().toISOString();
    let minted = 0;
    let unknown = 0;

    for (const row of this.repositories.participation.all()) {
      // The referee's own evidence, recorded before anything is concluded from
      // it: a DID in a flow's mints or a state listing is the referee saying it
      // saw our registration, which is a different fact from the room echoing
      // our bytes and is kept in its own column.
      if (mints.has(row.did) && row.flow_evidence_at === null) {
        this.repositories.participation.markRefereeEvidence(row.agent_id, 'flow', at);
      }
      if (stateListed.has(row.did) && row.state_evidence_at === null) {
        this.repositories.participation.markRefereeEvidence(row.agent_id, 'state', at);
      }
      let status = row.status;
      if (mints.has(row.did)) {
        status = advanceStatus(status, 'mint_observed');
      } else if (
        missingFlow.length > 0 &&
        current !== null &&
        row.readback_at !== null &&
        PARTICIPATION_RANK[status] < PARTICIPATION_RANK.mint_observed
      ) {
        status = advanceStatus(status, 'mint_unknown');
      }
      if (status === row.status) continue;
      this.repositories.participation.upsert({
        ...row,
        status,
        updated_at: this.now().toISOString(),
      });
      if (status === 'mint_observed') {
        minted += 1;
        this.logger.event({
          level: 'info',
          source: 'scheduler',
          code: 'mint_observed',
          message: `the referee minted ${row.agent_id}`,
          data: { agentId: row.agent_id },
        });
      } else if (status === 'mint_unknown') {
        unknown += 1;
        this.logger.event({
          level: 'warn',
          source: 'scheduler',
          code: 'mint_unknown',
          message: `mint status unknown for ${row.agent_id}: a sweep's flow was omitted`,
          data: { agentId: row.agent_id, sweeps: missingFlow.slice(-5) },
        });
      }
    }
    return { minted, unknown };
  }

  // -------------------------------------------------------------------------
  // SettlementService — referee flow parsing, settled/void, funds reason
  // -------------------------------------------------------------------------
  /**
   * Apply the referee's own per-trade outcomes.
   *
   * `flow.settled` / `flow.void` are the referee naming what happened to trades
   * it saw, and the shape is not pinned by the published schema, so this parses
   * defensively: an id list, a list of `{id|tid, reason}` rows, or an id→reason
   * map. Anything it cannot read is skipped rather than guessed at.
   *
   * `reason: funds` is the one verdict that is ambiguous — the referee does not
   * say which side was short — so `referee_funds_side` is stored as `unknown`
   * with `funds_side_confidence = 'official'`, and our own inference is kept
   * separately, labelled `local_inference`.
   */
  reconcileRefereeSettlements(): { settled: number; voided: number; funds: number } {
    const outcome = { settled: 0, voided: 0, funds: 0 };
    for (const row of this.repositories.referee.snapshotsSince('flow', 0)) {
      if (row.signature_valid !== 1) continue;
      let payload: Record<string, unknown>;
      try {
        payload = JSON.parse(row.payload) as Record<string, unknown>;
      } catch {
        continue;
      }
      for (const [list, defaultReason] of [
        [payload.settled, 'settled'],
        [payload.void, 'void'],
      ] as const) {
        for (const entry of parseOutcomeList(list, defaultReason)) {
          const trade = this.repositories.trades.get(entry.id);
          if (!trade) continue;
          if (trade.referee_reason === entry.reason) continue;
          this.repositories.trades.recordRefereeVerdict(entry.id, {
            reason: entry.reason,
            fundsSide: entry.reason === 'funds' ? 'unknown' : null,
            settleSweep: row.sweep ?? null,
          });
          if (trade.status !== 'settled' && trade.status !== 'void') {
            this.repositories.trades.updateStatus(
              entry.id,
              entry.reason === 'settled' ? 'settled' : 'void',
              entry.reason,
              row.sweep ?? undefined,
            );
          }
          if (entry.reason === 'settled') outcome.settled += 1;
          if (entry.reason === 'funds') {
            outcome.funds += 1;
            this.logger.event({
              level: 'warn',
              source: 'scheduler',
              code: 'referee_funds_verdict',
              message:
                `trade ${entry.id} was voided for funds; the referee did not name a side ` +
                '(official side: unknown)',
              data: { tradeId: entry.id, sweep: row.sweep, localInference: trade.local_funds_side },
            });
          }
          if (entry.reason !== 'settled' && entry.reason !== 'funds') outcome.voided += 1;
        }
      }
    }
    return outcome;
  }

  // -------------------------------------------------------------------------
  // RecoveryService — repost queue, cursor gaps, snapshot replay, outbox
  // -------------------------------------------------------------------------

  /**
   * Queue the local messages the referee reported as `missed`, and re-post them.
   *
   * The rules this holds to, in order:
   *   - only a message that is genuinely ours, matched on the room, the seq and
   *     the DID (or, for a trade, the trade id) is queued at all;
   *   - a message that cannot be matched is recorded and alerted about, never
   *     re-posted;
   *   - nothing is re-posted after the lock, and nothing to a room the referee
   *     has unlisted — such a message goes to `close1` instead, which never
   *     leaves the list;
   *   - the business content is byte-for-byte the original; only the outer nonce
   *     and its signature are regenerated;
   *   - each original message is queued once (the unique key survives a restart)
   *     and re-posted at most once.
   */
  async reconcileReposts(): Promise<{
    queued: number;
    posted: number;
    failed: number;
    skipped: number;
  }> {
    const queued = this.planReposts();
    const result = { queued, posted: 0, failed: 0, skipped: 0 };
    if (this.loadGuard.state.paused.readsOnly) return result;
    const sweep = this.reader.verifier.state.currentSweep;
    // The contest's own wall clock, checked before any re-post. Unlike the
    // referee's sweep it is true even when the feed has gone silent — and a
    // re-post past the deadline cannot count, so it is recorded and skipped.
    const wallClock = this.contestLock();

    for (const row of this.repositories.reposts.retryable()) {
      if (!wallClock.beforeLock) {
        this.repositories.reposts.markSkipped(row.id!, 'locked_by_wall_clock');
        result.skipped += 1;
        continue;
      }
      // The lock closes re-posting exactly as it closes registration: past it a
      // re-post cannot count, so it is noise on a contest room.
      if (sweep !== null && sweep > this.rules.lockSweep) {
        this.repositories.reposts.markSkipped(row.id!, 'lock_passed');
        result.skipped += 1;
        continue;
      }
      if (!this.repostAllowed(row.message_kind)) continue;

      const target = this.repostRoomFor(row.original_room);
      const posted = await this.writer.postRaw(
        row.agent_id,
        target,
        row.original_text,
        'repost',
      );
      if (posted.ok) {
        this.repositories.reposts.markPosted(row.id!, {
          newRoom: target,
          newNonce: posted.nonce,
          newSeq: posted.seq ?? null,
        });
        result.posted += 1;
        this.logger.event({
          level: 'info',
          source: 'scheduler',
          code: 'repost_posted',
          message: `re-posted a missed ${row.message_kind} for ${row.agent_id} into ${target}`,
          data: {
            agentId: row.agent_id,
            originalRoom: row.original_room,
            originalSeq: row.original_seq,
            newRoom: target,
            newSeq: posted.seq ?? null,
          },
        });
      } else {
        this.repositories.reposts.markFailed(row.id!, posted.reason ?? 'repost_failed');
        result.failed += 1;
      }
    }
    return result;
  }

  /** A re-post is a write, so it obeys the same two gates a fresh post does. */
  private repostAllowed(kind: string): boolean {
    return kind === 'trade' ? this.config.tradingArmed : this.config.allowRegistration;
  }

  /**
   * Where a re-post may go.
   *
   * Never into a room the referee has unlisted: it stopped reading it, so the
   * message would be missed again. `close1` is the fallback, because the rules
   * say it never leaves the list.
   */
  private repostRoomFor(originalRoom: string): string {
    const safe = this.rules.tradingRoom;
    if (originalRoom === safe) return safe;
    const registry = this.repositories.roomRegistry.get(originalRoom);
    return registry !== undefined && registry.listed === 1 ? originalRoom : safe;
  }

  /** Turn the recorded `missed` anomalies into queue rows, once each. */
  private planReposts(): number {
    const byDid = this.agentIdByDid();
    let queued = 0;
    for (const anomaly of this.repositories.refereeAnomalies.byKind('referee_missed')) {
      let entry: Record<string, unknown>;
      try {
        const parsed: unknown = JSON.parse(anomaly.raw_payload ?? 'null');
        if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) continue;
        entry = parsed as Record<string, unknown>;
      } catch {
        continue;
      }
      const room = typeof entry.room === 'string' ? entry.room : anomaly.room;
      const seq = typeof entry.seq === 'number' ? entry.seq : null;
      if (room === null || seq === null) continue;

      const message = this.repositories.messages.get(room, seq);
      const did = message?.sender_did ?? null;
      if (message === undefined || did === null || !this.keyStore.didSet().has(did)) {
        // Cannot be matched to one of ours: record it and alert, never re-post.
        this.repositories.reposts.enqueue({
          original_room: room,
          original_seq: seq,
          agent_id: '',
          did: typeof entry.did === 'string' ? entry.did : '',
          message_kind: 'unknown',
          trade_id: null,
          original_text: '',
          reason: 'unmatched_local_message',
          status: 'skipped',
        });
        this.logger.event({
          level: 'warn',
          source: 'scheduler',
          code: 'repost_unmatched',
          message: `a message the referee missed at ${room}#${seq} could not be matched locally; nothing is re-posted`,
          data: { room, seq, anomalyId: anomaly.id },
        });
        queued += 1;
        continue;
      }

      const agentId = byDid.get(did);
      if (agentId === undefined) continue;
      if (this.repositories.reposts.has(room, seq, did)) continue;

      const tradeId = message.kind === 'trade' ? (tradeIdOf(message.text) ?? null) : null;
      if (tradeIdMatches(entry, tradeId) === false) {
        this.repositories.reposts.enqueue({
          original_room: room,
          original_seq: seq,
          agent_id: agentId,
          did,
          message_kind: message.kind,
          trade_id: tradeId,
          original_text: message.text,
          reason: 'trade_id_mismatch',
          status: 'skipped',
        });
        queued += 1;
        continue;
      }

      // A late start never re-posts a missed trade verbatim. A trade id settles
      // at most once, so re-sending the same id is the one way a local ledger and
      // the referee's could disagree — the original may already have been read
      // under a sweep the summary did not show. The row is recorded as
      // deliberately set aside, the original stops counting as participation, and
      // the fallback re-issues the pair under a fresh id at the next sweep.
      if (message.kind === 'trade' && this.config.lateStartArmed) {
        const setAside = this.repositories.reposts.enqueue({
          original_room: room,
          original_seq: seq,
          agent_id: agentId,
          did,
          message_kind: 'trade',
          trade_id: tradeId,
          original_text: message.text,
          reason: 'late_start_reissue_required',
          status: 'skipped',
        });
        if (tradeId !== null) {
          const trade = this.repositories.trades.get(tradeId);
          if (trade !== undefined && trade.status !== 'settled' && trade.status !== 'void') {
            this.repositories.trades.updateStatus(tradeId, 'missed', 'referee_missed');
          }
        }
        this.logger.event({
          level: 'warn',
          source: 'scheduler',
          code: 'late_start_trade_missed',
          message: `the referee missed trade ${tradeId ?? '(unparsed)'} at ${room}#${seq}; it will be re-issued under a new id`,
          data: { room, seq, tradeId, agentId, originalNonce: message.nonce },
        });
        if (setAside) queued += 1;
        continue;
      }

      const accepted = this.repositories.reposts.enqueue({
        original_room: room,
        original_seq: seq,
        agent_id: agentId,
        did,
        message_kind: message.kind,
        trade_id: tradeId,
        original_text: message.text,
        reason: 'referee_missed',
        status: 'pending',
      });
      if (accepted) queued += 1;
    }
    return queued;
  }

  private agentIdByDid(): Map<string, string> {
    if (this.didIndex.size === 0) {
      for (const agentId of this.keyStore.agentIds) {
        this.didIndex.set(this.keyStore.did(agentId), agentId);
      }
    }
    return this.didIndex;
  }

  // -------------------------------------------------------------------------
  // TradingService — strategy outcomes, risk validation, signing, posting
  // -------------------------------------------------------------------------

  /**
   * Run one slice per group this tick.
   *
   * A run is a local deterministic evaluation and nothing else: no network, no
   * model, no heartbeat. That is why it is not gated on the load guard's trading
   * tiers — it is the 7x24h participation floor, and it costs microseconds.
   */
  private runAgentSlices(): { outcomes: RunOutcome[]; failures: Array<{ agentId: string; error: string }> } {
    const snapshot = this.reader.snapshot();
    // A late start does not take strangers' offers. Counting on an unknown
    // counterparty's collateral is the one risk this mode has no way to bound —
    // it cannot see the history that would tell it whether the maker is funded —
    // so the only offers an agent answers are the ones the fleet drives itself.
    const offers = this.config.lateStartArmed ? [] : this.reader.externalOffers();
    const perGroup = Math.max(1, this.config.scheduling.agentsPerTick);
    const inputs = STRATEGY_GROUPS.flatMap((group) => {
      const agents = this.repositories.identities
        .all()
        .filter((row) => row.strategy_group === group && row.enabled === 1)
        .map((row) => row.agent_id)
        .sort();
      const slice = GroupRunner.partition(agents, this.tickCount, perGroup);
      return slice.map((agentId) => this.buildRunInput(agentId, group, snapshot, offers));
    });
    return this.runner.runBatch(inputs, 'scheduler');
  }

  private buildRunInput(
    agentId: string,
    group: StrategyGroupName,
    snapshot: MarketSnapshot,
    offers: ReturnType<OrchestratorReader['externalOffers']>,
  ) {
    const identity = this.repositories.identities.get(agentId);
    const caps = {
      maxQty: Decimal.from(identity?.max_qty ?? '0'),
      maxOpenNotional: Decimal.from(identity?.max_open_notional ?? '0'),
      cooldownSweeps: identity?.cooldown_sweeps ?? 0,
      confidenceThreshold: Decimal.from(identity?.confidence_threshold ?? '1'),
    };
    const effective = this.repositories.strategyVersions.effective(group);
    const params = effective
      ? asDecimals(JSON.parse(effective.params_json) as Record<string, number>)
      : asDecimals(fallbackParams(group).values);
    const account = this.riskBook.get(this.keyStore.did(agentId));
    const open = this.openNotionalFor(agentId, snapshot.sweep);
    return {
      agentId,
      group,
      params,
      caps,
      market: snapshot,
      position: account?.position ?? Decimal.zero(),
      cash: account?.cash ?? Decimal.zero(),
      openNotional: open,
      lastTradeSweep: this.lastTradeSweep(agentId),
      randomSeed: identity?.random_seed ?? 0,
      sameDirectionStreak: this.sameDirectionStreak(agentId),
      externalOffers: group === 'external_offer_taker' ? offers : [],
      sweep: snapshot.sweep,
      // A late start takes the bootstrap decision in place of the group profile,
      // because the profile needs a history the missing seed would have provided.
      // `external_offer_taker` is excluded: its input is a stranger's offer from
      // a book we cannot audit, which is not a price signal at all.
      ...(this.config.lateStartArmed && group !== 'external_offer_taker'
        ? { lateStartBootstrap: { enabled: this.config.lateStartStrategyTradingArmed } }
        : {}),
    };
  }

  /** Open notional we are carrying, from our own not-yet-settled local trades. */
  private openNotionalFor(agentId: string, sweep: number): Decimal {
    let total = Decimal.zero();
    for (const trade of this.repositories.trades.openForAgent(agentId)) {
      if (trade.until_sweep < sweep) continue;
      total = total.add(Decimal.from(trade.qty).mul(Decimal.from(trade.px)));
    }
    return total;
  }

  private lastTradeSweep(agentId: string): number | null {
    let latest: number | null = null;
    for (const trade of this.repositories.trades.openForAgent(agentId)) {
      if (latest === null || trade.until_sweep > latest) latest = trade.until_sweep;
    }
    return latest;
  }

  private sameDirectionStreak(agentId: string): number {
    const rows = this.db
      .prepare(
        "SELECT side FROM trades WHERE agent_id = ? AND status IN ('settled','pending') ORDER BY created_at DESC LIMIT 8",
      )
      .all(agentId) as Array<{ side: string }>;
    if (rows.length === 0) return 0;
    const first = rows[0]!.side;
    let streak = 0;
    for (const row of rows) {
      if (row.side !== first) break;
      streak += 1;
    }
    return streak;
  }

  // -------------------------------------------------------------------------
  // TradingService — trade writer
  // -------------------------------------------------------------------------

  /**
   * The participation trade: one small matched trade per agent, once.
   *
   * This serves presence, not score. Every one of the 150 owners should end the
   * contest with at least one trade the referee actually ruled on, and the
   * deterministic strategy cannot promise that: a flat market, a risk cap or a
   * shed tier can each leave an agent with nothing to do. So a late start pairs
   * the fleet into 75 fixed couples and writes one legal trade each.
   *
   * Everything is derived from the referee's *current* post and nothing else —
   * the price from the published band, `until` from the band's own `for` sweep,
   * the quantity from the rules' minimum — so the trade is bounded by exactly
   * what the referee said, not by a local reconstruction of it. It is written
   * only while the late-start trading gate is satisfied, and the `trades` ledger
   * — not a counter — is what makes it at-most-once per agent.
   */
  private async ensureParticipationTrades(): Promise<{
    pairs: number;
    posted: number;
    skipped: number;
    refused: number;
  }> {
    const result = { pairs: 0, posted: 0, skipped: 0, refused: 0 };
    // Only a late start owes this fallback. The strict mode has a replayed
    // history and its own strategy path; it is not handed a second, blunter one.
    if (!this.config.lateStartTradingArmed) return result;
    if (this.loadGuard.state.paused.readsOnly) return result;

    const snapshot = this.reader.snapshot();
    const limits = snapshot.nextLimits;
    const forSweep = snapshot.limitsForSweep;
    // Without `for` there is no sweep for `until` to bind to, and a band the
    // verifier marked unusable may not price a live trade. Both are recorded and
    // reported; neither is a licence to guess.
    if (limits === null || forSweep === null || snapshot.limitsUsable === false) return result;
    if (snapshot.locked) return result;

    // The same gate the strategy path obeys, so the two can never disagree about
    // whether a trade may be written. A refusal here is not an error: `/status`
    // names the reason, and the fallback simply runs again on the next tick.
    const gates = this.readiness();
    if (!gates.lateStart.feed.ready || !gates.lateStart.marketSnapshot.ready) return result;
    // Registration precedes trade for the whole fleet, not merely for a pair:
    // the fallback owes one trade per agent, so it waits until every owner is on
    // the register with a seq. A pair-local check would let the first pairs
    // trade while the last owners were still unregistered.
    if (!gates.lateStart.registrationProgress.ready) return result;
    // The contest's own wall clock, re-checked here rather than trusted from the
    // referee feed: a feed that stopped talking must not let the fallback write
    // past the published deadline.
    if (!gates.lateStart.lock.beforeLock) return result;

    const px = this.participationPrice(limits);
    if (px === null) return result;
    const qty = this.rules.minQty;

    // Only the owners who do not already have an effective trade. A bootstrap
    // trade written earlier in this tick is a trade the referee will rule on, so
    // that owner is covered already; pairing the full fleet blindly would either
    // hand them a second position or leave their partner with none.
    const agents = [...this.keyStore.agentIds]
      .sort()
      .filter(
        (agentId) => !this.repositories.trades.hasEffectiveTradeForDid(this.keyStore.did(agentId)),
      );
    for (let i = 0; i + 1 < agents.length; i += 2) {
      const makerAgentId = agents[i]!;
      const takerAgentId = agents[i + 1]!;
      result.pairs += 1;
      const makerDid = this.keyStore.did(makerAgentId);
      const takerDid = this.keyStore.did(takerAgentId);
      if (makerDid === takerDid) {
        result.skipped += 1;
        continue;
      }
      // Registration first, structurally and not incidentally: a trade written
      // before both owners are on the register would settle against an account
      // the referee has not minted yet. `technocore_seq` is the room's own
      // acknowledgement, which is what makes the registration real.
      const registered = [makerAgentId, takerAgentId].every((id) => {
        const row = this.repositories.participation.get(id);
        return row !== undefined && row.technocore_seq !== null;
      });
      if (!registered) {
        result.skipped += 1;
        continue;
      }
      // A missed copy has already spent its id, so the re-issue moves to the
      // next generation; a refused one never spent one, so it retries its own.
      const id = participationTradeId(
        makerDid,
        takerDid,
        forSweep,
        this.repositories.trades.pairGenerations(makerDid, takerDid),
      );
      const existing = this.repositories.trades.get(id);
      if (existing !== undefined && !REWRITABLE_TRADE_STATUS.has(existing.status)) {
        result.skipped += 1;
        continue;
      }

      let terms: TradeTerms;
      let signed: SignedTrade;
      try {
        terms = buildTerms({
          id,
          maker: makerDid,
          side: 'buy',
          qty,
          px,
          until: forSweep,
          taker: takerDid,
        });
        signed = this.keyStore.withSeed(makerAgentId, (makerSeed) =>
          this.keyStore.withSeed(takerAgentId, (takerSeed) =>
            // Both halves in one call: the maker signs the terms and the taker
            // signs the accept payload, so the message carries a countersigned
            // pair rather than an open offer nobody answered.
            signTrade({ terms, taker: takerDid, makerSeed, takerSeed }),
          ),
        );
      } catch (error) {
        result.refused += 1;
        this.logger.event({
          level: 'error',
          source: 'scheduler',
          code: 'participation_trade_unbuildable',
          message: `could not build the participation trade for ${makerAgentId}/${takerAgentId}`,
          data: {
            makerAgentId,
            takerAgentId,
            error: error instanceof Error ? error.message : String(error),
          },
        });
        continue;
      }

      const write = await this.writer.postTrade(makerAgentId, this.rules.tradingRoom, signed.text);
      const row: TradeRow = {
        id,
        season: this.rules.season,
        maker_did: makerDid,
        taker_did: takerDid,
        side: 'buy',
        qty: terms.qty,
        px: terms.px,
        until_sweep: terms.until,
        maker_sig: signed.maker_sig,
        taker_sig: signed.taker_sig,
        status: write.ok ? 'pending' : 'refused',
        reason: write.ok ? null : (write.reason ?? 'write_failed'),
        room: this.rules.tradingRoom,
        seq: write.seq ?? null,
        agent_id: makerAgentId,
        counter_agent_id: takerAgentId,
        posted_sweep: snapshot.sweep,
        local_funds_side: this.localFundsSide(terms, makerDid),
        funds_side_confidence: 'local_inference',
        trade_source: 'participation',
      };
      if (!this.repositories.trades.insert(row)) {
        // The row exists but never took effect — a previous `refused`. Rewriting
        // it in place keeps the pair on one id rather than leaking a new one.
        this.repositories.trades.updateUnposted(row);
      }
      if (write.ok) {
        result.posted += 1;
        this.logger.event({
          level: 'info',
          source: 'scheduler',
          code: 'participation_trade_posted',
          message: `posted the participation trade for ${makerAgentId} and ${takerAgentId}`,
          data: {
            makerAgentId,
            takerAgentId,
            tradeId: id,
            px: terms.px,
            qty: terms.qty,
            until: terms.until,
            seq: write.seq ?? null,
          },
        });
      } else {
        result.refused += 1;
        this.logger.event({
          level: 'warn',
          source: 'scheduler',
          code: 'participation_trade_refused',
          message: `the participation trade for ${makerAgentId}/${takerAgentId} was refused`,
          data: { makerAgentId, takerAgentId, tradeId: id, reason: row.reason },
        });
      }
    }
    return result;
  }

  /**
   * The price a participation trade is written at: the middle of the band.
   *
   * The published band is the only price surface that is authoritative, and its
   * midpoint is inside it by construction — so the trade the referee is asked to
   * settle cannot be refused for sitting outside limits. Quantised to the two
   * decimals the wire allows, then clamped back inside the band for the one case
   * where quantising could push it over: a band narrower than a cent.
   */
  private participationPrice(limits: { low: Decimal; high: Decimal }): Decimal | null {
    if (!limits.low.gt(0) || !limits.high.gt(0) || !limits.low.lt(limits.high)) return null;
    const mid = limits.low.add(limits.high).div(2).quantize(2);
    if (mid.lt(limits.low)) return limits.low;
    if (mid.gt(limits.high)) return limits.high;
    return mid;
  }

  /**
   * Turn this tick's candidate actions into (at most) one posted trade each.
   *
   * In dry-run mode the full path runs — validation, caps, signing — and the
   * result is written to `trades` with status `dry_run` instead of being posted.
   * That is what makes the dry-run a rehearsal rather than a simulation.
   */
  private async executeActions(
    outcomes: RunOutcome[],
  ): Promise<{ dryRun: number; posted: number; refused: number }> {
    const result = { dryRun: 0, posted: 0, refused: 0 };
    const candidates = outcomes.filter((outcome) => outcome.action.intent !== 'NO_TRADE');
    if (candidates.length === 0) return result;

    const snapshot = this.reader.snapshot();
    const pin = this.repositories.upstream.getPin();
    const drift = Number(pin?.drift ?? 0) === 1;
    const tradingAllowed =
      this.loadGuard.allow('new_offer') && !snapshot.locked && !drift;
    // Live only: the readiness gate is the single answer to "may a trade be
    // written right now", and lite cannot bypass it. Dry-run still rehearses the
    // whole path and records a `dry_run` row.
    const readinessBlock = this.config.liveArmed && !this.readiness().trading.ready;

    for (const outcome of candidates) {
      const agentId = outcome.agentId;
      const action = outcome.action;
      const did = this.keyStore.did(agentId);
      // Which decision asked for this trade, recorded rather than inferred from
      // an id prefix: the sources are trusted for different reasons and have to
      // be countable apart.
      const tradeSource: TradeSource =
        outcome.decision === 'late_start_bootstrap' ? 'bootstrap' : 'strategy';
      try {
        const built = this.buildSignedTrade(agentId, did, action, snapshot);
        if (!built.ok) {
          result.refused += 1;
          if (built.terms) {
            this.recordTrade(agentId, built.terms, 'refused', built.reason, null, null, null, tradeSource);
          }
          continue;
        }
        const { terms, signed } = built;
        // Specific facts before the aggregate gate, so the refusal names which
        // one it was rather than a generic `not_trading_ready`. Registration
        // precedes the trade: a trade written before its owner is on the
        // register would settle against an account the referee has not minted.
        if (this.config.lateStartTradingArmed && !this.hasPostedRegistration(agentId)) {
          this.recordTrade(
            agentId,
            terms,
            'refused',
            'owner_registration_not_posted',
            signed.maker_sig,
            signed.taker_sig,
            null,
            tradeSource,
          );
          result.refused += 1;
          continue;
        }
        // The wall clock, independently of the referee's sweep: a feed that went
        // quiet must not let the strategy write past the contest's own deadline.
        if (!this.contestLock().beforeLock) {
          this.recordTrade(
            agentId,
            terms,
            'refused',
            'locked_by_wall_clock',
            signed.maker_sig,
            signed.taker_sig,
            null,
            tradeSource,
          );
          result.refused += 1;
          continue;
        }
        // One bootstrap trade per agent, ever, and never a second position on
        // top of one that already exists. The ledger answers this rather than a
        // counter, so a restart cannot double it and the participation fallback
        // cannot add to it.
        if (tradeSource === 'bootstrap' && this.repositories.trades.hasEffectiveTradeForDid(did)) {
          this.recordTrade(
            agentId,
            terms,
            'refused',
            'bootstrap_trade_already_recorded',
            signed.maker_sig,
            signed.taker_sig,
            null,
            tradeSource,
          );
          result.refused += 1;
          continue;
        }
        const refusal = !tradingAllowed
          ? snapshot.locked
            ? 'locked'
            : drift
              ? 'package_drift'
              : 'load_shed'
          : readinessBlock
            ? 'not_trading_ready'
            : null;
        if (refusal !== null) {
          this.recordTrade(
            agentId,
            terms,
            'refused',
            refusal,
            signed.maker_sig,
            signed.taker_sig,
            null,
            tradeSource,
          );
          result.refused += 1;
          continue;
        }
        // Live only: a band the referee did not label with `for` (or labelled
        // with the wrong sweep) cannot price a new trade. Conservative mode has
        // already stopped the strategy from proposing one; this is the explicit
        // second lock on the write path itself.
        if (this.config.liveArmed && snapshot.limitsUsable === false) {
          this.recordTrade(
            agentId,
            terms,
            'refused',
            snapshot.limitsForSweep === null ? 'limits_for_missing' : 'limits_for_mismatch',
            signed.maker_sig,
            signed.taker_sig,
            null,
            tradeSource,
          );
          result.refused += 1;
          continue;
        }
        // A requested-but-unarmed late start is a dry run for the same reason a
        // dry-run process is: the anchor that would make a live trade meaningful
        // is not in place, so the trade is recorded and not posted.
        if (!this.config.liveArmed || this.lateStartMisconfigured) {
          this.recordTrade(
            agentId,
            terms,
            'dry_run',
            this.lateStartMisconfigured ? 'late_start_not_armed' : 'dry_run',
            signed.maker_sig,
            signed.taker_sig,
            null,
            tradeSource,
          );
          result.dryRun += 1;
          continue;
        }
        // Live registration and live trading are separate commitments. An
        // operator who has armed registration but not trading is rehearsing the
        // real fleet, so the trade is recorded as a refusal rather than posted.
        if (!this.config.allowTrading) {
          this.recordTrade(
            agentId,
            terms,
            'refused',
            'trading_not_armed',
            signed.maker_sig,
            signed.taker_sig,
            null,
            tradeSource,
          );
          result.refused += 1;
          continue;
        }
        const write = await this.writer.postTrade(agentId, this.rules.tradingRoom, signed.text);
        if (write.ok) {
          this.recordTrade(
            agentId,
            terms,
            'pending',
            null,
            signed.maker_sig,
            signed.taker_sig,
            write.seq ?? null,
            tradeSource,
          );
          result.posted += 1;
        } else {
          this.recordTrade(
            agentId,
            terms,
            'refused',
            write.reason ?? 'write_failed',
            signed.maker_sig,
            signed.taker_sig,
            null,
            tradeSource,
          );
          result.refused += 1;
        }
      } catch (error) {
        result.refused += 1;
        this.logger.event({
          level: 'error',
          source: 'scheduler',
          code: 'trade_aborted',
          message: `trade for ${agentId} aborted`,
          data: { agentId, error: error instanceof Error ? error.message : String(error) },
        });
      }
    }
    return result;
  }

  /**
   * Terms plus both signatures, or a named refusal.
   *
   * This is the only place a trade message is produced, and it is deliberately
   * downstream of both the deterministic gate (which sized and priced it) and,
   * for an external offer, `validateExternalOffer` (which re-checked price,
   * clock, pairing and funds against this agent's own account).
   */
  private buildSignedTrade(
    agentId: string,
    did: string,
    action: GatedAction,
    snapshot: MarketSnapshot,
  ):
    | { ok: true; terms: TradeTerms; signed: SignedTrade }
    | { ok: false; reason: string; terms: TradeTerms | null } {
    if (action.intent === 'ACCEPT_EXTERNAL') {
      const offer = action.offer;
      if (!offer) return { ok: false, reason: 'no_offer', terms: null };
      // Refuse anything pairings our own keys, whatever the reader proposed.
      if (offer.terms.maker === did) return { ok: false, reason: 'self_trade', terms: offer.terms };
      if (this.keyStore.didSet().has(offer.terms.maker)) {
        return { ok: false, reason: 'local_did', terms: offer.terms };
      }
      const verdict = validateExternalOffer(
        { terms: offer.terms, maker_sig: offer.makerSig },
        {
          rules: this.rules,
          sweep: snapshot.sweep,
          reference: snapshot.reference,
          nextLimits: snapshot.nextLimits,
          staleReference: snapshot.staleReference,
          externalOfferLimits: {
            maxQty: this.config.risk.externalOffer.maxQty,
            maxNotional: this.config.risk.externalOffer.maxNotional,
            clawbackBuffer: this.config.risk.externalOffer.clawbackBuffer,
          },
          // The clawback is priced by the sweep's closing price, which the referee
          // publishes only when the sweep ends — an offer has to be answered before
          // that. Null says so, and the validator bounds our fee by the worst case
          // instead of pricing it at the reference and understating it on exactly
          // the move that matters. A void trade is strictly worse than a refusal.
          close: null,
          localDids: this.keyStore.didSet(),
          settledIds: new Set(this.repositories.trades.settledIds()),
          accounts: new Map(this.riskBook),
          conservative: snapshot.degraded,
          tolerateUnknownAccounts: true,
          takerDid: did,
        },
      );
      if (!verdict.ok) {
        this.logger.event({
          level: 'info',
          source: 'scheduler',
          code: 'external_offer_refused',
          message: `offer ${offer.terms.id} refused for ${agentId}: ${verdict.reason}`,
          data: { agentId, offerId: offer.terms.id, reason: verdict.reason, detail: verdict.detail },
        });
        return { ok: false, reason: verdict.reason ?? 'refused', terms: offer.terms };
      }
      try {
        const signed = this.keyStore.withSeed(agentId, (seed) =>
          countersignOffer({
            terms: offer.terms,
            takerDid: did,
            takerSeed: seed,
            makerSig: offer.makerSig,
          }),
        );
        return { ok: true, terms: offer.terms, signed };
      } catch (error) {
        return { ok: false, reason: `sign_failed:${String(error)}`, terms: offer.terms };
      }
    }

    const terms = this.buildTermsFor(did, action, snapshot);
    if (!terms) return { ok: false, reason: 'terms_unbuildable', terms: null };
    try {
      const signed = this.keyStore.withSeed(agentId, (seed) =>
        // An open offer carries the maker signature only; the countersignature
        // arrives later, from whoever takes it.
        signTrade({ terms, taker: did, makerSeed: seed }),
      );
      return { ok: true, terms, signed };
    } catch (error) {
      return { ok: false, reason: `sign_failed:${String(error)}`, terms };
    }
  }

  /** Terms for a proposal, in canonical decimal form, or null when impossible. */
  private buildTermsFor(did: string, action: GatedAction, snapshot: MarketSnapshot): TradeTerms | null {
    if (action.side === null || action.px === null || action.qty === null) return null;
    // A late start prices its trades from the band the referee published for one
    // specific sweep, so `until` is that band's own `for`: the price we were
    // bounded by is the price that holds for the trade's whole life. The local
    // horizon is the strict mode's rule, and it is kept there.
    const until =
      this.config.lateStartArmed && snapshot.limitsUsable !== false && snapshot.limitsForSweep !== null
        ? Math.min(snapshot.limitsForSweep, this.rules.lockSweep)
        : Math.min(snapshot.sweep + DEFAULT_TRADE_HORIZON_SWEEPS, this.rules.lockSweep);
    if (until <= snapshot.sweep) return null;
    const px = action.px;
    // The referee's published band is authoritative; the local ±5% window is the
    // fallback for a price post that carried no band at all.
    if (snapshot.nextLimits !== null) {
      if (!withinPublishedLimits(px, snapshot.nextLimits)) return null;
    } else if (snapshot.reference !== null && !withinLimits(this.rules, px, snapshot.reference)) {
      return null;
    }
    return buildTerms({
      id: generateTradeId(did, action.side),
      maker: did,
      side: action.side,
      qty: action.qty,
      px,
      until,
    });
  }

  /**
   * Record what happened to a proposed trade, whatever that was.
   *
   * Refusals and dry-runs are recorded as well as posts: an auditor asking "why
   * did agent-0042 not trade" should find the answer in `trades`, not have to
   * infer it from an absence.
   */
  private recordTrade(
    agentId: string,
    terms: TradeTerms,
    status: string,
    reason: string | null,
    makerSig: string | null,
    takerSig: string | null,
    seq: number | null = null,
    /** Which decision asked for this trade. Recorded, never inferred. */
    source: TradeSource = 'strategy',
  ): void {
    const did = this.keyStore.did(agentId);
    const accepted = this.repositories.trades.insert({
      id: terms.id,
      season: this.rules.season,
      maker_did: terms.maker,
      taker_did: terms.taker === 'any' ? did : terms.taker,
      side: terms.side,
      qty: terms.qty,
      px: terms.px,
      until_sweep: terms.until,
      maker_sig: makerSig ?? '',
      taker_sig: takerSig && takerSig.length > 0 ? takerSig : null,
      status,
      reason,
      room: this.rules.tradingRoom,
      seq,
      agent_id: agentId,
      counter_agent_id: null,
      // The local inference is stored from the first write, labelled for what it
      // is. It is never the referee's conclusion, and `referee_funds_side` stays
      // null until the referee itself names a reason.
      local_funds_side: this.localFundsSide(terms, did),
      funds_side_confidence: 'local_inference',
      trade_source: source,
    });
    if (!accepted) {
      this.logger.event({
        level: 'warn',
        source: 'scheduler',
        code: 'duplicate_trade_id',
        message: `trade id ${terms.id} was already recorded; the first copy stands`,
        data: { agentId, tradeId: terms.id },
      });
    }
  }

  /**
   * Which side of this trade is ours, from what we actually hold.
   *
   * This is an inference about *our* exposure, not a claim about which side the
   * referee found short — the referee never says, and `referee_funds_side` is
   * always `unknown` for a `funds` verdict. It is stored beside the official
   * fields under `funds_side_confidence = 'local_inference'` and is never
   * promoted: `recordRefereeVerdict` writes `official` and the repository refuses
   * to overwrite it.
   */
  private localFundsSide(terms: TradeTerms, did: string): 'maker' | 'taker' | 'both' | 'unknown' {
    const local = this.keyStore.didSet();
    const makerIsUs = local.has(terms.maker);
    const explicitTaker = terms.taker === 'any' ? null : terms.taker;
    const takerIsUs = explicitTaker !== null && local.has(explicitTaker);
    if (makerIsUs && takerIsUs) return 'both';
    if (makerIsUs) return 'maker';
    if (takerIsUs) return 'taker';
    // Neither term names a local DID and the offer was open: this is a stranger's
    // `taker:"any"` offer that our agent countersigned, so the local side is the
    // taker.
    if (explicitTaker === null && local.has(did)) return 'taker';
    return 'unknown';
  }

  // -------------------------------------------------------------------------
  // OperationsService — watchdog, Lark report, upstream check
  // -------------------------------------------------------------------------

  /**
   * The 7x24h floor's safety net.
   *
   * Once per local day, find agents whose last run is older than the rolling
   * window and run them — locally, with no trade, no heartbeat and no model.
   * Requires at least one completed tick so the reader has a snapshot to hand
   * the strategies; a backfill on an empty market would only produce NO_TRADE
   * for the wrong reason.
   */
  private async maybeRunWatchdog(at: Date): Promise<{ ran: boolean; backfilled: number }> {
    const day = localDateKey(at, this.config.timezone);
    const hour = Number.parseInt(
      new Intl.DateTimeFormat('en-GB', {
        timeZone: this.config.timezone,
        hour: '2-digit',
        hour12: false,
      }).format(at),
      10,
    );
    if (this.lastWatchdogDay === day) return { ran: false, backfilled: 0 };
    if (hour < this.config.scheduling.weeklyWatchdogHours) return { ran: false, backfilled: 0 };
    if (!this.reader.warmedUp) return { ran: false, backfilled: 0 };
    if (!this.loadGuard.allow('weekly_backfill')) {
      this.logger.event({
        level: 'warn',
        source: 'scheduler',
        code: 'watchdog_deferred',
        message: 'weekly watchdog deferred: the load guard paused backfill work',
        data: { tier: this.loadGuard.state.tier, reasons: this.loadGuard.state.reasons },
      });
      return { ran: false, backfilled: 0 };
    }
    this.lastWatchdogDay = day;

    const stale = this.runner.staleAgents();
    if (stale.length === 0) {
      this.logger.event({
        level: 'info',
        source: 'scheduler',
        code: 'watchdog_clean',
        message: 'weekly watchdog: every agent ran inside the rolling window',
        data: { windowHours: this.config.scheduling.runWindowHours },
      });
      return { ran: true, backfilled: 0 };
    }

    const snapshot = this.reader.snapshot();
    const inputs = stale.map((entry) =>
      this.buildRunInput(entry.agentId, entry.group as StrategyGroupName, snapshot, []),
    );
    const outcome = this.runner.runBatch(inputs, 'weekly_backfill');
    this.logger.event({
      level: 'warn',
      source: 'scheduler',
      code: 'watchdog_backfill',
      message: `weekly watchdog: backfilled ${outcome.outcomes.length} agents that had not run`,
      data: {
        backfilled: outcome.outcomes.length,
        failures: outcome.failures.length,
        agents: outcome.outcomes.map((item) => item.agentId),
      },
    });
    return { ran: true, backfilled: outcome.outcomes.length };
  }

  // -------------------------------------------------------------------------
  // OperationsService — Lark report + maintenance
  // -------------------------------------------------------------------------

  /**
   * Deliver whatever report is due, then — only if it actually reached Lark —
   * run the maintenance pass. History is never pruned on a day the report did
   * not go out.
   */
  private async maybeReport(at: Date): Promise<{ delivered: string[]; maintenance: boolean }> {
    if (!this.lark) return { delivered: [], maintenance: false };
    let delivered: string[] = [];
    try {
      const outcome = await this.lark.scheduler.runOnce(at);
      delivered = outcome.delivered;
    } catch (error) {
      this.logger.event({
        level: 'error',
        source: 'scheduler',
        code: 'lark_report_failed',
        message: 'the report pass threw',
        data: { error: error instanceof Error ? error.message : String(error) },
      });
      return { delivered: [], maintenance: false };
    }

    const day = localDateKey(at, this.config.timezone);
    const sent = delivered.filter(
      (reportId) => this.repositories.larkOutbox.byReportId(reportId)?.status === 'sent',
    );
    if (sent.length === 0) return { delivered, maintenance: false };
    if (this.lastMaintenanceDay === day) return { delivered, maintenance: false };
    if (!this.maintenance) return { delivered, maintenance: false };
    this.lastMaintenanceDay = day;
    try {
      const report = await this.maintenance.run(true);
      this.logger.event({
        level: 'info',
        source: 'scheduler',
        code: 'maintenance_complete',
        message: 'daily maintenance finished',
        data: {
          reportId: report.reportId,
          chatterArchived: report.chatterArchived,
          chatterDeleted: report.chatterDeleted,
          evidenceIntact: report.evidenceIntact,
          diskUsedPercent: Number(report.diskUsedPercent.toFixed(2)),
        },
      });
      return { delivered, maintenance: true };
    } catch (error) {
      this.logger.event({
        level: 'error',
        source: 'scheduler',
        code: 'maintenance_failed',
        message: 'daily maintenance failed; nothing was pruned',
        data: { error: error instanceof Error ? error.message : String(error) },
      });
      return { delivered, maintenance: false };
    }
  }

  // -------------------------------------------------------------------------
  // OperationsService — upstream package check
  // -------------------------------------------------------------------------

  private async maybeCheckUpstream(at: Date): Promise<boolean> {
    if (!this.upstream) return false;
    const intervalMs = Math.max(1, this.config.upstream.checkMinutes) * 60_000;
    // The first tick arms the timer instead of checking: startup is spent on
    // participation, and a GitHub request in the first second of a restart is
    // pure noise.
    if (this.lastUpstreamCheckMs === 0) {
      this.lastUpstreamCheckMs = at.getTime();
      return false;
    }
    if (at.getTime() - this.lastUpstreamCheckMs < intervalMs) return false;
    this.lastUpstreamCheckMs = at.getTime();
    try {
      await this.upstream.check();
      return true;
    } catch (error) {
      this.logger.event({
        level: 'warn',
        source: 'scheduler',
        code: 'upstream_check_failed',
        message: 'upstream check failed; the pinned package stays in force',
        data: { error: error instanceof Error ? error.message : String(error) },
      });
      return false;
    }
  }

  // -------------------------------------------------------------------------
  // OperationsService — status and health
  // -------------------------------------------------------------------------

  /**
   * The two readiness gates, derived from facts the process already holds.
   *
   * Deliberately computed on demand rather than cached: a cached gate is exactly
   * how a trade slips through after the referee room was recreated. `status()`
   * computes it once and shares the answer with the trade and registration paths.
   */
  private readiness(): {
    refereeFeed: Readiness;
    registration: Readiness;
    trading: Readiness;
    lateStart: LateStartGates;
  } {
    const verifier = this.reader.verifier.state;
    const readerStatus = this.reader.readerStatus();
    const gaps = this.reader.gaps();
    // The five referee rooms and `close1` are graded by different rules, so the
    // sets are split before anything is decided about them: a gap in a referee
    // room is a hole in the contest record, while a gap in `close1` is graded by
    // `CLOSE1_GAP_POLICY` — and never waved through when it might hide our own
    // posts.
    const refereeRooms = this.reader.refereeRoomList;
    const refereeSet = new Set(refereeRooms);
    const coverage = this.reader.tradingRoomCoverage();
    const lite = this.config.profile === 'lite';
    // The profile resolves the non-core lanes; this asserts the resolution
    // actually happened rather than trusting that it did.
    const profileLaneOk =
      !lite ||
      (this.config.technoCore.readerEnabled &&
        !this.config.deepseek.enabled &&
        !this.config.externalOfferTakerEnabled &&
        this.config.roomDiscovery.maxRooms === 0);
    const identities = this.repositories.identities.all();
    const enabled = identities.filter((row) => row.enabled === 1).length;
    const total = this.keyStore.size;
    const fleetComplete = total > 0 && enabled === total;
    // A disk-protection tier refuses writes, so it refuses a registration post
    // just as squarely as it refuses a trade. Derived from the load guard rather
    // than from a write attempt, because the gate must answer *before* anything
    // is committed.
    const writesAllowed = !this.loadGuard.state.paused.readsOnly;
    const readback = this.repositories.participation.readbackProgress();
    // The feed gate's inputs, shared by all three gates so the three can never
    // disagree about the feed itself.
    const feedInputs = {
      readerContinuous: readerStatus.continuousMode,
      readerRunning: readerStatus.running,
      refereeRoomCount: readerStatus.fixedRoomCount - (coverage.mode === null ? 0 : 1),
      expectedRefereeRoomCount: refereeRooms.length,
      refereeRoomsWithGap: gaps.rooms.filter((room) => refereeSet.has(room)),
      // The reader's own verdict, not the durable `gap_resolved_at` flag: a room
      // whose cursor resumed while it is still behind is not resolved.
      refereeRoomsWithUnresolvedGap: readerStatus.unresolvedGapRooms.filter((room) =>
        refereeSet.has(room),
      ),
      refereeRoomsReset: gaps.resets.filter((room) => refereeSet.has(room)),
      profileLaneOk,
      seedSeen: verifier.seedSeen,
      // The verifier names its own feed refusals — a seed in the wrong room, a
      // signature that did not verify, a DID that is not the pinned one, a
      // package that drifted. Everything else it holds is a risk posture, not a
      // feed fact, and does not belong in this gate.
      refereeFeedBlockers: refereeFeedBlockerReasons(verifier.conservativeReasons),
      refereeDid: verifier.refereeDid,
      expectedRefereeDid: this.config.expectedRefereeDid,
      packageHash: verifier.packageHash,
      expectedPackageHash: verifier.expectedPackageHash,
      hydrated: this.reader.isHydrated,
      requirePin: this.config.requireRefereePin,
      hasReference: verifier.reference !== null,
      hasLimits: verifier.limits !== null,
      currentSweepRecoverable: verifier.currentSweep !== null,
    } as const;

    const refereeFeed = refereeFeedReadiness(feedInputs);

    const registration = registrationReadiness({
      ...feedInputs,
      tradingRoomHasCoverageGap: coverage.hasGap,
      tradingRoomCriticalGap: coverage.criticalGap,
      tradingRoomCriticalGapRooms: coverage.criticalRooms,
      tradingRoomUnattainable: coverage.unattainable,
      close1GapPolicy: this.config.technoCore.close1GapPolicy,
      allowRegistrationWithClose1Gap: this.config.technoCore.allowRegistrationWithClose1Gap,
      localMessageInGap: coverage.localMessagesInGap,
      fleetComplete,
      writerHealthy: writesAllowed,
      nonceStoreUsable: writesAllowed,
      durableEvidenceWritable: writesAllowed,
    });

    const trading = tradingReadiness({
      registration,
      conservative: verifier.conservative,
      conservativeReasons: verifier.conservativeReasons,
      sweep: verifier.currentSweep,
      hasReference: verifier.reference !== null,
      limits:
        verifier.limits === null
          ? null
          : { low: verifier.limits.low.toString(), high: verifier.limits.high.toString() },
      limitsUsable: verifier.limitsUsable,
      limitsForSweep: verifier.limitsForSweep,
      staleReference: this.reader.snapshot().staleReference,
      locked: verifier.locked,
      loadAllowsNewOffer: this.loadGuard.allow('new_offer'),
      packageDrift: Number(this.repositories.upstream.getPin()?.drift ?? 0) === 1,
      fleetComplete,
      registrationRequired: this.config.liveArmed,
      registrationReadbackComplete: readback.completed >= total,
      close1GapPolicy: this.config.technoCore.close1GapPolicy,
      // Only the full caught-up test satisfies this. `degraded_readonly` never
      // does, and the operator switch only ever covers a *plain coverage* gap:
      // it is waived nowhere else, and only with a recorded override.
      close1FullyCaughtUp: coverage.fullyCaughtUp,
      close1NetPersistBacklogRate: coverage.netPersistBacklogRate,
      unresolvedGap: readerStatus.unresolvedGap,
      close1Unattainable: coverage.unattainable,
      localMessageInGap: coverage.localMessagesInGap,
      writerHealthy: writesAllowed,
      allowTradingWithClose1Gap: this.config.technoCore.allowTradingWithClose1Gap,
      manualOverride: this.config.technoCore.tradingOverride,
    });

    // ---- late start: a second, parallel set of gates ------------------------
    //
    // Reported always, armed or not, so `/status` can answer "is the mode on,
    // and if not, what is it missing" without the operator reading the unit
    // file. `refereeFeed` above stays the *strict* gate in every mode: it is
    // the honest answer to "was the contest replayed from its seed", and a late
    // start does not get to relabel it.
    const launchPinVerified =
      this.config.expectedPackageHash !== null &&
      this.config.expectedRefereeDid !== null &&
      this.config.requireRefereePin;
    const refereeSeen = this.reader.verifier.lastAcceptedPostAt !== null;
    const lateStartFeedInputs = {
      lateStartArmed: this.config.lateStartArmed,
      readerContinuous: readerStatus.continuousMode,
      readerRunning: readerStatus.running,
      refereeRoomCount: readerStatus.fixedRoomCount - (coverage.mode === null ? 0 : 1),
      expectedRefereeRoomCount: refereeRooms.length,
      // Only a gap that is still open can be hiding the price post the next
      // sweep needs. A loss recorded before the late start is audit history, and
      // `/status.lateStart.audit` reports it without holding participation.
      refereeRoomsWithUnresolvedGap: readerStatus.unresolvedGapRooms.filter((room) =>
        refereeSet.has(room),
      ),
      refereeRoomsReset: gaps.resets.filter((room) => refereeSet.has(room)),
      launchPinVerified,
      refereeDid: verifier.refereeDid,
      expectedRefereeDid: this.config.expectedRefereeDid,
      refereeFeedBlockers: lateStartFeedBlockerReasons(verifier.conservativeReasons),
      refereeSeen,
    } as const;
    // The wall clock and the register are read once per assembly, so the gate,
    // the three write paths and `/status` all quote the same two facts.
    const lock = this.contestLock();
    const registrationProgress = this.registrationProgress();
    const lateStartFeed = lateStartFeedReadiness(lateStartFeedInputs);
    const lateStartRegistration = lateStartRegistrationReadiness({
      ...lateStartFeedInputs,
      allowRegistration: this.config.allowRegistration,
      fleetComplete,
      writerHealthy: writesAllowed,
      nonceStoreUsable: writesAllowed,
      lockBefore: lock.beforeLock,
      lockValid: lock.valid,
    });
    const marketSnapshot = marketSnapshotReadiness({
      refereeSeen,
      sweep: verifier.currentSweep,
      reference: verifier.reference?.toString() ?? null,
      limits:
        verifier.limits === null
          ? null
          : { low: verifier.limits.low.toString(), high: verifier.limits.high.toString() },
      limitsForSweep: verifier.limitsForSweep,
      limitsUsable: verifier.limitsUsable,
      locked: verifier.locked,
      secondsSinceLastPost: this.secondsSinceRefereePost(),
      sweepSeconds: this.rules.sweepSeconds,
      maxStaleSweeps: LATE_START_MAX_STALE_SWEEPS,
    });
    const lateStartTrading = lateStartTradingReadiness({
      lateStartFeed,
      // A trade may not precede its owner's registration, globally, by the same
      // count `/status` reports — and never by a mint it cannot see.
      registrationReady: registrationProgress.ready,
      registrationPostAcked: registrationProgress.postAcked,
      registrationExpected: registrationProgress.expected,
      registrationPending: registrationProgress.pending,
      registrationFailed: registrationProgress.failed,
      registrationUnresolvedMissed: registrationProgress.unresolvedMissed,
      tradingArmed: this.config.lateStartTradingArmed,
      marketSnapshot,
      wallClockBeforeLock: lock.beforeLock,
      wallClockLockValid: lock.valid,
      loadAllowsNewOffer: this.loadGuard.allow('new_offer'),
      writerHealthy: writesAllowed,
      nonceStoreUsable: writesAllowed,
      packageDrift: Number(this.repositories.upstream.getPin()?.drift ?? 0) === 1,
      fleetComplete,
      localTradeUnresolved: this.repositories.trades.hasUnresolvedMissed(),
      // Deliberately *trades only*. `coverage.localMessagesInGap` is derived from
      // our owner registrations, and a late start's registration may sit in an old
      // band the ring has already rotated past. Holding every future trade on
      // that would be the audit view refusing the trading view — exactly the
      // coupling a late start exists to break. A *trade* in the band is different:
      // it may have been read, and re-issuing it risks a double settlement.
      localMessageInGap:
        coverage.band === null
          ? false
          : this.repositories.trades.seqsInBand(coverage.band.from, coverage.band.to).length > 0,
    });

    // In late-start mode the *effective* registration and trading answers come
    // from the late-start gates; the strict feed gate keeps its own meaning.
    if (this.config.lateStartArmed) {
      return {
        refereeFeed,
        registration: lateStartRegistration,
        trading: lateStartTrading,
        lateStart: {
          feed: lateStartFeed,
          registration: lateStartRegistration,
          trading: lateStartTrading,
          marketSnapshot,
          launchPinVerified,
          refereeSeen,
          lock,
          registrationProgress,
        },
      };
    }
    return {
      refereeFeed,
      registration,
      trading,
      lateStart: {
        feed: lateStartFeed,
        registration: lateStartRegistration,
        trading: lateStartTrading,
        marketSnapshot,
        launchPinVerified,
        refereeSeen,
        lock,
        registrationProgress,
      },
    };
  }

  /**
   * True when the operator asked for a late start that did not arm.
   *
   * Such a process must not write anything. Its anchor — the confirmations that
   * make a seedless start trustworthy — is incomplete, so a registration or a
   * trade it posted would rest on a guarantee nobody made. It keeps reading,
   * evaluating and reporting, and `/status.lateStartBlockedReason` says which
   * switch is missing.
   */
  private get lateStartMisconfigured(): boolean {
    return this.config.lateStartRequested && !this.config.lateStartArmed;
  }

  /**
   * How long since the referee last posted anything this verifier accepted.
   *
   * `null` when nothing has been accepted yet. The reader's own clock is used,
   * so a stored history that was replayed at startup ages from the *message*,
   * which is the honest reading: a feed that went quiet before we restarted is
   * still quiet.
   */
  private secondsSinceRefereePost(): number | null {
    const last = this.reader.verifier.lastAcceptedPostAt;
    if (last === null) return null;
    const at = Date.parse(last);
    if (Number.isNaN(at)) return null;
    return Math.max(0, (this.now().getTime() - at) / 1000);
  }

  /**
   * Which of the three operating postures the process is in.
   *
   * Derived from the arming flags, never from the calendar: a deadline is not an
   * operator, and "the contest is nearly over" must not be able to move this.
   */
  private operatingMode(): OperatingMode {
    // Late-start is its own posture, never a variant of `live_trading`: an
    // operator reading `/status` must be able to tell "we are trading on a
    // replayed history that begins at the seed" from "we are participating from
    // a late start", because the two are trusted for different reasons.
    //
    // A late start that was *asked for* and did not arm is a dry run: it posts
    // nothing, and it must not look armed while it waits for a missing switch.
    if (this.lateStartMisconfigured) return 'dry_run';
    if (this.config.lateStartArmed) {
      return this.config.lateStartTradingArmed
        ? 'late_start_full_participation'
        : 'late_start_registration_only';
    }
    if (!this.config.liveArmed) return 'dry_run';
    return this.config.tradingArmed ? 'live_trading' : 'live_registration_only';
  }

  status(): StatusSnapshot {
    const at = this.now();
    const verifier = this.reader.verifier.state;
    const readiness = this.readiness();
    const identities = this.repositories.identities.all();
    const stale = this.runner.staleAgents();
    const byGroup: Record<string, number> = {};
    for (const group of STRATEGY_GROUPS) byGroup[group] = 0;
    for (const row of identities) {
      byGroup[row.strategy_group] = (byGroup[row.strategy_group] ?? 0) + 1;
    }
    const runWindowStart = new Date(
      at.getTime() - this.config.scheduling.runWindowHours * 3600_000,
    ).toISOString();
    const dayStart = `${localDateKey(at, this.config.timezone)}T00:00:00.000Z`;
    const usage = this.budget.usage();
    const pin = this.repositories.upstream.getPin();
    const memory = process.memoryUsage();
    const uptimeSeconds = Math.max(1, (Date.now() - this.startedAt) / 1000);
    const cursorGaps = this.reader.gaps();
    const tradingRoomCursor = this.repositories.roomCursors.get(this.rules.tradingRoom);
    const readerStatus = this.reader.readerStatus();
    // The close1 policy surface: the room's coverage classification, our own seqs
    // that provably fell in the band, and the 150/150 readback progress. Computed
    // from the same reader/DB facts the gates use, so the two cannot disagree.
    const coverage = this.reader.tradingRoomCoverage();
    const feedback = this.repositories.participation.readbackProgress();
    const wsStatus = this.lark?.websocket.status;
    const archiveState = this.repositories.archiveState.get();
    const archiveBySweep = this.repositories.archiveSweeps.all();
    const fullVerified = archiveBySweep.filter(
      (row) => row.verified === 1 && row.status === 'full',
    ).length;
    const redactedVerified = archiveBySweep.filter(
      (row) => row.verified === 1 && row.status === 'redacted',
    ).length;
    const verdicts = this.repositories.trades.fundsVerdicts();
    const officialReasons = this.repositories.trades.refereeReasonCounts();
    const localInferred = this.repositories.trades.countLocalInference();

    const sweeps = this.repositories.trades.sweepCounts(verifier.currentSweep, this.rules.lockSweep);
    const tradeOutcomes = this.repositories.trades.outcomeCounts();
    // The wall clock and the register come from the same assembly the gates
    // used, so `/status` cannot report a different answer than the write path.
    const lock = readiness.lateStart.lock;
    const registrationProgress = readiness.lateStart.registrationProgress;
    const participationCoverage = this.repositories.trades.participationCoverage();
    const participationExpected = Math.floor(this.keyStore.size / 2);
    // The strategy path's own view. The mode is named from the config alone, so
    // an operator can tell "the profiles are running" from "the bootstrap is
    // running" without reading the unit file.
    const tradeSourceCounts = this.repositories.trades.tradeSourceCounts();
    const strategyGateMode: 'group' | 'late_start_bootstrap' = this.config.lateStartArmed
      ? 'late_start_bootstrap'
      : 'group';
    const observations = this.reader.snapshot().history;
    const latestObservation = observations[observations.length - 1];
    const previousObservation = observations[observations.length - 2];
    const lateStartSignalValue: LateStartSignal | 'insufficient' =
      observations.length < LATE_START_OBSERVATIONS_REQUIRED ||
      latestObservation === undefined ||
      previousObservation === undefined
        ? 'insufficient'
        : lateStartSignal(latestObservation, previousObservation, this.rules.priceStep);
    const lateStartStrategyTradingReady =
      this.config.lateStartStrategyTradingArmed &&
      readiness.lateStart.trading.ready &&
      lateStartSignalValue !== 'insufficient';
    const strategyBlockedReason: string | null =
      strategyGateMode !== 'late_start_bootstrap'
        ? readiness.trading.ready
          ? null
          : (readiness.trading.reasons[0] ?? null)
        : !this.config.lateStartStrategyTradingArmed
          ? 'late_start_strategy_disabled'
          : !readiness.lateStart.trading.ready
            ? (readiness.lateStart.trading.reasons[0] ?? null)
            : lateStartSignalValue === 'insufficient'
              ? 'late_start_insufficient_observations'
              : null;

    return {
      at: at.toISOString(),
      statusSchemaVersion: STATUS_SCHEMA_VERSION,
      readerMetricsVersion: READER_METRICS_VERSION,
      commit: buildCommit(),
      profile: this.config.profile,
      mode: this.config.mode,
      liveArmed: this.config.liveArmed,
      tier: this.loadGuard.state.tier,
      tierReasons: this.loadGuard.state.reasons,
      paused: { ...this.loadGuard.state.paused },
      sweep: verifier.currentSweep,
      reference: verifier.reference?.toString() ?? null,
      limits:
        verifier.limits === null
          ? null
          : { low: verifier.limits.low.toString(), high: verifier.limits.high.toString() },
      locked: verifier.locked,
      conservative: verifier.conservative,
      conservativeReasons: verifier.conservativeReasons,
      packageHash: verifier.packageHash,
      expectedPackageHash: verifier.expectedPackageHash,
      packageDrift: Number(pin?.drift ?? 0) === 1,
      refereeDid: verifier.refereeDid,
      expectedRefereeDid: this.config.expectedRefereeDid,
      seedSource: this.reader.seedSource,
      seedVerified: this.reader.seedVerified,
      historicalReplayComplete: this.reader.historicalReplayComplete,
      historicalReplayUnavailable: this.reader.historicalReplayUnavailable,
      launchPinVerified: readiness.lateStart.launchPinVerified,
      lateStartMode: this.config.lateStartArmed,
      lateStartFeedReady: readiness.lateStart.feed.ready,
      marketSnapshotReady: readiness.lateStart.marketSnapshot.ready,
      tradeUntilSweep: verifier.limitsForSweep,
      lateStartBlockedReason: this.config.lateStartBlockedReason,
      lateStartTradingReady: readiness.lateStart.trading.ready,
      tradeBlockedReason:
        this.config.lateStartArmed && !readiness.lateStart.trading.ready
          ? // The wall clock outranks the feed-derived reasons: an operator
            // reading "locked_by_wall_clock" knows the contest is over, while a
            // stale-feed reason would suggest waiting for a newer post.
            lock.beforeLock
            ? (readiness.lateStart.trading.reasons[0] ?? null)
            : 'locked_by_wall_clock'
          : readiness.trading.ready
            ? null
            : (readiness.trading.reasons[0] ?? null),
      wallClockBeforeLock: lock.beforeLock,
      lockedByReferee: verifier.locked,
      lockedByWallClock: lock.locked,
      registrationReady: registrationProgress.ready,
      registrationExpected: registrationProgress.expected,
      registrationPostAcked: registrationProgress.postAcked,
      registrationRoomEchoed: registrationProgress.roomEchoed,
      registrationMintConfirmed: registrationProgress.mintConfirmed,
      registrationMintUncertain: registrationProgress.mintUncertain,
      participationTradesExpected: participationExpected,
      participationTradesPosted: participationCoverage.posted,
      participationAgentsCovered: participationCoverage.agentsCovered,
      strategyGateMode,
      lateStartStrategyTradingReady,
      strategyBlockedReason,
      lateStartObservationCount: observations.length,
      lateStartSignal: lateStartSignalValue,
      strategyTradesPosted: tradeSourceCounts.strategy,
      bootstrapStrategyTradesPosted: tradeSourceCounts.bootstrap,
      registration: this.repositories.participation.outcomeCounts(),
      trading: {
        eligibleAgents: this.keyStore.size,
        tradeAttempts: tradeOutcomes.attempts,
        tradePosted: tradeOutcomes.posted,
        tradeEchoConfirmed: tradeOutcomes.echoConfirmed,
        tradeSettled: tradeOutcomes.settled,
        tradeUnknown: tradeOutcomes.unknown,
      },
      lateStartAudit: {
        room: this.rules.tradingRoom,
        coverage: coverage.coverage,
        gaps: cursorGaps.total,
        firstSeq: tradingRoomCursor?.first_seq ?? null,
        lastSeq: tradingRoomCursor?.last_seq ?? null,
        generation: tradingRoomCursor?.generation ?? null,
        // Deliberately the reader's own verdict, which is false without a seed.
        // This is the audit view saying what it cannot claim, not a gate.
        historicalReplayComplete: this.reader.historicalReplayComplete,
      },
      agents: {
        total: this.keyStore.size,
        enabled: identities.filter((row) => row.enabled === 1).length,
        byGroup,
        staleCount: stale.length,
        staleSample: stale.slice(0, 10).map((entry) => entry.agentId),
        lastRunAt:
          identities
            .map((row) => row.last_run_at)
            .filter((value): value is string => value !== null)
            .sort()
            .pop() ?? null,
        failures: this.repositories.runtimeEvents.countByCode('agent_run_failed'),
      },
      participation: {
        ...this.repositories.participation.countByStatus(),
        total: this.repositories.participation.count(),
        readback: this.repositories.participation.countWithReadback(),
      },
      runs: {
        // Durable rows: they survive restarts, so they can exceed anything this
        // process did. The `sinceStartup` figure below is the process's own.
        today: this.repositories.agentRuns.countSince(dayStart),
        window: this.repositories.agentRuns.countSince(runWindowStart),
        sinceStartup: this.runStats.evaluated,
        schedulerTicks: this.tickCount,
        uniqueAgents: this.runStats.uniqueAgents.size,
        fullFleetCycles: this.runStats.fleetCycles,
        watchdogRuns: this.runStats.watchdogRuns,
        agentsInCurrentTick: this.runStats.agentsInCurrentTick,
        lastTickAt: this.lastTickReport?.at ?? null,
        nextTickAt: this.nextTickAt(),
      },
      trades: {
        ...this.repositories.trades.countByStatus(),
        total: this.repositories.trades.count(),
      },
      tradeSweeps: {
        inCurrent: sweeps.inSweep,
        afterLock: sweeps.afterLock,
        duplicateAttempts: this.repositories.runtimeEvents.countByCode('duplicate_trade_id'),
      },
      runtimeEvents: runtimeEventSummary(this.repositories),
      funds: {
        officialReasons,
        fundsVerdicts: verdicts.length,
        localInferred,
      },
      repost: {
        ...this.repositories.reposts.countByStatus(),
        total: this.repositories.reposts.count(),
      },
      archive: {
        latestIndexSweep: archiveState?.latest_index_sweep ?? null,
        latestVerifiedSweep: archiveState?.latest_verified_sweep ?? null,
        lagSweeps: archiveState?.lag_sweeps ?? null,
        fullVerified,
        redactedVerified,
        unavailable: this.repositories.archiveSweeps.unavailableSweeps().length,
        hashMismatch: this.repositories.archiveSweeps.mismatchedSweeps().length,
        lastCheckAt: archiveState?.last_check_at ?? null,
        lastError: archiveState?.last_error ?? null,
      },
      rooms: {
        scope: this.reader.roomScope,
        fixed: this.reader.fixedRoomList,
        dynamic: this.reader.dynamicRooms,
        cap: this.config.roomDiscovery.maxRooms,
        bootstrap: cursorGaps.bootstrap,
        gaps: cursorGaps.rooms,
        registrationReady: readiness.registration.ready,
        tradingReady: readiness.trading.ready,
      },
      operatingMode: this.operatingMode(),
      readiness: {
        refereeFeedReady: readiness.refereeFeed.ready,
        registrationReady: readiness.registration.ready,
        tradingReady: readiness.trading.ready,
        refereeFeedReasons: readiness.refereeFeed.reasons,
        registrationReasons: readiness.registration.reasons,
        tradingReasons: readiness.trading.reasons,
      },
      close1: {
        coverage: coverage.coverage,
        gapPolicy: this.config.technoCore.close1GapPolicy,
        registrationPolicy: {
          allowWithClose1Gap: this.config.technoCore.allowRegistrationWithClose1Gap,
        },
        tradingPolicy: {
          allowWithClose1Gap: this.config.technoCore.allowTradingWithClose1Gap,
          override: this.config.technoCore.tradingOverride,
        },
        localMessagesInGap: coverage.localSeqsInGap,
        localAgentsInGap: coverage.localAgentsInGap,
        unresolvedGapRooms: readerStatus.unresolvedGapRooms,
        registrationPending: feedback.pending,
        registrationReadback: feedback,
        tradeBlockedReason: readiness.trading.ready ? null : (readiness.trading.reasons[0] ?? null),
      },
      cors: {
        gaps: cursorGaps.total,
        gapRooms: cursorGaps.rooms,
        resets: cursorGaps.resets,
        bootstrap: cursorGaps.bootstrap,
      },
      reader: readerStatus,
      technocore: this.client.stats() as unknown as Record<string, number>,
      llm: {
        normal: usage.normal,
        retries: usage.retries,
        total: usage.total,
        blocked: usage.blocked,
        tokens: usage.tokens.total,
      },
      lark: {
        connected: wsStatus?.connected ?? false,
        state: wsStatus?.state ?? 'stopped',
        heartbeatStale: wsStatus?.heartbeatStale ?? false,
        outbox: this.repositories.larkOutbox.countByStatus(),
      },
      upstream: { checkedAt: pin?.updated_at ?? null, drift: Number(pin?.drift ?? 0) === 1 },
      system: {
        rssBytes: memory.rss,
        heapUsedBytes: memory.heapUsed,
        // Process CPU over the last tick interval — never the lifetime average
        // that produced 2182% from a mostly-idle process.
        cpuPercent: this.processCpuPercent,
        cpuState: this.processCpuPercent === null ? 'warming_up' : 'ok',
        uptimeSeconds: Number(uptimeSeconds.toFixed(0)),
        diskUsedPercent: Number(this.loadGuard.diskUsedPercent(this.config.dataDir).toFixed(2)),
        eventLoopLagMs: this.lastEventLoopLagMs,
      },
      storage: {
        dbBytes: existsSync(this.config.paths.database)
          ? fileBytes(this.config.paths.database)
          : 0,
        archiveBytes: this.repositories.archiveManifests.totalBytes(),
        walBytes: existsSync(`${this.config.paths.database}-wal`)
          ? fileBytes(`${this.config.paths.database}-wal`)
          : 0,
        writerQueueDepth: this.writer.depth,
      },
    };
  }

  /**
   * The field acceptance view of the reader, for `/reader-report`.
   *
   * Read-only and secret-free by construction: it is a projection of `status()`,
   * so it can only contain what `/status` already carries.
   */
  readerReport(): ReaderReport {
    const status = this.status();
    const reader = status.reader;
    const readiness = this.readiness();
    return {
      at: status.at,
      commit: status.commit,
      statusSchemaVersion: status.statusSchemaVersion,
      readerMetricsVersion: status.readerMetricsVersion,
      mode: reader.continuousMode ? 'continuous' : 'scheduler_tick',
      running: reader.running,
      catchupState: reader.catchupState,
      fullyCaughtUp: reader.fullyCaughtUp,
      netBacklogIncreasing: reader.netBacklogIncreasing,
      pageSaturated: reader.pageSaturated,
      consecutiveShortPages: reader.consecutiveShortPages,
      effectiveConfig: reader.effectiveConfig,
      rooms: reader.rooms.map((row) => ({
        room: row.room,
        mode: row.mode,
        producerRate: row.producerRate,
        persistedConsumerRate: row.persistedRate,
        cursorAdvanceRate: row.cursorAdvanceRate,
        lostGapRate: row.lostGapRate,
        netPersistBacklogRate: row.netPersistBacklogRate,
        cursorLag: row.cursorLag,
        waitSeconds: row.waitSeconds,
        lastLimitUsed: row.lastLimitUsed,
        lastReturnedCount: row.lastReturnedCount,
        pageSaturated: row.pageSaturated,
        catchingUpForMs: row.catchingUpForMs,
        lastSuccessAt: row.lastSuccessAt,
        silenceMs: row.silenceMs,
      })),
      totals: {
        producerRate: reader.producerRate,
        persistedConsumerRate: reader.persistedConsumerRate,
        cursorAdvanceRate: reader.cursorAdvancePerMinute,
        lostGapRate: reader.lostGapRate,
        netBacklogRate: reader.netBacklogRate,
        persistedMessages: reader.persistedMessages,
        duplicateMessages: reader.duplicateMessages,
        gapMessages: reader.gapMessages,
      },
      exportRecovery: reader.exportRecovery,
      unresolvedGapRooms: reader.unresolvedGapRooms,
      operatingMode: status.operatingMode,
      close1Coverage: status.close1.coverage,
      registrationPolicy: status.close1.registrationPolicy,
      tradingPolicy: status.close1.tradingPolicy,
      localMessagesInGap: status.close1.localMessagesInGap,
      registrationPending: status.close1.registrationPending,
      registrationReadback: status.close1.registrationReadback,
      tradeBlockedReason: status.close1.tradeBlockedReason,
      readiness: {
        refereeFeedReady: readiness.refereeFeed.ready,
        registrationReady: readiness.registration.ready,
        tradingReady: readiness.trading.ready,
        refereeFeedReasons: readiness.refereeFeed.reasons,
        registrationReasons: readiness.registration.reasons,
        tradingReasons: readiness.trading.reasons,
      },
      lateStart: {
        mode: status.lateStartMode,
        blockedReason: status.lateStartBlockedReason,
        feedReady: status.lateStartFeedReady,
        marketSnapshotReady: status.marketSnapshotReady,
        launchPinVerified: status.launchPinVerified,
        seedVerified: status.seedVerified,
        historicalReplayComplete: status.historicalReplayComplete,
        historicalReplayUnavailable: status.historicalReplayUnavailable,
        currentSweep: status.sweep,
        tradeUntilSweep: status.tradeUntilSweep,
        reference: status.reference,
        limits: status.limits,
        registration: status.registration,
        trading: status.trading,
        tradingReady: status.lateStartTradingReady,
        tradeBlockedReason: status.tradeBlockedReason,
        wallClockBeforeLock: status.wallClockBeforeLock,
        lockedByReferee: status.lockedByReferee,
        lockedByWallClock: status.lockedByWallClock,
        registrationReady: status.registrationReady,
        registrationExpected: status.registrationExpected,
        registrationPostAcked: status.registrationPostAcked,
        registrationRoomEchoed: status.registrationRoomEchoed,
        registrationMintConfirmed: status.registrationMintConfirmed,
        registrationMintUncertain: status.registrationMintUncertain,
        participationTradesExpected: status.participationTradesExpected,
        participationTradesPosted: status.participationTradesPosted,
        participationAgentsCovered: status.participationAgentsCovered,
        strategyGateMode: status.strategyGateMode,
        lateStartStrategyTradingReady: status.lateStartStrategyTradingReady,
        strategyBlockedReason: status.strategyBlockedReason,
        lateStartObservationCount: status.lateStartObservationCount,
        lateStartSignal: status.lateStartSignal,
        strategyTradesPosted: status.strategyTradesPosted,
        bootstrapStrategyTradesPosted: status.bootstrapStrategyTradesPosted,
        audit: status.lateStartAudit,
      },
      serverContract: reader.serverContract,
    };
  }

  /** The Lark report body: local SQLite and process metrics only, no model call. */
  async buildReport(): Promise<{
    reportId: string;
    title: string;
    summary: string;
    sections: Array<{ heading: string; lines: string[] }>;
    critical: string[];
    alerts: { blocking: string[]; critical: string[]; warning: string[]; info: string[] };
  }> {
    const status = this.status();
    const blocking: string[] = [];
    const critical: string[] = [];
    const warning: string[] = [];
    const info: string[] = [];
    if (status.packageDrift) {
      critical.push(
        `package hash drift: expected ${status.expectedPackageHash ?? '<unset>'}, seed says ${status.packageHash ?? '<none>'} — active trading is paused`,
      );
    }
    // The seed's signer is the referee's identity: a seed signed by anyone other
    // than the pinned DID is a different contest, so it is never a warning.
    if (
      status.refereeDid !== null &&
      status.expectedRefereeDid !== null &&
      status.refereeDid !== status.expectedRefereeDid
    ) {
      critical.push(
        `referee seed mismatch: the seed is signed by ${status.refereeDid}, not the pinned ${status.expectedRefereeDid}`,
      );
    }
    if (status.conservative) {
      critical.push(`conservative mode: ${status.conservativeReasons.join('; ')}`);
    }
    if (
      status.conservativeReasons.includes('limits_for_mismatch') ||
      status.conservativeReasons.includes('limits_for_missing')
    ) {
      critical.push(
        'the published limits do not label the next sweep (`for`); no new live trade can be priced from them',
      );
    }
    if (status.archive.hashMismatch > 0) {
      critical.push(`archive records that did not verify: ${status.archive.hashMismatch}`);
    }
    const overflowAnomalies = this.repositories.refereeAnomalies.byKind('room_overflow').length;
    if (overflowAnomalies > 0) {
      critical.push(
        `room_overflow: ${overflowAnomalies} listing(s) above the cap of ${status.rooms.cap}; ` +
          'the fixed referee set and close1 are unchanged',
      );
    }
    if ((status.repost.failed ?? 0) > 0) {
      critical.push(`missed-message re-posts that failed: ${status.repost.failed}`);
    }
    // A mid-run gap is a real loss of messages: critical. A first start against a
    // room whose history no longer reaches back to seq 1 is a permanent fact
    // about the room, not a loss this process suffered, so it is a warning — and
    // it must never be dressed up as a complete history.
    if (status.cors.gaps > 0) {
      critical.push(
        `cursor gaps (mid-run loss): ${status.cors.gaps}${status.cors.gapRooms.length ? ` in ${status.cors.gapRooms.join(', ')}` : ''}`,
      );
    }
    if (status.cors.bootstrap.length > 0) {
      warning.push(
        `bootstrap_truncated (history before first_seq was never retrievable): ${status.cors.bootstrap.join(', ')} — recorded permanently, not counted as a gap`,
      );
    }
    // The reader is off the scheduler's cadence now, so "is it actually running"
    // is a finding in its own right. It is already carried by the referee feed
    // gate above — a reader that is not continuous makes `refereeFeedReady` false
    // with that exact reason — so it is not repeated here as a separate warning.
    // A saturated page means the service had more than one page waiting, so the
    // reader is behind — nothing more. It is never a health signal, and it must
    // not read as "catching up".
    if (status.reader.pageSaturated) {
      warning.push(
        'reader page came back saturated: the service had more than one page of messages waiting, so the reader is behind',
      );
    }
    // A widening backlog is the stronger and separate finding: the room produces
    // faster than the reader stores, so messages will be lost whether or not
    // `gap` has recorded one yet. This is the state that must never be described
    // as "catching up".
    if (status.reader.netBacklogIncreasing || status.reader.catchupState === 'unattainable') {
      critical.push(
        'catch-up unattainable under current API capacity: producer > persisted consumer — ' +
          `producer ${status.reader.estimatedProducerRate}/min vs persisted consumer ` +
          `${status.reader.estimatedPersistedRate}/min (cursor advance ` +
          `${status.reader.estimatedCursorAdvanceRate}/min, a protocol metric only), ` +
          `net persisted backlog ${status.reader.estimatedBacklogRate}/min over ` +
          `${status.reader.rooms[0]?.positiveBacklogWindows ?? 0}+ whole windows, ` +
          `limit ${status.reader.limit} (server ${status.reader.serverLimit}), read concurrency ${status.reader.concurrency}`,
      );
    } else if (status.reader.estimatedBacklogRate > 0) {
      // The weaker, one-window statement. It is deliberately a different sentence
      // from the two-window verdict above, because "behind this minute" and "cannot
      // win" are different findings and only one of them is a capacity problem.
      warning.push(
        'producer > persisted consumer over the last window: producer ' +
          `${status.reader.estimatedProducerRate}/min vs persisted consumer ` +
          `${status.reader.estimatedPersistedRate}/min`,
      );
    }
    if (status.reader.unresolvedGap) {
      const rooms = status.reader.unresolvedGapRooms.join(', ') || 'unlabelled';
      // Worded exactly, never "caught up again": a contiguous resume is not
      // recovery, and the historical gap stays on the record either way.
      const note =
        status.reader.contiguousResumeCount > 0
          ? 'contiguous resume observed; historical gap remains'
          : 'unresolved gap remains';
      const line = `${note}: ${rooms}`;
      // A loss in a *referee* room is a hole in the contest record itself, so it
      // is always critical. A loss in the public trading room is graded by the
      // coverage classification below, and is critical only when the room is
      // measured unattainable or its backlog is still widening.
      const refereeGap = status.reader.unresolvedGapRooms.some((room) =>
        this.reader.refereeRoomList.includes(room),
      );
      if (
        refereeGap ||
        status.reader.unattainableRooms.length > 0 ||
        status.reader.netBacklogIncreasing
      ) {
        critical.push(line);
      } else {
        warning.push(line);
      }
    }
    if (status.tier === 'critical' || status.tier === 'readonly') {
      critical.push(`load tier ${status.tier}: ${status.tierReasons.join('; ')}`);
    }
    // Registration readback is only a live commitment. In dry-run, or with
    // registration disabled, missing readbacks are expected and are information.
    if (status.participation.readback < status.agents.total) {
      const missing = status.agents.total - status.participation.readback;
      if (this.config.liveArmed) {
        critical.push(`owner registrations without readback: ${missing}`);
      } else if (this.config.allowRegistration) {
        info.push(`owner registrations without readback: ${missing} (dry-run, registration enabled)`);
      } else {
        info.push(
          `registration disabled / not expected: ${missing} agent(s) have no readback (dry-run, registration off)`,
        );
      }
    }

    // The two readiness gates, banded by what they actually mean here.
    //
    // Only the BLOCKING band carries the reason list. The non-blocking bands
    // name the finding and nothing else, because the reasons are already printed
    // in full by the `referee_ready` / `trading_ready` lines of the state
    // section: repeating a multi-clause list here is what pushes a rendered
    // message past its character budget and buries the sections an operator
    // reads first.
    if (!status.readiness.refereeFeedReady) {
      const detail = status.readiness.refereeFeedReasons.join('; ') || 'reason unlabelled';
      if (this.config.liveArmed) {
        blocking.push(`referee not ready — registration and trading are held: ${detail}`);
      } else if (this.config.expectedRefereeDid === null) {
        info.push('dry-run: referee DID not pinned; observation only, not a live gate');
      } else {
        warning.push('referee seed not verified');
      }
    } else if (!status.readiness.registrationReady) {
      // Distinct from the feed gate on purpose: the referee can be perfectly
      // provable while our own write lane is not, and the two need different
      // sentences or an operator cannot tell which one to fix.
      const detail = status.readiness.registrationReasons.join('; ') || 'reason unlabelled';
      if (this.config.liveArmed) {
        blocking.push(`registration not ready — the 150 owner registrations are held: ${detail}`);
      } else {
        info.push(`dry-run: registration not ready (${detail})`);
      }
    }
    if (!status.readiness.tradingReady) {
      if (this.config.liveArmed) {
        const detail = status.readiness.tradingReasons.join('; ') || 'awaiting seed';
        blocking.push(`trading not ready — no live trade can be written: ${detail}`);
      } else {
        info.push('dry-run only: trading not ready');
      }
    }

    // ---- the close1 coverage posture, named explicitly ----------------------
    //
    // A registration-only launch over a degraded public room is a *chosen*,
    // bounded posture: reads and reports keep working, registration is permitted
    // by an explicit switch, and no trade is possible. It is a warning, and it
    // says all four of those things rather than leaving an operator to infer them
    // from an absence of criticals.
    if (status.operatingMode === 'live_registration_only' && status.close1.coverage !== 'fully_covered') {
      warning.push('registration-only degraded coverage');
      warning.push('trading remains blocked');
      if (
        status.close1.coverage === 'degraded_public_coverage' ||
        status.close1.coverage === 'upstream_gap'
      ) {
        warning.push('close1 historical coverage incomplete');
      }
    }
    if (this.config.liveArmed && status.close1.registrationPending > 0) {
      warning.push(
        `local registration readback pending: ${status.close1.registrationPending} of ${status.close1.registrationReadback.total}`,
      );
    }
    // A local seq inside the band is proof, not suspicion: the message was
    // written and the room's own record of it was lost.
    if (status.close1.localMessagesInGap.length > 0) {
      critical.push(
        `local message provably inside the close1 gap: seq ${status.close1.localMessagesInGap.join(', ')}`,
      );
    }
    if (status.close1.coverage === 'local_message_in_gap') {
      critical.push('a local trade, offer or re-post message falls inside the close1 gap');
    }
    if (status.close1.coverage === 'unattainable') {
      critical.push('close1 is measured unattainable: the public room outruns what can be stored');
    }

    const groupStats = this.runner.groupStats();
    // The first reason trading is refused, shortened for the message budget. The
    // full sentence stays in `/status` and in the alerts bands; this line only
    // has to say *that* a trade is blocked and roughly why.
    const blockedReason =
      status.close1.tradeBlockedReason === null
        ? 'none'
        : status.close1.tradeBlockedReason.length > 60
          ? `${status.close1.tradeBlockedReason.slice(0, 60)}…`
          : status.close1.tradeBlockedReason;
    const participationStatuses = Object.entries(status.participation)
      .filter(([key]) => key !== 'total' && key !== 'readback')
      .map(([key, value]) => `${key}=${value}`)
      .join(' ');

    return {
      reportId: '',
      title: `FLOP Close Call (close-1) 运行报告 ${status.at}`,
      summary: `${status.profile} · ${status.mode}${status.liveArmed ? ' (armed)' : ''} · tier ${status.tier} · sweep ${status.sweep ?? '-'} · agents ${status.agents.total}`,
      alerts: { blocking, critical, warning, info },
      sections: [
        {
          heading: '运行状态',
          lines: [
            `report_time: ${status.at}`,
            `process_uptime: ${status.system.uptimeSeconds}s`,
            `profile: ${status.profile}`,
            `current_mode: ${status.mode}${status.liveArmed ? ' (live armed)' : ' (dry-run)'}`,
            `current_sweep: ${status.sweep ?? '-'}`,
            // The package hash, the referee DID, the lock and conservative mode
            // are all printed in 比赛状态 below; repeating them here would spend
            // report budget on the same four facts.
            //
            // The gate posture is one line, and deliberately without the reasons:
            // the alerts bands carry those in full, and this message is truncated
            // past 4000 characters, so a repeated multi-clause list is what costs
            // a section its middle.
            `operating_mode: ${status.operatingMode} · close1_coverage: ${status.close1.coverage} · close1_gap_policy: ${status.close1.gapPolicy}`,
            `gates: referee_feed ${status.readiness.refereeFeedReady} · registration ${status.readiness.registrationReady} · trading ${status.readiness.tradingReady} · readback ${status.close1.registrationReadback.completed}/${status.close1.registrationReadback.total} pending ${status.close1.registrationPending} in-gap ${status.close1.localMessagesInGap.length} · blocked: ${blockedReason}`,
            `bootstrap state: ${
              status.cors.bootstrap.length > 0
                ? `bootstrap_truncated in ${status.cors.bootstrap.join(', ')}`
                : 'ready (no room opened with truncated history)'
            }`,
            `cursor gaps: ${status.cors.gaps}${status.cors.gapRooms.length ? ` (${status.cors.gapRooms.join(', ')})` : ''} · room_scope: ${status.rooms.scope}`,
            `load tier: ${status.tier}${status.tierReasons.length ? ` (${status.tierReasons.join('; ')})` : ''} · process CPU: ${
              status.system.cpuPercent === null
                ? 'warming_up (needs two tick samples)'
                : `${status.system.cpuPercent}% of one core over the last tick`
            }`,
            `event loop: rss ${(status.system.rssBytes / 1024 / 1024).toFixed(1)}MB heap ${(status.system.heapUsedBytes / 1024 / 1024).toFixed(1)}MB lag ${status.system.eventLoopLagMs}ms`,
          ],
        },
        {
          heading: '读取器 (reader)',
          lines: [
            // Deliberately compact — the rendered message has a hard character
            // budget. Exactly the fields an operator needs to judge throughput:
            // the mode of every room (quiet rooms summarised), the page size and
            // its ceiling, the three *separate* rates, the coverage verdict, the
            // lifetime totals, the export result and the service's own pacing.
            `mode: ${status.reader.continuousMode ? 'continuous' : 'scheduler tick'} · rooms: ${status.reader.fixedRoomCount} · active: ${status.reader.activeRequests} · catch-up: ${status.reader.catchupState} · limit: ${status.reader.limit}/${status.reader.serverLimit}`,
            `room modes: ${Object.entries(status.reader.modeByRoom)
              .filter(([, mode]) => mode !== 'normal')
              .map(([room, mode]) => `${room.replace(/^d-close1-/, '')}=${mode}`)
              .join(' ') || 'all normal'}`,
            // The rates are the honest answer to "are we keeping up", and two of
            // them are deliberately separate from the third: `persisted/min` is
            // consumption, while `cursor-adv/min` is only how far the cursor
            // *number* moved — a cursor steps over a gap nobody stored, so showing
            // it alone is how a reader that is losing ground comes to look healthy.
            `rates/min: reads ${status.reader.readsPerMinute} · returned ${status.reader.returnedPerMinute} · producer ${status.reader.estimatedProducerRate} · persisted ${status.reader.estimatedPersistedRate} · cursor-adv ${status.reader.estimatedCursorAdvanceRate} · lost-gap ${status.reader.estimatedLostGapRate} · req ${Math.round(status.reader.rooms.reduce((sum, row) => sum + row.avgRequestDurationMs, 0) / Math.max(1, status.reader.rooms.length))}ms`,
            `net persisted backlog/min: ${status.reader.estimatedBacklogRate}${status.reader.netBacklogIncreasing ? ' (INCREASING over 2 windows)' : ''} · page-saturated: ${status.reader.pageSaturated} · fully-caught-up: ${status.reader.fullyCaughtUp} · unattainable: ${status.reader.unattainableRooms.join(', ') || 'none'}`,
            `totals: returned ${status.reader.returnedMessages} · persisted ${status.reader.persistedMessages} · duplicate ${status.reader.duplicateMessages} · rejected ${status.reader.rejectedMessages} · signed ${status.reader.signedMessages} · bad-sig ${status.reader.invalidSignatureMessages} · cursor-adv ${status.reader.cursorSequenceAdvance} · gap ${status.reader.gapMessages}`,
            `export: ${status.reader.exportRecovery.enabled ? 'on' : 'off'}${status.reader.exportRecovery.skippedReason === null ? '' : ` (skipped: ${status.reader.exportRecovery.skippedReason})`} · attempts ${status.reader.exportRecovery.attempts} · ok ${status.reader.exportRecovery.succeeded} · failed ${status.reader.exportRecovery.failed} · gen-mismatch ${status.reader.exportRecovery.generationMismatch} · recovered ${status.reader.exportRecovery.recoveredMessages} · malformed ${status.reader.exportRecovery.malformedRecords} · 429 ${status.reader.throttledReads} · timeout ${status.reader.timeoutReads} · wait-not-held ${status.reader.waitNotHeld}`,
            `health: ${status.reader.healthy ? 'healthy' : status.reader.healthReasons.join('; ')} · recorded gaps: ${status.reader.gaps.total}${
              status.reader.gaps.rooms.length ? ` (${status.reader.gaps.rooms.join(', ')})` : ''
            } · unresolved gap: ${status.reader.unresolvedGapRooms.join(', ') || 'none'} · resumes: ${status.reader.contiguousResumeCount} · recoveries: ${status.reader.gapRecoveryCount}`,
            `fairness: silent ${status.reader.silentRooms.join(', ') || 'none'} · warned ${status.reader.rooms.filter((row) => row.fairnessWarning).map((row) => row.room).join(', ') || 'none'} · bound ${status.reader.rooms[0]?.fairnessBudgetMs ?? '-'}ms · error: ${status.reader.lastError ?? 'none'}`,
          ],
        },
        {
          heading: '比赛状态',
          lines: [
            `current_sweep: ${status.sweep ?? '-'}`,
            `price.applied (settled reference): ${this.reader.verifier.state.appliedReference?.toString() ?? '-'}`,
            `price.ref.px (close): ${status.reference ?? '-'}`,
            `limits: ${status.limits ? `${status.limits.low} .. ${status.limits.high}` : '-'}`,
            `limits for sweep: ${this.reader.verifier.state.limitsForSweep ?? '-'} (usable: ${this.reader.verifier.state.limitsUsable})`,
            `locked: ${status.locked}`,
            `package hash: ${status.packageHash ?? '-'}`,
            `referee DID: ${status.refereeDid ?? '-'}`,
            `conservative: ${status.conservative}`,
          ],
        },
        {
          heading: '参赛证据',
          lines: [
            `total_agents: ${status.agents.total} · enabled: ${status.agents.enabled} · strategy failures: ${status.agents.failures}`,
            `groups: ${STRATEGY_GROUPS.map((group) => `${group}=${status.agents.byGroup[group] ?? 0}`).join(' ')}`,
            // `statuses` already carries the per-status counts, including the
            // minted and unknown ones, so the two looser counts it used to sit
            // beside are gone rather than repeated. The budget they free is what
            // pays for the seedless posture: the mode, the two gates it is
            // anchored on, what it does *not* claim, and the registration layers.
            // The full block lives in `/status` and `/reader-report`.
            `statuses: ${participationStatuses}`,
            `ls: ${status.operatingMode} pin=${status.launchPinVerified} feed=${status.lateStartFeedReady}` +
              ` snap=${status.marketSnapshotReady} seed=${status.seedVerified} replay=${status.historicalReplayComplete}` +
              ` reg=${status.registration.postAcked}/${status.registration.roomEchoConfirmed}/${status.registration.mintConfirmed}/${status.registration.mintUncertain}` +
              // Registration-before-trade and the wall clock, in the same breath
              // as the layers they gate: `regready` is what the trading path
              // requires, and `pt` is the fallback's own coverage.
              ` regready=${status.registrationReady}/${status.registrationExpected}` +
              ` lock=${status.wallClockBeforeLock}${status.lockedByWallClock ? '(wall)' : ''}` +
              ` pt=${status.participationTradesPosted}/${status.participationTradesExpected}/${status.participationAgentsCovered}` +
              // The strategy path, only where it is the bootstrap: in the strict
              // mode the group profiles' numbers are already in `statuses`.
              (status.strategyGateMode === 'late_start_bootstrap'
                ? ` strat=${status.lateStartSignal} obs=${status.lateStartObservationCount}` +
                  ` ready=${status.lateStartStrategyTradingReady}` +
                  ` st=${status.strategyTradesPosted}/bs${status.bootstrapStrategyTradesPosted}`
                : '') +
              (status.lateStartBlockedReason === null ? '' : ` blocked=${status.lateStartBlockedReason}`),
          ],
        },
        {
          heading: '运行覆盖 (7x24h)',
          lines: [
            `runs since startup: ${status.runs.sinceStartup} · scheduler ticks: ${status.runs.schedulerTicks} · unique agents: ${status.runs.uniqueAgents}/${status.agents.total}`,
            `full fleet cycles: ${status.runs.fullFleetCycles}`,
            `watchdog passes: ${status.runs.watchdogRuns} · last tick: ${status.runs.lastTickAt ?? 'never'} · next: ${status.runs.nextTickAt ?? '-'} · this tick: ${status.runs.agentsInCurrentTick}`,
            // The durable count spans every process that ran today, so it sits
            // next to the process's own figures rather than replacing them.
            `agent_runs rows today (durable, spans restarts): ${status.runs.today} · in window: ${status.runs.window}`,
            `agents_run_in_last_window: ${status.agents.total - status.agents.staleCount} · not run: ${status.agents.staleCount} · last run: ${status.agents.lastRunAt ?? 'never'} · missing ids: ${status.agents.staleSample.join(', ') || 'none'}`,
          ],
        },
        {
          heading: '策略分组',
          // One line rather than five: the per-group agent counts already appear
          // above, so repeating them here would spend report budget on the same
          // five numbers.
          lines: [
            groupStats
              .map((entry) => `${entry.group} ${entry.runs}/${entry.agents}`)
              .join(' · '),
          ],
        },
        {
          heading: '交易',
          lines: [
            `total trades: ${status.trades.total ?? 0}`,
            `pending: ${status.trades.pending ?? 0} settled: ${status.trades.settled ?? 0} void: ${status.trades.void ?? 0} funds: ${status.trades.funds ?? 0} limits: ${status.trades.limits ?? 0} expired: ${status.trades.expired ?? 0}`,
            `trades in current sweep: ${status.tradeSweeps.inCurrent}`,
            `trades after lock (should be 0): ${status.tradeSweeps.afterLock}`,
            `duplicate trade attempts: ${status.tradeSweeps.duplicateAttempts}`,
            // The cursor-gap, bootstrap and readiness lines live in 运行状态;
            // repeating them here would spend report budget on the same facts.
            `room resets: ${status.cors.resets.join(', ') || 'none'}`,
          ],
        },
        {
          heading: '资金方向 (funds)',
          lines: [
            `official reasons: ${Object.entries(status.funds.officialReasons)
              .map(([key, value]) => `${key}=${value}`)
              .join(' ') || 'none'}`,
            `official side: unknown (the referee names a reason, never a side)`,
            `local inferred side: ${this.localFundsSideSummary()} — confidence: local_inference`,
            `funds verdicts (official): ${status.funds.fundsVerdicts}`,
            `trades carrying a local inference: ${status.funds.localInferred}`,
          ],
        },
        {
          heading: '房间范围 (room scope)',
          lines: [
            `fixed rooms: ${status.rooms.fixed.join(', ')}`,
            `dynamic rooms (${status.rooms.dynamic.length}/${status.rooms.cap}): ${
              status.rooms.dynamic.join(', ') || 'none'
            }`,
          ],
        },
        {
          heading: '归档 (archive)',
          lines: [
            `archive_latest_index_sweep: ${status.archive.latestIndexSweep ?? '-'}`,
            `archive_latest_verified_sweep: ${status.archive.latestVerifiedSweep ?? '-'}`,
            `archive_lag_sweeps: ${status.archive.lagSweeps ?? '-'}`,
            `archive_full_verified: ${status.archive.fullVerified}`,
            `archive_redacted_verified: ${status.archive.redactedVerified}`,
            `archive_unavailable: ${status.archive.unavailable}`,
            `archive_hash_mismatch: ${status.archive.hashMismatch}`,
            `archive last check: ${status.archive.lastCheckAt ?? 'never'}${status.archive.lastError ? ` (${status.archive.lastError})` : ''}`,
          ],
        },
        {
          heading: 'missed 重发队列',
          lines: [
            `reposts: ${Object.entries(status.repost)
              .filter(([key]) => key !== 'total')
              .map(([key, value]) => `${key}=${value}`)
              .join(' ') || 'none'} (total ${status.repost.total})`,
            `lock sweep: ${this.rules.lockSweep} — re-posting stops past it`,
          ],
        },
        {
          heading: '模型与平台',
          lines: [
            `deepseek calls today: ${status.llm.normal} normal / ${status.llm.retries} retry / ${status.llm.total} total (hard cap 3)`,
            `deepseek blocked: ${status.llm.blocked} tokens: ${status.llm.tokens}`,
            `technocore reads ${status.technocore.reads ?? 0} writes ${status.technocore.writes ?? 0} 429 ${status.technocore.throttled ?? 0} errors ${status.technocore.errors ?? 0}`,
            `lark ws: ${status.lark.state} connected=${status.lark.connected} stale=${status.lark.heartbeatStale}`,
            `lark outbox: ${Object.entries(status.lark.outbox)
              .map(([key, value]) => `${key}=${value}`)
              .join(' ') || 'empty'}`,
          ],
        },
        {
          heading: '运行事件 (runtime events)',
          lines: [
            `events recorded: ${status.runtimeEvents.total} (critical ${status.runtimeEvents.critical} / warning ${status.runtimeEvents.warning})`,
            `alert delivery: delivered ${status.runtimeEvents.delivered} pending ${status.runtimeEvents.pending} failed ${status.runtimeEvents.failed}`,
            `recent codes: ${status.runtimeEvents.recentCodes.join(', ') || 'none'}`,
          ],
        },
        {
          heading: '存储与基础设施',
          lines: [
            `db: ${(status.storage.dbBytes / 1024 / 1024).toFixed(1)}MB wal: ${(status.storage.walBytes / 1024 / 1024).toFixed(1)}MB`,
            `archive: ${(status.storage.archiveBytes / 1024 / 1024).toFixed(1)}MB`,
            `writer queue depth: ${status.storage.writerQueueDepth}`,
            `lark outbox pending: ${status.lark.outbox.pending ?? 0} failed: ${status.lark.outbox.failed ?? 0} sent: ${status.lark.outbox.sent ?? 0}`,
            `archive status: ${status.archive.lastError ?? 'ok'} (last check ${status.archive.lastCheckAt ?? 'never'})`,
            `last error: ${status.archive.lastError ?? 'none'}`,
            `disk used: ${status.system.diskUsedPercent}%`,
          ],
        },
      ],
      critical,
    };
  }

  /** The package hash the process was launched against, if a pin exists. */
  private pinnedPackageHash(): string | null {
    return this.repositories.upstream.getPin()?.expected_package_hash ?? null;
  }

  /**
   * A compact summary of the local funds-side inferences, for the report.
   *
   * Always labelled as an inference where it is printed: the referee's own
   * `funds_side` is `unknown`, and this must never read as a referee finding.
   */
  private localFundsSideSummary(): string {
    const rows = this.db
      .prepare(
        `SELECT COALESCE(local_funds_side, 'unknown') AS side, COUNT(*) AS n FROM trades
          WHERE funds_side_confidence IS NULL OR funds_side_confidence = 'local_inference'
          GROUP BY side ORDER BY side`,
      )
      .all() as Array<{ side: string; n: number }>;
    if (rows.length === 0) return 'unknown (no local trades yet)';
    return rows.map((row) => `${row.side}=${row.n}`).join(' ');
  }
}

export type { ParticipationStatus };
