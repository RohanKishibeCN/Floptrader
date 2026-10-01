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
  Decimal,
  parseTradeMessage,
  verifyMakerSignature,
  verifyTakerSignature,
  withinPublishedLimits,
} from '@flop/close-call';
import { verifyRoomSignatureForRoom } from '@flop/identity';
import { LATE_START_CONFIRM_VALUE, loadConfig, type Config } from '../apps/orchestrator/src/config.js';
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
    harness = await buildLateStart({ trading: true, env: { AGENTS_PER_TICK: '30' } });
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
