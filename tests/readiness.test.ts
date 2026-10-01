/**
 * The readiness gates: three of them, nested, and each strictly stronger than
 * the one before.
 *
 * `refereeFeedReady` is about *provenance* — is the contest record we are
 * reading genuinely the pinned referee's. `registrationReady` adds our own write
 * lane, and `tradingReady` adds everything a priced trade needs plus the 150/150
 * readback. The unit half pins each clause; the integration half pins the wiring
 * — that `close1`, a 17-million-message public room, does not by itself hold the
 * registrations, and that registration readiness is never read as trading
 * readiness.
 */
import { afterEach, describe, expect, it } from 'vitest';
import {
  refereeFeedReadiness,
  registrationReadiness,
  tradingReadiness,
  type RefereeFeedReadinessInputs,
  type RegistrationReadinessInputs,
  type TradingReadinessInputs,
} from '../apps/orchestrator/src/readiness.js';
import { buildHarness, HARNESS_PACKAGE_HASH, type Harness } from './support/orchestrator.js';
import { FakeTransport } from './support/fake-transport.js';
import { waitFor } from './support/harness.js';

/** Every referee-feed clause satisfied: five clean rooms, pinned and hydrated. */
const READY_FEED: RefereeFeedReadinessInputs = {
  readerContinuous: true,
  readerRunning: true,
  refereeRoomCount: 5,
  expectedRefereeRoomCount: 5,
  refereeRoomsWithGap: [],
  refereeRoomsWithUnresolvedGap: [],
  refereeRoomsReset: [],
  profileLaneOk: true,
  seedSeen: true,
  refereeDid: 'did:key:z6Mkreferee',
  expectedRefereeDid: 'did:key:z6Mkreferee',
  packageHash: 'a'.repeat(64),
  expectedPackageHash: 'a'.repeat(64),
  hydrated: true,
  requirePin: true,
  currentSweepRecoverable: true,
};

function feed(patch: Partial<RefereeFeedReadinessInputs> = {}) {
  return refereeFeedReadiness({ ...READY_FEED, ...patch });
}

/**
 * The feed, plus a write lane that is sound and a `close1` with no recorded gap.
 *
 * NOTE what is *absent*: there is no clause here for the shape of the public
 * room's history. That absence is the design — a `close1` gap is graded by its
 * own clauses below, never by the referee's.
 */
const READY_REGISTRATION: RegistrationReadinessInputs = {
  ...READY_FEED,
  tradingRoomHasCoverageGap: false,
  tradingRoomCriticalGap: false,
  tradingRoomCriticalGapRooms: [],
  tradingRoomUnattainable: false,
  close1GapPolicy: 'block',
  fleetComplete: true,
  writerHealthy: true,
  nonceStoreUsable: true,
  durableEvidenceWritable: true,
  allowRegistrationWithClose1Gap: false,
  localMessageInGap: false,
};

function registration(patch: Partial<RegistrationReadinessInputs> = {}) {
  return registrationReadiness({ ...READY_REGISTRATION, ...patch });
}

const READY_TRADING: TradingReadinessInputs = {
  registration: { ready: true, reasons: [] },
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
  close1GapPolicy: 'block',
  close1FullyCaughtUp: true,
  close1NetPersistBacklogRate: 0,
  unresolvedGap: false,
  close1Unattainable: false,
  localMessageInGap: false,
  writerHealthy: true,
  allowTradingWithClose1Gap: false,
  manualOverride: null,
};

const OVERRIDE = { operator: 'lei', reason: 'deadline, plain public gap only', at: '2026-09-30T00:00:00.000Z' };

describe('refereeFeedReadiness', () => {
  it('is ready only when every clause holds', () => {
    expect(feed()).toEqual({ ready: true, reasons: [] });
  });

  it('is not ready without a seed', () => {
    const result = feed({ seedSeen: false });
    expect(result.ready).toBe(false);
    expect(result.reasons.join(' ')).toContain('seed not read');
  });

  it('is not ready when the seed comes from anyone but the pinned referee', () => {
    const result = feed({ refereeDid: 'did:key:z6Mkstranger' });
    expect(result.ready).toBe(false);
    expect(result.reasons.join(' ')).toContain('not the pinned one');
  });

  it('is not ready when the seed package differs from the pin', () => {
    const result = feed({ packageHash: 'b'.repeat(64) });
    expect(result.ready).toBe(false);
    expect(result.reasons.join(' ')).toContain('differs from the pinned package');
  });

  it('is not ready before the verifier has been hydrated', () => {
    const result = feed({ hydrated: false });
    expect(result.ready).toBe(false);
    expect(result.reasons.join(' ')).toContain('not hydrated');
  });

  it('is not ready when the official sweep cannot be recovered', () => {
    // A verifier with no sweep cannot price anything and cannot say which sweep
    // the contest is in. That is a feed problem: everything downstream reads it.
    const result = feed({ currentSweepRecoverable: false });
    expect(result.ready).toBe(false);
    expect(result.reasons.join(' ')).toContain('sweep is not recoverable');
  });

  it('is not ready when a referee room was recreated underneath us', () => {
    const result = feed({ refereeRoomsReset: ['d-close1-state'] });
    expect(result.ready).toBe(false);
    expect(result.reasons.join(' ')).toContain('d-close1-state');
  });

  it('is not ready while the reader is off, stopping, or missing referee rooms', () => {
    const off = feed({ readerContinuous: false });
    expect(off.ready).toBe(false);
    expect(off.reasons.join(' ')).toContain('continuous reader is off');

    const stopping = feed({ readerRunning: false });
    expect(stopping.ready).toBe(false);
    expect(stopping.reasons.join(' ')).toContain('not running');

    const short = feed({ refereeRoomCount: 4 });
    expect(short.ready).toBe(false);
    expect(short.reasons.join(' ')).toContain('reader owns 4 referee rooms, expected 5');
  });

  it('stays not-ready while any referee room carries a cursor gap', () => {
    // Still losing: the gate names the room as an *unresolved* gap.
    const open = feed({
      refereeRoomsWithGap: ['d-close1-state'],
      refereeRoomsWithUnresolvedGap: ['d-close1-state'],
    });
    expect(open.ready).toBe(false);
    expect(open.reasons.join(' ')).toContain('unresolved cursor gap in referee room(s) d-close1-state');

    // Caught up, but a loss still happened: a refusal either way, reported as
    // recovered so an operator can tell "still losing" from "lost, then caught up".
    const recovered = feed({ refereeRoomsWithGap: ['d-close1-state'] });
    expect(recovered.ready).toBe(false);
    expect(recovered.reasons.join(' ')).toContain('recovered, still on the record');

    // An empty list is the only acceptable value: a gap is never silently cleared.
    expect(feed({ refereeRoomsWithGap: [], refereeRoomsWithUnresolvedGap: [] }).ready).toBe(true);
  });

  it('ignores the public trading room entirely', () => {
    // The gate has no clause for `close1` — not "a gap is tolerated", but "the
    // public room is not part of the question". That is what keeps a 17-million
    // message room from holding the contest record hostage.
    const clean = feed();
    expect(clean.ready).toBe(true);
    const withPublicGap = registration({ tradingRoomHasCoverageGap: true, tradingRoomCriticalGap: true });
    expect(withPublicGap.ready).toBe(false);
    // Same feed inputs, different gate: only the registration gate moved.
    expect(feed().ready).toBe(true);
  });

  it('refuses to call an unpinned referee established when a pin is required', () => {
    const result = feed({ expectedRefereeDid: null, requirePin: true, refereeDid: 'did:key:z6Mkanyone' });
    expect(result.ready).toBe(false);
    expect(result.reasons.join(' ')).toContain('no referee DID pinned');
  });
});

describe('registrationReadiness', () => {
  it('is ready only when every clause holds', () => {
    expect(registration()).toEqual({ ready: true, reasons: [] });
  });

  it('inherits every referee-feed clause', () => {
    const noSeed = registration({ seedSeen: false });
    expect(noSeed.ready).toBe(false);
    expect(noSeed.reasons.join(' ')).toContain('seed not read');

    const roomGap = registration({ refereeRoomsWithUnresolvedGap: ['d-close1-flow'] });
    expect(roomGap.ready).toBe(false);
    expect(roomGap.reasons.join(' ')).toContain('unresolved cursor gap in referee room(s) d-close1-flow');
  });

  it('allows a plain public coverage gap only when the operator has said so', () => {
    // Default: `CLOSE1_GAP_POLICY=block` with the switch off refuses outright.
    const blocked = registration({ tradingRoomHasCoverageGap: true });
    expect(blocked.ready).toBe(false);
    expect(blocked.reasons.join(' ')).toContain('CLOSE1_GAP_POLICY=block');

    // The explicit operator switch is what a registration-only launch turns on.
    const allowed = registration({
      tradingRoomHasCoverageGap: true,
      allowRegistrationWithClose1Gap: true,
    });
    expect(allowed.ready).toBe(true);

    // `degraded_readonly` is the other way to permit observation + registration
    // on a plain public gap, and it needs no per-process switch.
    const degraded = registration({
      tradingRoomHasCoverageGap: true,
      close1GapPolicy: 'degraded_readonly',
    });
    expect(degraded.ready).toBe(true);
  });

  it('never allows a gap that could hold one of our own registrations', () => {
    // Policy and switch are both irrelevant here: an unprovable participation
    // record is not a policy question.
    for (const policy of ['block', 'degraded_readonly'] as const) {
      for (const allow of [false, true]) {
        const critical = registration({
          tradingRoomHasCoverageGap: true,
          tradingRoomCriticalGap: true,
          tradingRoomCriticalGapRooms: ['close1'],
          close1GapPolicy: policy,
          allowRegistrationWithClose1Gap: allow,
        });
        expect(critical.ready).toBe(false);
        expect(critical.reasons.join(' ')).toContain('may contain one of our own messages');
      }
    }
  });

  it('refuses outright when one of our seqs provably falls in the band', () => {
    const inGap = registration({
      tradingRoomHasCoverageGap: true,
      tradingRoomCriticalGap: true,
      tradingRoomCriticalGapRooms: ['close1'],
      localMessageInGap: true,
      allowRegistrationWithClose1Gap: true,
    });
    expect(inGap.ready).toBe(false);
    expect(inGap.reasons.join(' ')).toContain('provably falls inside the recorded close1 gap');
  });

  it('refuses registration while close1 is measurably unattainable', () => {
    // Unattainable is arithmetic, not effort: the room can never be caught up, so
    // no switch makes registering into it sound.
    const result = registration({
      tradingRoomHasCoverageGap: true,
      tradingRoomUnattainable: true,
      allowRegistrationWithClose1Gap: true,
    });
    expect(result.ready).toBe(false);
    expect(result.reasons.join(' ')).toContain('catch-up unattainable');
  });

  it('refuses registration when our own write lane is not sound', () => {
    expect(registration({ fleetComplete: false }).reasons.join(' ')).toContain('fleet is not complete');
    expect(registration({ writerHealthy: false }).reasons.join(' ')).toContain('writer cannot accept');
    expect(registration({ nonceStoreUsable: false }).reasons.join(' ')).toContain(
      'nonce store is not usable',
    );
    expect(registration({ durableEvidenceWritable: false }).reasons.join(' ')).toContain(
      'durable evidence cannot be written',
    );
  });

  it('is strictly stronger than the feed gate', () => {
    // The feed can be perfectly provable while registration is held; the reverse
    // can never happen, because registration takes the feed clauses as given.
    const criticalGap = registration({
      tradingRoomHasCoverageGap: true,
      tradingRoomCriticalGap: true,
      tradingRoomCriticalGapRooms: ['close1'],
    });
    expect(feed().ready).toBe(true);
    expect(criticalGap.ready).toBe(false);
  });
});

describe('tradingReadiness', () => {
  const ready = READY_TRADING;

  it('is ready only when every clause holds', () => {
    expect(tradingReadiness(ready)).toEqual({ ready: true, reasons: [] });
  });

  it('is never ready when the registration gate is not', () => {
    const result = tradingReadiness({
      ...ready,
      registration: { ready: false, reasons: ['referee seed not read'] },
    });
    expect(result.ready).toBe(false);
    expect(result.reasons.join(' ')).toContain('registration: referee seed not read');
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

  it('blocks an incomplete fleet, an unwritable writer and missing readbacks only when required', () => {
    expect(tradingReadiness({ ...ready, fleetComplete: false }).reasons.join(' ')).toContain(
      'fleet is not complete',
    );
    expect(tradingReadiness({ ...ready, writerHealthy: false }).reasons.join(' ')).toContain(
      'writer cannot accept a trade',
    );
    expect(tradingReadiness({ ...ready, registrationReadbackComplete: false }).ready).toBe(false);
    // A dry run never registers against the referee, so readbacks are not a gate.
    expect(
      tradingReadiness({ ...ready, registrationRequired: false, registrationReadbackComplete: false }).ready,
    ).toBe(true);
  });

  it('blocks on conservative mode', () => {
    const result = tradingReadiness({ ...ready, conservative: true, conservativeReasons: ['limits_for_missing'] });
    expect(result.ready).toBe(false);
    expect(result.reasons.join(' ')).toContain('limits_for_missing');
  });

  it('refuses trading on a plain close1 coverage gap under either policy', () => {
    // The coverage clause is satisfied by the full caught-up test alone. A gap in
    // the trading room is never a trade, and `degraded_readonly` — which exists to
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

  it('treats ALLOW_TRADING_WITH_CLOSE1_GAP as insufficient on its own', () => {
    // A config value with no author, no reason and no time is not a decision.
    const flagged = tradingReadiness({
      ...ready,
      close1FullyCaughtUp: false,
      allowTradingWithClose1Gap: true,
    });
    expect(flagged.ready).toBe(false);
    expect(flagged.reasons.join(' ')).toContain('no manual override is recorded');
  });

  it('waives only the coverage clause, and only for a recorded override', () => {
    const overridden = tradingReadiness({
      ...ready,
      close1FullyCaughtUp: false,
      close1GapPolicy: 'degraded_readonly',
      allowTradingWithClose1Gap: true,
      manualOverride: OVERRIDE,
    });
    expect(overridden.ready).toBe(true);

    // The override is not a general licence: an unresolved gap on the record, a
    // local message known to be in the band and an unattainable room all stay
    // absolute refusals.
    const unresolved = tradingReadiness({
      ...ready,
      close1FullyCaughtUp: false,
      allowTradingWithClose1Gap: true,
      manualOverride: OVERRIDE,
      unresolvedGap: true,
    });
    expect(unresolved.ready).toBe(false);
    expect(unresolved.reasons.join(' ')).toContain('unresolved cursor gap remains');
  });

  it('refuses trading on a local trade, offer or re-post message in the band, whatever is waived', () => {
    const result = tradingReadiness({
      ...ready,
      close1FullyCaughtUp: false,
      allowTradingWithClose1Gap: true,
      manualOverride: OVERRIDE,
      localMessageInGap: true,
    });
    expect(result.ready).toBe(false);
    expect(result.reasons.join(' ')).toContain('local trade, offer or re-post message provably falls inside');
  });

  it('refuses trading while close1 is unattainable, however hard an operator tries', () => {
    const result = tradingReadiness({
      ...ready,
      close1Unattainable: true,
      allowTradingWithClose1Gap: true,
      manualOverride: OVERRIDE,
    });
    expect(result.ready).toBe(false);
    expect(result.reasons.join(' ')).toContain('catch-up is unattainable');
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

describe('the three gates are wired', () => {
  let harness: Harness | undefined;

  afterEach(async () => {
    if (harness) await harness.dispose();
    harness = undefined;
  });

  function liveHarness(env: Record<string, string> = {}): Promise<Harness> {
    return buildHarness({
      agentCount: 150,
      // A read is paced so the continuous loops the live gate requires can be
      // started and observed without spinning against an instant-returning double.
      transport: new FakeTransport({ readDelayMs: 1 }),
      env: {
        FLOP_MODE: 'live',
        FLOP_LIVE_CONFIRM: 'close-1',
        FLOP_ALLOW_REGISTRATION: 'true',
        EXPECTED_PACKAGE_HASH: HARNESS_PACKAGE_HASH,
        ...env,
      },
    });
  }

  /** A price with its `for` label, exactly as the referee publishes one. */
  function publishSweep(h: Harness, sweep: number): void {
    h.referee.post('d-close1-price', {
      t: 'price',
      season: 'close-1',
      n: sweep,
      ref: { px: '225.10', time: '2026-09-28T12:00:00Z', tid: `t${sweep}` },
      limits: ['213.85', '236.36'],
      for: sweep + 1,
    });
  }

  /**
   * Establish the referee: the reader loop, the seed, then a priced sweep.
   *
   * The seed has to be *observed* before the price is posted — the verifier
   * refuses any post that arrives before the seed, and the per-room loops can
   * read the price room before the state room — so this waits on the verifier's
   * own state rather than on a sleep.
   */
  async function establishReferee(h: Harness, sweep = 824): Promise<void> {
    h.runtime.reader.startContinuous();
    await waitFor(
      () => h.runtime.reader.readerStatus().lastSuccessByRoom['d-close1-state'] !== undefined,
      'the reader to complete its first pass',
    );
    h.referee.seedPost(HARNESS_PACKAGE_HASH);
    await waitFor(() => h.runtime.reader.verifier.state.seedSeen, 'the seed to be observed');
    publishSweep(h, sweep);
    await waitFor(() => h.runtime.reader.verifier.state.currentSweep !== null, 'the sweep to be observed');
    await waitFor(() => h.runtime.scheduler.status().readiness.refereeFeedReady, 'the feed gate to open');
  }

  /** A recorded loss that is already closed: the band is historical, not open. */
  function recordHistoricalGap(h: Harness, from: number, to: number): void {
    h.runtime.repositories.roomCursors.update('close1', {
      gap: 0,
      gap_count: 1,
      last_gap_from: from,
      last_gap_to: to,
      gap_resolved_at: new Date().toISOString(),
    });
  }

  it('grades a public close1 gap separately from the referee feed', async () => {
    harness = await liveHarness();
    const h = harness;
    await establishReferee(h);

    const clean = h.runtime.scheduler.status();
    expect(clean.readiness.refereeFeedReady).toBe(true);
    expect(clean.readiness.registrationReady).toBe(true);
    expect(clean.readiness.tradingReady).toBe(false);
    expect(clean.operatingMode).toBe('live_registration_only');

    // A historical gap in the public room is real, is reported, and does not
    // touch the referee gate — nor the registrations, until the policy says so.
    recordHistoricalGap(h, 900, 950);
    const degraded = h.runtime.scheduler.status();
    expect(degraded.readiness.refereeFeedReady).toBe(true);
    expect(degraded.close1.coverage).toBe('degraded_public_coverage');
    expect(degraded.close1.gapPolicy).toBe('block');
    expect(degraded.readiness.registrationReady).toBe(false);
    expect(degraded.readiness.registrationReasons.join(' ')).toContain('CLOSE1_GAP_POLICY=block');
    // And no trade can be written from registration readiness alone.
    expect(degraded.readiness.tradingReady).toBe(false);
    expect(degraded.close1.tradeBlockedReason).not.toBeNull();

    // The registration path is genuinely held, not merely flagged.
    const held = await h.runtime.scheduler.ensureParticipation();
    expect(held.posted).toBe(0);
    expect(h.runtime.repositories.participation.count()).toBe(0);

    const report = await h.runtime.scheduler.buildReport();
    expect(report.alerts.blocking.join(' ')).toContain('registration not ready');

    // A loss in a *referee* room is a different thing entirely: the contest
    // record itself is incomplete, so the feed gate closes and registration
    // follows it down.
    h.runtime.repositories.roomCursors.update('d-close1-state', {
      gap: 1,
      gap_count: 1,
      last_gap_from: 900,
      last_gap_to: 900,
      gap_resolved_at: null,
    });
    const holed = h.runtime.scheduler.status();
    expect(holed.readiness.refereeFeedReady).toBe(false);
    expect(holed.readiness.registrationReady).toBe(false);
    expect(holed.readiness.registrationReasons.join(' ')).toContain('d-close1-state');
    const holedReport = await h.runtime.scheduler.buildReport();
    expect(holedReport.alerts.critical.join(' ')).toContain('d-close1-state');
  });

  it('permits registration-only over a degraded public room, and never trading', async () => {
    harness = await liveHarness({ ALLOW_REGISTRATION_WITH_CLOSE1_GAP: 'true' });
    const h = harness;
    await establishReferee(h);

    // The operator switch covers a *plain public* coverage gap only.
    recordHistoricalGap(h, 900, 950);
    const degraded = h.runtime.scheduler.status();
    expect(degraded.readiness.refereeFeedReady).toBe(true);
    expect(degraded.readiness.registrationReady).toBe(true);
    expect(degraded.close1.coverage).toBe('degraded_public_coverage');

    // Registration only: no trade is writable, ever, from this posture.
    expect(degraded.operatingMode).toBe('live_registration_only');
    expect(degraded.readiness.tradingReady).toBe(false);
    expect(h.config.tradingArmed).toBe(false);

    const posted = await h.runtime.scheduler.ensureParticipation();
    expect(posted.posted).toBe(150);

    // Posted is not read back. The local message index records the POST — its own
    // request id, the body hash and the sweep — and the row stays pending until
    // the room echoes it.
    const pending = h.runtime.scheduler.status();
    expect(pending.close1.registrationPending).toBe(150);
    expect(pending.close1.registrationReadback.completed).toBe(0);
    const row = h.runtime.repositories.participation.all()[0]!;
    expect(row.post_request_id).toContain('close1|');
    expect(row.message_hash).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(row.post_sweep).toBe(824);
    expect(row.readback_at ?? null).toBeNull();

    const degradedReport = await h.runtime.scheduler.buildReport();
    expect(degradedReport.alerts.warning.join(' ')).toContain('registration-only degraded coverage');
    expect(degradedReport.alerts.warning.join(' ')).toContain('trading remains blocked');
    expect(degradedReport.alerts.warning.join(' ')).toContain('close1 historical coverage incomplete');
    expect(degradedReport.alerts.warning.join(' ')).toContain('local registration readback pending');

    // The reader's own passes are what turn a post into evidence. They are paced,
    // so this drives ticks until every row has been echoed back rather than
    // assuming one pass sees all 150 at once.
    for (
      let attempt = 0;
      attempt < 20 && h.runtime.scheduler.status().close1.registrationReadback.completed < 150;
      attempt += 1
    ) {
      await h.runtime.scheduler.runTick();
    }
    const confirmed = h.runtime.scheduler.status();
    expect(confirmed.close1.registrationReadback.completed).toBe(150);
    expect(confirmed.close1.registrationPending).toBe(0);
    // Readbacks complete, and trading is still refused: registration readiness is
    // a precondition of trading, never a substitute for it.
    expect(confirmed.readiness.registrationReady).toBe(true);
    expect(confirmed.readiness.tradingReady).toBe(false);

    // Now make the band provably hold our own messages: this is proof, not
    // suspicion, and it closes registration as well as trading.
    h.runtime.repositories.roomCursors.update('close1', {
      gap: 150,
      gap_count: 1,
      last_gap_from: 1,
      last_gap_to: 150,
      gap_resolved_at: null,
    });
    const inGap = h.runtime.scheduler.status();
    expect(inGap.close1.coverage).toBe('local_message_in_gap');
    expect(inGap.close1.localMessagesInGap.length).toBeGreaterThan(0);
    expect(inGap.readiness.registrationReady).toBe(false);
    expect(inGap.readiness.tradingReady).toBe(false);
    const inGapReport = await h.runtime.scheduler.buildReport();
    expect(inGapReport.alerts.critical.join(' ')).toContain('local message provably inside the close1 gap');
  });

  it('keeps a dry run running while the gates are open, and reports them as info', async () => {
    harness = await buildHarness({ agentCount: 8 });
    const h = harness;

    const outcome = await h.runtime.scheduler.ensureParticipation();
    // Dry-run registration is untouched by the referee gate.
    expect(outcome.posted).toBe(8);

    const status = h.runtime.scheduler.status();
    expect(status.operatingMode).toBe('dry_run');
    expect(status.readiness.refereeFeedReady).toBe(false);
    expect(status.readiness.registrationReady).toBe(false);
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

  it('holds every registration in live until the referee feed is provable, then posts them', async () => {
    harness = await liveHarness();
    const h = harness;

    h.runtime.reader.startContinuous();
    await waitFor(
      () => h.runtime.reader.readerStatus().lastSuccessByRoom['d-close1-state'] !== undefined,
      'the reader to complete its first pass',
    );

    const held = await h.runtime.scheduler.ensureParticipation();
    expect(held.posted).toBe(0);
    expect(h.runtime.repositories.participation.count()).toBe(0);

    const before = h.runtime.scheduler.status();
    expect(before.readiness.refereeFeedReady).toBe(false);
    expect(before.readiness.registrationReady).toBe(false);
    expect(before.readiness.tradingReady).toBe(false);

    const report = await h.runtime.scheduler.buildReport();
    expect(report.alerts.blocking.join(' ')).toContain('referee not ready');

    // The seed establishes the referee's identity; the priced sweep makes the
    // contest's current sweep recoverable. Both are feed clauses. Registrations
    // may now proceed even though no trade can be priced — the two are separate.
    h.referee.seedPost(HARNESS_PACKAGE_HASH);
    await waitFor(() => h.runtime.reader.verifier.state.seedSeen, 'the seed to be observed');
    publishSweep(h, 824);
    await waitFor(() => h.runtime.scheduler.status().readiness.refereeFeedReady, 'the feed gate to open');

    const after = h.runtime.scheduler.status();
    expect(after.readiness.refereeFeedReady).toBe(true);
    expect(after.readiness.registrationReady).toBe(true);
    // Registration readiness is not trading readiness: the trade still cannot be
    // priced here, and the trading reasons say why rather than borrowing the
    // registration gate's silence.
    expect(after.readiness.tradingReady).toBe(false);
    expect(after.readiness.tradingReasons.length).toBeGreaterThan(0);

    const posted = await h.runtime.scheduler.ensureParticipation();
    expect(posted.posted).toBe(h.config.expectedAgentCount);
  });
});
