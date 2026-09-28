/**
 * Load guard: the defined degradation order.
 *
 * The point of these tests is that the process sheds work in a fixed order
 * instead of dying, that a single lag spike never trips the guard, and that a
 * tier change is durable in the events table.
 */
import { describe, expect, it } from 'vitest';
import { createRepositories, openDatabase } from '@flop/storage';
import { loadConfig, type Config } from '../apps/orchestrator/src/config.js';
import { createLogger } from '../apps/orchestrator/src/logger.js';
import { EventLoopMonitor, LoadGuard, type PausedFlags } from '../apps/orchestrator/src/load-guard.js';

const quiet = () => createLogger({ level: 'fatal' });

function config(overrides: Record<string, string> = {}): Config {
  return loadConfig({ DATA_DIR: '/tmp/flop-loadguard-unused', ...overrides });
}

function guard(cfg: Config, now?: () => Date): LoadGuard {
  return new LoadGuard({
    config: cfg,
    logger: quiet(),
    readProcessMemory: () => ({ rssBytes: 100, heapUsedBytes: 10 }),
    readDiskUsage: () => 1,
    now,
  });
}

describe('load guard: memory pressure', () => {
  it('pauses llm and compression above rssPausePercent but never blocks reads', () => {
    const g = guard(config({ RSS_PAUSE_PERCENT: '70', RSS_SHED_PERCENT: '85' }));
    const state = g.sample({ rssBytes: 780, rssLimitBytes: 1000, diskUsedPercent: 1 });

    expect(state.tier).toBe('pause_llm');
    expect(state.paused.llm).toBe(true);
    expect(state.paused.compression).toBe(true);
    expect(state.paused.activeTrading).toBe(false);
    expect(state.reasons.some((reason) => reason.includes('rss 78% > 70%'))).toBe(true);

    expect(g.allow('read')).toBe(true);
    expect(g.allow('llm')).toBe(false);
    expect(g.allow('compression')).toBe(false);
  });

  it('stops active trading above rssShedPercent but keeps reads', () => {
    const g = guard(config({ RSS_PAUSE_PERCENT: '70', RSS_SHED_PERCENT: '85' }));
    const state = g.sample({ rssBytes: 900, rssLimitBytes: 1000, diskUsedPercent: 1 });

    expect(state.tier).toBe('shed_trading');
    expect(state.paused.activeTrading).toBe(true);
    expect(g.allow('active_trading')).toBe(false);
    expect(g.allow('new_offer')).toBe(false);
    expect(g.allow('read')).toBe(true);
  });
});

describe('load guard: disk pressure', () => {
  const diskConfig = () =>
    config({
      DISK_COMPRESS_PERCENT: '70',
      DISK_SHED_PERCENT: '75',
      DISK_CRITICAL_PERCENT: '90',
      DISK_READONLY_PERCENT: '95',
    });

  it('sheds verbose debug at the shed threshold, critical at critical, readonly at readonly', () => {
    const g = guard(diskConfig());

    const shed = g.sample({ rssBytes: 100, rssLimitBytes: 1000, diskUsedPercent: 80 });
    expect(shed.tier).toBe('shed_trading');
    expect(shed.paused.verboseDebug).toBe(true);

    const critical = g.sample({ diskUsedPercent: 91 });
    expect(critical.tier).toBe('critical');
    expect(critical.paused.activeTrading).toBe(true);
    expect(critical.reasons.some((reason) => reason.includes('disk 91% > 90%'))).toBe(true);

    const readonly = g.sample({ diskUsedPercent: 96 });
    expect(readonly.tier).toBe('readonly');
    expect(readonly.paused.readsOnly).toBe(true);
    expect(g.allow('read')).toBe(true);
    expect(g.allow('new_offer')).toBe(false);
    expect(g.allow('active_trading')).toBe(false);
  });
});

describe('load guard: queue pressure', () => {
  it('pauses new offers when the writer queue is over the threshold', () => {
    const g = guard(config({ WRITER_QUEUE_SHED: '100' }));
    const state = g.sample({
      rssBytes: 100,
      rssLimitBytes: 1000,
      diskUsedPercent: 1,
      writerQueueDepth: 101,
    });
    expect(state.paused.newOffers).toBe(true);
    expect(g.allow('new_offer')).toBe(false);
  });

  it('reports the llm queue when it is over the threshold', () => {
    const g = guard(config({ LLM_QUEUE_SHED: '5' }));
    const state = g.sample({
      rssBytes: 100,
      rssLimitBytes: 1000,
      diskUsedPercent: 1,
      llmQueueDepth: 6,
    });
    expect(state.tier).toBe('pause_llm');
    expect(state.reasons.some((reason) => reason.includes('llm queue 6 > 5'))).toBe(true);
  });
});

describe('load guard: event loop lag must be continuous', () => {
  const lagConfig = () =>
    config({ EVENT_LOOP_LAG_MS: '250', EVENT_LOOP_LAG_SECONDS: '60' });

  it('does not trip on a single spike shorter than eventLoopLagSeconds', () => {
    let current = new Date('2026-01-01T00:00:00.000Z');
    const g = guard(lagConfig(), () => current);

    g.sample({ rssBytes: 100, rssLimitBytes: 1000, diskUsedPercent: 1, eventLoopLagMs: 400 });
    current = new Date(current.getTime() + 1_000);
    const state = g.sample({ eventLoopLagMs: 5 });

    expect(state.tier).toBe('normal');
    expect(state.lagOverSinceMs).toBeNull();
  });

  it('pauses weekly backfill once the lag is sustained past the window', () => {
    let current = new Date('2026-01-01T00:00:00.000Z');
    const g = guard(lagConfig(), () => current);

    g.sample({ rssBytes: 100, rssLimitBytes: 1000, diskUsedPercent: 1, eventLoopLagMs: 400 });
    current = new Date(current.getTime() + 61_000);
    const state = g.sample({ eventLoopLagMs: 400 });

    expect(state.tier).toBe('pause_llm');
    expect(state.paused.weeklyBackfill).toBe(true);
    expect(state.reasons.some((reason) => reason.includes('event loop lag'))).toBe(true);
  });
});

describe('load guard: monotonic escalation', () => {
  it('makes every higher tier imply the pauses of the tiers below it', () => {
    const cfg = config({
      DISK_COMPRESS_PERCENT: '70',
      DISK_SHED_PERCENT: '75',
      DISK_CRITICAL_PERCENT: '90',
      DISK_READONLY_PERCENT: '95',
    });

    const pauseGuard = guard(cfg);
    const pause = pauseGuard.sample({ rssBytes: 780, rssLimitBytes: 1000, diskUsedPercent: 1 });

    const shedGuard = guard(cfg);
    const shed = shedGuard.sample({ rssBytes: 100, rssLimitBytes: 1000, diskUsedPercent: 80 });

    const criticalGuard = guard(cfg);
    const critical = criticalGuard.sample({ rssBytes: 100, rssLimitBytes: 1000, diskUsedPercent: 91 });

    const readonlyGuard = guard(cfg);
    const readonly = readonlyGuard.sample({ rssBytes: 100, rssLimitBytes: 1000, diskUsedPercent: 96 });

    expect(pause.tier).toBe('pause_llm');
    expect(shed.tier).toBe('shed_trading');
    expect(critical.tier).toBe('critical');
    expect(readonly.tier).toBe('readonly');

    // Every flag that is paused at a lower tier must stay paused at a higher one.
    const implies = (higher: PausedFlags, lower: PausedFlags): void => {
      for (const flag of Object.keys(lower) as Array<keyof PausedFlags>) {
        if (lower[flag]) expect(higher[flag]).toBe(true);
      }
    };
    implies(shed.paused, pause.paused);
    implies(critical.paused, pause.paused);
    implies(readonly.paused, critical.paused);
  });
});

describe('load guard: durable tier changes', () => {
  it('records a load_tier_changed event in the events table', () => {
    const db = openDatabase({ path: ':memory:' });
    const repositories = createRepositories(db);
    const logger = createLogger({ level: 'debug', repositories });
    const g = new LoadGuard({
      config: config({ RSS_PAUSE_PERCENT: '70', RSS_SHED_PERCENT: '85' }),
      logger,
      readProcessMemory: () => ({ rssBytes: 100, heapUsedBytes: 10 }),
      readDiskUsage: () => 1,
      now: () => new Date('2026-01-01T00:00:00.000Z'),
    });

    expect(g.state.tier).toBe('normal');
    const state = g.poll({ rssBytes: 900, rssLimitBytes: 1000, diskUsedPercent: 1 });
    expect(state.tier).toBe('shed_trading');

    const codes = repositories.events.recent(20).map((row) => row.code);
    expect(codes).toContain('load_tier_changed');
    db.close();
  });
});

describe('event loop monitor', () => {
  it('tracks max and p99 from recorded samples', () => {
    const monitor = new EventLoopMonitor();
    for (const value of [1, 2, 3, 4, 500]) monitor.record(value);
    expect(monitor.samples).toBe(5);
    expect(monitor.maxLagMs).toBe(500);
    expect(monitor.p99LagMs).toBe(500);
  });

  it('start/stop is safe to call twice and stop degrades to a no-op', () => {
    const monitor = new EventLoopMonitor();
    monitor.start();
    monitor.stop();
    expect(() => monitor.stop()).not.toThrow();
  });
});
