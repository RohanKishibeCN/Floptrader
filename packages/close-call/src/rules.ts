/**
 * Close Call rules, pinned.
 *
 * The rules package is fixed by the manifest hash in the referee's seed message.
 * Nothing here may follow GitHub `main` after that: `package-pin.ts` compares the
 * observed hash against the pin and the orchestrator stops trading on a mismatch.
 * The copy of contest.json below is the reference used when no pinned file is
 * supplied; a real run loads the file whose hash matches the seed.
 */
import { z } from 'zod';
import { Decimal } from './decimal.js';

export const ContestConfigSchema = z.object({
  contest_id: z.string(),
  rules_version: z.string(),
  market: z.string(),
  unit: z.string(),
  opening: z.string(),
  first_sweep: z.string(),
  sweep_seconds: z.number().int().positive(),
  lock: z.string(),
  lock_sweep: z.number().int().positive(),
  final_price_time: z.string(),
  mint: z.string(),
  price_step: z.string(),
  qty_step: z.string(),
  min_qty: z.string(),
  limit_window: z.string(),
  fee_rate: z.string(),
  fee_rule: z.literal('clawback'),
  prize_pool: z.string(),
  prize_places: z.number().int().positive(),
  prize_unit: z.string(),
  claim_window_days: z.number().int().positive(),
  identity_policy: z.string(),
  rooms: z.object({
    trading: z.array(z.string()),
    referee: z.array(z.string()),
    reserved: z.array(z.string()),
  }),
});

export type ContestConfig = z.infer<typeof ContestConfigSchema>;

/** The reference contest.json, byte-identical to the published file's content. */
export const REFERENCE_CONTEST_JSON = `{
  "contest_id": "close-1",
  "rules_version": "0.1-draft",
  "market": "xyz:NVDA on Hyperliquid",
  "unit": "POLF, one per US dollar of NVDA",
  "opening": "2026-09-25T12:00:00Z",
  "first_sweep": "2026-09-25T12:05:00Z",
  "sweep_seconds": 300,
  "lock": "2026-10-04T09:00:00Z",
  "lock_sweep": 2556,
  "final_price_time": "2026-10-04T10:00:00Z",
  "mint": "10000",
  "price_step": "0.01",
  "qty_step": "0.01",
  "min_qty": "0.1",
  "limit_window": "0.05",
  "fee_rate": "0.01",
  "fee_rule": "clawback",
  "prize_pool": "1000000",
  "prize_places": 3,
  "prize_unit": "FLOP",
  "claim_window_days": 90,
  "identity_policy": "any did:key; nothing else is checked",
  "rooms": {
    "trading": [
      "close1"
    ],
    "referee": [
      "d-close1-flow",
      "d-close1-state",
      "d-close1-price",
      "d-close1-positions",
      "d-close1-pnl"
    ],
    "reserved": [
      "d-close1",
      "d-close1-rules",
      "d-close1-results",
      "d-close1-trade",
      "d-close1-trades",
      "d-close1-referee",
      "d-close1-announce",
      "d-close1-registration",
      "d-close-1",
      "d-close-1-flow",
      "d-close-1-state",
      "d-close-1-price",
      "d-close-1-positions",
      "d-close-1-pnl",
      "d-closecall",
      "d-close-call"
    ]
  }
}
`;

export const CONTEST_ID = 'close-1';
export const SEASON = 'close-1';
/** The default trading room. Owners register and post signed trades here. */
export const TRADING_ROOM = 'close1';
export const REFEREE_ROOMS = [
  'd-close1-price',
  'd-close1-flow',
  'd-close1-positions',
  'd-close1-pnl',
  'd-close1-state',
] as const;
export type RefereeRoom = (typeof REFEREE_ROOMS)[number];

/**
 * The room the referee posts the seed and the final price to.
 *
 * It has to be read before the price and flow rooms: the seed establishes the
 * package and the baseline, and a price that arrives before it is refused. The
 * order of `contest.json`'s `rooms.referee` is not the referee's posting order,
 * so the reader hoists this room to the front of every pass.
 */
export const REFEREE_STATE_ROOM = 'd-close1-state';

export interface Rules {
  contestId: string;
  season: string;
  tradingRoom: string;
  refereeRooms: readonly string[];
  /** 5% of the previous sweep's reference price. */
  limitWindow: Decimal;
  minQty: Decimal;
  priceStep: Decimal;
  qtyStep: Decimal;
  mint: Decimal;
  feeRate: Decimal;
  lockSweep: number;
  lockAt: string;
  finalPriceTime: string;
  prizePlaces: number;
  sweepSeconds: number;
  config: ContestConfig;
}

export function rulesFromConfig(config: ContestConfig): Rules {
  return {
    contestId: config.contest_id,
    season: config.contest_id,
    tradingRoom: config.rooms.trading[0] ?? TRADING_ROOM,
    refereeRooms: config.rooms.referee,
    limitWindow: Decimal.from(config.limit_window),
    minQty: Decimal.from(config.min_qty),
    priceStep: Decimal.from(config.price_step),
    qtyStep: Decimal.from(config.qty_step),
    mint: Decimal.from(config.mint),
    feeRate: Decimal.from(config.fee_rate),
    lockSweep: config.lock_sweep,
    lockAt: config.lock,
    finalPriceTime: config.final_price_time,
    prizePlaces: config.prize_places,
    sweepSeconds: config.sweep_seconds,
    config,
  };
}

export function parseContestConfig(json: string): ContestConfig {
  const parsed = ContestConfigSchema.parse(JSON.parse(json));
  if (parsed.contest_id !== CONTEST_ID) {
    throw new Error(`contest_id must be ${CONTEST_ID}, got ${parsed.contest_id}`);
  }
  if (parsed.fee_rule !== 'clawback') {
    throw new Error('fee_rule must be clawback');
  }
  return parsed;
}

export function referenceRules(): Rules {
  return rulesFromConfig(parseContestConfig(REFERENCE_CONTEST_JSON));
}

/** Sweep number for a timestamp: sweeps start at 12:05 UTC on 25 September. */
export function sweepAt(rules: Rules, at: Date): number {
  const first = Date.parse(rules.config.first_sweep);
  const elapsed = Math.floor((at.getTime() - first) / (rules.sweepSeconds * 1000));
  return elapsed < 0 ? 0 : elapsed + 1;
}

/** True once the lock sweep has been reached: no new active offers after this. */
export function isLocked(rules: Rules, sweep: number): boolean {
  return sweep > rules.lockSweep;
}

/** A price is inside the window when |px - ref| <= window * ref. */
export function withinLimits(rules: Rules, px: Decimal, reference: Decimal): boolean {
  return px.sub(reference).abs().lte(rules.limitWindow.mul(reference));
}

/**
 * The limits the referee publishes: reference ± 5%, rounded *outward* to the
 * price step so a price the referee accepts is never rejected locally.
 * The posted form is authoritative; this is only used when a price post is
 * missing and the operator must decide conservatively.
 */
export function limitBand(rules: Rules, reference: Decimal): { low: Decimal; high: Decimal } {
  const span = rules.limitWindow.mul(reference);
  return {
    low: reference.sub(span).quantize(2, 'down'),
    high: reference.add(span).quantize(2, 'half-up'),
  };
}
