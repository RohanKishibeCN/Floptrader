/**
 * Load guard: keep the process inside the 2 vCPU / 4 GB VPS budget by degrading
 * in a fixed order instead of dying.
 *
 * The order is monotonic — the worst condition that fires wins, and a higher
 * tier implies every pause of the tiers below it. Nothing here ever throws:
 * under memory or disk pressure the useful behaviour is to shed work, not to
 * crash the process that is holding the contest record.
 *
 *   normal        nothing paused
 *   pause_llm     non-essential model + compression work paused
 *   shed_trading  active trading, new offers and verbose debug stopped; reads kept
 *   critical      as above, plus a permanent `disk_critical` alert
 *   readonly      read-only protection mode; only reads are allowed
 */
import { statfsSync } from 'node:fs';
import { monitorEventLoopDelay, type IntervalHistogram } from 'node:perf_hooks';
import { totalmem } from 'node:os';
import type { Config } from './config.js';
import type { Logger } from './logger.js';

export type LoadTier = 'normal' | 'pause_llm' | 'shed_trading' | 'critical' | 'readonly';

export interface LoadSignals {
  rssBytes: number;
  rssLimitBytes: number;
  heapUsedBytes: number;
  eventLoopLagMs: number;
  diskUsedPercent: number;
  writerQueueDepth: number;
  llmQueueDepth: number;
  timestamp: string;
}

export interface PausedFlags {
  llm: boolean;
  compression: boolean;
  weeklyBackfill: boolean;
  newOffers: boolean;
  verboseDebug: boolean;
  activeTrading: boolean;
  readsOnly: boolean;
}

export interface LoadState {
  tier: LoadTier;
  reasons: string[];
  paused: PausedFlags;
  /** ms timestamp at which event loop lag first went continuously over the threshold. */
  lagOverSinceMs: number | null;
  updatedAt: string;
}

/** Release order; a higher rank is a strictly worse state. */
const TIER_RANK: Record<LoadTier, number> = {
  normal: 0,
  pause_llm: 1,
  shed_trading: 2,
  critical: 3,
  readonly: 4,
};

/**
 * What each tier pauses. Read is never in this table: reads are always allowed,
 * which is what makes `readonly` a protection mode rather than a shutdown.
 */
const TIER_PAUSES: Record<LoadTier, PausedFlags> = {
  normal: {
    llm: false,
    compression: false,
    weeklyBackfill: false,
    newOffers: false,
    verboseDebug: false,
    activeTrading: false,
    readsOnly: false,
  },
  pause_llm: {
    llm: true,
    compression: true,
    weeklyBackfill: true,
    newOffers: false,
    verboseDebug: false,
    activeTrading: false,
    readsOnly: false,
  },
  shed_trading: {
    llm: true,
    compression: true,
    weeklyBackfill: true,
    newOffers: true,
    verboseDebug: true,
    activeTrading: true,
    readsOnly: false,
  },
  critical: {
    llm: true,
    compression: true,
    weeklyBackfill: true,
    newOffers: true,
    verboseDebug: true,
    activeTrading: true,
    readsOnly: false,
  },
  readonly: {
    llm: true,
    compression: true,
    weeklyBackfill: true,
    newOffers: true,
    verboseDebug: true,
    activeTrading: true,
    readsOnly: true,
  },
};

export interface LoadGuardOptions {
  config: Config;
  logger: Logger;
  readProcessMemory?: () => { rssBytes: number; heapUsedBytes: number };
  readDiskUsage?: (path: string) => number;
  getQueueDepths?: () => { writer: number; llm: number };
  now?: () => Date;
}

export type GuardAction =
  | 'llm'
  | 'compression'
  | 'weekly_backfill'
  | 'new_offer'
  | 'active_trading'
  | 'verbose_debug'
  | 'read';

const ACTION_FLAG: Record<Exclude<GuardAction, 'read'>, keyof PausedFlags> = {
  llm: 'llm',
  compression: 'compression',
  weekly_backfill: 'weeklyBackfill',
  new_offer: 'newOffers',
  active_trading: 'activeTrading',
  verbose_debug: 'verboseDebug',
};

const round = (value: number): string => value.toFixed(0);

export class LoadGuard {
  private readonly config: Config;
  private readonly logger: Logger;
  private readonly readProcessMemory: () => { rssBytes: number; heapUsedBytes: number };
  private readonly readDiskUsage: (path: string) => number;
  private readonly getQueueDepths: (() => { writer: number; llm: number }) | undefined;
  private readonly now: () => Date;
  private diskUnavailableLogged = false;
  private lagOverSinceMs: number | null = null;
  private current: LoadSignals;
  private lastState: LoadState;

  constructor(options: LoadGuardOptions) {
    this.config = options.config;
    this.logger = options.logger;
    this.now = options.now ?? (() => new Date());
    this.readProcessMemory =
      options.readProcessMemory ??
      (() => {
        const usage = process.memoryUsage();
        return { rssBytes: usage.rss, heapUsedBytes: usage.heapUsed };
      });
    this.readDiskUsage = options.readDiskUsage ?? ((path: string) => this.defaultDiskUsage(path));
    this.getQueueDepths = options.getQueueDepths;
    this.current = {
      rssBytes: 0,
      rssLimitBytes: totalmem(),
      heapUsedBytes: 0,
      eventLoopLagMs: 0,
      diskUsedPercent: 0,
      writerQueueDepth: 0,
      llmQueueDepth: 0,
      timestamp: this.now().toISOString(),
    };
    this.lastState = this.buildState('normal', [], null, this.current.timestamp);
  }

  /** Public so the maintenance pass can reuse the same disk reading. */
  diskUsedPercent(path: string): number {
    return this.readDiskUsage(path);
  }

  /**
   * The signals the last `poll()` sampled.
   *
   * Exposed read-only so the status report can quote the same writer-queue depth
   * and memory readings the shed ladder acted on, rather than measuring again
   * and reporting a different number.
   */
  get signals(): LoadSignals {
    return { ...this.current };
  }

  get state(): LoadState {
    return {
      ...this.lastState,
      reasons: [...this.lastState.reasons],
      paused: { ...this.lastState.paused },
    };
  }

  /**
   * Recompute the tier from a set of signals. Partial signals are merged over the
   * last sample, so a caller can update only what it just measured.
   */
  sample(signals: Partial<LoadSignals>): LoadState {
    const merged: LoadSignals = {
      ...this.current,
      ...signals,
      timestamp: signals.timestamp ?? this.now().toISOString(),
    };
    const thresholds = this.config.loadGuard;
    const reasons: string[] = [];
    let tier: LoadTier = 'normal';
    const bump = (candidate: LoadTier, reason: string): void => {
      reasons.push(reason);
      if (TIER_RANK[candidate] > TIER_RANK[tier]) tier = candidate;
    };

    const rssPercent =
      merged.rssLimitBytes > 0 ? (merged.rssBytes / merged.rssLimitBytes) * 100 : 0;
    if (rssPercent > thresholds.rssPausePercent) {
      bump('pause_llm', `rss ${round(rssPercent)}% > ${thresholds.rssPausePercent}%`);
    }
    if (rssPercent > thresholds.rssShedPercent) {
      bump('shed_trading', `rss ${round(rssPercent)}% > ${thresholds.rssShedPercent}%`);
    }

    // Event loop lag only counts when it has been over the threshold for the
    // configured number of seconds; a single spike must not shed work.
    const nowMs = this.now().getTime();
    let lagOverSinceMs = this.lagOverSinceMs;
    if (merged.eventLoopLagMs > thresholds.eventLoopLagMs) {
      if (lagOverSinceMs === null) lagOverSinceMs = nowMs;
      const elapsedSeconds = (nowMs - lagOverSinceMs) / 1000;
      if (elapsedSeconds >= thresholds.eventLoopLagSeconds) {
        bump(
          'pause_llm',
          `event loop lag ${round(merged.eventLoopLagMs)}ms > ${thresholds.eventLoopLagMs}ms ` +
            `for ${round(elapsedSeconds)}s`,
        );
      }
    } else {
      lagOverSinceMs = null;
    }
    this.lagOverSinceMs = lagOverSinceMs;

    if (merged.diskUsedPercent > thresholds.diskCompressPercent) {
      bump('pause_llm', `disk ${round(merged.diskUsedPercent)}% > ${thresholds.diskCompressPercent}%`);
    }
    if (merged.diskUsedPercent > thresholds.diskShedPercent) {
      bump('shed_trading', `disk ${round(merged.diskUsedPercent)}% > ${thresholds.diskShedPercent}%`);
    }
    if (merged.diskUsedPercent > thresholds.diskCriticalPercent) {
      bump('critical', `disk ${round(merged.diskUsedPercent)}% > ${thresholds.diskCriticalPercent}%`);
    }
    if (merged.diskUsedPercent > thresholds.diskReadonlyPercent) {
      bump('readonly', `disk ${round(merged.diskUsedPercent)}% > ${thresholds.diskReadonlyPercent}%`);
    }

    if (merged.writerQueueDepth > thresholds.writerQueueShed) {
      bump(
        'shed_trading',
        `writer queue ${merged.writerQueueDepth} > ${thresholds.writerQueueShed}`,
      );
    }
    if (merged.llmQueueDepth > thresholds.llmQueueShed) {
      bump('pause_llm', `llm queue ${merged.llmQueueDepth} > ${thresholds.llmQueueShed}`);
    }

    this.current = { ...merged, timestamp: merged.timestamp };
    const state = this.buildState(tier, reasons, lagOverSinceMs, merged.timestamp);
    this.lastState = state;
    return { ...state, reasons: [...state.reasons], paused: { ...state.paused } };
  }

  /**
   * Sample the live process and the injected queues, then emit an event when the
   * tier changed. `critical` and `readonly` additionally carry the permanent
   * codes the retention policy never prunes.
   */
  poll(signals: Partial<LoadSignals> = {}): LoadState {
    const memory = this.readProcessMemory();
    const queues = this.getQueueDepths?.() ?? { writer: 0, llm: 0 };
    const merged: Partial<LoadSignals> = {
      rssBytes: memory.rssBytes,
      heapUsedBytes: memory.heapUsedBytes,
      diskUsedPercent: this.readDiskUsage(this.config.dataDir),
      writerQueueDepth: queues.writer,
      llmQueueDepth: queues.llm,
      ...signals,
    };
    const previousTier = this.lastState.tier;
    const state = this.sample(merged);

    if (state.tier !== previousTier) {
      this.logger.event({
        level: this.levelForTier(state.tier),
        source: 'load-guard',
        code: 'load_tier_changed',
        message: `load tier ${previousTier} -> ${state.tier}`,
        data: { from: previousTier, to: state.tier, reasons: state.reasons },
      });
      if (state.tier === 'critical') {
        this.logger.event({
          level: 'error',
          source: 'load-guard',
          code: 'disk_critical',
          message: 'disk pressure is critical; new active trading stopped',
          data: { reasons: state.reasons, diskUsedPercent: this.current.diskUsedPercent },
        });
      }
      if (state.tier === 'readonly') {
        this.logger.event({
          level: 'fatal',
          source: 'load-guard',
          code: 'disk_readonly',
          message: 'disk pressure put the process into read-only protection mode',
          data: { reasons: state.reasons, diskUsedPercent: this.current.diskUsedPercent },
        });
      }
    }
    return state;
  }

  allow(action: GuardAction): boolean {
    if (action === 'read') return true;
    return !this.lastState.paused[ACTION_FLAG[action]];
  }

  private buildState(
    tier: LoadTier,
    reasons: string[],
    lagOverSinceMs: number | null,
    updatedAt: string,
  ): LoadState {
    return {
      tier,
      reasons,
      paused: { ...TIER_PAUSES[tier] },
      lagOverSinceMs,
      updatedAt,
    };
  }

  private levelForTier(tier: LoadTier): 'info' | 'warn' | 'error' | 'fatal' {
    switch (tier) {
      case 'normal':
        return 'info';
      case 'pause_llm':
      case 'shed_trading':
        return 'warn';
      case 'critical':
        return 'error';
      case 'readonly':
        return 'fatal';
    }
  }

  private defaultDiskUsage(path: string): number {
    if (typeof statfsSync !== 'function') {
      if (!this.diskUnavailableLogged) {
        this.diskUnavailableLogged = true;
        this.logger.warn(
          { source: 'load-guard' },
          'fs.statfsSync unavailable; disk pressure checks report 0%',
        );
      }
      return 0;
    }
    try {
      const stats = statfsSync(path);
      const blockSize = Number(stats.bsize);
      const total = Number(stats.blocks) * blockSize;
      const available = Number(stats.bavail) * blockSize;
      if (total <= 0) return 0;
      return ((total - available) / total) * 100;
    } catch {
      // An unreadable path is not disk pressure; refusing to shed on an
      // unrelated error would be worse than reporting 0.
      return 0;
    }
  }
}

/**
 * Event loop lag monitor.
 *
 * `monitorEventLoopDelay` is not available in every runtime (and is not in the
 * soak test's fake environment), so `start()` is a no-op returning false there;
 * callers can then feed `record()` from their own timer.
 */
export class EventLoopMonitor {
  private histogram: IntervalHistogram | undefined;
  private readonly recorded: number[] = [];
  private recordedMax = 0;
  private recordedP99 = 0;

  /** Returns false when the runtime has no `monitorEventLoopDelay`. */
  start(): boolean {
    if (typeof monitorEventLoopDelay !== 'function') return false;
    if (this.histogram) return true;
    const histogram = monitorEventLoopDelay({ resolution: 20 });
    histogram.enable();
    this.histogram = histogram;
    return true;
  }

  /** Safe to call twice; the second call is a no-op. */
  stop(): void {
    const histogram = this.histogram;
    if (!histogram) return;
    this.recordedMax = Math.max(this.recordedMax, histogram.max / 1e6);
    this.recordedP99 = Math.max(this.recordedP99, histogram.percentile(99) / 1e6);
    histogram.disable();
    this.histogram = undefined;
  }

  record(lagMs: number): void {
    this.recorded.push(lagMs);
    if (this.recorded.length > 10_000) this.recorded.shift();
  }

  get maxLagMs(): number {
    let max = this.recordedMax;
    for (const value of this.recorded) if (value > max) max = value;
    if (this.histogram) max = Math.max(max, this.histogram.max / 1e6);
    return max;
  }

  get p99LagMs(): number {
    let p99 = this.recordedP99;
    if (this.recorded.length > 0) {
      const sorted = [...this.recorded].sort((a, b) => a - b);
      // Nearest-rank percentile: the smallest value that is >= 99% of the samples.
      const rank = Math.ceil(0.99 * sorted.length);
      const index = Math.min(sorted.length - 1, Math.max(0, rank - 1));
      p99 = Math.max(p99, sorted[index]!);
    }
    if (this.histogram) p99 = Math.max(p99, this.histogram.percentile(99) / 1e6);
    return p99;
  }

  get samples(): number {
    return this.recorded.length;
  }
}
