/**
 * The conductor: everything that happens on a timer happens here.
 *
 * There is exactly one scheduler and one process. Every tick walks the same
 * fixed order, and the order is the design:
 *
 *   1. sample the load guard, so every later step can be shed by tier;
 *   2. read the six rooms — reads are never shed, because reading is how the
 *      process finds out the problem is over;
 *   3. seed the local risk mirror from the mints the referee has confirmed;
 *   4. make sure every agent has a signed owner registration and a readback;
 *   5. run each group's slice of agents through its deterministic strategy;
 *   6. post a trade, but only past the validator, the local caps and the load
 *      guard — and never in dry-run;
 *   7. reconcile participation against the referee's flow posts;
 *   8. once a day: the weekly watchdog, which is the 7x24h floor;
 *   9. twice a day: the Lark report, and the maintenance pass after it lands;
 *  10. twice a day, in an idle window only: the model parameter review.
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
import {
  Decimal,
  RiskAccount,
  buildTerms,
  generateTradeId,
  withinLimits,
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
  watchdog: { ran: boolean; backfilled: number };
  lark: { delivered: string[]; maintenance: boolean };
  deepseek: { attempted: string[]; refused: number };
  upstream: { checked: boolean; drift: boolean };
}

export interface StatusSnapshot {
  at: string;
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
  };
  participation: Record<string, number> & { total: number; readback: number };
  runs: { today: number; window: number };
  trades: Record<string, number>;
  cors: { gaps: number; gapRooms: string[]; resets: string[] };
  technocore: Record<string, number>;
  llm: { normal: number; retries: number; total: number; blocked: number; tokens: number };
  lark: { connected: boolean; state: string; heartbeatStale: boolean; outbox: Record<string, number> };
  upstream: { checkedAt: string | null; drift: boolean };
  system: { rssBytes: number; heapUsedBytes: number; cpuPercent: number; uptimeSeconds: number; diskUsedPercent: number };
  storage: { dbBytes: number; archiveBytes: number; walBytes: number };
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
  now?: () => Date;
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
  private readonly now: () => Date;

  private timer: ReturnType<typeof setInterval> | null = null;
  private inFlight: Promise<TickReport> | null = null;
  private tickCount = 0;
  private lastWatchdogDay: string | null = null;
  private lastMaintenanceDay: string | null = null;
  private lastUpstreamCheckMs = 0;
  private lastTickReport: TickReport | null = null;
  /** Per-agent mirror of cash and open lots; rebuilt from the referee's mints. */
  private readonly riskBook: Map<string, RiskAccount> = new Map();
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
    const periodMs = Math.max(5, this.config.scheduling.tickSeconds) * 1000;
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

  private async tickOnce(): Promise<TickReport> {
    const at = this.now();
    const state = this.loadGuard.poll();

    const tick = await this.reader.tick();
    this.seedRiskBook();

    const participation = await this.ensureParticipation();

    const runOutcome = this.runAgentSlices();
    const trades = await this.executeActions(runOutcome.outcomes);

    const reconciled = this.reconcileMints();
    const watchdog = await this.maybeRunWatchdog(at);
    const lark = await this.maybeReport(at);

    let deepseek = { attempted: [] as string[], refused: 0 };
    if (this.deepSeek && this.loadGuard.allow('llm')) {
      try {
        const result = await this.deepSeek.runOnce(at);
        deepseek = { attempted: result.attempted, refused: result.refused.length };
      } catch (error) {
        this.logger.event({
          level: 'warn',
          source: 'scheduler',
          code: 'deepseek_slot_failed',
          message: 'model slot failed; the previous parameters stay effective',
          data: { error: error instanceof Error ? error.message : String(error) },
        });
      }
    }

    const upstream = await this.maybeCheckUpstream(at);
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
      watchdog,
      lark,
      deepseek,
      upstream: {
        checked: upstream,
        drift: Number(pin?.drift ?? 0) === 1,
      },
    };
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
  // participation
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
  // local strategy runs
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
  // trades
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
        const refusal = tradingAllowed
          ? null
          : snapshot.locked
            ? 'locked'
            : drift
              ? 'package_drift'
              : 'load_shed';
        if (refusal !== null) {
          this.recordTrade(agentId, terms, 'refused', refusal, signed.maker_sig, signed.taker_sig);
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
    if (snapshot.reference !== null && !withinLimits(this.rules, px, snapshot.reference)) return null;
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

  // -------------------------------------------------------------------------
  // weekly watchdog
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
  // Lark report + maintenance
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
  // upstream
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
  // status
  // -------------------------------------------------------------------------

  status(): StatusSnapshot {
    const at = this.now();
    const verifier = this.reader.verifier.state;
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
    const cpu = process.cpuUsage();
    const uptimeSeconds = Math.max(1, (Date.now() - this.startedAt) / 1000);
    const cursorGaps = this.reader.gaps();
    const wsStatus = this.lark?.websocket.status;

    return {
      at: at.toISOString(),
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
      },
      participation: {
        ...this.repositories.participation.countByStatus(),
        total: this.repositories.participation.count(),
        readback: this.repositories.participation.countWithReadback(),
      },
      runs: {
        today: this.repositories.agentRuns.countSince(dayStart),
        window: this.repositories.agentRuns.countSince(runWindowStart),
      },
      trades: this.repositories.trades.countByStatus(),
      cors: { gaps: cursorGaps.total, gapRooms: cursorGaps.rooms, resets: cursorGaps.resets },
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
        cpuPercent: Number((((cpu.user + cpu.system) / 1000 / uptimeSeconds) * 100).toFixed(2)),
        uptimeSeconds: Number(uptimeSeconds.toFixed(0)),
        diskUsedPercent: Number(this.loadGuard.diskUsedPercent(this.config.dataDir).toFixed(2)),
      },
      storage: {
        dbBytes: existsSync(this.config.paths.database)
          ? fileBytes(this.config.paths.database)
          : 0,
        archiveBytes: this.repositories.archiveManifests.totalBytes(),
        walBytes: existsSync(`${this.config.paths.database}-wal`)
          ? fileBytes(`${this.config.paths.database}-wal`)
          : 0,
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
  }> {
    const status = this.status();
    const critical: string[] = [];
    if (status.packageDrift) {
      critical.push(
        `package hash drift: expected ${status.expectedPackageHash ?? '<unset>'}, seed says ${status.packageHash ?? '<none>'} — active trading is paused`,
      );
    }
    if (status.conservative) {
      critical.push(`conservative mode: ${status.conservativeReasons.join('; ')}`);
    }
    if (status.cors.gaps > 0) critical.push(`cursor gaps: ${status.cors.gaps}`);
    if (status.tier === 'critical' || status.tier === 'readonly') {
      critical.push(`load tier ${status.tier}: ${status.tierReasons.join('; ')}`);
    }
    if (status.participation.readback < status.agents.total) {
      critical.push(
        `owner registrations without readback: ${status.agents.total - status.participation.readback}`,
      );
    }

    const groupStats = this.runner.groupStats();
    const participationStatuses = Object.entries(status.participation)
      .filter(([key]) => key !== 'total' && key !== 'readback')
      .map(([key, value]) => `${key}=${value}`)
      .join(' ');

    return {
      reportId: '',
      title: `FLOP Close Call (close-1) 运行报告 ${status.at}`,
      summary: `${status.mode}${status.liveArmed ? ' (armed)' : ''} · tier ${status.tier} · sweep ${status.sweep ?? '-'} · agents ${status.agents.total}`,
      sections: [
        {
          heading: '运行状态',
          lines: [
            `report_time: ${status.at}`,
            `uptime: ${status.system.uptimeSeconds}s`,
            `mode: ${status.mode}${status.liveArmed ? ' (live armed)' : ' (dry-run)'}`,
            `load tier: ${status.tier}${status.tierReasons.length ? ` (${status.tierReasons.join('; ')})` : ''}`,
            `event loop: rss ${(status.system.rssBytes / 1024 / 1024).toFixed(1)}MB heap ${(status.system.heapUsedBytes / 1024 / 1024).toFixed(1)}MB cpu ${status.system.cpuPercent}%`,
          ],
        },
        {
          heading: '比赛状态',
          lines: [
            `current_sweep: ${status.sweep ?? '-'}`,
            `reference price: ${status.reference ?? '-'}`,
            `limits: ${status.limits ? `${status.limits.low} .. ${status.limits.high}` : '-'}`,
            `locked: ${status.locked}`,
            `package hash: ${status.packageHash ?? '-'}`,
            `referee DID: ${status.refereeDid ?? '-'}`,
            `conservative: ${status.conservative}`,
          ],
        },
        {
          heading: '参赛证据',
          lines: [
            `agents total: ${status.agents.total} enabled: ${status.agents.enabled}`,
            `participation records: ${status.participation.total}`,
            `registration readback: ${status.participation.readback}`,
            `statuses: ${participationStatuses}`,
            `mint_observed: ${status.participation.mint_observed ?? 0}`,
            `mint_unknown: ${status.participation.mint_unknown ?? 0}`,
          ],
        },
        {
          heading: '运行覆盖 (7x24h)',
          lines: [
            `today runs: ${status.runs.today}`,
            `window runs: ${status.runs.window}`,
            `agents not run in window: ${status.agents.staleCount}`,
            `missing agent ids: ${status.agents.staleSample.join(', ') || 'none'}`,
            `last run at: ${status.agents.lastRunAt ?? 'never'}`,
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
            `trades: ${Object.entries(status.trades)
              .map(([key, value]) => `${key}=${value}`)
              .join(' ') || 'none'}`,
            `cursor gap: ${status.cors.gaps}${status.cors.gapRooms.length ? ` (${status.cors.gapRooms.join(', ')})` : ''}`,
            `room resets: ${status.cors.resets.join(', ') || 'none'}`,
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
          heading: '存储',
          lines: [
            `db: ${(status.storage.dbBytes / 1024 / 1024).toFixed(1)}MB wal: ${(status.storage.walBytes / 1024 / 1024).toFixed(1)}MB`,
            `archive: ${(status.storage.archiveBytes / 1024 / 1024).toFixed(1)}MB`,
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
}

export type { ParticipationStatus };
