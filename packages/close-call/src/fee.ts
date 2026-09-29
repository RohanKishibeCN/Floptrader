/**
 * The fee rule, ported from the official fold.
 *
 *   base = fee_rate * qty * px            each side pays 1% of the trade's value
 *   gap  = (close - px) * qty             positive when the buyer paid under the close
 *   buyer  pays max(base,  gap)
 *   seller pays max(base, -gap)
 *
 * "The side that got a better price than the sweep's closing price pays that
 * difference times the quantity instead, if it is more." Fees leave play.
 *
 * Note `Decimal.max` returns whichever operand wins, preserving its scale: the
 * fold prints `36.0000` for `0.01 * 20 * 180.00`, and the string form is part of
 * the fold's output.
 */
import { Decimal } from './decimal.js';

export interface SideFees {
  /** The fee paid by the maker, who is on `side`. */
  maker: Decimal;
  /** The fee paid by the countersigner, who is on the opposite side. */
  taker: Decimal;
}

export function sideFees(
  side: 'buy' | 'sell',
  qty: Decimal,
  px: Decimal,
  close: Decimal,
  feeRate: Decimal,
): SideFees {
  const base = feeRate.mul(qty).mul(px);
  const gap = close.sub(px).mul(qty);
  const buyer = Decimal.max(base, gap);
  const seller = Decimal.max(base, gap.neg());
  return side === 'buy' ? { maker: buyer, taker: seller } : { maker: seller, taker: buyer };
}

/**
 * Both sides' fees when one key is on both sides of the trade: it pays both, and
 * its position does not change.
 */
export function selfTradeFee(
  side: 'buy' | 'sell',
  qty: Decimal,
  px: Decimal,
  close: Decimal,
  feeRate: Decimal,
): Decimal {
  const fees = sideFees(side, qty, px, close, feeRate);
  return fees.maker.add(fees.taker);
}

/**
 * The largest move between consecutive references the contest tolerates.
 *
 * The sweep's closing price is "Hyperliquid's last trade before the sweep ends",
 * which is what the next sweep's reference reports. A larger move than this
 * between consecutive references is an anomaly the verifier refuses to trade on,
 * so inside normal operation a close cannot be further than this from the
 * reference that preceded it — which is what makes a worst case computable at all
 * for a fee that is priced by a price nobody has seen yet.
 */
export const MAX_REFERENCE_MOVE = Decimal.from('0.25');

/**
 * The worst-case fee one side can pay when the sweep's close is not yet known.
 *
 * The clawback is priced by the close, and the close is published only when the
 * sweep ends — so a taker answering an offer right now cannot know it. Pricing the
 * fee at the reference assumes the market does not move in between, and that
 * assumption fails in exactly the case that matters: when the move is against us.
 * An understated fee is a trade the referee voids for funds.
 *
 * So this bounds it instead. The buyer pays most when the close lands high and the
 * seller when it lands low, and neither can land more than `MAX_REFERENCE_MOVE`
 * from the reference that set the limits.
 */
export function worstCaseSideFee(
  side: 'buy' | 'sell',
  qty: Decimal,
  px: Decimal,
  reference: Decimal,
  feeRate: Decimal,
  maxMove: Decimal = MAX_REFERENCE_MOVE,
): Decimal {
  const close =
    side === 'buy'
      ? reference.mul(Decimal.from(1).add(maxMove))
      : reference.mul(Decimal.from(1).sub(maxMove));
  // `sideFees` names its two sides maker and taker, so the fee belonging to
  // `side` is the one it calls `maker`.
  return sideFees(side, qty, px, close, feeRate).maker;
}

/** Numeric side convention used throughout: buy is +1, sell is -1. */
export function sideSign(side: 'buy' | 'sell'): 1 | -1 {
  return side === 'buy' ? 1 : -1;
}
