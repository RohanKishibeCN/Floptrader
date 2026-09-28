/**
 * The gate every trade passes before it is posted or accepted.
 *
 * Reasons are named to line up with the fold's void reasons (`shape`,
 * `not_owner`, `taker`, `settled`, `expired`, `locked`, `limits`, `funds`) plus
 * the local refusals the fold cannot express (`signature`, `local_did`,
 * `self_trade`, `duplicate`, `conservative`, `not_ours`). A local refusal and a
 * referee void should never disagree; when they do, the fold's verdict is
 * authoritative and the decision is logged as a divergence.
 *
 * The order below is the fold's order, with signature checks first: nothing else
 * is worth checking on a trade whose signatures do not verify, and verifying them
 * is the only way to know who the two sides really are.
 */
import { Decimal } from './decimal.js';
import { TradeTerms } from './models.js';
import { sideFees } from './fee.js';
import { fundsReason, RiskAccount } from './risk.js';
import { Rules, SEASON, withinLimits } from './rules.js';
import { checkTermsShape } from './terms.js';
import { verifyMakerSignature, verifyTakerSignature } from './trade-signing.js';

export type TradeRefusal =
  | 'shape'
  | 'signature'
  | 'taker'
  | 'not_owner'
  | 'settled'
  | 'duplicate'
  | 'expired'
  | 'locked'
  | 'limits'
  | 'funds'
  | 'self_trade'
  | 'local_did'
  | 'conservative'
  | 'not_ours';

export interface TradeVerdict {
  ok: boolean;
  reason: TradeRefusal | null;
  detail: string;
}

const OK: TradeVerdict = { ok: true, reason: null, detail: 'ok' };

function refuse(reason: TradeRefusal, detail: string): TradeVerdict {
  return { ok: false, reason, detail };
}

export interface TradeValidationContext {
  rules: Rules;
  /** The sweep in which this trade would settle. */
  sweep: number;
  /** The reference the previous sweep posted; sets this sweep's limits. */
  reference: Decimal | null;
  /** This sweep's closing price, which prices the clawback. */
  close: Decimal | null;
  /** Every DID this process controls; a trade between two of them is refused. */
  localDids: Set<string>;
  /** Trade ids already applied, from local records and the referee's flow. */
  settledIds: Set<string>;
  /** Balances and positions as the referee last published them. */
  accounts: Map<string, RiskAccount>;
  /** True when the reader is degraded; no new active risk. */
  conservative: boolean;
  /**
   * Whether a trade between two of our own DIDs should be refused. It is always
   * true for the orchestrator: 150 owners trading with each other moves no value
   * and only pays fees. Exposed as a flag so the fold-comparison test can turn it
   * off when replaying referee output.
   */
  refuseLocalPairing?: boolean;
  /** When true, missing accounts are tolerated (external counterparties). */
  tolerateUnknownAccounts?: boolean;
}

export interface TradeCandidate {
  terms: TradeTerms;
  taker: string;
  maker_sig: string;
  taker_sig: string;
}

export function validateTrade(candidate: TradeCandidate, context: TradeValidationContext): TradeVerdict {
  const { terms, taker, maker_sig: makerSig, taker_sig: takerSig } = candidate;

  // --- shape, in the fold's field order ---------------------------------
  const shape = checkTermsShape(terms);
  if (!shape.ok) return refuse('shape', shape.detail);
  if (terms.qty !== shape.terms.qty || terms.px !== shape.terms.px) {
    return refuse('shape', 'qty/px are not in canonical decimal form');
  }
  if (Decimal.from(terms.qty).lt(context.rules.minQty)) {
    return refuse('shape', `qty ${terms.qty} is below the ${context.rules.minQty} minimum`);
  }

  // --- signatures -------------------------------------------------------
  if (!verifyMakerSignature(terms, makerSig)) {
    return refuse('signature', 'maker signature does not verify over close-1|terms|<terms>');
  }
  if (!takerSig) {
    return refuse('signature', 'taker signature is missing: an open offer is not yet a trade');
  }
  if (!verifyTakerSignature(terms, taker, takerSig)) {
    return refuse('signature', 'taker signature does not verify over close-1|accept|<terms>|<taker>');
  }
  if (terms.maker === taker) {
    return refuse('self_trade', 'maker and countersigner are the same key');
  }

  // --- identity and pairing --------------------------------------------
  if (terms.taker !== 'any' && terms.taker !== taker) {
    return refuse('taker', `terms name ${terms.taker} but ${taker} countersigned`);
  }
  const refuseLocal = context.refuseLocalPairing !== false;
  if (refuseLocal && context.localDids.has(terms.maker) && context.localDids.has(taker)) {
    return refuse(
      'local_did',
      'both sides are local DIDs: an internal trade moves no value and pays two fees',
    );
  }
  const known = (did: string): boolean =>
    context.accounts.has(did) || context.tolerateUnknownAccounts === true;
  if (!known(terms.maker) || !known(taker)) {
    return refuse('not_owner', 'a side is not a registered owner we can see');
  }

  // --- sweep clock ------------------------------------------------------
  if (context.settledIds.has(terms.id)) {
    return refuse('settled', `id ${terms.id} has already settled`);
  }
  if (context.sweep > terms.until) {
    return refuse('expired', `sweep ${context.sweep} is past until ${terms.until}`);
  }
  if (context.sweep > context.rules.lockSweep) {
    return refuse('locked', `sweep ${context.sweep} is past the lock at ${context.rules.lockSweep}`);
  }

  // --- price window and funds ------------------------------------------
  if (context.reference === null) {
    return refuse('limits', 'no reference price from the previous sweep: cannot price the limits');
  }
  const px = Decimal.from(terms.px);
  if (!withinLimits(context.rules, px, context.reference)) {
    return refuse(
      'limits',
      `px ${terms.px} is outside ${context.reference} ± ${context.rules.limitWindow.mul(context.reference)}`,
    );
  }
  const close = context.close ?? context.reference;
  const fees = sideFees(terms.side, Decimal.from(terms.qty), px, close, context.rules.feeRate);
  const funds = fundsReason({
    maker: context.accounts.get(terms.maker),
    taker: context.accounts.get(taker),
    side: terms.side,
    qty: Decimal.from(terms.qty),
    px,
    close,
    feeRate: context.rules.feeRate,
    selfTrade: false,
    makerFee: fees.maker,
    takerFee: fees.taker,
  });
  if (funds) return refuse('funds', 'a side cannot cover the price of the contracts it opens plus its fee');

  if (context.conservative) {
    return refuse('conservative', 'reader is degraded: no new active risk');
  }
  return OK;
}

/**
 * Validate an external offer we are considering taking, from the taker's side.
 *
 * This is the `external_offer_taker` strategy's gate, and it is deliberately
 * stricter than `validateTrade`: the offer is an open `taker:"any"` maker offer
 * from a stranger, so the taker signature is absent by construction, and the
 * checks are the ones that matter to us — is the maker real, is the price inside
 * the limits, is the id unused, can we fund it, and is the maker genuinely
 * external?
 *
 * Refusals: `not_ours` when the maker is one of our own DIDs (the offer is
 * internal, so we must not take it), `limits`, `funds`, `settled`, `expired`,
 * `locked`, `shape`, `taker`.
 */
export function validateExternalOffer(
  offer: { terms: TradeTerms; maker_sig: string },
  context: TradeValidationContext & { takerDid: string },
): TradeVerdict {
  const { terms } = offer;
  const shape = checkTermsShape(terms);
  if (!shape.ok) return refuse('shape', shape.detail);
  if (Decimal.from(terms.qty).lt(context.rules.minQty)) {
    return refuse('shape', `qty ${terms.qty} is below the ${context.rules.minQty} minimum`);
  }
  if (terms.taker !== 'any' && terms.taker !== context.takerDid) {
    return refuse('taker', `offer is not open: it names ${terms.taker}`);
  }
  if (context.localDids.has(terms.maker)) {
    return refuse('not_ours', 'the offer was made by a local DID: internal trades are refused');
  }
  if (!verifyMakerSignature(terms, offer.maker_sig)) {
    return refuse('signature', 'maker signature does not verify');
  }
  if (context.settledIds.has(terms.id)) {
    return refuse('settled', `id ${terms.id} has already settled`);
  }
  if (context.sweep > terms.until) {
    return refuse('expired', `sweep ${context.sweep} is past until ${terms.until}`);
  }
  if (context.sweep > context.rules.lockSweep) {
    return refuse('locked', 'past the lock');
  }
  if (context.reference === null) {
    return refuse('limits', 'no reference price: cannot price the limits');
  }
  const px = Decimal.from(terms.px);
  if (!withinLimits(context.rules, px, context.reference)) {
    return refuse('limits', `px ${terms.px} is outside the 5% window around ${context.reference}`);
  }
  const close = context.close ?? context.reference;
  const qty = Decimal.from(terms.qty);
  // We are the taker, so our side is the opposite of the maker's.
  const ourSide = terms.side === 'buy' ? 'sell' : 'buy';
  const fees = sideFees(terms.side, qty, px, close, context.rules.feeRate);
  const ourAccount = context.accounts.get(context.takerDid);
  if (!ourAccount) return refuse('funds', 'our account is not funded yet');
  const ourFee = fees.taker;
  if (ourAccount.opening(ourSide === 'buy' ? 1 : -1, qty).mul(px).add(ourFee).gt(ourAccount.cash)) {
    return refuse('funds', 'we cannot cover the contracts this offer opens plus our fee');
  }
  if (context.conservative) {
    return refuse('conservative', 'reader is degraded: no new active risk');
  }
  return OK;
}

/** Fold-equivalent numeric side for the taker of a maker offer. */
export function takerSideOf(makerSide: 'buy' | 'sell'): 'buy' | 'sell' {
  return makerSide === 'buy' ? 'sell' : 'buy';
}

export { SEASON };
