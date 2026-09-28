/**
 * The five fixed Close Call strategy groups, exactly 30 agents each.
 *
 * Every profile is a pure function of the context: no clock, no I/O, no model
 * call, no randomness beyond the agent's own stable seed. That is what makes a
 * run reproducible and a decision explainable — the same context always yields
 * the same proposal, and `reason` plus `indicators` say why.
 *
 * Each profile returns a *proposal*. Position sizing, caps, limits, funding and
 * the lock are enforced afterwards by `deterministic-gate.ts`, so no profile can
 * post something the risk engine would refuse. "Not trading" is a first-class
 * outcome everywhere: the contest ranks every owner however little they traded,
 * and an unnecessary trade pays two fees.
 */
import { Decimal, MarketSnapshot } from './types.js';
import {
  StrategyContext,
  StrategyProposal,
  noTrade,
} from './types.js';
import { ema, highest, indicatorRecord, lowest, pctChange, slopeFraction, volatility } from './indicators.js';

export interface StrategyProfile {
  group: StrategyContext['group'];
  /** Bumped whenever the logic below changes, so decisions are attributable. */
  version: string;
  evaluate(context: StrategyContext): StrategyProposal;
}

/** Clamp a fraction into [0, 1]. */
function fraction(value: Decimal): Decimal {
  if (value.lt(0)) return Decimal.zero();
  if (value.gt(1)) return Decimal.from(1);
  return value;
}

/** Number of history points needed before a profile will act at all. */
function enoughHistory(context: StrategyContext, needed: number): boolean {
  return context.market.history.length >= needed;
}

// ---------------------------------------------------------------------------
// 1. trend_following
// ---------------------------------------------------------------------------

/**
 * Short-window slope, confirmed by the slower window.
 *
 *   - slope of the last `fastWindow` reference prices, as a fraction of price;
 *   - only trade when |slope| clears `slopeThreshold`;
 *   - require the slow window to agree in sign, which filters one-sweep noise;
 *   - high volatility shrinks the size rather than blocking the trade, because a
 *     trending market is often a volatile one;
 *   - a flat market is `flat`, and flat means NO_TRADE.
 */
export const trendFollowing: StrategyProfile = {
  group: 'trend_following',
  version: 'trend-v1',
  evaluate(context) {
    const { market, params } = context;
    const fast = Number(params.fastWindow!);
    const slow = Number(params.slowWindow!);
    const threshold = params.slopeThreshold!;
    const volatilityCap = params.volatilityCap!;
    const baseFraction = params.sizeFraction!;

    const fastSlope = slopeFraction(market.history, fast);
    const slowSlope = slopeFraction(market.history, slow);
    const recentVol = volatility(market.history, slow);
    const indicators = indicatorRecord({ fastSlope, slowSlope, volatility: recentVol });

    if (!enoughHistory(context, slow) || fastSlope === null || slowSlope === null) {
      return noTrade('insufficient_history', indicators);
    }
    if (market.reference === null) return noTrade('no_reference', indicators);
    if (fastSlope.abs().lt(threshold)) return noTrade('flat', indicators);
    if (fastSlope.isZero() || slowSlope.isZero() || fastSlope.isPositive() !== slowSlope.isPositive()) {
      return noTrade('windows_disagree', indicators);
    }

    const side = fastSlope.isPositive() ? 'buy' : 'sell';
    // Confidence scales with how far the signal clears its threshold, capped at
    // 1. `min(1, |slope| / (2 * threshold))` gives 0.5 exactly at the threshold.
    const strength = fraction(fastSlope.abs().div(threshold.mul(2)));
    let size = baseFraction.mul(Decimal.from('0.5').add(strength.div(2)));
    let reason = side === 'buy' ? 'trend_up' : 'trend_down';

    if (recentVol !== null && recentVol.gt(volatilityCap)) {
      // High volatility: quarter the size. The trend may be real and the range of
      // outcomes is wide, so we participate smaller rather than sit out.
      size = size.div(4);
      reason = `${reason}_high_vol`;
    }
    return {
      intent: 'MAKE_OFFER',
      side,
      sizeFraction: fraction(size),
      confidence: fraction(Decimal.from('0.5').add(strength.div(2))),
      reason,
      indicators,
    };
  },
};

// ---------------------------------------------------------------------------
// 2. mean_reversion
// ---------------------------------------------------------------------------

/**
 * Fade a stretched price back toward its EMA.
 *
 *   - `emaWindow` reference prices give the fair value;
 *   - a deviation beyond `deviationThreshold` is the entry;
 *   - high volatility switches the group off entirely — fading a market that is
 *     repricing is how a reversion strategy loses;
 *   - within `edgeBuffer` of either limit edge the group stands down, because the
 *     referee's window is about to bind and the fill is not worth the fee.
 */
export const meanReversion: StrategyProfile = {
  group: 'mean_reversion',
  version: 'meanrev-v1',
  evaluate(context) {
    const { market, params } = context;
    const window = Number(params.emaWindow!);
    const deviationThreshold = params.deviationThreshold!;
    const volatilityCap = params.volatilityCap!;
    const edgeBuffer = params.edgeBuffer!;
    const baseFraction = params.sizeFraction!;

    const fair = ema(market.history, window);
    const recentVol = volatility(market.history, window);
    const reference = market.reference;
    const deviation = fair === null || reference === null ? null : pctChange(fair, reference);
    const indicators = indicatorRecord({ ema: fair, deviation, volatility: recentVol });

    if (!enoughHistory(context, window) || fair === null || reference === null || deviation === null) {
      return noTrade('insufficient_history', indicators);
    }
    if (recentVol !== null && recentVol.gt(volatilityCap)) {
      return noTrade('volatility_cap', indicators);
    }
    if (market.limits !== null) {
      const span = market.limits.high.sub(market.limits.low);
      const buffer = span.mul(edgeBuffer);
      if (
        reference.sub(market.limits.low).lt(buffer) ||
        market.limits.high.sub(reference).lt(buffer)
      ) {
        return noTrade('near_limit_edge', indicators);
      }
    }
    if (deviation.abs().lt(deviationThreshold)) return noTrade('near_fair_value', indicators);

    // Price above the EMA: sell it back down. Below: buy it back up.
    const side = deviation.isPositive() ? 'sell' : 'buy';
    const strength = fraction(deviation.abs().div(deviationThreshold.mul(3)));
    return {
      intent: 'MAKE_OFFER',
      side,
      sizeFraction: fraction(baseFraction.mul(Decimal.from('0.5').add(strength.div(2)))),
      confidence: fraction(Decimal.from('0.5').add(strength.div(2))),
      reason: side === 'sell' ? 'fade_up' : 'fade_down',
      indicators,
    };
  },
};

// ---------------------------------------------------------------------------
// 3. breakout
// ---------------------------------------------------------------------------

/**
 * Trade a confirmed break of the recent range, once.
 *
 *   - the range is the highest and lowest reference of the last `window` sweeps;
 *   - `breakBuffer` clearance is required, so a price merely touching the edge is
 *     not a breakout;
 *   - `maxChase` refuses to pay up for a move that has already run;
 *   - a `sameDirectionStreak` at or above `cooldownSweeps` switches the group off,
 *     which is the rule against chasing the same move forever.
 */
export const breakout: StrategyProfile = {
  group: 'breakout',
  version: 'breakout-v1',
  evaluate(context) {
    const { market, params } = context;
    const window = Number(params.window!);
    const breakBuffer = params.breakBuffer!;
    const cooldown = Number(params.cooldownSweeps!);
    const maxChase = params.maxChase!;
    const baseFraction = params.sizeFraction!;

    const rangeHigh = highest(market.history, window);
    const rangeLow = lowest(market.history, window);
    const reference = market.reference;
    const indicators = indicatorRecord({
      rangeHigh,
      rangeLow,
      distanceFromHigh: rangeHigh && reference ? pctChange(rangeHigh, reference) : null,
      distanceFromLow: rangeLow && reference ? pctChange(reference, rangeLow) : null,
      streak: Decimal.from(context.sameDirectionStreak),
    });

    if (!enoughHistory(context, window) || rangeHigh === null || rangeLow === null || reference === null) {
      return noTrade('insufficient_history', indicators);
    }
    if (context.sameDirectionStreak >= cooldown) return noTrade('cooldown', indicators);

    const above = pctChange(rangeHigh, reference);
    const below = pctChange(reference, rangeLow);
    const isUp = above.gte(breakBuffer);
    const isDown = below.gte(breakBuffer);
    if (!isUp && !isDown) return noTrade('inside_range', indicators);
    if (isUp && isDown) return noTrade('ambiguous_range', indicators);

    const side = isUp ? 'buy' : 'sell';
    const excursion = isUp ? above : below;
    if (excursion.gt(breakBuffer.add(maxChase))) return noTrade('too_far_to_chase', indicators);

    // Confidence is highest just past the buffer and decays toward maxChase.
    const overshoot = excursion.sub(breakBuffer).div(maxChase);
    const confidence = fraction(Decimal.from('0.55').add(Decimal.from('0.35').mul(Decimal.from(1).sub(fraction(overshoot)))));
    return {
      intent: 'MAKE_OFFER',
      side,
      sizeFraction: fraction(baseFraction.mul(confidence)),
      confidence,
      reason: side === 'buy' ? 'breakout_up' : 'breakout_down',
      indicators,
    };
  },
};

// ---------------------------------------------------------------------------
// 4. contrarian
// ---------------------------------------------------------------------------

/**
 * Fade a single over-large sweep move, with the smallest size of any group.
 *
 *   - `moveThreshold` is the one-sweep move that counts as over-moved;
 *   - a trend stronger than `trendCutoff` disables the group: fading a real trend
 *     is the mistake this profile exists to avoid;
 *   - `maxEntriesPerWindow` caps entries, so the group cannot keep adding to a
 *     losing fade. This is the default-lowest-risk tier by construction: the
 *     smallest `sizeFraction` bound, a `max_qty` of 10 and the highest confidence
 *     threshold.
 */
export const contrarian: StrategyProfile = {
  group: 'contrarian',
  version: 'contrarian-v1',
  evaluate(context) {
    const { market, params } = context;
    const moveThreshold = params.moveThreshold!;
    const trendCutoff = params.trendCutoff!;
    const baseFraction = params.sizeFraction!;
    const maxEntries = Number(params.maxEntriesPerWindow!);

    const history = market.history;
    const last = history.length >= 1 ? history[history.length - 1]! : null;
    const previous = history.length >= 2 ? history[history.length - 2]! : null;
    const move = last === null || previous === null ? null : pctChange(previous, last);
    const trend = slopeFraction(history, 6);
    const indicators = indicatorRecord({ move, trend, entries: Decimal.from(context.sameDirectionStreak) });

    if (move === null || trend === null) return noTrade('insufficient_history', indicators);
    if (context.sameDirectionStreak >= maxEntries) return noTrade('entry_cap', indicators);
    if (trend.abs().gt(trendCutoff)) return noTrade('strong_trend', indicators);
    if (move.abs().lt(moveThreshold)) return noTrade('no_overreaction', indicators);

    // The move went up, so we sell into it, and vice versa.
    const side = move.isPositive() ? 'sell' : 'buy';
    const strength = fraction(move.abs().div(moveThreshold.mul(3)));
    return {
      intent: 'MAKE_OFFER',
      side,
      sizeFraction: fraction(baseFraction.mul(Decimal.from('0.5').add(strength.div(2)))),
      confidence: fraction(Decimal.from('0.45').add(strength.div(2))),
      reason: side === 'sell' ? 'fade_spike_up' : 'fade_spike_down',
      indicators,
    };
  },
};

// ---------------------------------------------------------------------------
// 5. external_offer_taker
// ---------------------------------------------------------------------------

/**
 * Take someone else's offer; never post one.
 *
 * This group does not create maker offers at all. It reads the trading room for
 * open `taker:"any"` offers whose maker is a genuinely external DID, and takes
 * the best one that clears `maxSpreadFromReference`. The safety work is not here:
 * `validateExternalOffer` in `@flop/close-call` re-checks the maker signature,
 * the price window, the id, the deadline, the lock and our funding, and refuses
 * any offer made by one of our own DIDs. This profile only ranks what it is
 * shown, and prefers a bigger edge at a smaller size.
 */
export const externalOfferTaker: StrategyProfile = {
  group: 'external_offer_taker',
  version: 'taker-v1',
  evaluate(context) {
    const { market, params, externalOffers } = context;
    const minEdge = params.maxSpreadFromReference!;
    const minQty = params.minQty!;
    const maxQty = params.maxQty!;
    const notionalFraction = params.maxOpenNotionalFraction!;
    const reference = market.reference;

    if (reference === null) return noTrade('no_reference', indicatorRecord({ offers: Decimal.from(externalOffers.length) }));
    if (externalOffers.length === 0) {
      return noTrade('no_external_offers', indicatorRecord({ offers: Decimal.zero() }));
    }

    let best: { offer: (typeof externalOffers)[number]; edge: Decimal; qty: Decimal } | null = null;
    for (const offer of externalOffers) {
      const px = Decimal.from(offer.terms.px);
      const qty = Decimal.from(offer.terms.qty);
      if (qty.lt(minQty) || qty.gt(maxQty)) continue;
      // Maker sells to us: we want px below the reference. Maker buys from us: we
      // want px above it. Either way the edge is signed in our favour.
      const edge = offer.terms.side === 'sell' ? pctChange(px, reference) : pctChange(reference, px);
      if (edge.lt(minEdge)) continue;
      if (best === null || edge.gt(best.edge)) best = { offer, edge, qty };
    }

    const indicators = indicatorRecord({
      offers: Decimal.from(externalOffers.length),
      bestEdge: best?.edge ?? null,
    });
    if (best === null) return noTrade('no_offer_meets_edge', indicators);

    const notional = best.qty.mul(Decimal.from(best.offer.terms.px));
    const budget = context.caps.maxOpenNotional.mul(notionalFraction);
    if (context.openNotional.add(notional).gt(budget)) {
      return noTrade('offer_exceeds_budget', indicators);
    }

    // Confidence grows with the edge, saturating at 3x the minimum.
    const strength = fraction(best.edge.div(minEdge.mul(3)));
    const confidence = fraction(Decimal.from('0.5').add(strength.div(2)));
    return {
      intent: 'ACCEPT_EXTERNAL',
      side: best.offer.terms.side === 'sell' ? 'buy' : 'sell',
      sizeFraction: Decimal.from(1),
      confidence,
      reason: 'take_external_offer',
      indicators,
      offer: best.offer,
    };
  },
};

export const STRATEGY_PROFILES: Record<StrategyContext['group'], StrategyProfile> = {
  trend_following: trendFollowing,
  mean_reversion: meanReversion,
  breakout,
  contrarian,
  external_offer_taker: externalOfferTaker,
};

export function profileFor(group: StrategyContext['group']): StrategyProfile {
  const profile = STRATEGY_PROFILES[group];
  if (!profile) throw new Error(`unknown strategy group: ${String(group)}`);
  return profile;
}

export function evaluateGroup(group: StrategyContext['group'], context: StrategyContext): StrategyProposal {
  return profileFor(group).evaluate(context);
}

export type { MarketSnapshot };
