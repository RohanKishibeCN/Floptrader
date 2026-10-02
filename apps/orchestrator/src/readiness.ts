/**
 * Readiness: the three gates between "we can see the room" and "we may act".
 *
 * A dry run may read, evaluate and report while no gate is satisfied — that is
 * what makes it a rehearsal. Live is different, and live is *three* steps, not
 * one: the referee feed must be provable, then the 150 owner registrations may
 * be posted, and only then may a trade be written. The three are derived here
 * from facts the process already holds, so the same reasons appear in the gate,
 * in `status()` and in the report.
 *
 * They are nested, and the nesting is the point — each is strictly stronger
 * than the one before:
 *
 *   1. `refereeFeedReady` — *identity and provenance*. Do we know who the
 *      referee is, is the seed genuine, does the package match the pin, is the
 *      reader running, and does any referee room carry a loss? This is about the
 *      feed being trustworthy, and nothing else.
 *   2. `registrationReady` — may we commit 150 signed owner registrations? That
 *      needs the feed *and* the trading room's coverage to be good enough that a
 *      registration of ours cannot have been lost: a `close1` gap that might
 *      hold one of our own posts blocks registration whichever policy is set.
 *   3. `tradingReady` — may a trade be written? That needs registration *and*
 *      everything required to price one, plus the 150/150 readback that proves
 *      our registrations were actually seen rather than merely posted.
 *
 * Reading them as "registrationReady means we can trade" is the mistake this
 * shape exists to prevent: registration readiness is a precondition of trading
 * and never a substitute for it.
 */

import type { Rules } from '@flop/close-call';

export interface Readiness {
  ready: boolean;
  reasons: string[];
}

/**
 * The contest's own wall-clock lock, as a fact about *now*.
 *
 * Every other lock in this process is derived from the referee feed: the sweep
 * number, `price.for`, the verifier's `locked` flag. All of those depend on the
 * feed still talking. A feed that goes quiet — the referee stops posting, or
 * the reader loses its cursor — leaves the sweep frozen where it was, and a
 * frozen sweep before `lock_sweep` reads as "still open". The wall clock does
 * not depend on any of that: `rules.lockAt` is published, fixed, and true
 * whether or not we can hear the referee. It is the one gate that cannot be
 * talked out of being closed.
 */
export interface LockState {
  /** True when `lockAt` parsed. False is a refusal, never "unknown, so open". */
  valid: boolean;
  /** True only while the wall clock is strictly before the lock. */
  beforeLock: boolean;
  /** True when the contest is closed to new writes. */
  locked: boolean;
  reason: string | null;
}

/** The wall-clock reason, phrased once so the gate, the record and the report agree. */
export const WALL_CLOCK_LOCKED_REASON = 'contest lockAt has passed by wall clock';
/** The wall clock could not be read; fail closed rather than treat it as open. */
export const WALL_CLOCK_INVALID_REASON = 'invalid contest lockAt';

/**
 * Parse `lockAt` as UTC.
 *
 * A bare `YYYY-MM-DDTHH:MM:SS` carries no zone designator, and ECMAScript parses
 * that form as *local* time — which would silently move the lock by the host's
 * offset. The rules publish UTC, so the missing-zone form is read as UTC
 * explicitly rather than trusting the server's locale.
 */
function parseLockAt(value: string): number {
  const trimmed = value.trim();
  const zoned = /(?:Z|[+-]\d{2}:?\d{2})$/i.test(trimmed) ? trimmed : `${trimmed}Z`;
  return Date.parse(zoned);
}

/**
 * The wall-clock lock. Uses the injected clock, never `new Date()`, so a test
 * can move time deliberately and the two never disagree.
 *
 * Invalid `lockAt` fails closed: an unparsable deadline is a closed contest,
 * because the alternative is a process that cannot read its own rules and
 * writes anyway.
 */
export function lockState(now: Date, rules: Rules): LockState {
  const lockMs = parseLockAt(rules.lockAt);

  if (!Number.isFinite(lockMs)) {
    return { valid: false, beforeLock: false, locked: true, reason: WALL_CLOCK_INVALID_REASON };
  }

  if (now.getTime() >= lockMs) {
    return {
      valid: true,
      beforeLock: false,
      locked: true,
      reason: WALL_CLOCK_LOCKED_REASON,
    };
  }

  return { valid: true, beforeLock: true, locked: false, reason: null };
}

/**
 * The referee *feed* clauses, and only those.
 *
 * Deliberately narrower than the registration gate: everything here is a fact
 * about whether the contest record we are reading can be trusted at all.
 */
export interface RefereeFeedReadinessInputs {
  /** The reader's own continuous loops are on, i.e. reading is decoupled. */
  readerContinuous: boolean;
  /** Those loops are actually running (not stopping, not failed to start). */
  readerRunning: boolean;
  /** The five referee rooms, without the trading room. */
  refereeRoomCount: number;
  expectedRefereeRoomCount: number;
  /** Referee rooms carrying a recorded cursor gap: a real mid-run loss. */
  refereeRoomsWithGap: string[];
  /** Of those, the ones still *open*: no contiguous read has resumed past them. */
  refereeRoomsWithUnresolvedGap: string[];
  /** Referee rooms whose generation was reset. */
  refereeRoomsReset: string[];
  /** The profile and lane configuration match the profile being run. */
  profileLaneOk: boolean;
  /** A seed post was read, signature-checked and accepted. */
  seedSeen: boolean;
  /**
   * The referee-feed reasons the verifier itself is holding.
   *
   * Conservative mode is where a seed that arrived in the wrong room, a
   * signature that did not verify, a sender that is not the pinned referee or a
   * package that drifted away from the pin are recorded. They are named here
   * rather than inferred from `seedSeen`, so the operator is told *which* of them
   * is holding the feed instead of only "no seed".
   */
  refereeFeedBlockers: string[];
  refereeDid: string | null;
  expectedRefereeDid: string | null;
  /** The package hash the accepted seed quoted. */
  packageHash: string | null;
  /** The package hash fixed at launch, if one was. */
  expectedPackageHash: string | null;
  /** `hydrateFromSnapshots()` has run, so the stored referee history is loaded. */
  hydrated: boolean;
  /** Whether a referee DID was required to be pinned at launch. */
  requirePin: boolean;
  /** A reference price is held: the feed's own number, not one we derived. */
  hasReference: boolean;
  /** The limits published for the next sweep are held. */
  hasLimits: boolean;
  /**
   * The official sweep is recoverable from stored history.
   *
   * A verifier that hydrated but has no sweep, no reference and no limits cannot
   * price anything and cannot say which sweep the contest is in. That is a feed
   * problem, not a trading problem: everything downstream reads the sweep.
   */
  currentSweepRecoverable: boolean;
}

/** The feed clauses plus what only matters once we start *posting* into close1. */
export interface RegistrationReadinessInputs extends RefereeFeedReadinessInputs {
  /** The trading room carries *some* recorded gap, open or recovered. */
  tradingRoomHasCoverageGap: boolean;
  /**
   * An unresolved gap in the trading room that may contain one of our own posts.
   *
   * `close1` is where our own owner registrations, trades and re-posts live. A
   * gap there is not merely a hole in the feed: if the missing range could hold
   * one of our messages, the participation record itself is incomplete, and no
   * policy setting may wave that through.
   */
  tradingRoomCriticalGap: boolean;
  /** The rooms behind `tradingRoomCriticalGap`, for the message. */
  tradingRoomCriticalGapRooms: string[];
  /**
   * The trading room's catch-up is measured to be unattainable.
   *
   * This is arithmetic, not effort: the producer has outrun what we can store
   * across whole windows, so the feed will keep losing messages however hard the
   * reader works. It blocks registration as well as trading.
   */
  tradingRoomUnattainable: boolean;
  /**
   * What a trading-room gap does to this gate.
   *
   * `block` refuses outright. `degraded_readonly` keeps reading and reporting —
   * registration is not held by a *plain coverage* gap — while trading stays
   * refused and the coverage is never reported as complete. Neither value
   * unblocks a critical gap or an unattainable room.
   */
  close1GapPolicy: 'block' | 'degraded_readonly';
  /** Every agent in the fleet is present and enabled: 5 groups of 30. */
  fleetComplete: boolean;
  /** The writer is accepting work and SQLite is writable. */
  writerHealthy: boolean;
  /** The nonce store is usable, so no registration can reuse a counter. */
  nonceStoreUsable: boolean;
  /** The durable evidence tables can be written to. */
  durableEvidenceWritable: boolean;
  /**
   * The operator's explicit switch for registration into a degraded `close1`.
   *
   * `ALLOW_REGISTRATION_WITH_CLOSE1_GAP`. Off by default everywhere, and it only
   * ever covers a *plain public coverage* gap: a band that could hold one of our
   * own registrations is still refused, because that is not a policy question.
   */
  allowRegistrationWithClose1Gap: boolean;
  /** A local registration seq provably falls inside the recorded band. */
  localMessageInGap: boolean;
}

/**
 * The conservative-mode reasons that are facts about the *referee feed*.
 *
 * The verifier collects one flat set of reasons; only some of them speak to
 * whether the contest record itself can be trusted. Those are the ones the feed
 * gate names, so "the feed is not ready" can say *which* refusal it is holding
 * rather than only "no seed".
 */
const REFEREE_FEED_BLOCKERS: ReadonlySet<string> = new Set([
  'seed_required',
  'seed_wrong_room',
  'seed_rooms_mismatch',
  'referee_signature_invalid',
  'referee_did_mismatch',
  'referee_unpinned',
  'package_hash_drift',
  'package_hash_unpinned',
]);

/** Narrow the verifier's reasons to the ones about the feed itself. */
export function refereeFeedBlockerReasons(reasons: readonly string[]): string[] {
  return reasons.filter((reason) => REFEREE_FEED_BLOCKERS.has(reason));
}

/**
 * The conservative reasons a *seedless* start deliberately does not act on.
 *
 * A late start does not need a seed, so a seed-shaped message in the wrong room
 * says nothing about whether the price we are reading is genuine — that is the
 * pinned referee's signature, checked on every post. They are still recorded and
 * still reported; they are simply not a reason to refuse to participate.
 */
const LATE_START_IGNORED_REASONS: ReadonlySet<string> = new Set([
  'seed_required',
  'seed_wrong_room',
  'seed_rooms_mismatch',
]);

/** The feed facts that still stop a seedless start: identity, signature, pin. */
export function lateStartFeedBlockerReasons(reasons: readonly string[]): string[] {
  return reasons.filter(
    (reason) => !LATE_START_IGNORED_REASONS.has(reason) && REFEREE_FEED_BLOCKERS.has(reason),
  );
}

// ---------------------------------------------------------------------------
// Late start: participation without the opening seed
// ---------------------------------------------------------------------------

export interface LateStartFeedReadinessInputs {
  /** `LATE_START_MODE` confirmed and in force. */
  lateStartArmed: boolean;
  readerContinuous: boolean;
  readerRunning: boolean;
  refereeRoomCount: number;
  expectedRefereeRoomCount: number;
  /** New losses inside the referee rooms: we may be missing the current post. */
  refereeRoomsWithUnresolvedGap: string[];
  refereeRoomsReset: string[];
  /**
   * The reviewed launch configuration pins the referee DID *and* the package.
   *
   * With no seed, this pin is the whole trust anchor: it is what makes "only
   * this DID, running only this package" answerable at all. Its absence is a
   * refusal, never a prompt to adopt whatever posts first.
   */
  launchPinVerified: boolean;
  refereeDid: string | null;
  expectedRefereeDid: string | null;
  /** Signature / DID / package refusals from the verifier. */
  refereeFeedBlockers: string[];
  /** At least one post from the pinned referee has been accepted. */
  refereeSeen: boolean;
}

/**
 * Is the referee feed provable *without* the opening seed?
 *
 * The strict gate asks "did we replay the contest from its seed". This one asks
 * the only other question that can be answered from a late start: is every post
 * we are acting on signed by the referee the launch record pinned, and are we
 * reading the rooms right now. A recorded loss from before the late start is
 * reported by the audit view and does not stop us — but a loss that is *still
 * open* does, because it could be hiding the price post the next sweep needs.
 */
export function lateStartFeedReadiness(input: LateStartFeedReadinessInputs): Readiness {
  const reasons: string[] = [];
  if (!input.lateStartArmed) reasons.push('late-start mode is not armed');
  if (!input.readerContinuous) {
    reasons.push('continuous reader is off; the fixed rooms are not being read');
  } else if (!input.readerRunning) {
    reasons.push('continuous reader is not running');
  }
  if (input.refereeRoomCount !== input.expectedRefereeRoomCount) {
    reasons.push(
      `reader owns ${input.refereeRoomCount} referee rooms, expected ${input.expectedRefereeRoomCount}`,
    );
  }
  if (input.refereeRoomsWithUnresolvedGap.length > 0) {
    reasons.push(
      `unresolved cursor gap in referee room(s) ${input.refereeRoomsWithUnresolvedGap.join(', ')}`,
    );
  }
  if (input.refereeRoomsReset.length > 0) {
    reasons.push(`referee room recreated: ${input.refereeRoomsReset.join(', ')}`);
  }
  if (!input.launchPinVerified) {
    reasons.push(
      'the launch configuration does not pin both EXPECTED_REFEREE_DID and EXPECTED_PACKAGE_HASH',
    );
  }
  if (input.expectedRefereeDid === null) {
    reasons.push('no referee DID pinned');
  } else if (input.refereeDid === null) {
    reasons.push('referee DID unknown');
  } else if (input.refereeDid !== input.expectedRefereeDid) {
    reasons.push(`referee DID is not the pinned one (${input.refereeDid})`);
  }
  // Narrowed here rather than trusting the caller: the seed-shaped refusals are
  // exactly what a late start exists to drop, and a caller that passed the
  // verifier's raw list must not be able to reintroduce them by accident.
  for (const blocker of lateStartFeedBlockerReasons(input.refereeFeedBlockers)) {
    reasons.push(`referee feed blocked: ${blocker}`);
  }
  if (!input.refereeSeen) reasons.push('no post from the pinned referee has been accepted yet');
  return { ready: reasons.length === 0, reasons };
}

export interface LateStartRegistrationReadinessInputs extends LateStartFeedReadinessInputs {
  /** `FLOP_ALLOW_REGISTRATION`. */
  allowRegistration: boolean;
  /** Every agent in the fleet is present and enabled: 5 groups of 30. */
  fleetComplete: boolean;
  /** The writer is accepting work and SQLite is writable. */
  writerHealthy: boolean;
  /** The nonce store is usable, so no registration can reuse a counter. */
  nonceStoreUsable: boolean;
  /** The real wall-clock lock: false once `rules.lockAt` has passed. */
  lockBefore: boolean;
  /** True when `lockAt` parsed. False is a refusal, never a reason to post. */
  lockValid: boolean;
}

/**
 * May this process post its owner registrations from a seedless start?
 *
 * The feed gate plus the write lane, plus the contest's own wall-clock lock.
 * `historicalReplayComplete` is deliberately *not* a clause: an owner
 * registration is a fresh message with a fresh nonce, and the referee mints it
 * at the next sweep. Nothing about it needs the opening price.
 *
 * The wall clock *is* a clause, and it is independent of the referee's sweep.
 * A registration that arrives after the published lock cannot mint, so the one
 * gate that holds it back must not be a feed that could still be reporting the
 * last sweep before the lock.
 */
export function lateStartRegistrationReadiness(
  input: LateStartRegistrationReadinessInputs,
): Readiness {
  const reasons = [...lateStartFeedReadiness(input).reasons];
  // Ahead of the write-lane clauses: "the contest is over" outranks "a switch
  // is off", and the reason has to say which it was.
  if (!input.lockBefore) {
    reasons.push(input.lockValid ? WALL_CLOCK_LOCKED_REASON : WALL_CLOCK_INVALID_REASON);
  }
  if (!input.allowRegistration) {
    reasons.push('FLOP_ALLOW_REGISTRATION is off; owner registrations are not posted');
  }
  if (!input.fleetComplete) reasons.push('the agent fleet is not complete (150 agents, 5 groups of 30)');
  if (!input.writerHealthy) reasons.push('the writer cannot accept a registration post');
  if (!input.nonceStoreUsable) {
    reasons.push('the nonce store is not usable; a duplicate registration is possible');
  }
  return { ready: reasons.length === 0, reasons };
}

export interface MarketSnapshotReadinessInputs {
  /** The pinned referee has posted something this verifier accepted. */
  refereeSeen: boolean;
  sweep: number | null;
  reference: string | null;
  /** The band the referee published for the next sweep. */
  limits: { low: string; high: string } | null;
  /** The sweep that band applies to — the price post's `for`. */
  limitsForSweep: number | null;
  /** False when the posting carried no `for`, or one that names another sweep. */
  limitsUsable: boolean;
  locked: boolean;
  /** Seconds since the referee last posted anything accepted. */
  secondsSinceLastPost: number | null;
  sweepSeconds: number;
  /** The widest tolerated age of the newest post, in sweeps. */
  maxStaleSweeps: number;
}

/**
 * May a new trade be priced from what the referee has published *now*?
 *
 * This is the whole replacement for the seed in a late start: a price post that
 * is signed by the pinned referee, carries a band for the very next sweep, and
 * is recent enough that it still describes the contest. Every clause is about
 * the current post — none of them is about the opening.
 */
export function marketSnapshotReadiness(input: MarketSnapshotReadinessInputs): Readiness {
  const reasons: string[] = [];
  if (!input.refereeSeen) {
    reasons.push('no post from the pinned referee has been accepted yet');
  }
  if (input.locked) reasons.push('the contest is locked');
  if (input.sweep === null) reasons.push('no current sweep from the referee feed');
  if (input.reference === null) reasons.push('no reference price from the referee feed');
  if (input.limits === null) {
    reasons.push('no published limits from the referee feed');
  } else {
    const low = Number.parseFloat(input.limits.low);
    const high = Number.parseFloat(input.limits.high);
    if (!(low > 0) || !(high > 0) || !(low < high)) {
      reasons.push(`the published band ${input.limits.low}..${input.limits.high} is not usable`);
    }
  }
  if (!input.limitsUsable) {
    reasons.push('the published limits may not price a live trade');
  }
  if (input.limitsForSweep === null) {
    reasons.push('the published limits carry no `for` sweep');
  } else if (input.sweep !== null && input.limitsForSweep !== input.sweep + 1) {
    reasons.push(`the published limits are for sweep ${input.limitsForSweep}, not ${input.sweep + 1}`);
  }
  const window = Math.max(1, input.maxStaleSweeps) * Math.max(1, input.sweepSeconds);
  if (input.secondsSinceLastPost === null) {
    reasons.push('the referee feed carries no accepted post to age');
  } else if (input.secondsSinceLastPost > window) {
    reasons.push(
      `the newest referee post is ${Math.round(input.secondsSinceLastPost)}s old, past the ${window}s window`,
    );
  }
  return { ready: reasons.length === 0, reasons };
}

/** The shape the registration gate reports, shared by the gate and `/status`. */
export interface RegistrationGateFacts {
  registrationPostAcked: number;
  registrationExpected: number;
  registrationPending: number;
  registrationFailed: number;
  registrationUnresolvedMissed: boolean;
}

/**
 * Why a trade may not precede owner registration, phrased once.
 *
 * Every clause is a fact about the register, never about a mint: the referee
 * naming our DID in a flow is a separate, later fact, and a sweep whose flow was
 * omitted leaves it unknown. Requiring it here would turn "the referee did not
 * publish this sweep's flow" into "this owner is not registered", which is
 * exactly the conflation the layered counts exist to prevent.
 */
export function registrationGateReason(input: RegistrationGateFacts): string {
  if (input.registrationUnresolvedMissed) {
    return 'owner registration has unresolved missed messages';
  }
  if (input.registrationFailed > 0) {
    return `owner registration has ${input.registrationFailed} failed message(s); a trade cannot precede registration`;
  }
  const pending =
    input.registrationPending > 0 ? `, ${input.registrationPending} pending` : '';
  return `owner registration is not ready: ${input.registrationPostAcked}/${input.registrationExpected} owner messages acknowledged${pending}`;
}

export interface LateStartTradingReadinessInputs {
  /** The late-start feed gate, nested: the trust boundary cannot be skipped. */
  lateStartFeed: Readiness;
  /** `FLOP_ALLOW_TRADING` **and** `LATE_START_ALLOW_TRADING`. */
  tradingArmed: boolean;
  /** The current price post: sweep, reference, band, `for`, freshness. */
  marketSnapshot: Readiness;
  /**
   * The reader's mode-aware "may the current post price a trade".
   *
   * Distinct from the historical audit: a resolved cursor gap or an old omitted
   * flow leaves the audit dirty forever without making the *current* post any
   * less tradeable. This is the current-only answer, and it is the same one the
   * strategy decision reads, so the gate and the decision cannot disagree.
   */
  currentMarketUsable: boolean;
  /** Why the current post may not price a trade; null when it may. */
  currentMarketBlockedReason: string | null;
  /**
   * Every expected owner has a persisted registration with a `technocore_seq`.
   *
   * Registration is a *precondition* of trading, never a substitute for it. A
   * trade written before its owner is on the register would settle against an
   * account the referee has not minted, and the close-1 participation rule is
   * that a trade is preceded by its owner's registration.
   */
  registrationReady: boolean;
  registrationPostAcked: number;
  registrationExpected: number;
  registrationPending: number;
  registrationFailed: number;
  /** A local owner registration was reported missed and not yet re-issued. */
  registrationUnresolvedMissed: boolean;
  /** The real wall-clock lock, independent of the referee's own sweep. */
  wallClockBeforeLock: boolean;
  /** True when `lockAt` parsed; false fails closed. */
  wallClockLockValid: boolean;
  loadAllowsNewOffer: boolean;
  writerHealthy: boolean;
  nonceStoreUsable: boolean;
  packageDrift: boolean;
  fleetComplete: boolean;
  /**
   * One of our own trade messages was reported `missed` and could not be
   * re-issued. A public gap is a coverage fact; this is a fact about our trade.
   */
  localTradeUnresolved: boolean;
  /** A local trade, offer or re-post provably falls inside the close1 gap. */
  localMessageInGap: boolean;
}

/**
 * May a trade be written from a seedless late start?
 *
 * Strictly a superset of the feed gate, and deliberately *not* a relaxation of
 * the strict trading gate — it is a different gate with a different anchor. The
 * strict one anchors on a replayed history that begins at the seed; this one
 * anchors on the pinned referee's current, signed, well-formed price post. The
 * things the strict gate refuses that this one does not — a coverage gap in the
 * public room, and a reference the referee itself calls old — are the things
 * that cannot be repaired from a late start, and treating them as fatal is how
 * a process ends up refusing to participate at all.
 */
export function lateStartTradingReadiness(input: LateStartTradingReadinessInputs): Readiness {
  const reasons: string[] = [];
  // The wall clock first: it is the one clause no feed can reopen.
  if (!input.wallClockBeforeLock) {
    reasons.push(input.wallClockLockValid ? WALL_CLOCK_LOCKED_REASON : WALL_CLOCK_INVALID_REASON);
  }
  // Registration before trade, and never the other way round.
  if (!input.registrationReady) {
    reasons.push(registrationGateReason(input));
  }
  if (!input.lateStartFeed.ready) {
    reasons.push(...input.lateStartFeed.reasons.map((reason) => `late-start feed: ${reason}`));
  }
  if (!input.tradingArmed) {
    reasons.push(
      'trading is not armed for late-start: FLOP_ALLOW_TRADING and LATE_START_ALLOW_TRADING must both be true',
    );
  }
  if (!input.marketSnapshot.ready) {
    reasons.push(...input.marketSnapshot.reasons.map((reason) => `market snapshot: ${reason}`));
  }
  // The current market, named separately from the snapshot clauses so a refusal
  // says *which* current fact held it rather than only "not ready".
  if (!input.currentMarketUsable) {
    reasons.push(`current market: ${input.currentMarketBlockedReason ?? 'not usable'}`);
  }
  if (input.localMessageInGap) {
    reasons.push('a local trade, offer or re-post message provably falls inside the close1 gap');
  }
  if (input.localTradeUnresolved) {
    reasons.push('a local trade was reported missed and has not been re-issued yet');
  }
  if (!input.writerHealthy) {
    reasons.push('the writer cannot accept a trade or SQLite is unwritable');
  }
  if (!input.nonceStoreUsable) {
    reasons.push('the nonce store is not usable; a trade could reuse a counter');
  }
  if (!input.loadAllowsNewOffer) reasons.push('load guard blocks new offers');
  if (input.packageDrift) reasons.push('package hash drift');
  if (!input.fleetComplete) reasons.push('the fleet is not complete');
  return { ready: reasons.length === 0, reasons };
}

/**
 * Is the referee *feed* provable?
 *
 * Every clause is a fact, never an inference: a seed we accepted, a sender that
 * matches the pin, a package that matches the pin, a verifier rebuilt from
 * durable history, a reader that is actually running over the five rooms, and no
 * referee room carrying a recorded loss. This gate says nothing about `close1`
 * and nothing about whether a trade could be priced.
 *
 * A recorded loss in a referee room is a permanent refusal, not a transient one:
 * the whole contest record comes from those five rooms, so a hole in them is a
 * hole in the evidence, and there is no policy under which that is acceptable.
 * The distinction between "still open" and "recovered" is only in what the
 * operator is told.
 */
export function refereeFeedReadiness(input: RefereeFeedReadinessInputs): Readiness {
  const reasons: string[] = [];
  if (!input.readerContinuous) {
    reasons.push('continuous reader is off; the fixed rooms are not being read');
  } else if (!input.readerRunning) {
    reasons.push('continuous reader is not running');
  }
  if (input.refereeRoomCount !== input.expectedRefereeRoomCount) {
    reasons.push(
      `reader owns ${input.refereeRoomCount} referee rooms, expected ${input.expectedRefereeRoomCount}`,
    );
  }
  if (input.refereeRoomsWithUnresolvedGap.length > 0) {
    reasons.push(
      `unresolved cursor gap in referee room(s) ${input.refereeRoomsWithUnresolvedGap.join(', ')}`,
    );
  } else if (input.refereeRoomsWithGap.length > 0) {
    // Still a refusal: a recorded loss in a referee room is permanent evidence
    // and is never cleared by a recovery. The distinction is only in *what the
    // operator is told* — an open gap means the reader is still losing, a
    // recovered one means it caught up but the loss happened.
    reasons.push(
      `recorded cursor gap in referee room(s) ${input.refereeRoomsWithGap.join(', ')} (recovered, still on the record)`,
    );
  }
  if (input.refereeRoomsReset.length > 0) {
    reasons.push(`referee room recreated: ${input.refereeRoomsReset.join(', ')}`);
  }
  if (!input.seedSeen) reasons.push('referee seed not read');
  for (const blocker of input.refereeFeedBlockers) {
    reasons.push(`referee feed blocked: ${blocker}`);
  }
  if (input.refereeDid === null) {
    reasons.push('referee DID unknown');
  } else if (input.expectedRefereeDid !== null && input.refereeDid !== input.expectedRefereeDid) {
    reasons.push(`referee DID is not the pinned one (${input.refereeDid})`);
  } else if (input.expectedRefereeDid === null && input.requirePin) {
    reasons.push('no referee DID pinned');
  }
  if (input.packageHash === null) {
    reasons.push('seed package hash unknown');
  } else if (input.expectedPackageHash !== null && input.packageHash !== input.expectedPackageHash) {
    reasons.push('seed package hash differs from the pinned package');
  }
  if (!input.profileLaneOk) reasons.push('profile/lane configuration does not match the profile');
  if (!input.hydrated) reasons.push('verifier not hydrated from stored referee history');
  // A sweep without a reference or without limits cannot price anything, and the
  // two come from the referee's own room: they are feed facts, not trading ones.
  if (!input.hasReference) reasons.push('no reference price from the referee feed');
  if (!input.hasLimits) reasons.push('no published limits from the referee feed');
  if (!input.currentSweepRecoverable) {
    reasons.push('the official sweep is not recoverable from stored referee history');
  }
  return { ready: reasons.length === 0, reasons };
}

/**
 * May this process post its 150 owner registrations?
 *
 * The feed gate, plus everything registration itself needs. Crucially, a `close1`
 * gap does **not** by itself refuse registration: `close1` is a high-traffic
 * public room that will keep gapping, the referee feed is the five structured
 * rooms, and making the whole contest hinge on catching up a 17-million-message
 * public room is how a process ends up never registering at all. What does
 * refuse is a gap that could have swallowed *our own* write — that is a fact
 * about our registration record, not about the public feed.
 *
 * Three of the clauses are deliberately about our own machinery rather than the
 * referee: the fleet has to be whole, the writer has to be able to accept and
 * commit a post, and the nonce store has to be usable. A registration post that
 * cannot be recorded durably, or that could reuse a counter, is not a
 * registration — and duplicating one is refused outright.
 *
 * Duplication is refused structurally rather than by a flag here: a registration
 * row is keyed by agent id, a row that was already echoed back is never posted
 * again, and the writer reserves a fresh nonce before signing every attempt, so
 * a retry after a lost reply cannot reuse the counter that probably landed. The
 * gate therefore only has to assert that the lane those guarantees live in is
 * sound, which is what `nonceStoreUsable` and `writerHealthy` are.
 */
export function registrationReadiness(input: RegistrationReadinessInputs): Readiness {
  const feed = refereeFeedReadiness(input);
  const reasons = [...feed.reasons];
  // ---- our own writes may have been lost: never a policy question ----------
  if (input.localMessageInGap) {
    reasons.push('a local registration message provably falls inside the recorded close1 gap');
  }
  if (input.tradingRoomCriticalGap) {
    reasons.push(
      `close1 gap may contain one of our own messages: ${input.tradingRoomCriticalGapRooms.join(', ') || 'close1'}`,
    );
  }
  if (input.tradingRoomUnattainable) {
    reasons.push('close1 catch-up unattainable under current API capacity');
  }
  // ---- a plain public coverage gap is a policy question -------------------
  if (
    input.tradingRoomHasCoverageGap &&
    !input.tradingRoomCriticalGap &&
    !input.localMessageInGap &&
    !input.allowRegistrationWithClose1Gap &&
    input.close1GapPolicy === 'block'
  ) {
    reasons.push(
      'close1 carries a recorded gap and CLOSE1_GAP_POLICY=block (ALLOW_REGISTRATION_WITH_CLOSE1_GAP=false)',
    );
  }
  // ---- our own machinery --------------------------------------------------
  if (!input.fleetComplete) reasons.push('the agent fleet is not complete (150 agents, 5 groups of 30)');
  if (!input.writerHealthy) reasons.push('the writer cannot accept a registration post');
  if (!input.nonceStoreUsable) reasons.push('the nonce store is not usable; a duplicate registration is possible');
  if (!input.durableEvidenceWritable) reasons.push('durable evidence cannot be written');
  return { ready: reasons.length === 0, reasons };
}

export interface TradingReadinessInputs {
  /**
   * The registration gate, not the feed gate.
   *
   * Trading is strictly downstream of registration, so a process that may not
   * post its registrations may not trade either — and a caller that passed the
   * feed gate here would be treating "the referee is provable" as "we are
   * registered", which is the substitution this type exists to prevent.
   */
  registration: Readiness;
  conservative: boolean;
  conservativeReasons: string[];
  sweep: number | null;
  hasReference: boolean;
  limits: { low: string; high: string } | null;
  limitsUsable: boolean;
  limitsForSweep: number | null;
  staleReference: boolean;
  locked: boolean;
  loadAllowsNewOffer: boolean;
  packageDrift: boolean;
  fleetComplete: boolean;
  /** Live, with registration enabled: every agent must be read back first. */
  registrationRequired: boolean;
  registrationReadbackComplete: boolean;
  /** `CLOSE1_GAP_POLICY`, so the refusal can name which rule produced it. */
  close1GapPolicy: 'block' | 'degraded_readonly';
  /**
   * The trading room passed the full caught-up test.
   *
   * This is the only thing that satisfies the coverage clause. `degraded_readonly`
   * does *not*: it keeps reading, reporting and registration alive, and it never
   * permits a trade — `close1 普通 coverage gap 时 degraded_readonly 仍禁止 trading`.
   */
  close1FullyCaughtUp: boolean;
  /** The trading room's measured `producer - persisted` backlog, messages/minute. */
  close1NetPersistBacklogRate: number;
  /** At least one room has a recorded gap that is not operationally closed. */
  unresolvedGap: boolean;
  /** The trading room's catch-up was measured to be unattainable. */
  close1Unattainable: boolean;
  /**
   * A local trade, offer or re-post message provably falls inside the band.
   *
   * Stronger than the registration equivalent: a trade is the thing the contest
   * is scored on, so a band that is known to hide one is never tradeable.
   */
  localMessageInGap: boolean;
  /** The writer is accepting work and SQLite is writable. */
  writerHealthy: boolean;
  /**
   * `ALLOW_TRADING_WITH_CLOSE1_GAP` — and it is never sufficient on its own.
   *
   * Set to `true` the trade is *still* blocked unless a deliberate, recorded
   * override exists. The flag exists so an operator can say "I accept a plain
   * public coverage gap", and it is deliberately not a switch that turns the
   * gate off: a config value with no author, no reason and no timestamp is not
   * a decision anybody can be held to.
   */
  allowTradingWithClose1Gap: boolean;
  /** The recorded override `allowTradingWithClose1Gap` requires to mean anything. */
  manualOverride: { operator: string; reason: string; at: string } | null;
}

/**
 * May a new trade be written right now?
 *
 * This mirrors, in one place, every condition the trade path already enforced
 * separately — the referee gate, the lock, the package pin, the load guard, the
 * `for` label and the stale clock — plus the three coverage conditions a live
 * trade needs: the trading room fully caught up, a backlog that is not widening,
 * and a gap policy that permits trading at all. `degraded_readonly` never does:
 * the coverage clause is satisfied by `fully_caught_up` alone, so a gap in
 * `close1` refuses every trade whichever policy is set, and the report says so
 * rather than calling the room covered.
 */
export function tradingReadiness(input: TradingReadinessInputs): Readiness {
  const reasons: string[] = [];
  if (!input.registration.ready) {
    reasons.push(...input.registration.reasons.map((reason) => `registration: ${reason}`));
  }
  if (input.conservative) {
    reasons.push(`conservative mode: ${input.conservativeReasons.join('; ') || 'unlabelled'}`);
  }
  // A local trade is an absolute refusal: no override, no policy and no deadline
  // may make a band that is known to hide our own trade acceptable.
  if (input.localMessageInGap) {
    reasons.push('a local trade, offer or re-post message provably falls inside the close1 gap');
  }
  if (input.close1Unattainable) {
    reasons.push('close1 catch-up is unattainable under current API capacity');
  }
  if (!input.close1FullyCaughtUp) {
    // The only clause an explicit, recorded override may waive — and only the
    // plain-coverage part of it. Everything else above stays absolute.
    const overridden = input.allowTradingWithClose1Gap && input.manualOverride !== null;
    if (!overridden) {
      const why =
        input.allowTradingWithClose1Gap && input.manualOverride === null
          ? 'ALLOW_TRADING_WITH_CLOSE1_GAP is set but no manual override is recorded (operator, reason, time); the default is to block'
          : input.close1GapPolicy === 'degraded_readonly'
            ? 'close1 is not fully caught up; degraded_readonly permits observation only, never a trade'
            : 'close1 is not fully caught up (CLOSE1_GAP_POLICY=block)';
      reasons.push(why);
    }
  }
  if (input.unresolvedGap) {
    reasons.push('an unresolved cursor gap remains on the record');
  }
  if (!input.writerHealthy) {
    reasons.push('the writer cannot accept a trade or SQLite is unwritable');
  }
  if (input.close1NetPersistBacklogRate > 0) {
    reasons.push(
      `close1 net persisted backlog is positive (${input.close1NetPersistBacklogRate}/min): the producer outruns what reaches SQLite`,
    );
  }
  if (input.sweep === null) reasons.push('no current sweep');
  if (!input.hasReference) reasons.push('no reference price');
  if (input.limits === null) {
    reasons.push('no published limits');
  } else if (!input.limitsUsable) {
    reasons.push('published limits may not price a live trade');
  }
  if (input.limitsForSweep === null) {
    reasons.push('published limits carry no `for` sweep');
  } else if (input.sweep !== null && input.limitsForSweep !== input.sweep + 1) {
    reasons.push(`published limits are for sweep ${input.limitsForSweep}, not ${input.sweep + 1}`);
  }
  if (input.staleReference) reasons.push('reference is stale');
  if (input.locked) reasons.push('the contest is locked');
  if (!input.loadAllowsNewOffer) reasons.push('load guard blocks new offers');
  if (input.packageDrift) reasons.push('package hash drift');
  if (!input.fleetComplete) reasons.push('the fleet is not complete');
  if (input.registrationRequired && !input.registrationReadbackComplete) {
    reasons.push('owner registrations are not all read back');
  }
  return { ready: reasons.length === 0, reasons };
}
