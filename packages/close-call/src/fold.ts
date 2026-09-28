/**
 * A line-by-line port of the official `close_call_fold.py`.
 *
 * This exists so the contest's own worked example can be replayed locally and
 * compared field by field (`official-fold.test.ts`). It deliberately mirrors the
 * Python's structure, including its string output: `str(Decimal)` keeps the
 * scale, so `0.01 * 20 * 180.00` prints `36.0000` and the global price prints
 * quantized to two places. The port is checked against
 * `examples/sample-season.expected.json`.
 *
 * Where it differs from the Python: nothing in the arithmetic. TS has no
 * `localcontext`, so the working precision lives in `Decimal.div`.
 */
import { Decimal } from './decimal.js';
import { RiskAccount, Lot } from './risk.js';
import { sideFees } from './fee.js';

export const DID_PATTERN = /^did:key:z6Mk[1-9A-HJ-NP-Za-km-z]{44}$/;
export const TRADE_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
export const TWO_PLACES = /^[0-9]{1,7}(\.[0-9]{1,2})?$/;
const CENT = Decimal.from('0.01');

export interface FoldConfig {
  mint: string;
  min_qty: string;
  limit_window: string;
  fee_rate: string;
  fee_rule: string;
  lock_sweep: number;
  prize_places: number;
}

export const FOLD_DEFAULTS: FoldConfig = {
  mint: '10000',
  min_qty: '0.1',
  limit_window: '0.05',
  fee_rate: '0.01',
  fee_rule: 'clawback',
  lock_sweep: 2556,
  prize_places: 3,
};

/** A price or quantity: a string with at most two decimals, above zero. */
export function amount(text: unknown): Decimal | null {
  if (typeof text !== 'string' || !TWO_PLACES.test(text)) return null;
  const value = Decimal.from(text);
  return value.gt(0) ? value : null;
}

export interface FoldTradeInput {
  id?: unknown;
  maker?: unknown;
  side?: unknown;
  qty?: unknown;
  px?: unknown;
  taker?: unknown;
  until?: unknown;
  countersigner?: unknown;
}

export type VoidReason =
  | 'shape'
  | 'not_owner'
  | 'taker'
  | 'settled'
  | 'expired'
  | 'locked'
  | 'limits'
  | 'funds';

export interface TradeOutcome {
  id: unknown;
  outcome: 'settled' | 'void';
  reason?: VoidReason;
  maker_fee?: string;
  taker_fee?: string;
}

export interface SweepResult {
  sweep: number;
  reference: string;
  close: string;
  minted: string[];
  trades: TradeOutcome[];
  global_price: string;
}

export interface Standing {
  key: string;
  score: string;
  position: string;
  fees: string;
  places: number[];
  sharing: number;
}

export interface FinalResult {
  S: string;
  owners: number;
  fees: string;
  zero_sum: string;
  standings: Standing[];
}

export interface ReplayResult {
  sweeps: SweepResult[];
  final: FinalResult | null;
}

export class Fold {
  readonly mint: Decimal;
  readonly minQty: Decimal;
  readonly window: Decimal;
  readonly feeRate: Decimal;
  readonly lock: number;
  readonly places: number;
  readonly accounts = new Map<string, RiskAccount>();
  readonly settled = new Set<string>();
  sweepN = 0;
  globalPx: Decimal | null = null;
  finalPx: Decimal | null = null;
  fees: Decimal = Decimal.zero();

  constructor(config: Partial<FoldConfig> = {}) {
    const cfg: FoldConfig = { ...FOLD_DEFAULTS, ...config };
    this.mint = Decimal.from(cfg.mint);
    this.minQty = Decimal.from(cfg.min_qty);
    this.window = Decimal.from(cfg.limit_window);
    this.feeRate = Decimal.from(cfg.fee_rate);
    if (cfg.fee_rule !== 'clawback') throw new Error("config: fee_rule must be 'clawback'");
    this.lock = cfg.lock_sweep;
    this.places = cfg.prize_places;
  }

  sideFees(side: 1 | -1, qty: Decimal, px: Decimal, close: Decimal): { maker: Decimal; taker: Decimal } {
    return sideFees(side > 0 ? 'buy' : 'sell', qty, px, close, this.feeRate);
  }

  seed(px: unknown): void {
    const value = amount(px);
    if (value === null || this.globalPx !== null) {
      throw new Error('seed: expected one opening price with at most two decimals');
    }
    this.globalPx = value;
  }

  /** The void reason for one trade, or null if it settles. */
  check(trade: unknown, n: number, ref: Decimal, close: Decimal): VoidReason | null {
    if (typeof trade !== 'object' || trade === null || Array.isArray(trade)) return 'shape';
    const candidate = trade as FoldTradeInput;
    const maker = candidate.maker;
    const taker = candidate.taker;
    const signer = candidate.countersigner;
    const qty = amount(candidate.qty);
    const px = amount(candidate.px);
    const until = candidate.until;
    if (
      typeof candidate.id !== 'string' ||
      !TRADE_ID_PATTERN.test(candidate.id) ||
      (candidate.side !== 'buy' && candidate.side !== 'sell') ||
      qty === null ||
      px === null ||
      typeof until !== 'number' ||
      !Number.isInteger(until) ||
      typeof maker !== 'string' ||
      typeof signer !== 'string' ||
      !(taker === 'any' || typeof taker === 'string')
    ) {
      return 'shape';
    }
    if (qty.lt(this.minQty)) return 'shape';
    if (!this.accounts.has(maker) || !this.accounts.has(signer)) return 'not_owner';
    if (taker !== 'any' && taker !== signer) return 'taker';
    if (this.settled.has(candidate.id)) return 'settled';
    if (n > until) return 'expired';
    if (n > this.lock) return 'locked';
    if (px.sub(ref).abs().gt(this.window.mul(ref))) return 'limits';

    const side: 1 | -1 = candidate.side === 'buy' ? 1 : -1;
    const fees = this.sideFees(side, qty, px, close);
    const mk = this.accounts.get(maker)!;
    const tk = this.accounts.get(signer)!;
    if (mk === tk) {
      if (mk.cash.lt(fees.maker.add(fees.taker))) return 'funds';
    } else {
      const makerNeeds = mk.opening(side, qty).mul(px).add(fees.maker);
      const takerNeeds = tk.opening((side * -1) as 1 | -1, qty).mul(px).add(fees.taker);
      if (mk.cash.lt(makerNeeds) || tk.cash.lt(takerNeeds)) return 'funds';
    }
    return null;
  }

  sweep(n: number, ref: unknown, close: unknown, owners: unknown[], trades: unknown[]): SweepResult {
    const reference = amount(ref);
    const closing = amount(close);
    if (
      this.globalPx === null ||
      reference === null ||
      closing === null ||
      typeof n !== 'number' ||
      !Number.isInteger(n) ||
      n <= this.sweepN
    ) {
      throw new Error(
        `sweep ${String(n)}: needs a seed, a reference and a closing price, and an increasing sweep number`,
      );
    }
    this.sweepN = n;
    const minted: string[] = [];
    for (const key of owners) {
      if (typeof key === 'string' && DID_PATTERN.test(key) && !this.accounts.has(key) && n <= this.lock) {
        this.accounts.set(key, RiskAccount.withMint(key, this.mint));
        minted.push(key);
      }
    }

    const outcomes: TradeOutcome[] = [];
    let volume = Decimal.zero();
    let notional = Decimal.zero();
    for (const trade of trades) {
      const reason = this.check(trade, n, reference, closing);
      const id =
        typeof trade === 'object' && trade !== null && !Array.isArray(trade)
          ? (trade as FoldTradeInput).id
          : undefined;
      if (reason) {
        outcomes.push({ id, outcome: 'void', reason });
        continue;
      }
      const candidate = trade as FoldTradeInput & { qty: string; px: string; side: 'buy' | 'sell'; id: string };
      const qty = Decimal.from(candidate.qty);
      const px = Decimal.from(candidate.px);
      const side: 1 | -1 = candidate.side === 'buy' ? 1 : -1;
      const fees = this.sideFees(side, qty, px, closing);
      const mk = this.accounts.get(candidate.maker as string)!;
      const tk = this.accounts.get(candidate.countersigner as string)!;
      if (mk === tk) {
        const total = fees.maker.add(fees.taker);
        mk.cash = mk.cash.sub(total);
        mk.fees = mk.fees.add(total);
      } else {
        mk.apply(side, qty, px, fees.maker);
        tk.apply((side * -1) as 1 | -1, qty, px, fees.taker);
      }
      this.fees = this.fees.add(fees.maker.add(fees.taker));
      this.settled.add(candidate.id);
      volume = volume.add(qty);
      notional = notional.add(qty.mul(px));
      outcomes.push({
        id: candidate.id,
        outcome: 'settled',
        maker_fee: fees.maker.toString(),
        taker_fee: fees.taker.toString(),
      });
    }
    if (!volume.isZero()) {
      this.globalPx = notional.div(volume);
    }
    return {
      sweep: n,
      reference: reference.toString(),
      close: closing.toString(),
      minted,
      trades: outcomes,
      global_price: this.globalPx!.quantize(2).toString(),
    };
  }

  final(px: unknown): FinalResult {
    const s = amount(px);
    if (s === null || this.finalPx !== null) {
      throw new Error('final: expected one closing price with at most two decimals');
    }
    this.finalPx = s;
    const scores = new Map<string, Decimal>();
    for (const [key, account] of this.accounts) {
      scores.set(key, account.valueAt(s).sub(this.mint));
    }
    const order = [...scores.keys()].sort((a, b) => {
      const cmp = scores.get(b)!.cmp(scores.get(a)!);
      return cmp !== 0 ? cmp : a < b ? -1 : a > b ? 1 : 0;
    });

    const winners = new Map<string, { places: number[]; sharing: number }>();
    let place = 0;
    while (place < Math.min(this.places, order.length)) {
      const pivotScore = scores.get(order[place]!)!;
      const tied = order.filter((key) => scores.get(key)!.eq(pivotScore));
      const spanned: number[] = [];
      for (let p = place + 1; p <= Math.min(place + tied.length, this.places); p += 1) spanned.push(p);
      for (const key of tied) winners.set(key, { places: spanned, sharing: tied.length });
      place += tied.length;
    }

    const table: Standing[] = order.map((key) => {
      const account = this.accounts.get(key)!;
      const winner = winners.get(key) ?? { places: [], sharing: 0 };
      return {
        key,
        score: scores.get(key)!.quantize(6).toString(),
        position: account.position.toString(),
        fees: account.fees.toString(),
        places: winner.places,
        sharing: winner.sharing,
      };
    });
    let scoreSum = Decimal.zero();
    for (const value of scores.values()) scoreSum = scoreSum.add(value);
    return {
      S: s.toString(),
      owners: order.length,
      fees: this.fees.toString(),
      zero_sum: scoreSum.add(this.fees).toString(),
      standings: table,
    };
  }
}

export interface ReplayEvent {
  t?: unknown;
  px?: unknown;
  n?: unknown;
  ref?: unknown;
  close?: unknown;
  owners?: unknown;
  trades?: unknown;
}

/** Replay seed/sweep/final events in the order the referee applied them. */
export function replay(lines: Iterable<string>, config: Partial<FoldConfig> = {}): ReplayResult {
  const fold = new Fold(config);
  const sweeps: SweepResult[] = [];
  let final: FinalResult | null = null;
  let number = 0;
  for (const line of lines) {
    number += 1;
    if (line.trim() === '') continue;
    const event = JSON.parse(line) as ReplayEvent;
    switch (event.t) {
      case 'seed':
        fold.seed(event.px);
        break;
      case 'sweep':
        sweeps.push(
          fold.sweep(
            event.n as number,
            event.ref,
            event.close,
            (event.owners as unknown[]) ?? [],
            (event.trades as unknown[]) ?? [],
          ),
        );
        break;
      case 'final':
        final = fold.final(event.px);
        break;
      default:
        throw new Error(`line ${number}: unknown event ${JSON.stringify(event.t)}`);
    }
  }
  return { sweeps, final };
}

export { CENT };
export type { Lot };
