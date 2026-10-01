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
import {
  lateStartFeedReadiness,
  marketSnapshotReadiness,
} from '../apps/orchestrator/src/readiness.js';
import { FakeTransport } from './support/fake-transport.js';
import { waitFor } from './support/harness.js';
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
