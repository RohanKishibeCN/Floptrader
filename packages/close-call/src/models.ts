/**
 * Wire models for everything the referee and owners post, plus the
 * `MarketSnapshot` the strategy layer reads.
 *
 * All room text is untrusted input. These schemas parse it; nothing here ever
 * acts on natural language found inside a message. Every schema is
 * `.passthrough()` because the live referee already emits fields the published
 * shapes do not mention (`age_s`, `applied`, `for`), and a strict schema would
 * drop a sweep the moment the referee adds a key.
 */
import { z } from 'zod';
import { Decimal } from './decimal.js';

export const DID_SCHEMA = z.string().regex(/^did:key:z6Mk[1-9A-HJ-NP-Za-km-z]{44}$/);
export const AMOUNT_SCHEMA = z.string().regex(/^[0-9]{1,7}(\.[0-9]{1,2})?$/);
export const TRADE_ID_SCHEMA = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/);

export const TradeTermsSchema = z
  .object({
    id: TRADE_ID_SCHEMA,
    maker: DID_SCHEMA,
    px: AMOUNT_SCHEMA,
    qty: AMOUNT_SCHEMA,
    side: z.enum(['buy', 'sell']),
    taker: z.union([z.literal('any'), DID_SCHEMA]),
    until: z.number().int(),
  })
  .passthrough();

export type TradeTerms = z.infer<typeof TradeTermsSchema>;

export const OwnerMessageSchema = z
  .object({
    t: z.literal('owner'),
    season: z.literal('close-1'),
    key: DID_SCHEMA,
  })
  .passthrough();

export const RoomMessageSchema = z
  .object({
    t: z.literal('room'),
    season: z.literal('close-1'),
    room: z.string().regex(/^[a-z0-9][a-z0-9_-]{0,47}$/),
  })
  .passthrough();

export const TradeMessageSchema = z
  .object({
    t: z.literal('trade'),
    season: z.literal('close-1'),
    terms: TradeTermsSchema,
    taker: DID_SCHEMA,
    maker_sig: z.string().min(1),
    taker_sig: z.string(),
  })
  .passthrough();

export const RefereePriceSchema = z
  .object({
    t: z.literal('price'),
    n: z.number().int(),
    ref: z
      .object({
        px: AMOUNT_SCHEMA,
        time: z.string(),
        tid: z.union([z.string(), z.number()]),
      })
      .passthrough(),
    limits: z.tuple([AMOUNT_SCHEMA, AMOUNT_SCHEMA]),
    global: AMOUNT_SCHEMA.optional(),
    file: z.string().optional(),
    age_s: z.number().optional(),
    applied: AMOUNT_SCHEMA.optional(),
    for: z.number().int().optional(),
  })
  .passthrough();

export const RefereeFlowSchema = z
  .object({
    t: z.literal('flow'),
    n: z.number().int(),
    mints: z.array(DID_SCHEMA).default([]),
    rooms: z.array(z.union([z.string(), z.record(z.unknown())])).default([]),
    settled: z.unknown().optional(),
    void: z.unknown().optional(),
    missed: z.array(z.unknown()).optional(),
    file: z.string().optional(),
  })
  .passthrough();

export const RefereePositionsSchema = z
  .object({
    t: z.literal('positions'),
    n: z.number().int(),
    open: z.unknown().optional(),
    longs: z.unknown().optional(),
    shorts: z.unknown().optional(),
    top: z.array(z.unknown()).optional(),
    file: z.string().optional(),
  })
  .passthrough();

export const RefereePnlSchema = z
  .object({
    t: z.literal('pnl'),
    n: z.number().int(),
    mark: AMOUNT_SCHEMA.optional(),
    top: z.array(z.unknown()).optional(),
    file: z.string().optional(),
  })
  .passthrough();

export const RefereeStateSchema = z
  .object({
    t: z.literal('state'),
    n: z.number().int(),
    root: z.unknown().optional(),
    owners: z.unknown().optional(),
    rooms: z.unknown().optional(),
    file: z.string().optional(),
  })
  .passthrough();

export const RefereeSeedSchema = z
  .object({
    t: z.literal('seed'),
    season: z.literal('close-1'),
    price: AMOUNT_SCHEMA,
    trade: z.object({ time: z.string(), tid: z.union([z.string(), z.number()]) }).passthrough(),
    package: z.string(),
    rooms: z.array(z.string()).default([]),
  })
  .passthrough();

export const RefereeFinalSchema = z
  .object({
    t: z.literal('final'),
    season: z.literal('close-1'),
    price: AMOUNT_SCHEMA,
    trade: z.object({ time: z.string(), tid: z.union([z.string(), z.number()]) }).passthrough(),
  })
  .passthrough();

export type RefereePrice = z.infer<typeof RefereePriceSchema>;
export type RefereeFlow = z.infer<typeof RefereeFlowSchema>;
export type RefereeSeed = z.infer<typeof RefereeSeedSchema>;
export type RefereeFinal = z.infer<typeof RefereeFinalSchema>;
export type OwnerMessage = z.infer<typeof OwnerMessageSchema>;
export type TradeMessage = z.infer<typeof TradeMessageSchema>;

export type RoomMessageKind =
  | 'owner'
  | 'room'
  | 'trade'
  | 'price'
  | 'flow'
  | 'positions'
  | 'pnl'
  | 'state'
  | 'seed'
  | 'final'
  | 'chatter';

/**
 * Classify a room message by its `t` field. Anything unparseable, or with an
 * unknown `t`, is `chatter` — conversation the referee ignores and so do we.
 */
export function classifyMessage(text: string): RoomMessageKind {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return 'chatter';
  }
  if (typeof parsed !== 'object' || parsed === null) return 'chatter';
  const kind = (parsed as { t?: unknown }).t;
  switch (kind) {
    case 'owner':
    case 'room':
    case 'trade':
    case 'price':
    case 'flow':
    case 'positions':
    case 'pnl':
    case 'state':
    case 'seed':
    case 'final':
      return kind;
    default:
      return 'chatter';
  }
}

/** Parse a message of a known kind, returning null when it does not match. */
export function parseRefereeMessage(text: string): { kind: RoomMessageKind; value: unknown } | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  const kind = classifyMessage(text);
  const schemas: Partial<Record<RoomMessageKind, z.ZodTypeAny>> = {
    price: RefereePriceSchema,
    flow: RefereeFlowSchema,
    positions: RefereePositionsSchema,
    pnl: RefereePnlSchema,
    state: RefereeStateSchema,
    seed: RefereeSeedSchema,
    final: RefereeFinalSchema,
    owner: OwnerMessageSchema,
    room: RoomMessageSchema,
    trade: TradeMessageSchema,
  };
  const schema = schemas[kind];
  if (!schema) return { kind, value: parsed };
  const result = schema.safeParse(parsed);
  return result.success ? { kind, value: result.data } : null;
}

/**
 * The market view a strategy evaluates against. Built only from verified
 * referee posts; a snapshot with `degraded` set must never widen risk.
 *
 * The price post carries five numbers, and they are not interchangeable:
 *
 *   - `applied`   the reference *this* sweep's trades were checked against. It
 *                 was posted by the previous sweep, so it prices history, never
 *                 a trade we are about to post.
 *   - `ref.px`    this sweep's closing price. It prices this sweep's fees and
 *                 clawback, and it is the baseline the *next* sweep's limits are
 *                 built from.
 *   - `limits`    the band the referee will enforce on the next sweep.
 *   - `for`       the sweep those limits apply to, normally `n + 1`.
 *   - `age_s`     seconds from `ref.time` to this sweep's close.
 *
 * `reference` and `limits` are kept as the names the strategy layer already
 * reads. They deliberately mean `close` and `nextLimits`: a new offer settles in
 * the *next* sweep, so it is priced around this sweep's close and bounded by the
 * published next-sweep band. The historical reference is `appliedReference`, and
 * it is exposed separately so the two are never confused again.
 */
export interface MarketSnapshot {
  sweep: number;
  /** `price.applied`: the reference this sweep's trades used. */
  appliedReference: Decimal | null;
  /** `price.ref.px`: this sweep's close. Prices fees/clawback; sets next limits. */
  close: Decimal | null;
  /** `price.limits`: the published band for the next sweep. */
  nextLimits: { low: Decimal; high: Decimal } | null;
  /** `price.for`: the sweep `nextLimits` apply to. Null when the post omits it. */
  limitsForSweep: number | null;
  /**
   * False when `nextLimits` may not be used to price a live trade.
   *
   * Set when `price.for` was missing or named a sweep other than `n + 1`: the
   * band is still recorded verbatim, but the sweep it applies to is not the one
   * the referee said it is, so a new trade built from it would be bounded by a
   * guess. A dry run ignores this (it never posts a trade anyway).
   */
  limitsUsable?: boolean;
  /** Alias of `close`: the price a new offer is measured against. */
  reference: Decimal | null;
  /** Alias of `nextLimits`: the band a new offer must sit inside. */
  limits: { low: Decimal; high: Decimal } | null;
  /** Closing prices oldest-first, most recent last. */
  history: Decimal[];
  globalPx: Decimal | null;
  ageSeconds: number | null;
  /**
   * True when the reference is older than the configured maximum. The official
   * reference is never rewritten or back-adjusted; a stale feed only stops us
   * from adding risk.
   */
  staleReference: boolean;
  locked: boolean;
  /** True when the reader is in conservative mode (gap, reset, omitted flow). */
  degraded: boolean;
  degradedReason: string | null;
  packageHash: string | null;
  refereeDid: string | null;
}

export function emptySnapshot(): MarketSnapshot {
  return {
    sweep: 0,
    appliedReference: null,
    close: null,
    nextLimits: null,
    limitsForSweep: null,
    // No band at all: nothing may be priced from it.
    limitsUsable: false,
    reference: null,
    limits: null,
    history: [],
    globalPx: null,
    ageSeconds: null,
    staleReference: false,
    locked: false,
    degraded: true,
    degradedReason: 'no referee data yet',
    packageHash: null,
    refereeDid: null,
  };
}
