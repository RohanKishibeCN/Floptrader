/**
 * The tick order is the design, and background work is off the trading path.
 *
 * Two things this pins down, because both are easy to lose when a feature is
 * added to the scheduler:
 *
 *   - the trading path walks a fixed order — read, reconcile participation,
 *     reconcile settlement, run strategies, validate risk and post, then
 *     reconcile the repost queue. Settlement is reconciled *before* the
 *     strategies run, so a trade proposed this tick sees the referee's latest
 *     flow; and nothing may be inserted between risk validation and posting.
 *   - the background operations — the watchdog, the Lark report, the model
 *     review, the upstream check — run after that path has closed, each one
 *     isolated. A background failure is a warning, never a failed tick and
 *     never a lost trade.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildHarness, type Harness } from './support/orchestrator.js';

/** An object whose methods can be spied on by name. */
type Tracked = Record<string, (...args: unknown[]) => unknown>;

/**
 * Wrap the methods that make up a tick so their invocation order is recorded.
 *
 * Vitest's `spyOn` keeps the real implementation and lets the call through, so
 * the tick under test is the real tick — only the ordering is observed.
 */
function trackOrder(harness: Harness, order: string[]): void {
  const record = (holder: Tracked, name: string, label: string): void => {
    const original = holder[name]?.bind(holder);
    if (!original) throw new Error(`no method ${name} on scheduler under test`);
    vi.spyOn(holder, name).mockImplementation(((...args: unknown[]) => {
      order.push(label);
      return original(...args);
    }) as never);
  };

  const reader = harness.runtime.reader as unknown as Tracked;
  const scheduler = harness.runtime.scheduler as unknown as Tracked;

  record(reader, 'tick', 'read');
  record(scheduler, 'ensureParticipation', 'participation');
  record(scheduler, 'reconcileMints', 'settlement');
  record(scheduler, 'runAgentSlices', 'strategies');
  record(scheduler, 'executeActions', 'trades');
  record(scheduler, 'reconcileReposts', 'reposts');
  record(scheduler, 'maybeRunWatchdog', 'watchdog');
  record(scheduler, 'maybeReport', 'lark');
  record(scheduler, 'maybeCheckUpstream', 'upstream');
}

describe('the scheduler tick order is fixed', () => {
  let harness: Harness;

  beforeEach(async () => {
    // A small fleet keeps the ordering test cheap; the order is fleet-independent.
    harness = await buildHarness({ agentCount: 5 });
  }, 120_000);

  afterEach(async () => {
    vi.restoreAllMocks();
    await harness.dispose();
  });

  it('reads, then reconciles participation and settlement, then trades, then reposts', async () => {
    const order: string[] = [];
    trackOrder(harness, order);

    await harness.runtime.scheduler.runTick();

    const at = (label: string): number => order.indexOf(label);
    expect(at('read')).toBeGreaterThanOrEqual(0);
    expect(at('read')).toBeLessThan(at('participation'));
    // Settlement is reconciled before the strategies run, so a trade proposed
    // this tick has already seen the referee's latest flow and outcomes.
    expect(at('participation')).toBeLessThan(at('settlement'));
    expect(at('settlement')).toBeLessThan(at('strategies'));
    expect(at('strategies')).toBeLessThan(at('trades'));
    // The repost queue is reconciled after the trade path has closed.
    expect(at('trades')).toBeLessThan(at('reposts'));
  });

  it('runs every background operation only after the trade path has closed', async () => {
    const order: string[] = [];
    trackOrder(harness, order);

    await harness.runtime.scheduler.runTick();

    const at = (label: string): number => order.indexOf(label);
    for (const background of ['watchdog', 'lark', 'upstream']) {
      expect(order).toContain(background);
      // Nothing background may run before the repost queue is reconciled: that
      // is the last step of the trading path.
      expect(at('reposts')).toBeLessThan(at(background));
    }
  });

  it('contains a background failure: the tick resolves and the trade path still runs', async () => {
    const order: string[] = [];
    trackOrder(harness, order);

    // Force the two most failure-prone background steps to reject. Neither may
    // reach `runTick`: the report and the upstream check are reporting, not
    // trading.
    vi.spyOn(harness.runtime.scheduler as never, 'maybeReport' as never).mockRejectedValue(
      new Error('lark report boom') as never,
    );
    vi.spyOn(harness.runtime.scheduler as never, 'maybeCheckUpstream' as never).mockRejectedValue(
      new Error('upstream boom') as never,
    );

    const report = await harness.runtime.scheduler.runTick();

    // The trading path completed despite both background steps throwing...
    expect(order).toContain('trades');
    expect(order).toContain('reposts');
    // ...and the report shows the two steps as no-ops rather than propagating.
    expect(report.lark.delivered).toEqual([]);
    expect(report.upstream.checked).toBe(false);
  });
});
