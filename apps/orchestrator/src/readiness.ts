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

export interface Readiness {
  ready: boolean;
  reasons: string[];
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
