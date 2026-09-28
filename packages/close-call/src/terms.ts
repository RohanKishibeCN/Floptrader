/**
 * Trade terms and their canonical serialisation.
 *
 * The terms object has exactly these keys, serialised with sorted keys and no
 * spaces, and its bytes are what both signatures cover:
 *
 *   {"id":"a7f3","maker":"did:key:z6MkA…","px":"181.20","qty":"2",
 *    "side":"sell","taker":"any","until":1236}
 *
 *   maker signs   close-1|terms|<terms>
 *   taker signs   close-1|accept|<terms>|<taker did:key>
 *
 * `qty` and `px` are decimal strings with at most two decimals, `until` is a
 * sweep number, and `side` is the *maker's* side. `Decimal` strings are not
 * cosmetic: the fold parses them with exact arithmetic and rejects a float.
 */
import { randomBytes } from 'node:crypto';
import { canonicalJson } from '@flop/identity';
import { Decimal } from './decimal.js';
import { AMOUNT_SCHEMA, DID_SCHEMA, TRADE_ID_SCHEMA, TradeTerms, TradeTermsSchema } from './models.js';
import { SEASON } from './rules.js';

export const TERMS_KEYS = ['id', 'maker', 'px', 'qty', 'side', 'taker', 'until'] as const;

export function termsPayload(terms: TradeTerms): Uint8Array {
  return new TextEncoder().encode(canonicalJson(terms as unknown as Record<string, unknown>));
}

export function makerSignaturePayload(terms: TradeTerms): Uint8Array {
  return new TextEncoder().encode(`${SEASON}|terms|${canonicalJson(terms as unknown as Record<string, unknown>)}`);
}

export function takerSignaturePayload(terms: TradeTerms, takerDid: string): Uint8Array {
  return new TextEncoder().encode(
    `${SEASON}|accept|${canonicalJson(terms as unknown as Record<string, unknown>)}|${takerDid}`,
  );
}

/** The fold's `TWO_PLACES` convention: at most two decimals, above zero. */
export function isAmountString(text: unknown): text is string {
  return typeof text === 'string' && AMOUNT_SCHEMA.safeParse(text).success && Decimal.from(text).gt(0);
}

export function isValidTradeId(text: unknown): text is string {
  return typeof text === 'string' && TRADE_ID_SCHEMA.safeParse(text).success;
}

/**
 * Validate and normalise raw terms. Returns the parsed terms plus the reason it
 * was refused, mirroring the fold's `shape` verdict field by field so a local
 * refusal and a void reason never disagree.
 */
export type TermsCheck =
  | { ok: true; terms: TradeTerms }
  | { ok: false; reason: 'shape'; detail: string };

export function checkTermsShape(raw: unknown): TermsCheck {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return { ok: false, reason: 'shape', detail: 'terms must be an object' };
  }
  const candidate = raw as Record<string, unknown>;
  if (!isValidTradeId(candidate.id)) {
    return { ok: false, reason: 'shape', detail: 'id must match [A-Za-z0-9_-]{1,64}' };
  }
  if (typeof candidate.maker !== 'string' || !DID_SCHEMA.safeParse(candidate.maker).success) {
    return { ok: false, reason: 'shape', detail: 'maker must be a did:key' };
  }
  if (!isAmountString(candidate.px)) {
    return { ok: false, reason: 'shape', detail: 'px must be a decimal string with at most 2 decimals' };
  }
  if (!isAmountString(candidate.qty)) {
    return { ok: false, reason: 'shape', detail: 'qty must be a decimal string with at most 2 decimals' };
  }
  if (candidate.side !== 'buy' && candidate.side !== 'sell') {
    return { ok: false, reason: 'shape', detail: 'side must be buy or sell' };
  }
  if (candidate.taker !== 'any' && !(typeof candidate.taker === 'string' && DID_SCHEMA.safeParse(candidate.taker).success)) {
    return { ok: false, reason: 'shape', detail: 'taker must be "any" or a did:key' };
  }
  if (typeof candidate.until !== 'number' || !Number.isInteger(candidate.until)) {
    return { ok: false, reason: 'shape', detail: 'until must be an integer sweep number' };
  }
  const parsed = TradeTermsSchema.safeParse(candidate);
  if (!parsed.success) {
    return { ok: false, reason: 'shape', detail: parsed.error.issues.map((issue) => issue.message).join('; ') };
  }
  return { ok: true, terms: parsed.data as TradeTerms };
}

export interface BuildTermsOptions {
  maker: string;
  side: 'buy' | 'sell';
  qty: Decimal | string;
  px: Decimal | string;
  until: number;
  taker?: string;
  id?: string;
}

/**
 * Build terms with a unique id. The id must be unique because "an id settles at
 * most once, so the first countersigned copy of an open offer wins" — a repeated
 * id turns a second trade into a void.
 */
export function buildTerms(options: BuildTermsOptions): TradeTerms {
  const qty = Decimal.from(options.qty);
  const px = Decimal.from(options.px);
  if (qty.lt('0.1')) throw new Error(`qty ${qty} is below the 0.1 minimum`);
  const terms: TradeTerms = {
    id: options.id ?? generateTradeId(options.maker, options.side),
    maker: options.maker,
    px: formatAmount(px),
    qty: formatAmount(qty),
    side: options.side,
    taker: options.taker ?? 'any',
    until: options.until,
  };
  const check = checkTermsShape(terms);
  if (!check.ok) throw new Error(`built terms are invalid: ${check.detail}`);
  return terms;
}

/**
 * `<8 hex chars><decimal ms><side>`: unique per maker and side without a
 * coordination round trip, and always inside the 64-character id limit.
 */
export function generateTradeId(maker: string, side: 'buy' | 'sell', entropy = randomBytes(4)): string {
  const suffix = maker.slice(-6).replace(/[^A-Za-z0-9_-]/g, '');
  return `${Buffer.from(entropy).toString('hex')}${Date.now().toString(36)}${side[0]}${suffix}`.slice(0, 64);
}

/**
 * A wire amount: at most two decimals, no scientific notation, no trailing
 * zeros. `2.00` and `2` are both legal on the wire; this picks the short form.
 */
export function formatAmount(value: Decimal | string | number): string {
  return Decimal.from(value).quantize(2).normalize().toString();
}
