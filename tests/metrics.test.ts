/**
 * What the report says about the process itself.
 *
 * Two numbers were wrong in a way that made the whole report untrustworthy:
 *
 *   - `cpu=2182.84%` came from dividing *lifetime* CPU microseconds by uptime
 *     seconds and multiplying by 100. A rate needs two points in time and
 *     consistent units, so the arithmetic now lives in a named function with
 *     tests, and the first tick reports `warming_up` instead of a number;
 *   - `runs today = 5800` next to `uptime = 151s` conflated the durable
 *     `agent_runs` table — which spans restarts and includes the weekly
 *     watchdog's backfill — with what this process had done. Both are printed
 *     now, under names that say which is which.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { processCpuPercent } from '../apps/orchestrator/src/scheduler.js';
import { buildHarness, type Harness } from './support/orchestrator.js';

// ---------------------------------------------------------------------------
// §4 process CPU
// ---------------------------------------------------------------------------

describe('processCpuPercent', () => {
  it('is cpu-delta over wall-delta, in consistent units', () => {
    // 10ms of CPU over 100ms of wall time is one tenth of a core.
    expect(processCpuPercent({ cpuUs: 0, wallMs: 0 }, { cpuUs: 10_000, wallMs: 100 })).toBe(10);
    // The same 10ms over a whole second is one percent.
    expect(processCpuPercent({ cpuUs: 0, wallMs: 0 }, { cpuUs: 10_000, wallMs: 1_000 })).toBe(1);
  });

  it('returns 0 when no CPU was used in the interval', () => {
    expect(processCpuPercent({ cpuUs: 5_000, wallMs: 1_000 }, { cpuUs: 5_000, wallMs: 2_000 })).toBe(0);
  });

  it('refuses an interval that cannot support a rate', () => {
    // No wall time passed: dividing by it would be an infinity, not a reading.
    expect(processCpuPercent({ cpuUs: 0, wallMs: 5_000 }, { cpuUs: 10_000, wallMs: 5_000 })).toBeNull();
    // A CPU counter that went backwards was reset; that is not a negative load.
    expect(processCpuPercent({ cpuUs: 10_000, wallMs: 0 }, { cpuUs: 0, wallMs: 1_000 })).toBeNull();
  });

  it('does not turn 151 seconds of uptime into 2182%', () => {
    // The old expression: 3.3s of CPU over 151s of uptime, `/1000` missing, `*100`
    // applied to a milliseconds-per-second figure. It printed 2182.84.
    const previous = { cpuUs: 0, wallMs: 0 };
    const current = { cpuUs: 3_300_000, wallMs: 151_000 };
    const percent = processCpuPercent(previous, current);
    expect(percent).toBe(2.19);
    // The class of failure, stated as a bound: a mostly-idle process cannot read
    // above a single core's worth of CPU by an order of magnitude.
    expect(percent!).toBeLessThan(100);
  });

  it('does not hide a genuine multi-core reading behind a clamp', () => {
    // Two cores fully busy is 200%, and that is the truth, not an error to mask.
    expect(processCpuPercent({ cpuUs: 0, wallMs: 0 }, { cpuUs: 200_000, wallMs: 100 })).toBe(200);
  });
});

// ---------------------------------------------------------------------------
// §5 run accounting
// ---------------------------------------------------------------------------

describe('run accounting in a live harness', () => {
  let harness: Harness | null = null;

  afterEach(async () => {
    if (harness) await harness.dispose();
    harness = null;
  });

  it('separates this process\'s work from the durable table, and the watchdog from both', async () => {
    harness = await buildHarness({ agentCount: 150 });
    const h = harness;

    expect(h.runtime.config.scheduling.tickSeconds).toBe(60);
    expect(h.runtime.config.scheduling.agentsPerTick).toBe(10);
    expect(h.runtime.config.scheduling.runWindowHours).toBe(168);

    // Nothing has run yet: the process has no history and the report says so.
    const before = h.runtime.scheduler.status();
    expect(before.runs.sinceStartup).toBe(0);
    expect(before.runs.schedulerTicks).toBe(0);
    expect(before.runs.fullFleetCycles).toBe(0);
    expect(before.runs.lastTickAt).toBeNull();
    // Before the first tick there is no rate to show, so it must not invent one.
    expect(before.system.cpuPercent).toBeNull();
    expect(before.system.cpuState).toBe('warming_up');

    await h.runtime.scheduler.runTick();

    const afterOne = h.runtime.scheduler.status();
    // One tick evaluates `agentsPerTick` agents in each of the five groups.
    expect(afterOne.runs.schedulerTicks).toBe(1);
    expect(afterOne.runs.agentsInCurrentTick).toBe(50);
    expect(afterOne.runs.sinceStartup).toBe(50);
    expect(afterOne.runs.uniqueAgents).toBe(50);
    expect(afterOne.runs.fullFleetCycles).toBe(0);
    expect(afterOne.runs.lastTickAt).not.toBeNull();
    expect(afterOne.runs.nextTickAt).not.toBeNull();

    // The watchdog ran on the first tick and backfilled every agent it found
    // stale. Those runs are in the durable table — and are *not* counted as this
    // process's tick work.
    expect(afterOne.runs.watchdogRuns).toBe(1);
    expect(afterOne.runs.today).toBeGreaterThan(afterOne.runs.sinceStartup);

    // Two more ticks complete a full fleet cycle: 150 agents, each evaluated once.
    await h.runtime.scheduler.runTick();
    await h.runtime.scheduler.runTick();
    const afterThree = h.runtime.scheduler.status();
    expect(afterThree.runs.schedulerTicks).toBe(3);
    expect(afterThree.runs.sinceStartup).toBe(150);
    expect(afterThree.runs.uniqueAgents).toBe(150);
    expect(afterThree.runs.fullFleetCycles).toBe(1);
    // The watchdog is once-a-day: it does not run again on ticks two and three.
    expect(afterThree.runs.watchdogRuns).toBe(1);
  }, 180_000);

  it('starts its own counters at zero after a restart, leaving the durable totals alone', async () => {
    const first = await buildHarness({ agentCount: 6 });
    const dir = first.dir;
    await first.runtime.scheduler.runTick();
    const durableBefore = first.runtime.scheduler.status().runs.today;
    expect(durableBefore).toBeGreaterThan(0);
    await first.runtime.db.close();

    // A second process over the same database: the durable rows are still there,
    // and the new process's own counters are not.
    const second = await buildHarness({ agentCount: 6, dir });
    harness = second;
    const status = second.runtime.scheduler.status();
    expect(status.runs.sinceStartup).toBe(0);
    expect(status.runs.schedulerTicks).toBe(0);
    expect(status.runs.today).toBe(durableBefore);

    // Close the first harness's database handle without re-cleaning the shared dir.
    await second.dispose();
    harness = null;
    first.runtime.db.close();
    await first.dispose();
  }, 180_000);

  it('labels both figures in the Lark report so they cannot be read as one', async () => {
    harness = await buildHarness({ agentCount: 6 });
    await harness.runtime.scheduler.runTick();
    await harness.runtime.scheduler.runTick();

    const report = await harness.runtime.scheduler.buildReport();
    const coverage = report.sections.find((section) => section.heading.includes('运行覆盖'));
    const text = coverage?.lines.join('\n') ?? '';

    expect(text).toContain('runs since startup (this process)');
    expect(text).toContain('agent_runs rows today (durable, spans restarts)');
    expect(text).toContain('watchdog passes');
    expect(text).toContain('full fleet cycles');
    expect(text).toContain('last tick');
    expect(text).toContain('next tick');

    const runtimeSection = report.sections.find((section) => section.heading.includes('运行状态'));
    const runtimeText = runtimeSection?.lines.join('\n') ?? '';
    // Two ticks have both samples, so a real rate is available and printed as the
    // process's own CPU — never the lifetime average that read 2182%.
    expect(runtimeText).toMatch(/process CPU: (\d+(\.\d+)?% of one core over the last tick|warming_up)/);
  }, 180_000);
});
