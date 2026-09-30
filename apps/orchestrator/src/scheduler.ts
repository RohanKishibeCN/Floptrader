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
import type { ParticipationRow, ParticipationStatus, Repositories, SqliteDatabase } from '@flop/storage';
import { fileBytes } from '@flop/storage';
import {
  GroupRunner,
  asDecimals,
  fallbackParams,
  type GatedAction,
  type RunOutcome,
  type StrategyGroupName,
} from '@flop/strategy';
import type { TechnocoreClient } from '@flop/technocore';
import type { ArchiveMaintenance } from './archive-maintenance.js';
import type { Config } from './config.js';
import type { DeepSeekBudget, DeepSeekScheduler, ParameterOptimiser } from './llm.js';
import { localDateKey } from './llm.js';
import type { LarkStack } from './lark.js';
import type { LoadGuard, LoadTier } from './load-guard.js';
import type { Logger } from './logger.js';
import type { OrchestratorReader } from './reader.js';
import { refereeReadiness, tradingReadiness, type Readiness } from './readiness.js';
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
  repost: { queued: number; posted: number; failed: number; skipped: number };
  watchdog: { ran: boolean; backfilled: number };
  lark: { delivered: string[]; maintenance: boolean };
  deepseek: { attempted: string[]; refused: number };
  upstream: { checked: boolean; drift: boolean };
}

export interface StatusSnapshot {
  at: string;
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
    refereeReady: boolean;
    tradingReady: boolean;
  };
  /**
   * The two readiness gates. `refereeReady` gates live registration,
   * `tradingReady` gates live trading; both carry the reasons they failed so a
   * report never has to guess why a trade was refused.
   */
  readiness: {
    refereeReady: boolean;
    tradingReady: boolean;
    refereeReasons: string[];
    tradingReasons: string[];
  };
  cors: { gaps: number; gapRooms: string[]; resets: string[]; bootstrap: string[] };
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
    const tick = await this.reader.tick();
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
      const refereeReadinessNow = this.readiness().referee;
      if (!refereeReadinessNow.ready) {
        this.logger.event({
          level: 'error',
          source: 'scheduler',
          code: 'registration_blocked_referee_not_ready',
          message: `referee is not ready; owner registrations are held: ${refereeReadinessNow.reasons.join('; ')}`,
          data: { reasons: refereeReadinessNow.reasons },
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
    const current = this.reader.verifier.state.currentSweep;
    let minted = 0;
    let unknown = 0;

    for (const row of this.repositories.participation.all()) {
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

    for (const row of this.repositories.reposts.retryable()) {
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
    const offers = this.reader.externalOffers();
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
      try {
        const built = this.buildSignedTrade(agentId, did, action, snapshot);
        if (!built.ok) {
          result.refused += 1;
          if (built.terms) {
            this.recordTrade(agentId, built.terms, 'refused', built.reason, null, null);
          }
          continue;
        }
        const { terms, signed } = built;
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
          this.recordTrade(agentId, terms, 'refused', refusal, signed.maker_sig, signed.taker_sig);
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
          );
          result.refused += 1;
          continue;
        }
        if (!this.config.liveArmed) {
          this.recordTrade(agentId, terms, 'dry_run', 'dry_run', signed.maker_sig, signed.taker_sig);
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
    const until = Math.min(snapshot.sweep + DEFAULT_TRADE_HORIZON_SWEEPS, this.rules.lockSweep);
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
  private readiness(): { referee: Readiness; trading: Readiness } {
    const verifier = this.reader.verifier.state;
    const referee = refereeReadiness({
      seedSeen: verifier.seedSeen,
      refereeDid: verifier.refereeDid,
      expectedRefereeDid: this.config.expectedRefereeDid,
      packageHash: verifier.packageHash,
      expectedPackageHash: verifier.expectedPackageHash,
      hydrated: this.reader.isHydrated,
      refereeRoomsReset: this.reader.refereeRoomsReset(),
      requirePin: this.config.requireRefereePin,
    });

    const identities = this.repositories.identities.all();
    const enabled = identities.filter((row) => row.enabled === 1).length;
    const total = this.keyStore.size;
    const trading = tradingReadiness({
      referee,
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
      fleetComplete: total > 0 && enabled === total,
      registrationRequired: this.config.liveArmed,
      registrationReadbackComplete: this.repositories.participation.countWithReadback() >= total,
    });
    return { referee, trading };
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

    return {
      at: at.toISOString(),
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
        refereeReady: readiness.referee.ready,
        tradingReady: readiness.trading.ready,
      },
      readiness: {
        refereeReady: readiness.referee.ready,
        tradingReady: readiness.trading.ready,
        refereeReasons: readiness.referee.reasons,
        tradingReasons: readiness.trading.reasons,
      },
      cors: {
        gaps: cursorGaps.total,
        gapRooms: cursorGaps.rooms,
        resets: cursorGaps.resets,
        bootstrap: cursorGaps.bootstrap,
      },
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
    if (!status.readiness.refereeReady) {
      const detail = status.readiness.refereeReasons.join('; ') || 'reason unlabelled';
      if (this.config.liveArmed) {
        blocking.push(`referee not ready — registration and trading are held: ${detail}`);
      } else if (this.config.expectedRefereeDid === null) {
        info.push(`dry-run: referee DID not pinned (${detail}); observation only, not a live gate`);
      } else {
        warning.push(`referee seed not verified: ${detail}`);
      }
    }
    if (!status.readiness.tradingReady) {
      const detail = status.readiness.tradingReasons.join('; ') || 'awaiting seed';
      if (this.config.liveArmed) {
        blocking.push(`trading not ready — no live trade can be written: ${detail}`);
      } else {
        info.push(`dry-run only: trading not ready (${detail})`);
      }
    }

    const groupStats = this.runner.groupStats();
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
            `locked: ${status.locked}`,
            `conservative: ${status.conservative}${
              status.conservative
                ? ` (${status.conservativeReasons.join('; ') || 'reason unlabelled'})`
                : ''
            }`,
            `package_hash: ${status.packageHash ?? '-'}`,
            `referee_did: ${status.refereeDid ?? '-'}`,
            `referee_ready: ${status.readiness.refereeReady}${
              status.readiness.refereeReady ? '' : ` (${status.readiness.refereeReasons.join('; ') || 'reason unlabelled'})`
            }`,
            `trading_ready: ${status.readiness.tradingReady}${
              status.readiness.tradingReady ? '' : ` (${status.readiness.tradingReasons.join('; ') || 'awaiting seed'})`
            }`,
            `bootstrap state: ${
              status.cors.bootstrap.length > 0
                ? `bootstrap_truncated in ${status.cors.bootstrap.join(', ')}`
                : 'ready (no room opened with truncated history)'
            }`,
            `cursor gaps: ${status.cors.gaps}${status.cors.gapRooms.length ? ` (${status.cors.gapRooms.join(', ')})` : ''}`,
            `room_scope: ${status.rooms.scope}`,
            `load tier: ${status.tier}${status.tierReasons.length ? ` (${status.tierReasons.join('; ')})` : ''}`,
            `process CPU: ${
              status.system.cpuPercent === null
                ? 'warming_up (needs two tick samples)'
                : `${status.system.cpuPercent}% of one core over the last tick`
            }`,
            `event loop: rss ${(status.system.rssBytes / 1024 / 1024).toFixed(1)}MB heap ${(status.system.heapUsedBytes / 1024 / 1024).toFixed(1)}MB lag ${status.system.eventLoopLagMs}ms`,
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
            `total_agents: ${status.agents.total}`,
            `enabled_agents: ${status.agents.enabled}`,
            `groups: ${STRATEGY_GROUPS.map((group) => `${group}=${status.agents.byGroup[group] ?? 0}`).join(' ')}`,
            `strategy failures: ${status.agents.failures}`,
            `registration count: ${status.participation.total}`,
            `registration readback count: ${status.participation.readback}`,
            `statuses: ${participationStatuses}`,
            `mint_observed: ${status.participation.mint_observed ?? 0}`,
            `mint_unknown: ${status.participation.mint_unknown ?? 0}`,
          ],
        },
        {
          heading: '运行覆盖 (7x24h)',
          lines: [
            `runs since startup (this process): ${status.runs.sinceStartup}`,
            `scheduler ticks (this process): ${status.runs.schedulerTicks}`,
            `unique agents evaluated (this process): ${status.runs.uniqueAgents}/${status.agents.total}`,
            `full fleet cycles: ${status.runs.fullFleetCycles}`,
            `agents run in current tick: ${status.runs.agentsInCurrentTick}`,
            `watchdog passes: ${status.runs.watchdogRuns}`,
            `last tick: ${status.runs.lastTickAt ?? 'never'}`,
            `next tick: ${status.runs.nextTickAt ?? '-'}`,
            // The durable count spans every process that ran today, so it sits
            // next to the process's own figures rather than replacing them.
            `agent_runs rows today (durable, spans restarts): ${status.runs.today}`,
            `agent_runs rows in window (durable): ${status.runs.window}`,
            `agents_run_in_last_window: ${status.agents.total - status.agents.staleCount}`,
            `agents_not_run_in_last_window: ${status.agents.staleCount}`,
            `last_agent_run_at: ${status.agents.lastRunAt ?? 'never'}`,
            `missing agent ids: ${status.agents.staleSample.join(', ') || 'none'}`,
          ],
        },
        {
          heading: '策略分组',
          lines: groupStats.map(
            (entry) => `${entry.group}: runs ${entry.runs} agents ${entry.agents}/${status.agents.byGroup[entry.group] ?? 0}`,
          ),
        },
        {
          heading: '交易',
          lines: [
            `total trades: ${status.trades.total ?? 0}`,
            `pending: ${status.trades.pending ?? 0} settled: ${status.trades.settled ?? 0} void: ${status.trades.void ?? 0} funds: ${status.trades.funds ?? 0} limits: ${status.trades.limits ?? 0} expired: ${status.trades.expired ?? 0}`,
            `trades in current sweep: ${status.tradeSweeps.inCurrent}`,
            `trades after lock (should be 0): ${status.tradeSweeps.afterLock}`,
            `duplicate trade attempts: ${status.tradeSweeps.duplicateAttempts}`,
            `by status: ${Object.entries(status.trades)
              .filter(([key]) => key !== 'total')
              .map(([key, value]) => `${key}=${value}`)
              .join(' ') || 'none'}`,
            `cursor gap: ${status.cors.gaps}${status.cors.gapRooms.length ? ` (${status.cors.gapRooms.join(', ')})` : ''}`,
            `bootstrap_truncated rooms: ${status.cors.bootstrap.join(', ') || 'none'}`,
            `room resets: ${status.cors.resets.join(', ') || 'none'}`,
            `referee_ready: ${status.readiness.refereeReady} trading_ready: ${status.readiness.tradingReady}`,
          ],
        },
        {
          heading: '资金方向 (funds)',
          lines: [
            `official reasons: ${Object.entries(status.funds.officialReasons)
              .map(([key, value]) => `${key}=${value}`)
              .join(' ') || 'none'}`,
            `official reason: funds — official side: unknown (the referee names a reason, never a side)`,
            `local inferred side: ${this.localFundsSideSummary()} — confidence: local_inference`,
            `funds verdicts (official): ${status.funds.fundsVerdicts}`,
            `trades carrying a local inference: ${status.funds.localInferred}`,
          ],
        },
        {
          heading: '房间范围 (room scope)',
          lines: [
            `room_scope: ${status.rooms.scope}`,
            `fixed rooms: ${status.rooms.fixed.join(', ')}`,
            `dynamic rooms (${status.rooms.dynamic.length}/${status.rooms.cap}): ${
              status.rooms.dynamic.join(', ') || 'none'
            }`,
            `MAX_DISCOVERED_ROOMS: ${status.rooms.cap}`,
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
