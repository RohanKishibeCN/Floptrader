/**
 * The gate between a proposal and an observable action.
 *
 * A profile says "the trend is up, I would like to buy, confidence 0.7". This
 * turns that into "a maker offer for 4.00 at 224.31", or refuses with a named
 * reason. It is the only place quantities and prices are produced, so the rules
 * that bound them are stated once:
 *
 *   - quantity is `max_qty * sizeFraction`, floored to the 0.01 step, and must
 *     still clear the 0.1 minimum after flooring;
 *   - price is derived from the reference and clamped inside the referee's
 *     published band, then rounded to the 0.01 step in the direction that keeps
 *     it inside the band;
 *   - the market must not be locked, degraded, or missing a reference;
 *   - the local risk caps (`max_qty`, `max_open_notional`, cooldown, confidence
 *     threshold, conservative mode) must all pass.
 *
 * Nothing here consults the model. Parameters reach it as numbers already
 * validated against their bounds.
 */
import {
  Decimal,
  checkLocalCaps,
  isLocked,
  withinLimits,
  type Rules as RuleSet,
} from '@flop/close-call';
import { GatedAction, StrategyContext, StrategyProposal } from './types.js';

export interface GateInput {
  proposal: StrategyProposal;
  context: StrategyContext;
  rules: RuleSet;
}

/**
 * The maker asks for an edge over the reference: a quarter of the limit window,
 * which is 1.25% of the reference. Big enough to be worth the fee, small enough
 * that the offer is still inside the band after rounding, and fixed rather than
 * tuned — an untuned constant is one less thing to be wrong.
 */
const MAKER_EDGE_FRACTION = Decimal.from('0.25');

export function gateDecision(input: GateInput): GatedAction {
  const { proposal, context, rules } = input;
  const base: Pick<GatedAction, 'confidence' | 'reason' | 'indicators'> = {
    confidence: proposal.confidence,
    reason: proposal.reason,
    indicators: proposal.indicators,
  };

  if (proposal.intent === 'NO_TRADE') {
    return { ...base, intent: 'NO_TRADE', side: null, qty: null, px: null, gate: 'no_trade' };
  }
  if (context.market.reference === null || context.market.limits === null) {
    return { ...base, intent: 'NO_TRADE', side: null, qty: null, px: null, gate: 'no_reference' };
  }
  if (isLocked(rules, context.sweep) || context.market.locked) {
    return { ...base, intent: 'NO_TRADE', side: null, qty: null, px: null, gate: 'locked' };
  }
  // A stale reference is never rewritten — it is still the number the referee
  // enforces — but a quiet feed is no basis for adding risk. New offers stop
  // until a fresh price post arrives; reading continues either way.
  if (context.market.staleReference) {
    return { ...base, intent: 'NO_TRADE', side: null, qty: null, px: null, gate: 'stale_reference' };
  }
  if (context.market.degraded) {
    return {
      ...base,
      intent: 'NO_TRADE',
      side: null,
      qty: null,
      px: null,
      gate: `conservative:${context.market.degradedReason ?? 'reader_degraded'}`,
    };
  }

  // --- accepting an external offer: price and size come from the offer -------
  if (proposal.intent === 'ACCEPT_EXTERNAL') {
    const offer = proposal.offer;
    if (!offer) {
      return { ...base, intent: 'NO_TRADE', side: null, qty: null, px: null, gate: 'missing_offer' };
    }
    const qty = Decimal.from(offer.terms.qty);
    const px = Decimal.from(offer.terms.px);
    const caps = checkLocalCaps({
      caps: context.caps,
      qty,
      px,
      reference: context.market.reference,
      confidence: proposal.confidence,
      sweep: context.sweep,
      locked: false,
      lastTradeSweep: context.lastTradeSweep,
      openNotional: context.openNotional,
      conservative: context.market.degraded,
    });
    if (!caps.allowed) {
      return { ...base, intent: 'NO_TRADE', side: null, qty: null, px: null, gate: caps.reason, offer };
    }
    return {
      ...base,
      intent: 'ACCEPT_EXTERNAL',
      side: proposal.side,
      qty,
      px,
      offer,
      gate: 'ok',
    };
  }

  // --- making an offer: derive a bounded quantity and price ------------------
  const reference = context.market.reference;
  const side = proposal.side;
  if (side === null) {
    return { ...base, intent: 'NO_TRADE', side: null, qty: null, px: null, gate: 'missing_side' };
  }

  const rawQty = context.caps.maxQty.mul(proposal.sizeFraction);
  const qty = rawQty.quantize(2, 'down');
  if (qty.lt(rules.minQty)) {
    return { ...base, intent: 'NO_TRADE', side: null, qty: null, px: null, gate: 'qty_below_minimum' };
  }

  const px = offerPrice(side, reference, context.market.limits, rules);
  if (!withinLimits(rules, px, reference)) {
    return { ...base, intent: 'NO_TRADE', side: null, qty: null, px: null, gate: 'price_outside_limits' };
  }

  const caps = checkLocalCaps({
    caps: context.caps,
    qty,
    px,
    reference,
    confidence: proposal.confidence,
    sweep: context.sweep,
    locked: false,
    lastTradeSweep: context.lastTradeSweep,
    openNotional: context.openNotional,
    conservative: context.market.degraded,
  });
  if (!caps.allowed) {
    return { ...base, intent: 'NO_TRADE', side: null, qty: null, px: null, gate: caps.reason };
  }
  return { ...base, intent: 'MAKE_OFFER', side, qty, px, gate: 'ok' };
}

/**
 * A price inside the band, on the maker's favourable side of the reference.
 *
 * A buy offer sits below the reference; a sell offer above it. Rounding goes
 * *inward* (down for a buy, down for a sell) so that rounding can never push the
 * price out of the band; the subsequent `withinLimits` check is the backstop.
 */
export function offerPrice(
  side: 'buy' | 'sell',
  reference: Decimal,
  limits: { low: Decimal; high: Decimal },
  rules: RuleSet,
): Decimal {
  const edge = rules.limitWindow.mul(MAKER_EDGE_FRACTION).mul(reference);
  const desired = side === 'buy' ? reference.sub(edge) : reference.add(edge);
  const ceiling = limits.high.sub(rules.priceStep);
  const clamped = Decimal.min(Decimal.max(desired, limits.low), ceiling);
  const rounded = clamped.quantize(2, 'down');
  // After flooring, a buy must still be at or above the low edge.
  return Decimal.max(rounded, limits.low);
}

/** The gate's refusal reasons, for the decision log's `reason` column. */
export const GATE_REFUSALS = [
  'no_trade',
  'no_reference',
  'locked',
  'stale_reference',
  'missing_side',
  'missing_offer',
  'qty_below_minimum',
  'price_outside_limits',
  'qty_cap',
  'notional_cap',
  'cooldown',
  'confidence',
  'conservative_mode',
] as const;
