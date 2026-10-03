/**
 * Late-start full participation.
 *
 * The opening seed is a one-time post, and a process that starts after
 * `d-close1-price`'s retained ring has rotated past it can never read it. The
 * strict mode requires that seed before it will believe a price, so such a
 * process cannot register and cannot trade — which is the whole contest.
 *
 * This mode replaces that one requirement with a different anchor: the pinned
 * referee's *current*, signed price post. It does not relax the trust boundary.
 * The launch configuration must still pin the referee DID and the package hash,
 * `adopt_first_sender` is still refused, and every room-bound signature is still
 * verified. What it drops is only the demand that the history be replayed from
 * its beginning.
 *
 * What is pinned here:
 *   - the mode is off by default, needs its own confirmation literal, cannot be
 *     armed by `FLOP_MODE=live` alone, and needs two switches to trade;
 *   - a price post's `for` is what binds `until`; a missing or wrong `for`, a
 *     stale post and the lock all stop a new trade;
 *   - the seedless registration and the participation trade are separate layers,
 *     and a registration is always on the room before a trade for that pair;
 *   - a missed trade is re-issued under a *new* id, never re-sent verbatim;
 *   - the status document says what the mode cannot claim rather than implying a
 *     full replay.
 */
import { afterEach, describe, expect, it } from 'vitest';
import {
  DEFAULT_RISK_CAPS,
  Decimal,
  emptySnapshot,
  parseTradeMessage,
  referenceRules,
  verifyMakerSignature,
  verifyTakerSignature,
  withinPublishedLimits,
  type MarketSnapshot,
} from '@flop/close-call';
import { didFromSeed, verifyRoomSignatureForRoom } from '@flop/identity';
import {
  LATE_START_BOOTSTRAP_VERSION,
  LATE_START_OBSERVATIONS_REQUIRED,
  asDecimals,
  fallbackParams,
  gateDecision,
  lateStartBootstrapProposal,
  lateStartSignal,
  type StrategyContext,
} from '@flop/strategy';
import {
  LATE_START_CONFIRM_VALUE,
  LATE_START_STRATEGY_CONFIRM_VALUE,
  loadConfig,
  type Config,
} from '../apps/orchestrator/src/config.js';
import { loadRules } from '../apps/orchestrator/src/main.js';
import {
  WALL_CLOCK_INVALID_REASON,
  WALL_CLOCK_LOCKED_REASON,
  lateStartFeedReadiness,
  lateStartRegistrationReadiness,
  lateStartTradingReadiness,
  lockState,
  marketSnapshotReadiness,
} from '../apps/orchestrator/src/readiness.js';
import { FakeTransport } from './support/fake-transport.js';
import { tempDir, waitFor } from './support/harness.js';
import {
  buildHarness,
  HARNESS_PACKAGE_HASH,
  HARNESS_REFEREE_DID,
  HARNESS_ROOMS,
  type Harness,
} from './support/orchestrator.js';

/** A clock that lines the harness up with the fake rooms' own timestamps. */
const CLOCK = '2026-09-25T12:00:00.000Z';

/** The pins a live process must carry, so a test cannot skip the trust boundary. */
const LIVE_PINS = {
  FLOP_MODE: 'live',
  FLOP_LIVE_CONFIRM: 'close-1',
  EXPECTED_REFEREE_DID: HARNESS_REFEREE_DID,
  EXPECTED_PACKAGE_HASH: HARNESS_PACKAGE_HASH,
  REQUIRE_REFEREE_PIN: 'true',
} as const;

function armLateStart(overrides: Record<string, string> = {}): Config {
  return loadConfig({
    ...LIVE_PINS,
    FLOP_ALLOW_REGISTRATION: 'true',
    ...overrides,
  });
}

// ---------------------------------------------------------------------------
// The mode is a second, explicit commitment
// ---------------------------------------------------------------------------

describe('late-start arming', () => {
  it('is off by default and never armed by FLOP_MODE=live alone', () => {
    const off = loadConfig({});
    expect(off.lateStartRequested).toBe(false);
    expect(off.lateStartArmed).toBe(false);
    expect(off.lateStartBlockedReason).toBeNull();

    // Live, fully pinned, and still not late-start: the two are separate.
    const live = armLateStart();
    expect(live.lateStartRequested).toBe(false);
    expect(live.lateStartArmed).toBe(false);
    expect(live.liveArmed).toBe(true);
  });

  it('needs its own confirmation literal', () => {
    const wrong = armLateStart({ LATE_START_MODE: 'true', LATE_START_CONFIRM: 'yes' });
    expect(wrong.lateStartRequested).toBe(true);
    expect(wrong.lateStartArmed).toBe(false);
    expect(wrong.lateStartBlockedReason).toContain(LATE_START_CONFIRM_VALUE);
  });

  it('needs live, not merely the mode switch', () => {
    const dry = loadConfig({
      LATE_START_MODE: 'true',
      LATE_START_CONFIRM: LATE_START_CONFIRM_VALUE,
    });
    expect(dry.lateStartArmed).toBe(false);
    expect(dry.lateStartBlockedReason).toContain('FLOP_MODE=live');
    // A half-configured late start is not a startup error: it keeps running as a
    // dry run and reports the missing switch instead of leaving no status page.
    expect(dry.mode).toBe('dry-run');
  });

  it('arms registration and trading on separate switches', () => {
    const armed = armLateStart({
      LATE_START_MODE: 'true',
      LATE_START_CONFIRM: LATE_START_CONFIRM_VALUE,
    });
    expect(armed.lateStartArmed).toBe(true);
    expect(armed.lateStartBlockedReason).toBeNull();
    // Registration is armed, trading is not: the mode itself must never be
    // enough to write a trade.
    expect(armed.lateStartTradingArmed).toBe(false);

    const trading = armLateStart({
      LATE_START_MODE: 'true',
      LATE_START_CONFIRM: LATE_START_CONFIRM_VALUE,
      FLOP_ALLOW_TRADING: 'true',
      LATE_START_ALLOW_TRADING: 'true',
    });
    expect(trading.lateStartTradingArmed).toBe(true);
  });

  it('does not trade on FLOP_ALLOW_TRADING without LATE_START_ALLOW_TRADING', () => {
    const one = armLateStart({
      LATE_START_MODE: 'true',
      LATE_START_CONFIRM: LATE_START_CONFIRM_VALUE,
      FLOP_ALLOW_TRADING: 'true',
    });
    expect(one.lateStartArmed).toBe(true);
    expect(one.lateStartTradingArmed).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// The seedless feed gate and the current market snapshot
// ---------------------------------------------------------------------------

const FEED_INPUTS = {
  lateStartArmed: true,
  readerContinuous: true,
  readerRunning: true,
  refereeRoomCount: 5,
  expectedRefereeRoomCount: 5,
  refereeRoomsWithUnresolvedGap: [] as string[],
  refereeRoomsReset: [] as string[],
  launchPinVerified: true,
  refereeDid: HARNESS_REFEREE_DID,
  expectedRefereeDid: HARNESS_REFEREE_DID,
  refereeFeedBlockers: [] as string[],
  refereeSeen: true,
};

const SNAPSHOT_INPUTS = {
  refereeSeen: true,
  sweep: 1758,
  reference: '229.80',
  limits: { low: '218.31', high: '241.29' },
  limitsForSweep: 1759,
  limitsUsable: true,
  locked: false,
  secondsSinceLastPost: 30,
  sweepSeconds: 300,
  maxStaleSweeps: 2,
};

describe('the seedless late-start feed gate', () => {
  it('is ready with no seed and no replay, once the pin and the signature hold', () => {
    const gate = lateStartFeedReadiness(FEED_INPUTS);
    expect(gate.ready).toBe(true);
    expect(gate.reasons).toEqual([]);
  });

  it('ignores the seed-shaped refusals but not the identity ones', () => {
    // `seed_required` is exactly the reason a late start exists to drop; it says
    // nothing about whether the price we are reading is genuine.
    const seedless = lateStartFeedReadiness({
      ...FEED_INPUTS,
      refereeFeedBlockers: ['seed_required', 'seed_wrong_room'],
    });
    expect(seedless.ready).toBe(true);

    // A referee that is not the pinned one is a different contest, seed or not.
    const impostor = lateStartFeedReadiness({ ...FEED_INPUTS, refereeDid: 'did:key:zImpostor' });
    expect(impostor.ready).toBe(false);
    expect(impostor.reasons.join(' ')).toContain('not the pinned one');

    const unsigned = lateStartFeedReadiness({
      ...FEED_INPUTS,
      refereeFeedBlockers: ['referee_signature_invalid'],
    });
    expect(unsigned.ready).toBe(false);
    expect(unsigned.reasons.join(' ')).toContain('referee_signature_invalid');
  });

  it('is not ready without the launch pin, and never falls back to first-sender', () => {
    const unpinned = lateStartFeedReadiness({ ...FEED_INPUTS, launchPinVerified: false });
    expect(unpinned.ready).toBe(false);
    expect(unpinned.reasons.join(' ')).toContain('EXPECTED_REFEREE_DID');

    const noReferee = lateStartFeedReadiness({
      ...FEED_INPUTS,
      refereeDid: null,
      refereeSeen: false,
    });
    expect(noReferee.ready).toBe(false);
  });

  it('is not ready before the mode is armed', () => {
    const off = lateStartFeedReadiness({ ...FEED_INPUTS, lateStartArmed: false });
    expect(off.ready).toBe(false);
    expect(off.reasons[0]).toContain('not armed');
  });
});

describe('the current market snapshot', () => {
  it('is ready for a signed, labelled, current price post', () => {
    expect(marketSnapshotReadiness(SNAPSHOT_INPUTS).ready).toBe(true);
    // The widest tolerated gap is exactly two sweep periods.
    expect(
      marketSnapshotReadiness({ ...SNAPSHOT_INPUTS, secondsSinceLastPost: 600 }).ready,
    ).toBe(true);
  });

  it('refuses a band whose `for` is not the next sweep', () => {
    const wrong = marketSnapshotReadiness({ ...SNAPSHOT_INPUTS, limitsForSweep: 1760 });
    expect(wrong.ready).toBe(false);
    expect(wrong.reasons.join(' ')).toContain('not 1759');

    // A post with no `for` at all: recorded, never used to price a new trade.
    const missing = marketSnapshotReadiness({
      ...SNAPSHOT_INPUTS,
      limitsForSweep: null,
      limitsUsable: false,
    });
    expect(missing.ready).toBe(false);
    expect(missing.reasons.join(' ')).toContain('no `for` sweep');
  });

  it('refuses an unusable band', () => {
    const inverted = marketSnapshotReadiness({
      ...SNAPSHOT_INPUTS,
      limits: { low: '241.29', high: '218.31' },
    });
    expect(inverted.ready).toBe(false);
    expect(inverted.reasons.join(' ')).toContain('not usable');
  });

  it('refuses a stale post', () => {
    const stale = marketSnapshotReadiness({ ...SNAPSHOT_INPUTS, secondsSinceLastPost: 601 });
    expect(stale.ready).toBe(false);
    expect(stale.reasons.join(' ')).toContain('past the');
  });

  it('refuses a locked contest', () => {
    const locked = marketSnapshotReadiness({ ...SNAPSHOT_INPUTS, locked: true });
    expect(locked.ready).toBe(false);
    expect(locked.reasons.join(' ')).toContain('locked');
  });
});

// ---------------------------------------------------------------------------
// The wiring: registration, echo and the participation trade
// ---------------------------------------------------------------------------

/**
 * A harness in the late-start posture.
 *
 * `live` is the production shape — a pinned live process with the reader's own
 * continuous loops, which is what the seedless feed gate asks for. A live
 * process also requires the full 150-agent fleet, because the referee counts
 * owners; the unarmed case is exercised as a dry run instead, which is exactly
 * what a half-configured late start is supposed to be.
 */
async function buildLateStart(options: {
  agentCount?: number;
  trading?: boolean;
  strategy?: boolean;
  live?: boolean;
  startReader?: boolean;
  env?: Record<string, string>;
}): Promise<Harness> {
  const live = options.live !== false;
  const transport = new FakeTransport({ readDelayMs: 5 });
  const harness = await buildHarness({
    agentCount: options.agentCount ?? 150,
    transport,
    now: () => new Date(CLOCK),
    env: {
      ...(live ? LIVE_PINS : {}),
      FLOP_ALLOW_REGISTRATION: 'true',
      LATE_START_MODE: 'true',
      LATE_START_CONFIRM: LATE_START_CONFIRM_VALUE,
      FLOP_ALLOW_TRADING: options.trading === true ? 'true' : 'false',
      LATE_START_ALLOW_TRADING: options.trading === true ? 'true' : 'false',
      // The bootstrap strategy is a third, separate switch. Left off it changes
      // nothing: the profiles and the fallback behave exactly as before.
      LATE_START_ALLOW_STRATEGY_TRADING: options.strategy === true ? 'true' : 'false',
      LATE_START_STRATEGY_CONFIRM:
        options.strategy === true ? LATE_START_STRATEGY_CONFIRM_VALUE : '',
      // The per-minute write gate is production pacing. A test that posts 150
      // registrations plus 75 trades must not spend the whole window waiting.
      WRITE_RATE_PER_MINUTE: '100000',
      ...options.env,
    },
  });
  for (const room of HARNESS_ROOMS) transport.room(room);
  if (options.startReader !== false) harness.runtime.reader.startContinuous();
  return harness;
}

/** Wait until the continuous loops have read every room once. */
async function waitForFirstPass(harness: Harness): Promise<void> {
  await waitFor(
    () => harness.runtime.reader.readerStatus().completedReads >= HARNESS_ROOMS.length,
    'the continuous reader to complete a first pass over every room',
  );
}

/** Post a price the anchor can be taken from, and wait for the verifier to take it. */
async function primeMarket(harness: Harness, sweep = 1758): Promise<void> {
  harness.referee.price(sweep, '229.80', ['218.31', '241.29'], sweep + 1);
  await waitFor(
    () => harness.runtime.reader.verifier.state.currentSweep === sweep,
    `the price post for sweep ${sweep} to be verified`,
  );
}

function tradeMessages(harness: Harness): Array<Record<string, unknown>> {
  return harness.transport
    .postsFor('close1')
    .map((post) => JSON.parse(post.body.text ?? 'null') as Record<string, unknown>)
    .filter((message) => message?.t === 'trade');
}

describe('no seed, full participation', () => {
  let harness: Harness | null = null;

  afterEach(async () => {
    if (harness) await harness.dispose();
    harness = null;
  });

  it('registers all 150 owners, then writes one signed participation trade per agent', async () => {
    harness = await buildLateStart({ trading: true });
    const h = harness;
    await waitForFirstPass(h);
    await primeMarket(h);

    const firstTick = await h.runtime.scheduler.runTick();

    // No seed was ever read, and the process says so rather than pretending.
    expect(h.runtime.reader.seedVerified).toBe(false);
    expect(h.runtime.reader.historicalReplayUnavailable).toBe(true);
    expect(h.runtime.reader.historicalReplayComplete).toBe(false);

    // The room's echo arrives on a later read. `ownOwnerRegistrations()` is an
    // incremental scan — polling it would consume the echoes before the tick that
    // records them — so the stored messages are what is waited on instead.
    await waitFor(
      () => h.runtime.repositories.messages.byKind('close1', 'owner').length >= 150,
      'the room to echo all 150 registrations',
    );
    await h.runtime.scheduler.runTick();

    const rows = h.runtime.repositories.participation.all();
    expect(rows).toHaveLength(150);
    // Every DID distinct, and every registration is that DID's own.
    expect(new Set(rows.map((row) => row.did)).size).toBe(150);
    for (const row of rows) {
      expect(row.technocore_seq).not.toBeNull();
      expect(row.readback_at).not.toBeNull();
      expect(JSON.parse(row.registration_text)).toEqual({
        t: 'owner',
        season: 'close-1',
        key: row.did,
      });
      // The signature is over `<room>|<nonce>|<text>` and must actually verify.
      expect(
        verifyRoomSignatureForRoom(
          row.did,
          row.registration_nonce,
          row.registration_text,
          row.registration_signature,
          'close1',
        ),
      ).toBe(true);
    }

    // 150 owners in a fixed order are 75 pairs, formed before anything is posted.
    expect(firstTick.participationTrades.pairs).toBe(75);
    expect(firstTick.participationTrades.posted + firstTick.participationTrades.skipped).toBe(75);

    // Every agent ends the tick with a trade that reached the room.
    for (const agentId of h.runtime.keyStore.agentIds) {
      const did = h.runtime.keyStore.did(agentId);
      expect(h.runtime.repositories.trades.hasEffectiveTradeForDid(did)).toBe(true);
    }

    const messages = tradeMessages(h);
    expect(messages.length).toBeGreaterThanOrEqual(1);
    const limits = { low: Decimal.from('218.31'), high: Decimal.from('241.29') };
    for (const raw of messages) {
      const message = parseTradeMessage(JSON.stringify(raw));
      expect(message).not.toBeNull();
      if (message === null) continue;
      const { terms } = message;
      // The band's own midpoint, inside the band, at the rules' minimum size.
      expect(Decimal.from(terms.qty).gte('0.1')).toBe(true);
      expect(withinPublishedLimits(Decimal.from(terms.px), limits)).toBe(true);
      // `until` is the sweep the price post labelled, never a local horizon.
      expect(terms.until).toBe(1759);
      // A matched pair of our own keys, never an open offer to a stranger.
      expect(terms.taker).not.toBe('any');
      expect(terms.maker).not.toBe(terms.taker);
      expect(h.runtime.keyStore.didSet().has(terms.maker)).toBe(true);
      expect(message.taker).not.toBe(terms.maker);
      expect(h.runtime.keyStore.didSet().has(message.taker)).toBe(true);
      // Both signatures verify against the terms they cover.
      expect(verifyMakerSignature(terms, message.maker_sig)).toBe(true);
      expect(verifyTakerSignature(terms, message.taker, message.taker_sig)).toBe(true);
    }

    // Registration strictly precedes the trade on the room.
    const registrationSeqs = rows.map((row) => row.technocore_seq ?? 0);
    const tradeSeqs = h.runtime.repositories.trades
      .all()
      .map((row) => row.seq ?? 0)
      .filter((seq) => seq > 0);
    if (tradeSeqs.length > 0) {
      expect(Math.max(...registrationSeqs)).toBeLessThan(Math.min(...tradeSeqs));
    }

    // A later post for the next sweep must not make the fleet trade again: the
    // ledger, not a counter, is what makes the participation trade at-most-once.
    h.referee.price(1759, '230.00', ['218.50', '241.50'], 1760);
    await waitFor(() => h.runtime.reader.verifier.state.currentSweep === 1759, 'the next price');
    const secondTick = await h.runtime.scheduler.runTick();
    expect(secondTick.participationTrades.posted).toBe(0);
    // And no participation id was ever repeated on the room.
    const participationIds = h.runtime.repositories.trades
      .all()
      .map((row) => row.id)
      .filter((id) => id.startsWith('pl'));
    expect(new Set(participationIds).size).toBe(participationIds.length);
  }, 180_000);

  it('reports the mode, the layers and what it cannot claim', async () => {
    harness = await buildLateStart({ trading: true });
    const h = harness;
    await waitForFirstPass(h);
    await primeMarket(h);
    await h.runtime.scheduler.runTick();

    const status = h.runtime.scheduler.status();
    expect(status.operatingMode).toBe('late_start_full_participation');
    expect(status.lateStartMode).toBe(true);
    expect(status.launchPinVerified).toBe(true);
    expect(status.lateStartFeedReady).toBe(true);
    expect(status.marketSnapshotReady).toBe(true);
    expect(status.lateStartTradingReady).toBe(true);
    expect(status.tradeUntilSweep).toBe(1759);
    expect(Number(status.reference)).toBeCloseTo(229.8, 2);
    expect(Number(status.limits?.low)).toBeCloseTo(218.31, 2);
    expect(Number(status.limits?.high)).toBeCloseTo(241.29, 2);

    // The honest half: no replay is claimed, and the absence is named.
    expect(status.seedVerified).toBe(false);
    expect(status.seedSource).toBeNull();
    expect(status.historicalReplayComplete).toBe(false);
    expect(status.historicalReplayUnavailable).toBe(true);
    expect(status.lateStartAudit.historicalReplayComplete).toBe(false);
    expect(status.lateStartAudit.room).toBe('close1');

    // The registration layers are counted apart, and none is inferred.
    expect(status.registration.total).toBe(150);
    expect(status.registration.postAcked).toBe(150);
    // Minting has not been observed, and that is neither zero nor a failure.
    expect(status.registration.mintConfirmed).toBe(0);

    expect(status.trading.eligibleAgents).toBe(150);
    expect(status.trading.tradePosted).toBeGreaterThanOrEqual(1);
    // A room ack is not a settlement, and the two are never added together.
    expect(status.trading.tradeSettled).toBe(0);
    expect(status.trading.tradeUnknown).toBe(status.trading.tradePosted);

    // The field-acceptance report carries the same view.
    const report = h.runtime.scheduler.readerReport();
    expect(report.lateStart.mode).toBe(true);
    expect(report.lateStart.marketSnapshotReady).toBe(true);
    expect(report.lateStart.historicalReplayUnavailable).toBe(true);
    expect(report.lateStart.registration.total).toBe(150);
    expect(report.lateStart.trading.eligibleAgents).toBe(150);

    // Nothing secret may survive into the payload.
    expect(JSON.stringify(status)).not.toMatch(/AGE-SECRET-KEY|BEGIN [A-Z ]*PRIVATE KEY/);
  }, 180_000);

  it('refuses to trade when the price post does not label the next sweep', async () => {
    harness = await buildLateStart({ trading: true });
    const h = harness;
    await waitForFirstPass(h);

    // `for` names sweep 1760 while the post is for sweep 1758: the band we would
    // enforce is not the band the referee announced.
    h.referee.price(1758, '229.80', ['218.31', '241.29'], 1760);
    await waitFor(
      () => h.runtime.reader.verifier.state.limitsUsable === false,
      'the verifier to refuse the mislabelled band',
    );

    const status = h.runtime.scheduler.status();
    expect(status.marketSnapshotReady).toBe(false);
    expect(status.lateStartFeedReady).toBe(true);
    expect(status.lateStartTradingReady).toBe(false);

    const report = await h.runtime.scheduler.runTick();
    expect(report.participationTrades.posted).toBe(0);
    // Registration is not held by a price problem: only new trades are.
    await waitFor(
      () => h.runtime.repositories.participation.all().length === 150,
      'the 150 registrations',
    );
  }, 180_000);

  it('stops every new registration and trade once the lock has passed', async () => {
    harness = await buildLateStart({ trading: true });
    const h = harness;
    await waitForFirstPass(h);

    // The first sweep past `lock_sweep`: the contest is over, and nothing may be
    // written into it any more.
    h.referee.price(2557, '229.80', ['218.31', '241.29'], 2558);
    await waitFor(
      () => h.runtime.reader.verifier.state.currentSweep === 2557,
      'the post-lock price',
    );
    expect(h.runtime.reader.verifier.state.locked).toBe(true);

    const status = h.runtime.scheduler.status();
    expect(status.marketSnapshotReady).toBe(false);
    expect(status.lateStartTradingReady).toBe(false);

    const report = await h.runtime.scheduler.runTick();
    expect(report.participation.posted).toBe(0);
    expect(report.participationTrades.posted).toBe(0);
    expect(h.transport.postsFor('close1')).toHaveLength(0);
  }, 180_000);

  it('separates a confirmed mint from a sweep whose flow was omitted', async () => {
    harness = await buildLateStart({});
    const h = harness;
    await waitForFirstPass(h);

    // The referee posts first: a registration is only written once the pinned
    // referee has actually been heard from, not merely declared in the config.
    const dids = h.runtime.keyStore.agentIds.map((agentId) => h.runtime.keyStore.did(agentId));
    h.referee.price(1758, '229.80', ['218.31', '241.29'], 1759);
    h.referee.flow(1758, dids.slice(0, 3));
    await waitFor(() => h.runtime.scheduler.mintedDids().size >= 3, 'the flow mints to be read');

    await h.runtime.scheduler.runTick();
    await waitFor(
      () => h.runtime.repositories.messages.byKind('close1', 'owner').length >= 150,
      'the room to echo all 150 registrations',
    );
    await h.runtime.scheduler.runTick();

    // A flow naming our DIDs is the referee's own evidence, and it is recorded in
    // its own column — never inferred from the room's echo.
    let status = h.runtime.scheduler.status();
    expect(status.registration.mintConfirmed).toBeGreaterThanOrEqual(3);
    expect(status.registration.roomEchoConfirmed).toBe(150);
    for (const agentId of h.runtime.keyStore.agentIds.slice(0, 3)) {
      expect(h.runtime.repositories.participation.get(agentId)?.flow_evidence_at).not.toBeNull();
    }

    // A sweep that posted a price but no flow leaves its mints unknown, never
    // zero and never a failure: absence from a summary is not absence.
    h.referee.price(1760, '231.00', ['219.45', '242.55'], 1761);
    h.referee.price(1762, '231.00', ['219.45', '242.55'], 1763);
    await waitFor(
      () => h.runtime.reader.verifier.state.currentSweep === 1762,
      'the later price posts to be read',
    );
    expect(h.runtime.scheduler.sweepsWithMissingFlow()).toContain(1760);
    await h.runtime.scheduler.runTick();
    await h.runtime.scheduler.runTick();
    h.runtime.scheduler.reconcileMints();

    status = h.runtime.scheduler.status();
    expect(status.registration.mintUncertain).toBeGreaterThan(0);
    expect(status.registration.mintConfirmed).toBeGreaterThanOrEqual(3);
    expect(h.runtime.repositories.participation.countByStatus().failed ?? 0).toBe(0);
  }, 180_000);

  it('is a dry run that writes nothing when the confirmation is missing', async () => {
    harness = await buildLateStart({
      agentCount: 4,
      live: false,
      startReader: false,
      env: { LATE_START_CONFIRM: '' },
    });
    const h = harness;

    const status = h.runtime.scheduler.status();
    expect(status.lateStartMode).toBe(false);
    expect(status.operatingMode).toBe('dry_run');
    expect(status.lateStartBlockedReason).toContain(LATE_START_CONFIRM_VALUE);

    await h.runtime.scheduler.runTick();
    expect(h.transport.postsFor('close1')).toHaveLength(0);
  }, 120_000);
});

// ---------------------------------------------------------------------------
// Missed handling: a trade is re-issued, never re-sent
// ---------------------------------------------------------------------------

describe('a missed trade is re-issued under a new id', () => {
  let harness: Harness | null = null;

  afterEach(async () => {
    if (harness) await harness.dispose();
    harness = null;
  });

  it('sets the original aside and posts a fresh id for the same pair', async () => {
    // A live process must carry the full 150-agent fleet, because the referee
    // counts owners — so this exercises the re-issue on the real fleet.
    harness = await buildLateStart({ trading: true });
    const h = harness;
    await waitForFirstPass(h);
    await primeMarket(h);

    await h.runtime.scheduler.runTick();
    const first = h.runtime.repositories.trades.all();
    expect(first.length).toBeGreaterThanOrEqual(1);
    const original = first.find((row) => row.seq !== null && row.id.startsWith('pl'))!;
    expect(original).toBeDefined();
    await waitFor(
      () => h.runtime.repositories.messages.get('close1', original.seq!) !== undefined,
      'the trade message to be stored',
    );

    // The referee reports exactly that message as missed.
    h.referee.post('d-close1-flow', {
      t: 'flow',
      season: 'close-1',
      n: 1759,
      mints: [],
      missed: [{ room: 'close1', seq: original.seq, tid: original.id }],
      rooms: [],
    });
    await waitFor(
      () => h.runtime.repositories.refereeAnomalies.byKind('referee_missed').length > 0,
      'the missed anomaly to be recorded',
    );

    await h.runtime.scheduler.runTick();

    // The original is set aside, not re-posted: a trade id settles at most once.
    const reposts = h.runtime.repositories.reposts.all();
    expect(reposts).toHaveLength(1);
    expect(reposts[0]!.status).toBe('skipped');
    expect(reposts[0]!.reason).toBe('late_start_reissue_required');
    expect(h.runtime.repositories.trades.get(original.id)?.status).toBe('missed');
    // Nothing is left unresolved, so the gate stays open for the re-issue.
    expect(h.runtime.repositories.trades.hasUnresolvedMissed()).toBe(false);

    // A later tick re-issues the pair on a fresh id, and the original stays put.
    const beforeReissue = new Set(h.runtime.repositories.trades.all().map((row) => row.id));
    await h.runtime.scheduler.runTick();
    const after = h.runtime.repositories.trades.all();
    expect(after.map((row) => row.id)).toContain(original.id);
    const replacements = after.filter((row) => !beforeReissue.has(row.id));
    expect(replacements).toHaveLength(1);
    expect(replacements[0]!.status).toBe('pending');
    // The replacement is a different trade id for the same pair.
    expect(replacements[0]!.id).not.toBe(original.id);
    expect(replacements[0]!.maker_did).toBe(original.maker_did);
    expect(replacements[0]!.taker_did).toBe(original.taker_did);
  }, 180_000);
});

// ---------------------------------------------------------------------------
// The wall-clock lock: the one lock no feed can reopen
// ---------------------------------------------------------------------------

describe('the wall-clock lock', () => {
  const rules = loadRules(loadConfig({}));

  it('is open strictly before lockAt and closed at or after it', () => {
    expect(lockState(new Date('2026-10-04T08:59:59.999Z'), rules).beforeLock).toBe(true);
    const closed = lockState(new Date('2026-10-04T09:00:00.000Z'), rules);
    expect(closed.valid).toBe(true);
    expect(closed.beforeLock).toBe(false);
    expect(closed.locked).toBe(true);
    expect(closed.reason).toBe(WALL_CLOCK_LOCKED_REASON);
  });

  it('fails closed on an unparsable lockAt', () => {
    const broken = lockState(new Date('2026-09-25T12:00:00Z'), {
      ...rules,
      lockAt: 'not-a-time',
    });
    expect(broken.valid).toBe(false);
    expect(broken.beforeLock).toBe(false);
    expect(broken.locked).toBe(true);
    expect(broken.reason).toBe(WALL_CLOCK_INVALID_REASON);
  });

  it('reads a zone-less lockAt as UTC rather than the host locale', () => {
    const bare = { ...rules, lockAt: '2026-10-04T09:00:00' };
    // One millisecond before the UTC lock is still open. Parsing the bare form as
    // local time would have moved the boundary by the host's offset.
    expect(lockState(new Date('2026-10-04T08:59:59.999Z'), bare).beforeLock).toBe(true);
    expect(lockState(new Date('2026-10-04T09:00:00.000Z'), bare).beforeLock).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// The trading gate: registration first, and the wall clock over everything
// ---------------------------------------------------------------------------

const TRADING_GATE_BASE = {
  lateStartFeed: { ready: true, reasons: [] },
  tradingArmed: true,
  marketSnapshot: { ready: true, reasons: [] },
  currentMarketUsable: true,
  currentMarketBlockedReason: null,
  registrationReady: true,
  registrationPostAcked: 150,
  registrationExpected: 150,
  registrationPending: 0,
  registrationFailed: 0,
  registrationUnresolvedMissed: false,
  wallClockBeforeLock: true,
  wallClockLockValid: true,
  loadAllowsNewOffer: true,
  writerHealthy: true,
  nonceStoreUsable: true,
  packageDrift: false,
  fleetComplete: true,
  localTradeUnresolved: false,
  localMessageInGap: false,
};

describe('the trading gate requires registration and the wall clock', () => {
  it('is ready only when every clause holds', () => {
    expect(lateStartTradingReadiness(TRADING_GATE_BASE).ready).toBe(true);
  });

  it('refuses a trade while registration is incomplete, naming the count', () => {
    const gate = lateStartTradingReadiness({
      ...TRADING_GATE_BASE,
      registrationReady: false,
      registrationPostAcked: 137,
      registrationPending: 13,
    });
    expect(gate.ready).toBe(false);
    expect(gate.reasons.join(' ')).toContain('137/150 owner messages acknowledged');
  });

  it('refuses a trade with an unresolved owner re-post', () => {
    const gate = lateStartTradingReadiness({
      ...TRADING_GATE_BASE,
      registrationReady: false,
      registrationUnresolvedMissed: true,
    });
    expect(gate.reasons.join(' ')).toContain('unresolved missed messages');
  });

  it('never requires a mint: an omitted flow leaves the gate open', () => {
    // `registrationReady` is a fact about the register, not about the referee's
    // flow. A sweep whose mints the referee omitted must not become a refusal.
    expect(lateStartTradingReadiness(TRADING_GATE_BASE).ready).toBe(true);
  });

  it('refuses a trade past the wall clock even when the feed looks open', () => {
    const gate = lateStartTradingReadiness({
      ...TRADING_GATE_BASE,
      wallClockBeforeLock: false,
      wallClockLockValid: true,
    });
    expect(gate.ready).toBe(false);
    expect(gate.reasons.join(' ')).toContain(WALL_CLOCK_LOCKED_REASON);
  });

  it('fails closed when the wall clock cannot be read', () => {
    const gate = lateStartTradingReadiness({
      ...TRADING_GATE_BASE,
      wallClockBeforeLock: false,
      wallClockLockValid: false,
    });
    expect(gate.reasons.join(' ')).toContain(WALL_CLOCK_INVALID_REASON);
  });

  it('does not read the public room\'s coverage at all: an unattainable close1 is not a trade refusal', () => {
    // Which clauses this gate is allowed to read is the contract. A late start
    // does not trade on `close1`; it trades on the pinned referee's own signed
    // price post, and the five referee rooms are held to the feed gate above.
    // `close1`'s cursor gap is an audit fact about what we managed to *read*, so
    // it must not be able to veto a trade priced from a post we did read. The
    // strict gate still refuses on it — that is what makes it an audit answer —
    // and this pins that the two do not drift into each other.
    const inputKeys = Object.keys(TRADING_GATE_BASE);
    for (const coverageKey of [
      'close1FullyCaughtUp',
      'close1Unattainable',
      'close1NetPersistBacklogRate',
      'tradingRoomUnattainable',
      'unresolvedGap',
    ]) {
      expect(inputKeys).not.toContain(coverageKey);
    }
    expect(lateStartTradingReadiness(TRADING_GATE_BASE).ready).toBe(true);
  });
});

describe('the registration gate obeys the wall clock', () => {
  const registrationInputs = {
    lateStartArmed: true,
    readerContinuous: true,
    readerRunning: true,
    refereeRoomCount: 5,
    expectedRefereeRoomCount: 5,
    refereeRoomsWithUnresolvedGap: [] as string[],
    refereeRoomsReset: [] as string[],
    launchPinVerified: true,
    refereeDid: HARNESS_REFEREE_DID,
    expectedRefereeDid: HARNESS_REFEREE_DID,
    refereeFeedBlockers: [] as string[],
    refereeSeen: true,
    allowRegistration: true,
    fleetComplete: true,
    writerHealthy: true,
    nonceStoreUsable: true,
  };

  it('holds every registration back once the wall clock has passed', () => {
    const gate = lateStartRegistrationReadiness({
      ...registrationInputs,
      lockBefore: false,
      lockValid: true,
    });
    expect(gate.ready).toBe(false);
    expect(gate.reasons.join(' ')).toContain(WALL_CLOCK_LOCKED_REASON);
  });

  it('fails closed when the wall clock cannot be read', () => {
    const gate = lateStartRegistrationReadiness({
      ...registrationInputs,
      lockBefore: false,
      lockValid: false,
    });
    expect(gate.ready).toBe(false);
    expect(gate.reasons.join(' ')).toContain(WALL_CLOCK_INVALID_REASON);
  });

  it('is ready before the lock with the pin, the feed and the write lane', () => {
    const gate = lateStartRegistrationReadiness({
      ...registrationInputs,
      lockBefore: true,
      lockValid: true,
    });
    expect(gate.ready).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// The wiring: registration before trade, and the wall clock on every path
// ---------------------------------------------------------------------------

/**
 * A price series whose last step is a spike.
 *
 * `contrarian` needs only a short history, and its `no_overreaction` rule fires
 * on a move past 1.5% while the six-sweep slope stays under 0.4% — so a gentle
 * decline ending in a +2% jump is a proposal the deterministic gate turns into a
 * real maker offer. The bands are ±5% of each close, wide enough that the final
 * spike is still inside the band it was published with.
 */
async function primeContrarian(harness: Harness): Promise<void> {
  const series: Array<[number, string]> = [
    [1753, '231.00'],
    [1754, '230.60'],
    [1755, '230.20'],
    [1756, '229.80'],
    [1757, '229.40'],
    [1758, '234.40'],
  ];
  for (const [sweep, px] of series) {
    const centre = Number.parseFloat(px);
    harness.referee.price(sweep, px, [
      (centre * 0.95).toFixed(2),
      (centre * 1.05).toFixed(2),
    ], sweep + 1);
  }
  await waitFor(
    () => harness.runtime.reader.verifier.state.currentSweep === 1758,
    'the contrarian price series to be verified',
  );
}

/** A price post at `sweep`, labelled for the next one, delayed not at all. */
async function primeAt(harness: Harness, sweep: number, px: string): Promise<void> {
  const centre = Number.parseFloat(px);
  harness.referee.price(sweep, px, [
    (centre * 0.95).toFixed(2),
    (centre * 1.05).toFixed(2),
  ], sweep + 1);
  await waitFor(
    () => harness.runtime.reader.verifier.state.currentSweep === sweep,
    `the price post for sweep ${sweep} to be verified`,
  );
}

describe('a trade may not precede its owner registration', () => {
  let harness: Harness | null = null;

  afterEach(async () => {
    if (harness) await harness.dispose();
    harness = null;
  });

  /**
   * A room that refuses every `close1` POST.
   *
   * Live requires the registration switch to be on, so the only way to reach
   * "trading armed, an owner with no seq" is a service that will not take the
   * registration. `maxCopies: 0` refuses every text at or above the floor, which
   * is exactly a room refusing our owner messages; the referee's own posts do not
   * go through POST and are unaffected.
   */
  function refuseEveryPost(h: Harness): void {
    h.transport.setDupeFilter('close1', 1, 0, 3600);
  }

  it('refuses a strategy trade while the owner has no posted registration', async () => {
    harness = await buildLateStart({
      trading: true,
      strategy: true,
      env: { AGENTS_PER_TICK: '30' },
    });
    const h = harness;
    await waitForFirstPass(h);
    refuseEveryPost(h);
    await primeContrarian(h);

    await h.runtime.scheduler.runTick();

    const refused = h.runtime.repositories.trades
      .all()
      .filter((row) => row.reason === 'owner_registration_not_posted');
    expect(refused.length).toBeGreaterThan(0);
    expect(refused.every((row) => row.status === 'refused')).toBe(true);
    // The refusal is before the POST, so no trade reached the room at all.
    expect(tradeMessages(h)).toHaveLength(0);
  }, 180_000);

  it('names registration rather than falling back to a generic readiness refusal', async () => {
    harness = await buildLateStart({ trading: true, env: { AGENTS_PER_TICK: '30' } });
    const h = harness;
    await waitForFirstPass(h);
    refuseEveryPost(h);
    await primeContrarian(h);
    await h.runtime.scheduler.runTick();

    const status = h.runtime.scheduler.status();
    // Registration is checked *before* the aggregate gate, so the operator is
    // told which fact is missing rather than the generic "not trading ready".
    expect(status.registrationReady).toBe(false);
    expect(status.registrationPostAcked).toBe(0);
    expect(status.lateStartTradingReady).toBe(false);
    expect(
      h.runtime.repositories.trades.all().some((row) => row.reason === 'not_trading_ready'),
    ).toBe(false);
  }, 180_000);
});

describe('the participation fallback waits for all 150 owners', () => {
  let harness: Harness | null = null;

  afterEach(async () => {
    if (harness) await harness.dispose();
    harness = null;
  });

  it('writes no trade while one owner is still unacknowledged', async () => {
    harness = await buildLateStart({ trading: true });
    const h = harness;
    await waitForFirstPass(h);

    // The room refuses a second copy of a text, so a re-post of one owner's
    // registration is a permanent refusal — which is exactly "one owner never
    // got a seq" without touching the fleet's shape.
    h.transport.setDupeFilter('close1', 1, 1, 3600);

    // A price whose `for` names the wrong sweep: the feed exists, so the
    // registration gate is satisfied, but the band may not price a trade — which
    // holds the fallback off while the 150 registrations go in.
    h.referee.price(1757, '229.80', ['218.31', '241.29'], 1760);
    await waitFor(
      () => h.runtime.reader.verifier.state.currentSweep === 1757,
      'the mislabelled price post',
    );

    // Tick 1: 150 registrations posted; the fallback is held by the unusable band.
    await h.runtime.scheduler.runTick();
    await waitFor(
      () => h.runtime.repositories.messages.byKind('close1', 'owner').length >= 150,
      'the room to echo all 150 registrations',
    );
    // Tick 2: the echoes are recorded, and every row now carries a readback.
    await h.runtime.scheduler.runTick();
    expect(h.runtime.repositories.participation.readbackProgress().completed).toBe(150);

    // Remove the room's acknowledgement from one owner's row, as a lost POST
    // reply would. Its next attempt is refused, so it never gets a seq back.
    const victim = [...h.runtime.keyStore.agentIds].sort()[0]!;
    const victimDid = h.runtime.keyStore.did(victim);
    const victimRow = h.runtime.repositories.participation.get(victim)!;
    h.runtime.repositories.participation.upsert({
      ...victimRow,
      technocore_seq: null,
      technocore_ts: null,
      readback_at: null,
      status: 'created',
      last_error: null,
    });

    // Now a usable market: the fallback has everything except the last owner.
    await primeAt(h, 1758, '229.80');

    const report = await h.runtime.scheduler.runTick();
    expect(report.participationTrades.posted).toBe(0);

    const status = h.runtime.scheduler.status();
    expect(status.registrationPostAcked).toBe(149);
    expect(status.registrationExpected).toBe(150);
    expect(status.registrationReady).toBe(false);
    expect(status.lateStartTradingReady).toBe(false);
    expect(status.participationTradesPosted).toBe(0);
    expect(tradeMessages(h)).toHaveLength(0);
    expect(h.runtime.repositories.participation.get(victim)?.technocore_seq).toBeNull();
    expect(h.runtime.keyStore.didSet().has(victimDid)).toBe(true);
  }, 240_000);
});

describe('150 owners complete, 75 pairs trade', () => {
  let harness: Harness | null = null;

  afterEach(async () => {
    if (harness) await harness.dispose();
    harness = null;
  });

  it('covers every owner, once, with the registration before the trade', async () => {
    harness = await buildLateStart({ trading: true });
    const h = harness;
    await waitForFirstPass(h);
    await primeAt(h, 1758, '229.80');

    await h.runtime.scheduler.runTick();
    await waitFor(
      () => h.runtime.repositories.messages.byKind('close1', 'owner').length >= 150,
      'the room to echo all 150 registrations',
    );
    await h.runtime.scheduler.runTick();

    const status = h.runtime.scheduler.status();
    expect(status.registrationReady).toBe(true);
    expect(status.registrationPostAcked).toBe(150);
    expect(status.participationTradesExpected).toBe(75);
    expect(status.participationTradesPosted).toBe(75);
    expect(status.participationAgentsCovered).toBe(150);

    const participation = h.runtime.repositories.trades
      .all()
      .filter((row) => row.id.startsWith('pl'));
    expect(participation).toHaveLength(75);
    expect(new Set(participation.map((row) => row.id)).size).toBe(75);

    const ownerSeqs = new Map<string, number>();
    for (const row of h.runtime.repositories.participation.all()) {
      if (row.did !== null && row.technocore_seq !== null) {
        ownerSeqs.set(row.did, row.technocore_seq);
      }
    }
    const covered = new Set<string>();
    for (const row of participation) {
      const maker = row.maker_did;
      const taker = row.taker_did;
      const seq = row.seq;
      if (maker === null || taker === null) {
        throw new Error(`participation trade ${row.id} has no counterparty`);
      }
      if (typeof seq !== 'number') {
        throw new Error(`participation trade ${row.id} was never acknowledged`);
      }
      expect(maker).not.toBe(taker);
      covered.add(maker);
      covered.add(taker);
      // The room's own order: both owners were acknowledged before the trade.
      const makerSeq = ownerSeqs.get(maker);
      const takerSeq = ownerSeqs.get(taker);
      if (makerSeq === undefined || takerSeq === undefined) {
        throw new Error(`participation trade ${row.id} names an owner with no registration`);
      }
      expect(makerSeq).toBeLessThan(seq);
      expect(takerSeq).toBeLessThan(seq);
    }
    expect(covered.size).toBe(150);
  }, 240_000);
});

describe('the wall clock closes every write path', () => {
  let harness: Harness | null = null;

  afterEach(async () => {
    if (harness) await harness.dispose();
    harness = null;
  });

  /** Move the injected clock past `lockAt` (2026-10-04T09:00:00Z). */
  function pastTheLock(h: Harness): void {
    const lock = Date.parse('2026-10-04T09:00:00Z');
    h.advance(lock - Date.parse(CLOCK) + 1000);
  }

  it('blocks trades and re-posts even while the sweep still says the contest is open', async () => {
    harness = await buildLateStart({ trading: true });
    const h = harness;
    await waitForFirstPass(h);
    // `lock_sweep` is 2556, so 2555 is the last sweep before the referee's own
    // lock — the feed alone would still say the contest is open.
    await primeAt(h, 2555, '229.80');
    pastTheLock(h);

    const status = h.runtime.scheduler.status();
    expect(status.lockedByReferee).toBe(false);
    expect(status.wallClockBeforeLock).toBe(false);
    expect(status.lockedByWallClock).toBe(true);
    expect(status.lateStartTradingReady).toBe(false);
    expect(status.tradeBlockedReason).toBe('locked_by_wall_clock');

    const report = await h.runtime.scheduler.runTick();
    expect(report.participationTrades.posted).toBe(0);
    expect(tradeMessages(h)).toHaveLength(0);

    // A queued re-post is terminal, and says by which lock.
    const firstAgent = [...h.runtime.keyStore.agentIds].sort()[0]!;
    const firstDid = h.runtime.keyStore.did(firstAgent);
    h.runtime.repositories.reposts.enqueue({
      original_room: 'close1',
      original_seq: 1,
      agent_id: firstAgent,
      did: firstDid,
      message_kind: 'owner',
      trade_id: null,
      original_text: '{"t":"owner","season":"close-1","key":"did:key:zFixture"}',
      reason: 'referee_missed',
    });
    const repost = await h.runtime.scheduler.reconcileReposts();
    expect(repost.posted).toBe(0);
    const queued = h.runtime.repositories.reposts.all();
    expect(queued[0]!.status).toBe('skipped');
    expect(queued[0]!.reason).toBe('locked_by_wall_clock');
  }, 180_000);

  it('fails closed with no sweep at all: past the lock, nothing is written', async () => {
    harness = await buildLateStart({ trading: true });
    const h = harness;
    await waitForFirstPass(h);
    pastTheLock(h);

    // No price was ever accepted, so the referee feed has no sweep — the state a
    // silent referee leaves behind. The wall clock is the only thing left.
    const status = h.runtime.scheduler.status();
    expect(status.sweep).toBeNull();
    expect(status.lockedByReferee).toBe(false);
    expect(status.wallClockBeforeLock).toBe(false);
    expect(status.lockedByWallClock).toBe(true);
    expect(status.tradeBlockedReason).toBe('locked_by_wall_clock');

    const report = await h.runtime.scheduler.runTick();
    expect(report.participation.posted).toBe(0);
    expect(report.participationTrades.posted).toBe(0);
    expect(h.transport.postsFor('close1')).toHaveLength(0);
  }, 180_000);
});

describe('kill-9 recovery', () => {
  let first: Harness | undefined;
  let second: Harness | undefined;

  afterEach(async () => {
    if (second) await second.dispose();
    second = undefined;
    try {
      await first?.runtime.db.close();
    } catch {
      /* already closed */
    }
    first = undefined;
  });

  it('keeps the registrations and the trades, and duplicates neither', async () => {
    const dir = tempDir('flop-late-kill-');
    const transport = new FakeTransport({ readDelayMs: 5 });
    const env = {
      ...LIVE_PINS,
      FLOP_ALLOW_REGISTRATION: 'true',
      LATE_START_MODE: 'true',
      LATE_START_CONFIRM: LATE_START_CONFIRM_VALUE,
      FLOP_ALLOW_TRADING: 'true',
      LATE_START_ALLOW_TRADING: 'true',
      WRITE_RATE_PER_MINUTE: '100000',
    };
    for (const room of HARNESS_ROOMS) transport.room(room);

    first = await buildHarness({ agentCount: 150, dir, transport, now: () => new Date(CLOCK), env });
    first.runtime.reader.startContinuous();
    await waitForFirstPass(first);
    await primeAt(first, 1758, '229.80');
    await first.runtime.scheduler.runTick();
    await waitFor(
      () => first!.runtime.repositories.messages.byKind('close1', 'owner').length >= 150,
      'the room to echo all 150 registrations',
    );
    await first.runtime.scheduler.runTick();

    const ownerPostsBefore = transport.postsFor('close1').filter((post) => {
      const text = post.body.text ?? '';
      return text.includes('"t":"owner"');
    }).length;
    expect(ownerPostsBefore).toBe(150);
    const ownerSeqsBefore = new Map(
      first.runtime.repositories.participation.all().map((row) => [row.agent_id, row.technocore_seq]),
    );
    const tradeIdsBefore = new Set(
      first.runtime.repositories.trades.all().map((row) => row.id),
    );
    const participationBefore = first.runtime.repositories.trades.participationCoverage();
    expect(participationBefore.posted).toBe(75);

    // A queued re-post that has not been attempted yet. It must survive the kill
    // and be drained by the next process, with a fresh nonce, rather than being
    // lost with the process that queued it.
    const queued = [...first.runtime.keyStore.agentIds].sort()[1]!;
    first.runtime.repositories.reposts.enqueue({
      original_room: 'close1',
      original_seq: 1,
      agent_id: queued,
      did: first.runtime.keyStore.did(queued),
      message_kind: 'trade',
      trade_id: null,
      original_text: '{"t":"trade-fixture","id":"tq1"}',
      reason: 'referee_missed',
    });

    // SIGKILL: the reader loops stop where they are and the process is gone. No
    // stop, no checkpoint of the scheduler, no flush of anything in memory.
    await first.runtime.reader.stopContinuous();

    second = await buildHarness({ agentCount: 150, dir, transport, now: () => new Date(CLOCK), env });
    second.runtime.reader.startContinuous();
    await waitForFirstPass(second);
    await second.runtime.scheduler.runTick();

    // Nothing was re-posted: the second process re-derived all of it from SQLite.
    const ownerPostsAfter = transport.postsFor('close1').filter((post) => {
      const text = post.body.text ?? '';
      return text.includes('"t":"owner"');
    }).length;
    expect(ownerPostsAfter).toBe(150);
    const ownerSeqsAfter = new Map(
      second.runtime.repositories.participation.all().map((row) => [row.agent_id, row.technocore_seq]),
    );
    expect(ownerSeqsAfter).toEqual(ownerSeqsBefore);

    const tradeIdsAfter = new Set(second.runtime.repositories.trades.all().map((row) => row.id));
    expect(tradeIdsAfter).toEqual(tradeIdsBefore);

    // The queued re-post survived the kill and was drained here, under the same
    // row but a nonce this process chose.
    const drained = second.runtime.repositories.reposts.all();
    expect(drained).toHaveLength(1);
    expect(drained[0]!.status).toBe('posted');
    expect(drained[0]!.new_nonce).not.toBeNull();

    const status = second.runtime.scheduler.status();
    expect(status.participationTradesPosted).toBe(75);
    expect(status.participationAgentsCovered).toBe(150);
    expect(status.registrationPostAcked).toBe(150);
    expect(status.registrationReady).toBe(true);
  }, 300_000);
});

// ---------------------------------------------------------------------------
// An omitted mint list is uncertainty, never confirmation
// ---------------------------------------------------------------------------

describe('an omitted mint list is uncertainty, never confirmation', () => {
  let harness: Harness | null = null;

  afterEach(async () => {
    if (harness) await harness.dispose();
    harness = null;
  });

  it('leaves the owners unconfirmed and unsettled when the referee omits the mints', async () => {
    harness = await buildLateStart({ trading: true });
    const h = harness;
    await waitForFirstPass(h);
    await primeAt(h, 1758, '229.80');
    await h.runtime.scheduler.runTick();
    await waitFor(
      () => h.runtime.repositories.messages.byKind('close1', 'owner').length >= 150,
      'the room to echo all 150 registrations',
    );
    await h.runtime.scheduler.runTick();

    const before = h.runtime.scheduler.status();
    expect(before.registration.postAcked).toBe(150);
    expect(before.registration.mintConfirmed).toBe(0);

    // A flow that names no mints but reports 150 omitted entries: a truncation,
    // not an absence. The reader records the omission; nothing turns the empty
    // list into evidence that the referee declined to mint.
    h.referee.post('d-close1-flow', {
      t: 'flow',
      season: 'close-1',
      n: 1759,
      mints: [],
      omitted: { mints: 150 },
      rooms: [],
    });
    await waitFor(
      () => h.runtime.repositories.refereeAnomalies.byKind('referee_omitted').length > 0,
      'the omitted-mints anomaly to be recorded',
    );
    await h.runtime.scheduler.runTick();

    const after = h.runtime.scheduler.status();
    // A POST the service acknowledged is not a mint, and an omitted list is not
    // evidence of one either.
    expect(after.registration.postAcked).toBe(150);
    expect(after.registration.mintConfirmed).toBe(0);
    // The uncertainty is maintained rather than resolved in either direction.
    expect(after.registration.mintUncertain).toBe(before.registration.mintUncertain);
    // Never turned into a failure, and never into a settled trade.
    expect(h.runtime.repositories.participation.countByStatus().failed ?? 0).toBe(0);
    expect(after.trading.tradeSettled).toBe(0);
    expect(after.trading.tradeUnknown).toBe(after.trading.tradePosted);
    for (const row of h.runtime.repositories.participation.all()) {
      expect(row.flow_evidence_at).toBeNull();
    }

    // The omission itself is recorded, so a report can show what the referee
    // truncated instead of an unexplained zero.
    const omitted = h.runtime.repositories.refereeAnomalies.byKind('referee_omitted');
    expect(omitted.length).toBeGreaterThan(0);
    expect(omitted.some((row) => (row.raw_payload ?? '').includes('150'))).toBe(true);
  }, 240_000);
});

// ---------------------------------------------------------------------------
// The bootstrap decision, read on its own
// ---------------------------------------------------------------------------

const BOOTSTRAP_RULES = referenceRules();

/** A market the current price post *can* price a trade from. */
function bootstrapMarket(
  overrides: Partial<MarketSnapshot> = {},
): MarketSnapshot {
  return {
    ...emptySnapshot(),
    sweep: 1758,
    close: Decimal.from('229.80'),
    reference: Decimal.from('229.80'),
    limits: { low: Decimal.from('218.31'), high: Decimal.from('241.29') },
    nextLimits: { low: Decimal.from('218.31'), high: Decimal.from('241.29') },
    limitsForSweep: 1759,
    limitsUsable: true,
    // Two accepted closes, the fewest a direction exists from.
    history: [Decimal.from('229.40'), Decimal.from('229.80')],
    degraded: false,
    degradedReason: null,
    refereeDid: HARNESS_REFEREE_DID,
    ...overrides,
  };
}

function bootstrapContext(overrides: Partial<StrategyContext> = {}): StrategyContext {
  return {
    agentId: 'agent-0001',
    group: 'trend_following',
    sweep: 1758,
    market: bootstrapMarket(),
    caps: DEFAULT_RISK_CAPS.trend_following!,
    params: asDecimals(fallbackParams('trend_following').values),
    position: Decimal.zero(),
    cash: BOOTSTRAP_RULES.mint,
    openNotional: Decimal.zero(),
    lastTradeSweep: null,
    randomSeed: 1,
    sameDirectionStreak: 0,
    externalOffers: [],
    ...overrides,
  };
}

const BOOTSTRAP_ARMED = { enabled: true, rules: BOOTSTRAP_RULES } as const;
const BOOTSTRAP_OFF = { enabled: false, rules: BOOTSTRAP_RULES } as const;

describe('the late-start bootstrap decision', () => {
  it('declines while its own switch is off, and says so rather than staying silent', () => {
    const context = bootstrapContext();
    const proposal = lateStartBootstrapProposal(context, BOOTSTRAP_OFF);
    expect(proposal.intent).toBe('NO_TRADE');
    expect(proposal.reason).toBe('late_start_strategy_disabled');
  });

  it('needs two accepted closes before it will read a direction', () => {
    const context = bootstrapContext({
      market: bootstrapMarket({ history: [Decimal.from('229.80')] }),
    });
    const proposal = lateStartBootstrapProposal(context, BOOTSTRAP_ARMED);
    expect(proposal.intent).toBe('NO_TRADE');
    expect(proposal.reason).toBe('late_start_insufficient_observations');
    expect(LATE_START_OBSERVATIONS_REQUIRED).toBe(2);
  });

  it('reads a move no larger than one price step as flat, not as a trend', () => {
    const step = BOOTSTRAP_RULES.priceStep;
    expect(lateStartSignal(Decimal.from('229.81'), Decimal.from('229.80'), step)).toBe('flat');
    expect(lateStartSignal(Decimal.from('229.80'), Decimal.from('229.80'), step)).toBe('flat');
    // One cent more and it is a real move; the threshold is the market's own.
    expect(lateStartSignal(Decimal.from('229.82'), Decimal.from('229.80'), step)).toBe('rising');
    expect(lateStartSignal(Decimal.from('229.78'), Decimal.from('229.80'), step)).toBe('falling');
  });

  it('declines on a flat market with its own reason', () => {
    const context = bootstrapContext({
      market: bootstrapMarket({
        history: [Decimal.from('229.80'), Decimal.from('229.80')],
      }),
    });
    const proposal = lateStartBootstrapProposal(context, BOOTSTRAP_ARMED);
    expect(proposal.intent).toBe('NO_TRADE');
    expect(proposal.reason).toBe('late_start_flat');
  });

  it('buys the smallest allowed size when the latest close is above the last', () => {
    const context = bootstrapContext();
    const action = gateDecision({
      proposal: lateStartBootstrapProposal(context, BOOTSTRAP_ARMED),
      context,
      rules: BOOTSTRAP_RULES,
    });
    expect(action.gate).toBe('ok');
    expect(action.intent).toBe('MAKE_OFFER');
    expect(action.side).toBe('buy');
    expect(action.reason).toBe('late_start_price_rising');
    // The rules' own minimum, never a position.
    expect(action.qty!.eq(BOOTSTRAP_RULES.minQty)).toBe(true);
    expect(action.qty!.gte(BOOTSTRAP_RULES.minQty)).toBe(true);
    // Priced inside the band the referee published for this very sweep.
    expect(withinPublishedLimits(action.px!, context.market.limits!)).toBe(true);
  });

  it('sells the smallest allowed size when the latest close is below the last', () => {
    const context = bootstrapContext({
      market: bootstrapMarket({
        history: [Decimal.from('229.80'), Decimal.from('229.40')],
      }),
    });
    const action = gateDecision({
      proposal: lateStartBootstrapProposal(context, BOOTSTRAP_ARMED),
      context,
      rules: BOOTSTRAP_RULES,
    });
    expect(action.gate).toBe('ok');
    expect(action.side).toBe('sell');
    expect(action.reason).toBe('late_start_price_falling');
    expect(action.qty!.gte(BOOTSTRAP_RULES.minQty)).toBe(true);
  });

  it('declines whenever the current post cannot price a trade, naming that', () => {
    const unusable: Array<Partial<MarketSnapshot>> = [
      { locked: true },
      { degraded: true, degradedReason: 'reference_jump' },
      { staleReference: true },
      { reference: null },
      { limits: null },
      { limitsUsable: false },
      { limitsForSweep: null },
      { limitsForSweep: 1760 },
    ];
    for (const override of unusable) {
      const context = bootstrapContext({ market: bootstrapMarket(override) });
      const proposal = lateStartBootstrapProposal(context, BOOTSTRAP_ARMED);
      expect(proposal.intent).toBe('NO_TRADE');
      expect(proposal.reason).toBe('late_start_market_unusable');
    }
  });
});

// ---------------------------------------------------------------------------
// The bootstrap strategy at the write path
// ---------------------------------------------------------------------------

/** A price series whose final step rises, i.e. a bootstrap BUY. */
async function primeRising(h: Harness): Promise<void> {
  const series: Array<[number, string]> = [
    [1753, '228.20'],
    [1754, '228.60'],
    [1755, '229.00'],
    [1756, '229.40'],
    [1757, '229.60'],
    [1758, '232.00'],
  ];
  for (const [sweep, px] of series) {
    const centre = Number.parseFloat(px);
    h.referee.price(sweep, px, [(centre * 0.95).toFixed(2), (centre * 1.05).toFixed(2)], sweep + 1);
  }
  await waitFor(
    () => h.runtime.reader.verifier.state.currentSweep === 1758,
    'the rising price series to be verified',
  );
}

/** The same shape, ending lower: a bootstrap SELL. */
async function primeFalling(h: Harness): Promise<void> {
  const series: Array<[number, string]> = [
    [1753, '227.60'],
    [1754, '228.00'],
    [1755, '228.40'],
    [1756, '228.80'],
    [1757, '229.20'],
    [1758, '226.40'],
  ];
  for (const [sweep, px] of series) {
    const centre = Number.parseFloat(px);
    h.referee.price(sweep, px, [(centre * 0.95).toFixed(2), (centre * 1.05).toFixed(2)], sweep + 1);
  }
  await waitFor(
    () => h.runtime.reader.verifier.state.currentSweep === 1758,
    'the falling price series to be verified',
  );
}

/** Wait until the room has echoed all 150 owner registrations. */
async function waitForRegistrations(h: Harness): Promise<void> {
  await waitFor(
    () => h.runtime.repositories.messages.byKind('close1', 'owner').length >= 150,
    'the room to echo all 150 registrations',
  );
}

/** Every trade row written by one source, whatever its status. */
function rowsFrom(h: Harness, source: string) {
  return h.runtime.repositories.trades.all().filter((row) => row.trade_source === source);
}

/** The rows from one source that actually count as a trade. */
function effectiveFrom(h: Harness, source: string) {
  return rowsFrom(h, source).filter(
    (row) => row.status === 'pending' || row.status === 'settled' || row.status === 'void',
  );
}

/** Every reason recorded in `agent_runs`, so "why no trade" is answerable. */
function runReasons(h: Harness): string[] {
  return (
    h.runtime.db.prepare('SELECT reason FROM agent_runs').all() as Array<{ reason: string }>
  ).map((row) => row.reason);
}

/**
 * The distinct owners named by any effective trade, whichever path wrote it.
 *
 * The late-start promise is 150/150 coverage; with the strategy switch on, some
 * of those owners are covered by a bootstrap trade and the rest by the fallback,
 * so the two sources have to be counted together.
 */
function coveredAgents(h: Harness): Set<string> {
  const covered = new Set<string>();
  for (const row of h.runtime.repositories.trades.all()) {
    if (row.status !== 'pending' && row.status !== 'settled' && row.status !== 'void') continue;
    covered.add(row.maker_did);
    if (row.taker_did !== null) covered.add(row.taker_did);
  }
  return covered;
}

describe('the bootstrap strategy at the write path', () => {
  let harness: Harness | null = null;

  afterEach(async () => {
    if (harness) await harness.dispose();
    harness = null;
  });

  it('writes nothing while its switch is off, and leaves the fallback whole', async () => {
    harness = await buildLateStart({ trading: true });
    const h = harness;
    await waitForFirstPass(h);
    await primeRising(h);
    await h.runtime.scheduler.runTick();
    await waitForRegistrations(h);
    await h.runtime.scheduler.runTick();

    // The market was priceable and the signal rising: only the switch held it.
    expect(rowsFrom(h, 'bootstrap')).toHaveLength(0);
    const status = h.runtime.scheduler.status();
    expect(status.strategyGateMode).toBe('late_start_bootstrap');
    expect(status.lateStartStrategyTradingReady).toBe(false);
    expect(status.strategyBlockedReason).toBe('late_start_strategy_disabled');
    expect(status.lateStartSignal).toBe('rising');
    expect(status.bootstrapStrategyTradesPosted).toBe(0);
    expect(status.strategyTradesPosted).toBe(0);
    expect(status.participationTradesPosted).toBe(75);
    expect(status.participationAgentsCovered).toBe(150);
  }, 240_000);

  it('posts a rising close as one bounded BUY per agent, never a position', async () => {
    harness = await buildLateStart({ trading: true, strategy: true });
    const h = harness;
    await waitForFirstPass(h);
    await primeRising(h);
    await h.runtime.scheduler.runTick();
    await waitForRegistrations(h);
    await h.runtime.scheduler.runTick();

    const bootstrap = effectiveFrom(h, 'bootstrap');
    expect(bootstrap.length).toBeGreaterThan(0);
    // One per maker, ever: no second position for the same agent.
    expect(new Set(bootstrap.map((row) => row.maker_did)).size).toBe(bootstrap.length);

    const groupByDid = new Map(
      h.runtime.repositories.identities.all().map((row) => [row.did, row.strategy_group]),
    );
    for (const row of bootstrap) {
      expect(row.status).toBe('pending');
      expect(row.side).toBe('buy');
      // The rules' own minimum, not a sized position.
      expect(row.qty).toBe('0.1');
      // `until` is the band's own `for`, never a local horizon.
      expect(row.until_sweep).toBe(1759);
      // The external-offer group never takes the bootstrap decision.
      expect(groupByDid.get(row.maker_did)).not.toBe('external_offer_taker');
    }

    const status = h.runtime.scheduler.status();
    expect(status.bootstrapStrategyTradesPosted).toBe(bootstrap.length);
    expect(status.strategyTradesPosted).toBe(0);
    // The fallback still owes every remaining owner one trade: the two sources
    // together cover the whole fleet.
    expect(coveredAgents(h).size).toBe(150);
    // No owner carries two positions at once: no bootstrap trade on top of a
    // participation trade, and none the other way round. A lifetime count would
    // also forbid an agent from trading again after its own `until_sweep` has
    // passed, which is the deadlock, so the invariant here is overlap.
    const inEffect = new Map<string, number[]>();
    for (const row of h.runtime.repositories.trades.all()) {
      if (row.status !== 'pending' && row.status !== 'settled') continue;
      // An open bootstrap offer names its own maker on both sides.
      for (const did of new Set([row.maker_did, row.taker_did ?? row.maker_did])) {
        const spans = inEffect.get(did) ?? [];
        spans.push(row.until_sweep);
        inEffect.set(did, spans);
      }
    }
    for (const [did, spans] of inEffect) {
      const live = [...spans].sort((a, b) => a - b);
      for (let i = 1; i < live.length; i += 1) {
        expect(
          live[i],
          `${did.slice(14, 22)} held two trades that can settle at the same time`,
        ).not.toBe(live[i - 1]);
      }
    }
    // The run is labelled as the bootstrap decision, not as a group profile:
    // "which decision asked for this trade" is answerable from the record.
    const versions = (
      h.runtime.db.prepare('SELECT DISTINCT strategy_version AS v FROM agent_runs').all() as Array<{
        v: string;
      }>
    ).map((row) => row.v);
    expect(versions).toContain(LATE_START_BOOTSTRAP_VERSION);
  }, 240_000);

  it('posts a falling close as a bounded SELL', async () => {
    harness = await buildLateStart({ trading: true, strategy: true });
    const h = harness;
    await waitForFirstPass(h);
    await primeFalling(h);
    await h.runtime.scheduler.runTick();
    await waitForRegistrations(h);
    await h.runtime.scheduler.runTick();

    const bootstrap = effectiveFrom(h, 'bootstrap');
    expect(bootstrap.length).toBeGreaterThan(0);
    for (const row of bootstrap) {
      expect(row.side).toBe('sell');
      expect(row.qty).toBe('0.1');
      expect(row.until_sweep).toBe(1759);
    }
  }, 240_000);

  it('declines with late_start_insufficient_observations until a second close exists', async () => {
    harness = await buildLateStart({ trading: true, strategy: true });
    const h = harness;
    await waitForFirstPass(h);
    // Exactly one accepted close: no direction exists yet.
    await primeAt(h, 1758, '229.80');
    await h.runtime.scheduler.runTick();
    await waitForRegistrations(h);
    await h.runtime.scheduler.runTick();

    expect(rowsFrom(h, 'bootstrap')).toHaveLength(0);
    expect(runReasons(h)).toContain('late_start_insufficient_observations:no_trade');
    const status = h.runtime.scheduler.status();
    expect(status.lateStartObservationCount).toBe(1);
    expect(status.lateStartSignal).toBe('insufficient');
    // The strategy's own shortfall does not touch the participation fallback.
    expect(status.participationTradesPosted).toBe(75);
    expect(status.participationAgentsCovered).toBe(150);
  }, 240_000);

  it('declines a flat market with late_start_flat', async () => {
    harness = await buildLateStart({ trading: true, strategy: true });
    const h = harness;
    await waitForFirstPass(h);
    await primeAt(h, 1757, '229.80');
    await primeAt(h, 1758, '229.80');
    await h.runtime.scheduler.runTick();
    await waitForRegistrations(h);
    await h.runtime.scheduler.runTick();

    expect(rowsFrom(h, 'bootstrap')).toHaveLength(0);
    expect(runReasons(h)).toContain('late_start_flat:no_trade');
    expect(h.runtime.scheduler.status().lateStartSignal).toBe('flat');
  }, 240_000);

  it('keeps trading after the participation fallback has covered the whole fleet', async () => {
    harness = await buildLateStart({ trading: true, strategy: true });
    const h = harness;
    await waitForFirstPass(h);

    // The production order, which the same-tick tests above never produce: a FLAT
    // market first, so the bootstrap declines and the one-shot participation
    // fallback is the only path that writes. It covers all 150 owners and then
    // stops for good.
    await primeAt(h, 1755, '229.80');
    await primeAt(h, 1756, '229.80');
    await h.runtime.scheduler.runTick();
    await waitForRegistrations(h);
    await h.runtime.scheduler.runTick();

    expect(h.runtime.scheduler.status().lateStartSignal).toBe('flat');
    expect(effectiveFrom(h, 'bootstrap')).toHaveLength(0);
    expect(h.runtime.repositories.trades.participationCoverage()).toEqual({
      posted: 75,
      agentsCovered: 150,
    });
    // The fallback's own deadline: the band it priced from is the next sweep.
    const participationUntil = new Set(
      h.runtime.repositories.trades
        .all()
        .filter((row) => row.trade_source === 'participation')
        .map((row) => row.until_sweep),
    );
    expect([...participationUntil]).toEqual([1757]);

    const refusalsFor = (): number =>
      rowsFrom(h, 'bootstrap').filter(
        (row) => row.reason === 'bootstrap_trade_already_recorded',
      ).length;
    const refusedWhileFlat = refusalsFor();

    // Now the market turns, *past* the fallback's own deadline. Every owner
    // already owns a participation trade, so a guard that asks "has this agent
    // ever traded" answers yes for all 150 and vetoes the only path left, forever
    // — the production deadlock, 46,080 refusals and zero trades. A guard that
    // asks "does this agent still hold something that can settle" answers no,
    // because the signed terms themselves expired, and the strategy keeps working.
    h.advance(5 * 60_000);
    await primeAt(h, 1757, '232.00');
    await primeAt(h, 1758, '232.40');
    expect(h.runtime.scheduler.status().lateStartSignal).toBe('rising');

    await h.runtime.scheduler.runTick();

    const turned = effectiveFrom(h, 'bootstrap');
    expect(turned.length).toBeGreaterThan(0);
    expect(refusalsFor()).toBe(refusedWhileFlat);
    const status = h.runtime.scheduler.status();
    expect(status.strategyGateMode).toBe('late_start_bootstrap');
    expect(status.lateStartStrategyTradingReady).toBe(true);
    expect(status.bootstrapStrategyTradesPosted).toBe(turned.length);
    // The fallback stays one-shot: the new bootstrap trades are the only rows the
    // second write added, and they are not a second position on a covered owner.
    expect(h.runtime.repositories.trades.participationCoverage()).toEqual({
      posted: 75,
      agentsCovered: 150,
    });
    for (const row of turned) {
      expect(row.status).toBe('pending');
      expect(row.side).toBe('buy');
      expect(row.qty).toBe('0.1');
    }

    // And it keeps going. One sweep later the bootstrap trades of the previous
    // sweep are past their own deadline (`until_sweep` 1759), so a further turn
    // writes again rather than stopping after a single burst.
    h.advance(5 * 60_000);
    await primeAt(h, 1759, '228.00');
    await primeAt(h, 1760, '227.60');
    expect(h.runtime.scheduler.status().lateStartSignal).toBe('falling');
    await h.runtime.scheduler.runTick();

    const second = effectiveFrom(h, 'bootstrap').filter((row) => row.until_sweep === 1761);
    expect(second.length).toBeGreaterThan(0);
    for (const row of second) {
      expect(row.side).toBe('sell');
      expect(row.until_sweep).toBe(1761);
    }
    expect(h.runtime.repositories.trades.participationCoverage()).toEqual({
      posted: 75,
      agentsCovered: 150,
    });
  }, 300_000);

  it('declines when the band does not label the next sweep', async () => {
    harness = await buildLateStart({ trading: true, strategy: true });
    const h = harness;
    await waitForFirstPass(h);
    h.referee.price(1757, '229.40', ['217.93', '240.87'], 1758);
    // Rising closes, but the band names 1760 rather than 1759: unusable.
    h.referee.price(1758, '229.80', ['218.31', '241.29'], 1760);
    await waitFor(
      () => h.runtime.reader.verifier.state.currentSweep === 1758,
      'the mislabelled price post',
    );
    await h.runtime.scheduler.runTick();
    await waitForRegistrations(h);
    await h.runtime.scheduler.runTick();

    expect(rowsFrom(h, 'bootstrap')).toHaveLength(0);
    expect(runReasons(h)).toContain('late_start_market_unusable:no_trade');
    expect(h.runtime.scheduler.status().strategyBlockedReason).not.toBeNull();
  }, 240_000);

  it('never turns a post from another DID into an observation or a trade', async () => {
    harness = await buildLateStart({ trading: true, strategy: true, startReader: false });
    const h = harness;
    const foreignSeed = new Uint8Array(32).fill(99);
    const foreignDid = didFromSeed(foreignSeed);
    for (const sweep of [1757, 1758]) {
      h.transport.room('d-close1-price').appendFrom(
        JSON.stringify({
          t: 'price',
          season: 'close-1',
          n: sweep,
          ref: { px: '229.80', time: '2026-09-28T12:00:00Z', tid: `t${sweep}` },
          limits: ['218.31', '241.29'],
          for: sweep + 1,
        }),
        { seed: foreignSeed, did: foreignDid, nonce: sweep },
      );
    }
    await h.runtime.reader.tick();
    await h.runtime.reader.tick();

    // The pinned referee never posted, so nothing was accepted.
    expect(h.runtime.reader.verifier.state.currentSweep).toBeNull();
    expect(h.runtime.reader.snapshot().history).toHaveLength(0);
    const status = h.runtime.scheduler.status();
    expect(status.lateStartObservationCount).toBe(0);
    expect(status.lateStartSignal).toBe('insufficient');

    await h.runtime.scheduler.runTick();
    expect(rowsFrom(h, 'bootstrap')).toHaveLength(0);
  }, 180_000);
});

describe('a bootstrap trade survives a restart without doubling', () => {
  let first: Harness | undefined;
  let second: Harness | undefined;

  afterEach(async () => {
    if (second) await second.dispose();
    second = undefined;
    try {
      await first?.runtime.db.close();
    } catch {
      /* already closed */
    }
    first = undefined;
  });

  it('keeps one bootstrap trade per agent and re-issues none', async () => {
    const dir = tempDir('flop-late-bootstrap-kill-');
    const transport = new FakeTransport({ readDelayMs: 5 });
    const env = {
      ...LIVE_PINS,
      FLOP_ALLOW_REGISTRATION: 'true',
      LATE_START_MODE: 'true',
      LATE_START_CONFIRM: LATE_START_CONFIRM_VALUE,
      FLOP_ALLOW_TRADING: 'true',
      LATE_START_ALLOW_TRADING: 'true',
      LATE_START_ALLOW_STRATEGY_TRADING: 'true',
      LATE_START_STRATEGY_CONFIRM: LATE_START_STRATEGY_CONFIRM_VALUE,
      WRITE_RATE_PER_MINUTE: '100000',
    };
    for (const room of HARNESS_ROOMS) transport.room(room);

    first = await buildHarness({ agentCount: 150, dir, transport, now: () => new Date(CLOCK), env });
    first.runtime.reader.startContinuous();
    await waitForFirstPass(first);
    await primeRising(first);
    await first.runtime.scheduler.runTick();
    await waitForRegistrations(first);
    await first.runtime.scheduler.runTick();

    const before = effectiveFrom(first, 'bootstrap');
    expect(before.length).toBeGreaterThan(0);
    const idsBefore = new Set(before.map((row) => row.id));
    const participationBefore = first.runtime.repositories.trades.participationCoverage().posted;

    // SIGKILL: the reader loops stop and the process is gone.
    await first.runtime.reader.stopContinuous();

    second = await buildHarness({ agentCount: 150, dir, transport, now: () => new Date(CLOCK), env });
    second.runtime.reader.startContinuous();
    await waitForFirstPass(second);
    await second.runtime.scheduler.runTick();
    await second.runtime.scheduler.runTick();

    // The same effective trades, and not one more, however ready the market is.
    const after = effectiveFrom(second, 'bootstrap');
    expect(new Set(after.map((row) => row.id))).toEqual(idsBefore);
    // The participation fallback is neither re-issued nor overwritten.
    expect(second.runtime.repositories.trades.participationCoverage().posted).toBe(
      participationBefore,
    );
    expect(second.runtime.scheduler.status().bootstrapStrategyTradesPosted).toBe(before.length);
  }, 300_000);
});

// ---------------------------------------------------------------------------
// The production shape: a persistent cursor gap in `close1`
// ---------------------------------------------------------------------------

/**
 * The exact failure the VPS reported.
 *
 * `close1` had gapped at some earlier point and the gap was provably resumed
 * past, so it lives on only as an audit line — `gap_resolved_at` set,
 * `gapCount > 0`. The global verifier had nevertheless entered conservative mode
 * on `cursor_health`, and there was no path out: `refreshHealth()` entered and
 * never cleared. Because `late-start-bootstrap` and the gate both read
 * `market.degraded`, every proposal was refused by a historical fact, and the
 * fleet posted zero strategy trades while `/status` kept saying
 * `lateStartTradingReady=true`.
 *
 * The fix is two-sided and this test pins both sides: the reader can now leave
 * conservative mode once the cursor is clean again, and the strategy reads a
 * *current* market answer that a resolved historical gap cannot hold back.
 */
describe('a resolved historical gap does not hold the bootstrap back', () => {
  let harness: Harness | null = null;

  afterEach(async () => {
    if (harness) await harness.dispose();
    harness = null;
  });

  it('trades through a resolved close1 gap while the audit still records the loss', async () => {
    harness = await buildLateStart({ trading: true, strategy: true, startReader: false });
    const h = harness;

    // A real gap in close1: the ring dropped 4 and 5 before the reader returned.
    for (let seq = 1; seq <= 3; seq += 1) h.transport.enqueue('close1', { seq, text: `gap${seq}` });
    h.runtime.reader.startContinuous();
    await waitFor(
      () => h.runtime.repositories.roomCursors.get('close1')?.cursor === 3,
      'the first three close1 messages',
    );
    for (let seq = 4; seq <= 8; seq += 1) h.transport.enqueue('close1', { seq, text: `gap${seq}` });
    h.transport.room('close1').firstSeqRetained = 6;
    await waitFor(
      () => h.runtime.reader.gaps().unresolved.includes('close1'),
      'the close1 gap to be recorded',
    );

    // An *open* gap is a current risk, so the verifier holds conservative mode
    // under `cursor_health` — the reason that used to be a one-way latch. The
    // harness clock is fixed, so advance it past the reader's health interval.
    h.advance(2_000);
    await waitFor(
      () => h.runtime.reader.verifier.state.conservativeReasons.includes('cursor_health'),
      'cursor_health to be entered',
    );
    expect(h.runtime.reader.snapshot().degraded).toBe(true);

    // A contiguous read past the missed range closes it. This is the normal
    // recovery path the production reader did not have.
    h.transport.enqueue('close1', { seq: 9, text: 'gap9' });
    h.transport.enqueue('close1', { seq: 10, text: 'gap10' });
    await waitFor(
      () => h.runtime.repositories.roomCursors.get('close1')?.gap_resolved_at !== null,
      'the close1 gap to be resolved',
    );
    h.advance(2_000);
    await waitFor(
      () => !h.runtime.reader.verifier.state.conservativeReasons.includes('cursor_health'),
      'cursor_health to be cleared once the gap is closed',
    );
    expect(h.runtime.reader.snapshot().degraded).toBe(false);

    // Resolved is not erased: the loss is still on the audit, with its count.
    const gaps = h.runtime.reader.gaps();
    expect(gaps.unresolved).not.toContain('close1');
    expect(gaps.recovered).toContain('close1');
    expect(gaps.states.find((state) => state.room === 'close1')?.gapCount).toBe(1);

    // The current referee feed is sound: two accepted closes that rise, a band
    // labelled `for` the next sweep, and the lock still ahead.
    await primeRising(h);
    await h.runtime.scheduler.runTick();
    await waitForRegistrations(h);
    await h.runtime.scheduler.runTick();

    const status = h.runtime.scheduler.status();
    // The historical replay really is unavailable — and that is not the gate.
    expect(status.historicalReplayComplete).toBe(false);
    expect(status.historicalReplayUnavailable).toBe(true);
    // The current market is usable independently of the historical audit.
    expect(status.currentMarketUsable).toBe(true);
    expect(status.currentMarketBlockedReason).toBeNull();
    // The two facts the status must never conflate are both reported.
    expect(status.activeUnresolvedGapRooms).toEqual([]);
    expect(status.historicalGapTotal).toBeGreaterThan(0);
    // The switch is armed and the strategy is ready — no contradictory
    // `conservative:cursor_health` beside a `true`.
    expect(status.lateStartStrategyTradingArmed).toBe(true);
    expect(status.lateStartStrategyTradingReady).toBe(true);
    expect(status.strategyBlockedReason).toBeNull();
    expect(status.lateStartObservationCount).toBeGreaterThanOrEqual(2);
    expect(status.lateStartSignal).toBe('rising');

    const bootstrap = effectiveFrom(h, 'bootstrap');
    expect(bootstrap.length).toBeGreaterThan(0);
    expect(status.bootstrapStrategyTradesPosted).toBe(bootstrap.length);
    expect(status.strategyTradesPosted).toBe(0);
    // The bootstrap and the fallback together still cover the whole fleet: the
    // historical gap did not cost a single owner their trade.
    expect(coveredAgents(h).size).toBe(150);
    // The invariant a position needs is "never two trades in effect at once".
    // A lifetime count would instead forbid an agent from ever trading again once
    // its own `until_sweep` has passed, which is the deadlock this pins against.
    const inEffect = new Map<string, number[]>();
    for (const row of h.runtime.repositories.trades.all()) {
      if (row.status !== 'pending' && row.status !== 'settled') continue;
      for (const did of new Set([row.maker_did, row.taker_did ?? row.maker_did])) {
        const spans = inEffect.get(did) ?? [];
        spans.push(row.until_sweep);
        inEffect.set(did, spans);
      }
    }
    for (const [did, spans] of inEffect) {
      const live = [...spans].sort((a, b) => a - b);
      for (let i = 1; i < live.length; i += 1) {
        expect(
          live[i],
          `${did.slice(14, 22)} held two trades that can settle at the same time`,
        ).not.toBe(live[i - 1]);
      }
    }
    // The trade was refused by neither the historical audit nor the gate.
    expect(runReasons(h)).not.toContain('late_start_market_unusable:no_trade');
  }, 300_000);

  it('still refuses the bootstrap while a referee room is losing messages', async () => {
    harness = await buildLateStart({ trading: true, strategy: true });
    const h = harness;
    await waitForFirstPass(h);
    // A flat close is not a direction, so two closes and a sound feed still post
    // nothing: the only thing that can block the trade below is the gap itself.
    await primeAt(h, 1757, '229.80');
    await primeAt(h, 1758, '229.80');
    await h.runtime.scheduler.runTick();
    await waitForRegistrations(h);
    expect(rowsFrom(h, 'bootstrap')).toHaveLength(0);

    // Now the referee's own room gaps: the ring drops two posts the cursor never
    // saw. Unlike the closed `close1` gap, this is a *current* loss.
    const room = h.transport.room('d-close1-price');
    const last = room.lastSeq()!;
    room.firstSeqRetained = last + 3;
    h.transport.enqueue('d-close1-price', { seq: last + 1, text: 'dropped-1' });
    h.transport.enqueue('d-close1-price', { seq: last + 2, text: 'dropped-2' });
    h.transport.enqueue('d-close1-price', { seq: last + 3, text: 'kept' });
    await waitFor(
      () => h.runtime.reader.gaps().unresolved.includes('d-close1-price'),
      'the referee-room gap to be recorded',
    );
    h.advance(2_000);
    await waitFor(
      () => h.runtime.reader.verifier.state.conservativeReasons.includes('cursor_health'),
      'the reader to re-grade its health',
    );

    await h.runtime.scheduler.runTick();

    const status = h.runtime.scheduler.status();
    expect(status.currentMarketUsable).toBe(false);
    expect(status.currentMarketBlockedReason).toContain('unresolved cursor gap');
    expect(status.currentMarketBlockedReason).toContain('d-close1-price');
    expect(status.activeUnresolvedGapRooms).toContain('d-close1-price');
    // The strategy is held back, and the status names the *current* reason.
    expect(status.lateStartStrategyTradingReady).toBe(false);
    expect(status.strategyBlockedReason).not.toBeNull();
    expect(rowsFrom(h, 'bootstrap')).toHaveLength(0);
    expect(runReasons(h)).toContain('late_start_market_unusable:no_trade');
  }, 300_000);

  it('clears only cursor_health and never a current-risk reason', async () => {
    harness = await buildLateStart({ trading: true, startReader: false });
    const h = harness;
    // Two current facts that the cursor-clean path must never touch.
    h.runtime.reader.verifier.enterConservative('package_hash_drift', 'the seed names another package');
    h.runtime.reader.verifier.enterConservative('referee_signature_invalid', 'seq 7 did not verify');
    h.runtime.reader.startContinuous();
    await waitForFirstPass(h);

    // The cursor set is clean, so the reader clears `cursor_health` — a no-op here
    // — while the two current reasons stay exactly where they are.
    const reasons = h.runtime.reader.verifier.state.conservativeReasons;
    expect(reasons).toContain('package_hash_drift');
    expect(reasons).toContain('referee_signature_invalid');
    expect(reasons).not.toContain('cursor_health');
    expect(h.runtime.reader.snapshot().degraded).toBe(true);
  }, 120_000);

  it('answers strict mode with `degraded`, so its gate is unchanged', async () => {
    // A plain harness: no late-start switch at all, so the reader is strict.
    const transport = new FakeTransport({ readDelayMs: 1 });
    const h = await buildHarness({ agentCount: 6, transport, now: () => new Date(CLOCK) });
    try {
      for (const room of HARNESS_ROOMS) transport.room(room);
      const reader = h.runtime.reader;
      const clean = reader.snapshot();
      // Strict mode's answer is exactly `!degraded`, with `degradedReason` as the
      // reason: the mode-aware field adds nothing to it.
      expect(clean.currentMarketUsable).toBe(!clean.degraded);

      reader.verifier.enterConservative('cursor_health', 'a gap happened');
      const blocked = reader.snapshot();
      expect(blocked.degraded).toBe(true);
      expect(blocked.currentMarketUsable).toBe(false);
      expect(blocked.currentMarketBlockedReason).toBe(blocked.degradedReason);
    } finally {
      await h.dispose();
    }
  }, 120_000);
});
