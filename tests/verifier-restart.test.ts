/**
 * Restart recovery: the verifier comes back from SQLite, not from the network.
 *
 * The crash-recovery test next door proves the *rows* survive a `kill -9`. This
 * one proves the thing derived from those rows survives too, which is the part
 * that actually gates trading after a restart.
 *
 * The referee history is the whole market view: the reference, the sweep, the
 * published limits, the mint set and the final price. The reader resumes its
 * cursors *after* every post it already read, so a restarted process that did
 * not replay the stored snapshots would come back with an empty view and stay
 * empty — and after the lock the referee never posts again, so "stay empty"
 * means "never trade again". `hydrateFromSnapshots()` runs inside
 * `createRuntime`, before the first read, and this test pins its result.
 *
 * The kill is modelled the same way as in the crash-recovery test: the first
 * runtime is never stopped, so its WAL is left on disk exactly as a SIGKILL
 * would leave it.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildHarness, HARNESS_PACKAGE_HASH, type Harness } from './support/orchestrator.js';
import { cleanup, tempDir } from './support/harness.js';

const AGENTS = 8;
const SWEEPS = 100;
/** `ref.px`: this sweep's close. */
const CLOSE = '225.10';
/** `applied`: the reference this sweep's trades were checked against. */
const APPLIED = '225.05';
const LOW = '213.85';
const HIGH = '236.36';
const GLOBAL_PX = '224.00';
const AGE_S = 2;

/**
 * A string-only, order-independent view of everything §6 says must come back.
 *
 * Decimals are stringified because two equal `Decimal`s are not `===`, and the
 * mint set is sorted because it is a `Set`.
 */
function view(h: Harness): {
  sweep: number;
  appliedReference: string | null;
  close: string | null;
  nextLimits: [string, string] | null;
  limitsForSweep: number | null;
  globalPx: string | null;
  history: string[];
  locked: boolean;
  degraded: boolean;
  degradedReason: string | null;
  packageHash: string | null;
  refereeDid: string | null;
  staleReference: boolean;
  conservativeReasons: string[];
  observedMints: string[];
} {
  const snapshot = h.runtime.reader.snapshot();
  const state = h.runtime.reader.verifier.state;
  return {
    sweep: snapshot.sweep,
    appliedReference: snapshot.appliedReference?.toString() ?? null,
    close: snapshot.close?.toString() ?? null,
    nextLimits:
      snapshot.nextLimits === null
        ? null
        : [snapshot.nextLimits.low.toString(), snapshot.nextLimits.high.toString()],
    limitsForSweep: snapshot.limitsForSweep,
    globalPx: snapshot.globalPx?.toString() ?? null,
    history: snapshot.history.map(String),
    locked: snapshot.locked,
    degraded: snapshot.degraded,
    degradedReason: snapshot.degradedReason,
    packageHash: snapshot.packageHash,
    refereeDid: snapshot.refereeDid,
    staleReference: snapshot.staleReference,
    conservativeReasons: [...state.conservativeReasons].sort(),
    observedMints: [...h.runtime.reader.verifier.observedMints()].sort(),
  };
}

describe('a restart rebuilds the verifier from the referee history already in SQLite', () => {
  const dir = tempDir('flop-restart-');
  let before: ReturnType<typeof view>;
  let after: ReturnType<typeof view>;
  /** The killed process: deliberately never stopped, so the WAL stays put. */
  let killed: Harness;
  let restarted: Harness;
  let mints: string[];

  beforeAll(async () => {
    killed = await buildHarness({ agentCount: AGENTS, dir });
    // The seed fixes the season, the package hash and the referee's baseline.
    killed.referee.seedPost(HARNESS_PACKAGE_HASH);
    mints = [...killed.runtime.keyStore.didSet()].slice(0, 2).sort();

    for (let n = 1; n <= SWEEPS; n += 1) {
      // A price post carries four separate numbers; the band it publishes is for
      // the *next* sweep, which is why trading is gated on `for`.
      killed.referee.post('d-close1-price', {
        t: 'price',
        season: 'close-1',
        n,
        ref: { px: CLOSE, time: '2026-09-28T12:00:00Z', tid: `t${n}` },
        limits: [LOW, HIGH],
        global: GLOBAL_PX,
        age_s: AGE_S,
        applied: APPLIED,
        for: n + 1,
      });
      killed.referee.post('d-close1-flow', { t: 'flow', season: 'close-1', n, mints, rooms: [] });
    }

    // Drive the real reader until it has caught up. A room read returns at most
    // 200 messages, so the 101 price posts land in one pass; the loop is a
    // guard, not an expectation.
    for (let attempt = 0; attempt < 4 && killed.runtime.reader.snapshot().sweep < SWEEPS; attempt += 1) {
      await killed.runtime.scheduler.runTick();
    }
    before = view(killed);

    // A sanity check on the fixture itself: the first process really did reach
    // the sweep the rest of the file reasons about.
    expect(before.sweep).toBe(SWEEPS);
    expect(before.history).toHaveLength(SWEEPS);

    // SIGKILL. Nothing is flushed, nothing is closed.
    restarted = await buildHarness({ agentCount: AGENTS, dir });
    // No tick, no read: whatever is in `after` was produced by the replay inside
    // `createRuntime`, from SQLite alone.
    after = view(restarted);
  }, 180_000);

  afterAll(async () => {
    try {
      await restarted.dispose();
    } catch {
      /* reported by the test, not by teardown */
    }
    try {
      killed.runtime.db.close();
    } catch {
      /* the harness may already have closed it */
    }
    cleanup(dir);
  });

  it('restores the whole market view, field for field', () => {
    expect(after).toEqual(before);
  });

  it('needed no network message to do it', () => {
    // Nothing was read from the referee rooms after the restart: the view above
    // came from the stored snapshots, not from a re-read.
    expect(restarted.transport.requestCount('d-close1-price')).toBe(0);
    expect(restarted.transport.requestCount('d-close1-flow')).toBe(0);
    expect(restarted.runtime.repositories.referee.count()).toBe(before.history.length * 2 + 1);
  });

  it('restores the referee DID and the package hash, so drift is still detectable', () => {
    expect(after.refereeDid).toBe(before.refereeDid);
    expect(after.packageHash).toBe(HARNESS_PACKAGE_HASH);
  });

  it('keeps applied and close apart across the restart', () => {
    // `applied` is this sweep's historical reference; `ref.px` is the close.
    // A replay that collapsed the two would silently reprice every new offer.
    expect(after.appliedReference).toBe(APPLIED);
    expect(after.close).toBe(CLOSE);
    expect(after.appliedReference).not.toBe(after.close);
  });

  it('restores the published band and the sweep it applies to', () => {
    expect(after.nextLimits).toEqual([LOW, HIGH]);
    expect(after.limitsForSweep).toBe(SWEEPS + 1);
    expect(after.globalPx).toBe(GLOBAL_PX);
  });

  it('restores the observed mints and stays out of conservative mode', () => {
    expect(after.observedMints).toEqual(mints);
    expect(after.degraded).toBe(false);
    expect(after.conservativeReasons).toEqual([]);
    expect(after.staleReference).toBe(false);
    expect(after.locked).toBe(false);
  });
});
