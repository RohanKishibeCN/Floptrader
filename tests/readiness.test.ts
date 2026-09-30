/**
 * The readiness gates: `refereeReady` gates live registration, `tradingReady`
 * gates live trading, and both must say *why* when they are false.
 *
 * The unit half pins the clauses; the integration half pins the wiring — that a
 * live process with no seed holds its registrations rather than posting 150
 * signed commitments to an unproven referee, and that a dry run keeps running.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { refereeReadiness, tradingReadiness, type RefereeReadinessInputs } from '../apps/orchestrator/src/readiness.js';
import { buildHarness, HARNESS_PACKAGE_HASH, type Harness } from './support/orchestrator.js';

const READY_REFEREE: RefereeReadinessInputs = {
  seedSeen: true,
  refereeDid: 'did:key:z6Mkreferee',
  expectedRefereeDid: 'did:key:z6Mkreferee',
  packageHash: 'a'.repeat(64),
  expectedPackageHash: 'a'.repeat(64),
  hydrated: true,
  refereeRoomsReset: [],
  requirePin: true,
};

function referee(patch: Partial<RefereeReadinessInputs> = {}) {
  return refereeReadiness({ ...READY_REFEREE, ...patch });
}

describe('refereeReadiness', () => {
  it('is ready only when every clause holds', () => {
    expect(referee()).toEqual({ ready: true, reasons: [] });
  });

  it('is not ready without a seed', () => {
    const result = referee({ seedSeen: false });
    expect(result.ready).toBe(false);
    expect(result.reasons.join(' ')).toContain('seed not read');
  });

  it('is not ready when the sender is not the pinned referee', () => {
    const result = referee({ refereeDid: 'did:key:z6Mkstranger' });
    expect(result.ready).toBe(false);
    expect(result.reasons.join(' ')).toContain('not the pinned one');
  });

  it('is not ready when the seed package differs from the pin', () => {
    const result = referee({ packageHash: 'b'.repeat(64) });
    expect(result.ready).toBe(false);
    expect(result.reasons.join(' ')).toContain('differs from the pinned package');
  });

  it('is not ready before the verifier has been hydrated', () => {
    const result = referee({ hydrated: false });
    expect(result.ready).toBe(false);
    expect(result.reasons.join(' ')).toContain('not hydrated');
  });

  it('is not ready when a referee room was recreated underneath us', () => {
    const result = referee({ refereeRoomsReset: ['d-close1-state'] });
    expect(result.ready).toBe(false);
    expect(result.reasons.join(' ')).toContain('d-close1-state');
  });

  it('refuses to call an unpinned referee established when a pin is required', () => {
    const result = referee({ expectedRefereeDid: null, requirePin: true, refereeDid: 'did:key:z6Mkanyone' });
    expect(result.ready).toBe(false);
    expect(result.reasons.join(' ')).toContain('no referee DID pinned');
  });
});

describe('tradingReadiness', () => {
  const ready = {
    referee: { ready: true, reasons: [] },
    conservative: false,
    conservativeReasons: [],
    sweep: 824,
    hasReference: true,
    limits: { low: '213.85', high: '236.36' },
    limitsUsable: true,
    limitsForSweep: 825,
    staleReference: false,
    locked: false,
    loadAllowsNewOffer: true,
    packageDrift: false,
    fleetComplete: true,
    registrationRequired: true,
    registrationReadbackComplete: true,
  };

  it('is ready only when every clause holds', () => {
    expect(tradingReadiness(ready)).toEqual({ ready: true, reasons: [] });
  });

  it('is never ready when the referee gate is not', () => {
    const result = tradingReadiness({ ...ready, referee: { ready: false, reasons: ['referee seed not read'] } });
    expect(result.ready).toBe(false);
    expect(result.reasons.join(' ')).toContain('referee: referee seed not read');
  });

  it('blocks a band labelled for the wrong sweep', () => {
    const result = tradingReadiness({ ...ready, limitsForSweep: 830 });
    expect(result.ready).toBe(false);
    expect(result.reasons.join(' ')).toContain('not 825');
  });

  it('blocks an unusable or unlabelled band', () => {
    expect(tradingReadiness({ ...ready, limitsUsable: false }).ready).toBe(false);
    const unlabelled = tradingReadiness({ ...ready, limitsForSweep: null });
    expect(unlabelled.ready).toBe(false);
    expect(unlabelled.reasons.join(' ')).toContain('no `for`');
  });

  it('blocks a stale reference, a lock, drift and a load shed', () => {
    expect(tradingReadiness({ ...ready, staleReference: true }).ready).toBe(false);
    expect(tradingReadiness({ ...ready, locked: true }).reasons.join(' ')).toContain('locked');
    expect(tradingReadiness({ ...ready, packageDrift: true }).reasons.join(' ')).toContain('drift');
    expect(tradingReadiness({ ...ready, loadAllowsNewOffer: false }).ready).toBe(false);
  });

  it('blocks an incomplete fleet and missing readbacks only when they are required', () => {
    expect(tradingReadiness({ ...ready, fleetComplete: false }).reasons.join(' ')).toContain('fleet is not complete');
    expect(tradingReadiness({ ...ready, registrationReadbackComplete: false }).ready).toBe(false);
    // A dry run never registers against the referee, so readbacks are not a gate.
    expect(tradingReadiness({ ...ready, registrationRequired: false, registrationReadbackComplete: false }).ready).toBe(
      true,
    );
  });

  it('blocks on conservative mode', () => {
    const result = tradingReadiness({ ...ready, conservative: true, conservativeReasons: ['limits_for_missing'] });
    expect(result.ready).toBe(false);
    expect(result.reasons.join(' ')).toContain('limits_for_missing');
  });
});

describe('the live gates are wired', () => {
  let harness: Harness | undefined;

  afterEach(async () => {
    if (harness) await harness.dispose();
    harness = undefined;
  });

  function liveHarness(agentCount: number): Promise<Harness> {
    return buildHarness({
      agentCount,
      env: {
        FLOP_MODE: 'live',
        FLOP_LIVE_CONFIRM: 'close-1',
        FLOP_ALLOW_REGISTRATION: 'true',
        EXPECTED_PACKAGE_HASH: HARNESS_PACKAGE_HASH,
      },
    });
  }

  it('holds every registration in live until the referee is established, then posts them', async () => {
    // Live requires the full 150-agent fleet, so this is the real shape.
    harness = await liveHarness(150);
    const h = harness;

    const held = await h.runtime.scheduler.ensureParticipation();
    expect(held.posted).toBe(0);
    expect(h.runtime.repositories.participation.count()).toBe(0);

    const before = h.runtime.scheduler.status();
    expect(before.readiness.refereeReady).toBe(false);
    expect(before.readiness.tradingReady).toBe(false);

    const report = await h.runtime.scheduler.buildReport();
    expect(report.alerts.blocking.join(' ')).toContain('referee not ready');

    // The seed establishes the referee; registrations may now proceed even
    // though no price exists yet, because the two gates are separate.
    h.referee.seedPost(HARNESS_PACKAGE_HASH);
    await h.runtime.reader.tick();

    const after = h.runtime.scheduler.status();
    expect(after.readiness.refereeReady).toBe(true);
    expect(after.readiness.tradingReady).toBe(false);
    expect(after.readiness.tradingReasons.join(' ')).toContain('no reference price');

    const posted = await h.runtime.scheduler.ensureParticipation();
    expect(posted.posted).toBe(h.config.expectedAgentCount);
  });

  it('keeps a dry run running while the gates are open, and reports them as info', async () => {
    harness = await buildHarness({ agentCount: 8 });
    const h = harness;

    const outcome = await h.runtime.scheduler.ensureParticipation();
    // Dry-run registration is untouched by the referee gate.
    expect(outcome.posted).toBe(8);

    const status = h.runtime.scheduler.status();
    expect(status.readiness.refereeReady).toBe(false);
    expect(status.readiness.tradingReady).toBe(false);

    const report = await h.runtime.scheduler.buildReport();
    expect(report.alerts.blocking).toEqual([]);
    // A dry run never proved the referee, so its missing readbacks are not a
    // critical finding — they are the expected state.
    expect(report.alerts.critical.join(' ')).not.toContain('without readback');
    expect(report.alerts.info.join(' ')).toContain('dry-run');
  });

  it('reports missing registrations as info, not critical, when registration is disabled', async () => {
    harness = await buildHarness({
      agentCount: 8,
      env: { FLOP_ALLOW_REGISTRATION: 'false' },
    });
    const h = harness;

    const report = await h.runtime.scheduler.buildReport();
    expect(report.alerts.blocking).toEqual([]);
    expect(report.alerts.critical.join(' ')).not.toContain('without readback');
    expect(report.alerts.info.join(' ')).toContain('registration disabled / not expected');
  });
});
