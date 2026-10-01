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
import { FakeTransport } from './support/fake-transport.js';
import { waitFor } from './support/harness.js';

const READY_REFEREE: RefereeReadinessInputs = {
  readerContinuous: true,
  readerRunning: true,
  refereeRoomCount: 5,
  expectedRefereeRoomCount: 5,
  refereeRoomsWithGap: [],
  refereeRoomsWithUnresolvedGap: [],
  refereeRoomsReset: [],
  tradingRoomHasCoverageGap: false,
  tradingRoomCriticalGap: false,
  tradingRoomCriticalGapRooms: [],
  tradingRoomUnattainable: false,
  close1GapPolicy: 'block',
  profileLaneOk: true,
  fleetComplete: true,
  seedSeen: true,
  refereeDid: 'did:key:z6Mkreferee',
  expectedRefereeDid: 'did:key:z6Mkreferee',
  packageHash: 'a'.repeat(64),
  expectedPackageHash: 'a'.repeat(64),
  hydrated: true,
  requirePin: true,
};

function referee(patch: Partial<RefereeReadinessInputs> = {}) {
  return refereeReadiness({ ...READY_REFEREE, ...patch });
}

const READY_TRADING = {
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
  close1GapPolicy: 'block' as const,
  close1FullyCaughtUp: true,
  close1NetPersistBacklogRate: 0,
  unresolvedGap: false,
};

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

  it('is not ready when a room was recreated underneath us', () => {
    const result = referee({ refereeRoomsReset: ['d-close1-state'] });
    expect(result.ready).toBe(false);
    expect(result.reasons.join(' ')).toContain('d-close1-state');
  });

  it('is not ready while the reader is off, stopping, or missing referee rooms', () => {
    const off = referee({ readerContinuous: false });
    expect(off.ready).toBe(false);
    expect(off.reasons.join(' ')).toContain('continuous reader is off');

    const stopping = referee({ readerRunning: false });
    expect(stopping.ready).toBe(false);
    expect(stopping.reasons.join(' ')).toContain('not running');

    const short = referee({ refereeRoomCount: 4 });
    expect(short.ready).toBe(false);
    expect(short.reasons.join(' ')).toContain('reader owns 4 referee rooms, expected 5');
  });

  it('stays not-ready while any referee room carries a cursor gap', () => {
    // Still losing: the gate names the room as an *unresolved* gap.
    const open = referee({
      refereeRoomsWithGap: ['d-close1-state'],
      refereeRoomsWithUnresolvedGap: ['d-close1-state'],
    });
    expect(open.ready).toBe(false);
    expect(open.reasons.join(' ')).toContain('unresolved cursor gap in referee room(s) d-close1-state');

    // Caught up, but a loss still happened: a refusal either way, reported as
    // recovered so an operator can tell "still losing" from "lost, then caught up".
    const recovered = referee({ refereeRoomsWithGap: ['d-close1-state'] });
    expect(recovered.ready).toBe(false);
    expect(recovered.reasons.join(' ')).toContain('recovered, still on the record');

    // An empty list is the only acceptable value: a gap is never silently cleared.
    expect(referee({ refereeRoomsWithGap: [], refereeRoomsWithUnresolvedGap: [] }).ready).toBe(true);
  });

  it('grades the trading room separately, and never lets a critical gap through', () => {
    // A plain coverage gap under the default policy blocks registration outright.
    const blocked = referee({ tradingRoomHasCoverageGap: true });
    expect(blocked.ready).toBe(false);
    expect(blocked.reasons.join(' ')).toContain('CLOSE1_GAP_POLICY=block');

    // `degraded_readonly` keeps observation and registration alive for a plain
    // coverage gap — and still refuses to call the room covered.
    const degraded = referee({
      tradingRoomHasCoverageGap: true,
      close1GapPolicy: 'degraded_readonly',
    });
    expect(degraded.ready).toBe(true);

    // A gap that could hold one of our own posts is refused by *both* policies:
    // no setting may make an incomplete participation record acceptable.
    for (const policy of ['block', 'degraded_readonly'] as const) {
      const critical = referee({
        tradingRoomHasCoverageGap: true,
        tradingRoomCriticalGap: true,
        tradingRoomCriticalGapRooms: ['close1'],
        close1GapPolicy: policy,
      });
      expect(critical.ready).toBe(false);
      expect(critical.reasons.join(' ')).toContain('may contain one of our own messages');
    }
  });

  it('refuses to call an unpinned referee established when a pin is required', () => {
    const result = referee({ expectedRefereeDid: null, requirePin: true, refereeDid: 'did:key:z6Mkanyone' });
    expect(result.ready).toBe(false);
    expect(result.reasons.join(' ')).toContain('no referee DID pinned');
  });

  it('refuses live while the trading room is measurably unattainable', () => {
    // Unattainable is arithmetic, not a temporary state that will clear on its
    // own, so it is a refusal in its own right and a different one from a gap.
    const unattainable = referee({ tradingRoomUnattainable: true });
    expect(unattainable.ready).toBe(false);
    expect(unattainable.reasons.join(' ')).toContain('catch-up unattainable');

    // It propagates: trading is strictly downstream of the referee gate, so a
    // reader that cannot keep up stops registration *and* trading.
    const trading = tradingReadiness({
      ...READY_TRADING,
      referee: unattainable,
    });
    expect(trading.ready).toBe(false);
    expect(trading.reasons.join(' ')).toContain('catch-up unattainable');
  });
});

describe('tradingReadiness', () => {
  const ready = READY_TRADING;

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

  it('refuses trading on a plain close1 coverage gap under either policy', () => {
    // The coverage clause is satisfied by `fully_caught_up` alone. A gap in the
    // trading room is never a trade, and `degraded_readonly` — which exists to
    // keep observation and registration alive — must not become a back door.
    const blocked = tradingReadiness({ ...ready, close1FullyCaughtUp: false });
    expect(blocked.ready).toBe(false);
    expect(blocked.reasons.join(' ')).toContain('CLOSE1_GAP_POLICY=block');

    const degraded = tradingReadiness({
      ...ready,
      close1FullyCaughtUp: false,
      close1GapPolicy: 'degraded_readonly',
    });
    expect(degraded.ready).toBe(false);
    expect(degraded.reasons.join(' ')).toContain('degraded_readonly permits observation only');
  });

  it('refuses trading while the close1 persisted backlog is still widening', () => {
    const result = tradingReadiness({ ...ready, close1NetPersistBacklogRate: 42.5 });
    expect(result.ready).toBe(false);
    expect(result.reasons.join(' ')).toContain('net persisted backlog is positive');
  });

  it('refuses trading while an unresolved gap remains on the record', () => {
    const result = tradingReadiness({ ...ready, unresolvedGap: true });
    expect(result.ready).toBe(false);
    expect(result.reasons.join(' ')).toContain('unresolved cursor gap remains');
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
      // A read is paced so the continuous loops the live gate requires can be
      // started and observed without spinning against an instant-returning double.
      transport: new FakeTransport({ readDelayMs: 1 }),
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

    // Live registration also requires the reader to own the fixed rooms
    // continuously, so the loops production runs are the loops this test runs.
    h.runtime.reader.startContinuous();
    await waitFor(
      () => h.runtime.reader.readerStatus().lastSuccessByRoom['d-close1-state'] !== undefined,
      'the reader to complete its first pass',
    );

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
    await waitFor(
      () => h.runtime.scheduler.status().readiness.refereeReady,
      'the continuous reader to read the seed',
    );

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

  it('grades a close1 gap by what it could hide, not by its size', async () => {
    harness = await buildHarness({ agentCount: 8 });
    const h = harness;

    // Nothing has been registered or posted into close1 yet, so there is nothing
    // of ours a band could hold: a coverage gap is real and is not critical.
    h.runtime.repositories.roomCursors.update('close1', {
      gap: 2,
      gap_count: 1,
      last_gap_from: 6,
      last_gap_to: 7,
      gap_resolved_at: null,
    });
    const plain = h.runtime.reader.tradingRoomCoverage();
    expect(plain.hasGap).toBe(true);
    expect(plain.criticalGap).toBe(false);

    // Once registrations have been posted, the same band is no longer provably
    // free of our work: an unread post of ours could sit anywhere in it, and
    // "unprovable" is refused.
    await h.runtime.scheduler.ensureParticipation();
    const unproven = h.runtime.reader.tradingRoomCoverage();
    expect(unproven.criticalGap).toBe(true);

    const status = h.runtime.scheduler.status();
    expect(status.readiness.refereeReady).toBe(false);
    expect(status.readiness.refereeReasons.join(' ')).toContain('may contain one of our own messages');

    // And a band that is provably below the oldest post of ours we have read back
    // is a plain coverage gap again — the refusal is about evidence, not alarm.
    const localDids = [...h.runtime.keyStore.didSet()];
    h.runtime.repositories.messages.insert({
      room: 'close1',
      seq: 900,
      ts: new Date().toISOString(),
      sender_did: localDids[0]!,
      nonce: 'n',
      sig: 's',
      text: 'own-post',
      kind: 'owner',
      signature_valid: 1,
      ingested_at: new Date().toISOString(),
    });
    h.runtime.repositories.roomCursors.update('close1', {
      last_gap_from: 6,
      last_gap_to: 7,
    });
    expect(h.runtime.reader.tradingRoomCoverage().criticalGap).toBe(false);

    // A band that reaches our own posts is refused again.
    h.runtime.repositories.roomCursors.update('close1', {
      last_gap_from: 899,
      last_gap_to: 901,
    });
    expect(h.runtime.reader.tradingRoomCoverage().criticalGap).toBe(true);
  });
});
