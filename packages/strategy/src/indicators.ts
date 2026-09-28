/**
 * Deterministic indicators over the referee's reference-price history.
 *
 * Everything is `Decimal`, because these values feed price and quantity
 * decisions and a float that drifts by 1e-15 can push a rounded price outside
 * the 5% window. Division is the only inexact operation and it is bounded.
 *
 * "History" is the sequence of reference prices the referee has posted, in sweep
 * order, oldest first. The reference is Hyperliquid's last `xyz:NVDA` trade at
 * that sweep's close, so it is the only honest input available: there is no
 * order book and no candle in this contest.
 */
import { Decimal } from '@flop/close-call';

/** Simple mean of the last `n` values, or null when there is not enough history. */
export function sma(values: Decimal[], n: number): Decimal | null {
  if (n <= 0 || values.length < n) return null;
  const window = values.slice(values.length - n);
  let total = Decimal.zero();
  for (const value of window) total = total.add(value);
  return total.div(String(n));
}

/**
 * Exponential moving average, seeded with the SMA of the first `n` values and
 * then advanced with k = 2/(n+1). Deterministic: no smoothing constant guessing.
 */
export function ema(values: Decimal[], n: number): Decimal | null {
  if (n <= 0 || values.length < n) return null;
  const seed = sma(values.slice(0, n), n);
  if (seed === null) return null;
  const k = Decimal.from(2).div(String(n + 1));
  let current = seed;
  for (const value of values.slice(n)) {
    current = value.mul(k).add(current.mul(Decimal.from(1).sub(k)));
  }
  return current;
}

/**
 * Least-squares slope over the last `n` values, expressed as a fraction of the
 * window's mean price per step. Using a fraction rather than an absolute price
 * delta is what makes one threshold meaningful across a $150 and a $250 NVDA.
 */
export function slopeFraction(values: Decimal[], n: number): Decimal | null {
  if (n < 2 || values.length < n) return null;
  const window = values.slice(values.length - n);
  const count = window.length;
  const meanX = Decimal.from(count - 1).div('2');
  let meanY = Decimal.zero();
  for (const value of window) meanY = meanY.add(value);
  meanY = meanY.div(String(count));
  if (meanY.isZero()) return null;

  let numerator = Decimal.zero();
  let denominator = Decimal.zero();
  for (let index = 0; index < count; index += 1) {
    const dx = Decimal.from(index).sub(meanX);
    numerator = numerator.add(dx.mul(window[index]!.sub(meanY)));
    denominator = denominator.add(dx.mul(dx));
  }
  if (denominator.isZero()) return null;
  return numerator.div(denominator).div(meanY);
}

/**
 * Volatility of the last `n` percentage changes, as a standard deviation of
 * returns. Population standard deviation (divide by n), not sample: the window
 * is the whole population we are reasoning about, and it keeps the value stable
 * at small n.
 */
export function volatility(values: Decimal[], n: number): Decimal | null {
  if (n < 2 || values.length < n + 1) return null;
  const window = values.slice(values.length - (n + 1));
  const returns: Decimal[] = [];
  for (let index = 1; index < window.length; index += 1) {
    const previous = window[index - 1]!;
    if (previous.isZero()) continue;
    returns.push(window[index]!.sub(previous).div(previous));
  }
  if (returns.length < 2) return null;
  let mean = Decimal.zero();
  for (const value of returns) mean = mean.add(value);
  mean = mean.div(String(returns.length));
  let variance = Decimal.zero();
  for (const value of returns) {
    const deviation = value.sub(mean);
    variance = variance.add(deviation.mul(deviation));
  }
  variance = variance.div(String(returns.length));
  return sqrt(variance);
}

/** Converged when successive Newton steps differ by less than 1e-20. */
const SQRT_EPSILON = Decimal.from('0.00000000000000000001');

/** Newton's method square root; input must be >= 0. */
export function sqrt(value: Decimal): Decimal {
  if (value.isZero()) return Decimal.zero();
  if (value.isNegative()) throw new Error('sqrt of a negative number');
  let guess = value.gt(1) ? value : Decimal.from(1);
  for (let iteration = 0; iteration < 80; iteration += 1) {
    const next = guess.add(value.div(guess)).div('2');
    if (next.sub(guess).abs().lt(SQRT_EPSILON)) return next;
    guess = next;
  }
  return guess;
}

/** Highest value in the last `n` values. */
export function highest(values: Decimal[], n: number): Decimal | null {
  if (n <= 0 || values.length < n) return null;
  return values.slice(values.length - n).reduce((best, value) => (value.gt(best) ? value : best));
}

/** Lowest value in the last `n` values. */
export function lowest(values: Decimal[], n: number): Decimal | null {
  if (n <= 0 || values.length < n) return null;
  return values.slice(values.length - n).reduce((best, value) => (value.lt(best) ? value : best));
}

/** Signed percentage change from `from` to `to`. */
export function pctChange(from: Decimal, to: Decimal): Decimal {
  if (from.isZero()) return Decimal.zero();
  return to.sub(from).div(from);
}

/** 1 when `value` is at or above `threshold`, else 0. Handy for confidence maths. */
export function atLeast(value: Decimal, threshold: Decimal): 1 | 0 {
  return value.gte(threshold) ? 1 : 0;
}

/** A compact, loggable rendering of a set of indicator values. */
export function indicatorRecord(values: Record<string, Decimal | null>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(values)) out[key] = value === null ? 'null' : value.toString();
  return out;
}
