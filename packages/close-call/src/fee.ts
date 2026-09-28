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

/** Numeric side convention used throughout: buy is +1, sell is -1. */
export function sideSign(side: 'buy' | 'sell'): 1 | -1 {
  return side === 'buy' ? 1 : -1;
}
