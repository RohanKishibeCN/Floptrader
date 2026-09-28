/**
 * The 7x24h floor, and the watchdog that enforces it.
 *
 * Every agent must execute a local strategy evaluation at least once every
 * rolling seven days. Two things about that are easy to get subtly wrong:
 *
 *   - the window is **rolling**, not an ISO week. An agent that ran Sunday night
 *     and again Monday morning is compliant under an ISO-week reading while
 *     having been silent for eight days. `staleSince` uses a timestamp cutoff.
 *   - a backfill is a **local** evaluation and nothing else: no trade, no post to
 *     technocore, no heartbeat, no model call. The watchdog exists to satisfy a
 *     participation floor, not to generate activity.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { referenceRules } from '@flop/close-call';
import { GroupRunner } from '@flop/strategy';
import {
  closeDatabase,
  createRepositories,
  openDatabase,
  type Repositories,
  type SqliteDatabase,
} from '@flop/storage';
import { Logger } from '../apps/orchestrator/src/logger.js';
import { buildHarness, type Harness } from './support/orchestrator.js';
import { generateAgents, groupCounts } from './support/harness.js';

const silent = Logger.create({ level: 'fatal' });
const rules = referenceRules();

const HOUR_MS = 3600_000;
const WINDOW_MS = 168 * HOUR_MS;
const EPOCH = '1970-01-01T00:00:00.000Z';

describe('rolling window arithmetic', () => {
  let db: SqliteDatabase;
  let repositories: Repositories;

  beforeEach(() => {
    db = openDatabase({ path: ':memory:' });
    repositories = createRepositories(db);
  });

  afterEach(() => {
    closeDatabase(db);
  });

  it('treats an agent that ran inside the window as fresh and one outside as stale', () => {
    const now = new Date('2026-09-28T12:00:00.000Z');
    const runner = new GroupRunner({ repositories, logger: silent, rules, now: () => now });

    seed(repositories, 'agent-fresh', 'did:key:z6Mk' + 'A'.repeat(44), new Date(now.getTime() - HOUR_MS).toISOString());
    seed(repositories, 'agent-stale', 'did:key:z6Mk' + 'B'.repeat(44), new Date(now.getTime() - 169 * HOUR_MS).toISOString());
    seed(repositories, 'agent-never', 'did:key:z6Mk' + 'C'.repeat(44), null);

    const stale = runner.staleAgents().map((entry) => entry.agentId);
    expect(stale).toContain('agent-stale');
    expect(stale).toContain('agent-never');
    expect(stale).not.toContain('agent-fresh');
    // Exactly one rolling week before "now", not a calendar boundary.
    expect(new Date(now.getTime() - WINDOW_MS).toISOString()).toBe('2026-09-21T12:00:00.000Z');
  });

  it('does not accept an ISO-week boundary as compliance', () => {
    // Sunday 23:00 and Monday 01:00 fall in different ISO weeks but are two hours
    // apart; the rolling window is what decides, and it says compliant.
    const sunday = new Date('2026-09-27T23:00:00.000Z');
    const monday = new Date('2026-09-28T01:00:00.000Z');
    const runner = new GroupRunner({ repositories, logger: silent, rules, now: () => monday });
    seed(repositories, 'agent-sunday', 'did:key:z6Mk' + 'D'.repeat(44), sunday.toISOString());
    expect(runner.staleAgents()).toHaveLength(0);
  });
});

describe('the scheduler keeps every agent inside the window', () => {
  let harness: Harness;

  beforeEach(async () => {
    // 15 agents = 3 per group, which exercises the per-group slicing without
    // paying for 150 key pairs in every test.
    harness = await buildHarness({ agentCount: 15 });
    expect(groupCounts(generateAgents(15, true))).toEqual({
      trend_following: 3,
      mean_reversion: 3,
      breakout: 3,
      contrarian: 3,
      external_offer_taker: 3,
    });
  }, 120_000);

  afterEach(async () => {
    await harness.dispose();
  });

  it('runs every agent within the first tick and stamps last_run_at', async () => {
    const report = await harness.runtime.scheduler.runTick();

    expect(report.runs.agents).toBe(15);
    expect(report.runs.failures).toBe(0);
    const ran = new Set(harness.runtime.repositories.agentRuns.distinctAgentsSince(EPOCH));
    expect(ran.size).toBe(15);
    expect(harness.runtime.scheduler.status().agents.staleCount).toBe(0);
    for (const agentId of harness.runtime.keyStore.agentIds) {
      expect(
        harness.runtime.repositories.identities.get(agentId)?.last_run_at ?? null,
      ).not.toBeNull();
    }
  }, 120_000);

  it('records a run as a local evaluation: no model call and no trade', async () => {
    // Registration is off so that the only writes this tick could make would be
    // trades — and there must be none.
    const quiet = await buildHarness({ agentCount: 15, env: { FLOP_ALLOW_REGISTRATION: 'false' } });
    try {
      await quiet.runtime.scheduler.runTick();

      expect(quiet.transport.writeCount).toBe(0);
      expect(quiet.runtime.repositories.llmCalls.count()).toBe(0);
      expect(quiet.runtime.repositories.trades.count()).toBe(0);
      // A run exists even though every one of them decided not to trade: the
      // participation floor counts runs, not trades.
      expect(quiet.runtime.repositories.agentRuns.count()).toBe(15);
      const actions = quiet.runtime.repositories.decisions.countByActionSince(EPOCH);
      expect(actions.NO_TRADE ?? 0).toBe(15);
    } finally {
      await quiet.dispose();
    }
  }, 120_000);
});

/**
 * The watchdog itself.
 *
 * `AGENTS_PER_TICK=1` is what makes this test meaningful: with the default of 10
 * the ordinary slice would run all three agents of every group before the
 * watchdog got its turn, and there would be nothing stale left to find. With one
 * agent per group per tick, tick 0 covers `agent-0001`..`agent-0005`, leaving
 * any other aged agent genuinely stale when the watchdog looks.
 */
describe('the weekly watchdog', () => {
  let harness: Harness;

  beforeEach(async () => {
    harness = await buildHarness({ agentCount: 15, env: { AGENTS_PER_TICK: '1' } });
  }, 120_000);

  afterEach(async () => {
    await harness.dispose();
  });

  /**
   * Model "everything has been running except these": stamp every agent as fresh,
   * then push a chosen few outside the window.
   *
   * Ageing a subset without stamping the rest would leave those stale too — they
   * have never run — and the count under test would be 15 rather than the subset.
   *
   * The subset is the third agent of each group: with `AGENTS_PER_TICK=1` the
   * normal slice reaches group position 0 on the first tick and position 1 on the
   * second, so position 2 stays genuinely stale for the watchdog to find.
   */
  function ageAgents(count: number): string[] {
    // The harness clock, not the wall clock: everything the runtime writes is
    // stamped from the injected clock, so mixing in `Date.now()` would make this
    // test pass or fail depending on what time of day it ran.
    const clock = harness.now().getTime();
    const fresh = new Date(clock - HOUR_MS).toISOString();
    for (const agentId of harness.runtime.keyStore.agentIds) {
      harness.runtime.repositories.identities.recordRun(agentId, fresh, '2026-W39');
    }
    const aged = harness.runtime.keyStore.agentIds.slice(10, 10 + count);
    const longAgo = new Date(clock - 200 * HOUR_MS).toISOString();
    for (const agentId of aged) {
      harness.runtime.repositories.identities.recordRun(agentId, longAgo, '2026-W01');
    }
    return aged;
  }

  it('backfills agents that fell outside the window, without trading or posting', async () => {
    const aged = ageAgents(5);
    expect(harness.runtime.scheduler.status().agents.staleCount).toBe(5);

    // The harness clock is 20:00 Shanghai, so the day's watchdog is due.
    const report = await harness.runtime.scheduler.runTick();

    expect(report.watchdog.ran).toBe(true);
    expect(report.watchdog.backfilled).toBe(5);

    for (const agentId of aged) {
      const lastRun = harness.runtime.repositories.identities.get(agentId)?.last_run_at ?? '';
      expect(Date.parse(lastRun)).toBeGreaterThan(harness.now().getTime() - HOUR_MS);
    }
    const source = harness.runtime.db
      .prepare("SELECT source FROM agent_runs WHERE agent_id = ? ORDER BY id DESC LIMIT 1")
      .get(aged[0]!) as { source: string };
    expect(source.source).toBe('weekly_backfill');

    // The watchdog is local: no trade, no technocore write, no model call.
    expect(harness.runtime.repositories.trades.count()).toBe(0);
    expect(harness.runtime.repositories.llmCalls.count()).toBe(0);
    // Registrations may have been posted by the participation pass; what must not
    // happen is a trade or a heartbeat. Every post is still an owner registration.
    for (const post of harness.transport.posts) {
      expect(JSON.parse(post.body.text!).t).toBe('owner');
    }
  }, 120_000);

  it('runs at most once per local day', async () => {
    ageAgents(4);

    const first = await harness.runtime.scheduler.runTick();
    const second = await harness.runtime.scheduler.runTick();
    const third = await harness.runtime.scheduler.runTick();

    expect(first.watchdog.ran).toBe(true);
    expect(second.watchdog.ran).toBe(false);
    expect(third.watchdog.ran).toBe(false);
  }, 120_000);

  it('defers, and does not claim the day, while the load guard has paused backfill', async () => {
    ageAgents(2);

    // A read-only disk reading pauses `weekly_backfill` on the next poll.
    harness.setDiskUsedPercent(97);

    const report = await harness.runtime.scheduler.runTick();

    expect(report.tier).toBe('readonly');
    expect(report.watchdog.ran).toBe(false);
    // The deferral must not silently mark the day as handled: the agents are
    // still stale and the watchdog will try again once pressure clears.
    expect(harness.runtime.scheduler.status().agents.staleCount).toBe(2);

    harness.setDiskUsedPercent(10);
    const after = await harness.runtime.scheduler.runTick();
    expect(after.watchdog.ran).toBe(true);
    expect(after.watchdog.backfilled).toBe(2);
  }, 120_000);
});

/** Insert an identity row with a chosen last_run_at, for stale-window tests. */
function seed(
  repositories: Repositories,
  agentId: string,
  did: string,
  lastRunAt: string | null,
): void {
  repositories.identities.upsert({
    agent_id: agentId,
    did,
    public_key_multibase: 'z6Mk',
    fingerprint: 'sha256:x',
    strategy_group: 'trend_following',
    season: 'close-1',
    risk_tier: 'trend_following',
    random_seed: 1,
    max_qty: '1',
    max_open_notional: '100',
    cooldown_sweeps: 1,
    confidence_threshold: '0.5',
    strategy_version: 'v1',
    last_run_at: lastRunAt,
    last_run_week: null,
    enabled: 1,
  });
}
