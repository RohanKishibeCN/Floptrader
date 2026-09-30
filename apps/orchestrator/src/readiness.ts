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
  /** Referee rooms whose cursor generation was reset. */
  refereeRoomsReset: string[];
  /** Whether a referee DID was required to be pinned at launch. */
  requirePin: boolean;
}

/**
 * May this process treat the referee as established?
 *
 * Every clause is a fact, never an inference: a seed we accepted, a sender that
 * matches the pin, a package that matches the pin, a verifier that has been
 * rebuilt from durable history, and no referee room that was recreated underneath
 * it. Nothing here "adopts the first sender" — an unpinned process fails the
 * gate, which is the point.
 */
export function refereeReadiness(input: RefereeReadinessInputs): Readiness {
  const reasons: string[] = [];
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
  if (!input.hydrated) reasons.push('verifier not hydrated from stored referee history');
  if (input.refereeRoomsReset.length > 0) {
    reasons.push(`referee room recreated: ${input.refereeRoomsReset.join(', ')}`);
  }
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
}

/**
 * May a new trade be written right now?
 *
 * This mirrors, in one place, every condition the trade path already enforced
 * separately — the referee gate, the lock, the package pin, the load guard, the
 * `for` label and the stale clock — plus the two whole-fleet conditions a live
 * launch needs. The trade path still checks what it must; this is the single
 * answer the report and the operator can both read.
 */
export function tradingReadiness(input: TradingReadinessInputs): Readiness {
  const reasons: string[] = [];
  if (!input.referee.ready) {
    reasons.push(...input.referee.reasons.map((reason) => `referee: ${reason}`));
  }
  if (input.conservative) {
    reasons.push(`conservative mode: ${input.conservativeReasons.join('; ') || 'unlabelled'}`);
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
