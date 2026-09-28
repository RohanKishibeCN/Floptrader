/**
 * Exact decimal arithmetic, faithful to Python's `decimal.Decimal`.
 *
 * Close Call settles with exact decimals: "its scores sum to minus the fees
 * exactly". A JavaScript float cannot express that, and the official fold's
 * *string output* also depends on Decimal's scale propagation — `0.01 * 20 *
 * 180.00` prints `36.0000`, not `36`. So this is a scaled-BigInt decimal with
 * Python's scale rules, not a round-to-two-places helper:
 *
 *   add/sub  result scale = max(scaleA, scaleB)     (Python: min of exponents)
 *   mul      result scale = scaleA + scaleB
 *   neg/abs  scale preserved
 *   div      rounded to a working precision, ROUND_HALF_EVEN
 *   quantize explicit scale, ROUND_HALF_EVEN by default
 *
 * Rounding is banker's rounding everywhere, matching Python's default context.
 */
export type Rounding = 'half-even' | 'half-up' | 'down';

export class DecimalError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DecimalError';
  }
}

const PATTERN = /^[+-]?(\d+)(?:\.(\d+))?$/;

export class Decimal {
  /** value = unscaled / 10^scale ; scale >= 0 */
  readonly unscaled: bigint;
  readonly scale: number;

  private constructor(unscaled: bigint, scale: number) {
    this.unscaled = unscaled;
    this.scale = scale;
  }

  static from(value: string | number | bigint | Decimal): Decimal {
    if (value instanceof Decimal) return value;
    if (typeof value === 'bigint') return new Decimal(value, 0);
    if (typeof value === 'number') {
      if (!Number.isFinite(value)) throw new DecimalError(`not a finite decimal: ${value}`);
      if (Number.isInteger(value)) return new Decimal(BigInt(value), 0);
      return Decimal.parse(value.toString());
    }
    return Decimal.parse(value);
  }

  static parse(text: string): Decimal {
    if (typeof text !== 'string') throw new DecimalError(`expected a decimal string, got ${typeof text}`);
    const match = PATTERN.exec(text.trim());
    if (!match) throw new DecimalError(`invalid decimal: ${JSON.stringify(text)}`);
    const sign = text.trim().startsWith('-') ? -1n : 1n;
    const fraction = match[2] ?? '';
    const digits = `${match[1]}${fraction}`;
    return new Decimal(sign * BigInt(digits === '' ? '0' : digits), fraction.length);
  }

  static zero(): Decimal {
    return new Decimal(0n, 0);
  }

  /** Re-scale to exactly `scale` decimal places. */
  private rescale(scale: number): bigint {
    if (scale === this.scale) return this.unscaled;
    if (scale > this.scale) return this.unscaled * 10n ** BigInt(scale - this.scale);
    return this.unscaled / 10n ** BigInt(this.scale - scale);
  }

  private static align(a: Decimal, b: Decimal): { left: bigint; right: bigint; scale: number } {
    const scale = Math.max(a.scale, b.scale);
    return { left: a.rescale(scale), right: b.rescale(scale), scale };
  }

  add(other: Decimal | string | number | bigint): Decimal {
    const right = Decimal.from(other);
    const { left, right: r, scale } = Decimal.align(this, right);
    return new Decimal(left + r, scale);
  }

  sub(other: Decimal | string | number | bigint): Decimal {
    const right = Decimal.from(other);
    const { left, right: r, scale } = Decimal.align(this, right);
    return new Decimal(left - r, scale);
  }

  mul(other: Decimal | string | number | bigint): Decimal {
    const right = Decimal.from(other);
    return new Decimal(this.unscaled * right.unscaled, this.scale + right.scale);
  }

  neg(): Decimal {
    return new Decimal(-this.unscaled, this.scale);
  }

  abs(): Decimal {
    return this.unscaled < 0n ? this.neg() : this;
  }

  isZero(): boolean {
    return this.unscaled === 0n;
  }

  isNegative(): boolean {
    return this.unscaled < 0n;
  }

  isPositive(): boolean {
    return this.unscaled > 0n;
  }

  /** -1, 0 or 1. */
  cmp(other: Decimal | string | number | bigint): -1 | 0 | 1 {
    const right = Decimal.from(other);
    const { left, right: r } = Decimal.align(this, right);
    if (left < r) return -1;
    if (left > r) return 1;
    return 0;
  }

  gt(other: Decimal | string | number | bigint): boolean {
    return this.cmp(other) > 0;
  }

  gte(other: Decimal | string | number | bigint): boolean {
    return this.cmp(other) >= 0;
  }

  lt(other: Decimal | string | number | bigint): boolean {
    return this.cmp(other) < 0;
  }

  lte(other: Decimal | string | number | bigint): boolean {
    return this.cmp(other) <= 0;
  }

  eq(other: Decimal | string | number | bigint): boolean {
    return this.cmp(other) === 0;
  }

  static max(a: Decimal, b: Decimal): Decimal {
    return a.gte(b) ? a : b;
  }

  static min(a: Decimal, b: Decimal): Decimal {
    return a.lte(b) ? a : b;
  }

  /** Sum, preserving the widest scale, exactly like Python's `sum`. */
  static sum(values: Iterable<Decimal>, start: Decimal = Decimal.zero()): Decimal {
    let total = start;
    for (const value of values) total = total.add(value);
    return total;
  }

  /**
   * Division at a working precision (default 40 decimal places), ROUND_HALF_EVEN.
   * The official fold runs with `prec=60` significant digits; 40 decimal places
   * exceeds anything the contest's price magnitudes can need, and `quantize` is
   * what fixes the digits that are actually printed.
   */
  div(other: Decimal | string | number | bigint, precision = 40): Decimal {
    const right = Decimal.from(other);
    if (right.unscaled === 0n) throw new DecimalError('division by zero');
    const targetScale = Math.max(precision, this.scale, right.scale);
    // (a / 10^sa) / (b / 10^sb) = (a * 10^(sb + targetScale - sa)) / b / 10^targetScale
    const shift = right.scale + targetScale - this.scale;
    const numerator = shift >= 0 ? this.unscaled * 10n ** BigInt(shift) : this.unscaled;
    const denominator = shift >= 0 ? right.unscaled : right.unscaled * 10n ** BigInt(-shift);
    const quotient = divideRounded(numerator, denominator, 'half-even');
    return new Decimal(quotient, targetScale);
  }

  /** Force a scale, rounding half-to-even. `19.005` at 2dp -> `19.00`. */
  quantize(scale: number, rounding: Rounding = 'half-even'): Decimal {
    if (!Number.isInteger(scale) || scale < 0) throw new DecimalError(`bad scale ${scale}`);
    if (scale >= this.scale) return new Decimal(this.rescale(scale), scale);
    const factor = 10n ** BigInt(this.scale - scale);
    return new Decimal(divideRounded(this.unscaled, factor, rounding), scale);
  }

  /** Drop trailing zeros, the way `Decimal.normalize()` does. */
  normalize(): Decimal {
    let unscaled = this.unscaled;
    let scale = this.scale;
    while (scale > 0 && unscaled % 10n === 0n) {
      unscaled /= 10n;
      scale -= 1;
    }
    return new Decimal(unscaled, scale);
  }

  /** Python-compatible string form: the scale is part of the representation. */
  toString(): string {
    const negative = this.unscaled < 0n;
    const digits = (negative ? -this.unscaled : this.unscaled).toString();
    if (this.scale === 0) return `${negative ? '-' : ''}${digits}`;
    const padded = digits.padStart(this.scale + 1, '0');
    const whole = padded.slice(0, padded.length - this.scale);
    const fraction = padded.slice(padded.length - this.scale);
    return `${negative ? '-' : ''}${whole}.${fraction}`;
  }

  toJSON(): string {
    return this.toString();
  }
}

/** Integer division with an explicit rounding mode (both operands share a sign). */
function divideRounded(numerator: bigint, denominator: bigint, rounding: Rounding): bigint {
  if (denominator === 0n) throw new DecimalError('division by zero');
  const negative = numerator < 0n !== denominator < 0n;
  const absNumerator = numerator < 0n ? -numerator : numerator;
  const absDenominator = denominator < 0n ? -denominator : denominator;
  const quotient = absNumerator / absDenominator;
  const remainder = absNumerator % absDenominator;
  if (remainder === 0n) return negative ? -quotient : quotient;

  let increment = false;
  if (rounding === 'down') {
    increment = false;
  } else if (rounding === 'half-up') {
    increment = remainder * 2n >= absDenominator;
  } else {
    const doubled = remainder * 2n;
    if (doubled > absDenominator) increment = true;
    else if (doubled === absDenominator) increment = quotient % 2n === 1n; // half-to-even
  }
  const magnitude = increment ? quotient + 1n : quotient;
  return negative ? -magnitude : magnitude;
}
