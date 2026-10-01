/**
 * Readiness: the two gates between "we can see the room" and "we may act".
 *
 * A dry run may read, evaluate and report while neither gate is satisfied — that
 * is what makes it a rehearsal. Live is different: `refereeReady` is what lets
 * the 150 owner registrations be posted, and `tradingReady` is what lets a trade
 * be written. Both are derived here, from facts the process already holds, so
 * that the same reasons appear in the gate, in `status()` and in the report.
 *
 * The two are deliberately separate. `refereeReady` is about *identity and
 * provenance* — do we know who the referee is, is the seed genuine, does the
 * package match what we were launched against, and is the stored history behind
 * it intact. `tradingReady` is about *whether a trade can be priced at all*
 * right now, and it is strictly downstream of `refereeReady`.
 */

export interface Readiness {
  ready: boolean;
  reasons: string[];
}

export interface RefereeReadinessInputs {
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
  /** The profile and lane configuration match the profile being run. */
  profileLaneOk: boolean;
  /** Every agent in the fleet is present and enabled. */
  fleetComplete: boolean;
  /** A seed post was read, signature-checked and accepted. */
  seedSeen: boolean;
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
}

/**
 * May this process treat the referee as established, and post its registrations?
 *
 * Every clause is a fact, never an inference: a seed we accepted, a sender that
 * matches the pin, a package that matches the pin, a verifier rebuilt from
 * durable history, and no referee room carrying a recorded loss.
 *
 * The five referee rooms and the trading room are graded separately, because
 * they are genuinely different questions. A gap in any referee room means the
 * referee feed itself is incomplete, and there is no policy under which that is
 * acceptable — the whole contest record comes from those five rooms. A gap in
 * `close1` is graded by `CLOSE1_GAP_POLICY`, and it can never be waved through
 * when it might hide one of our own messages.
 */
export function refereeReadiness(input: RefereeReadinessInputs): Readiness {
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
  if (input.tradingRoomCriticalGap) {
    reasons.push(
      `close1 gap may contain one of our own messages: ${input.tradingRoomCriticalGapRooms.join(', ') || 'close1'}`,
    );
  }
  if (input.tradingRoomUnattainable) {
    reasons.push('close1 catch-up unattainable under current API capacity');
  }
  if (input.tradingRoomHasCoverageGap && input.close1GapPolicy === 'block') {
    reasons.push('close1 carries a recorded gap and CLOSE1_GAP_POLICY=block');
  }
  if (!input.seedSeen) reasons.push('referee seed not read');
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
  if (!input.fleetComplete) reasons.push('the agent fleet is not complete');
  if (!input.hydrated) reasons.push('verifier not hydrated from stored referee history');
  return { ready: reasons.length === 0, reasons };
}

export interface TradingReadinessInputs {
  referee: Readiness;
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
  if (!input.referee.ready) {
    reasons.push(...input.referee.reasons.map((reason) => `referee: ${reason}`));
  }
  if (input.conservative) {
    reasons.push(`conservative mode: ${input.conservativeReasons.join('; ') || 'unlabelled'}`);
  }
  if (!input.close1FullyCaughtUp) {
    // Named by policy so an operator can tell "the room is behind" from "the room
    // is behind and we deliberately chose to keep observing anyway".
    reasons.push(
      input.close1GapPolicy === 'degraded_readonly'
        ? 'close1 is not fully caught up; degraded_readonly permits observation only, never a trade'
        : 'close1 is not fully caught up (CLOSE1_GAP_POLICY=block)',
    );
  }
  if (input.unresolvedGap) {
    reasons.push('an unresolved cursor gap remains on the record');
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
