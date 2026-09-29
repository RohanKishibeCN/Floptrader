/**
 * Risk: the ledger model, the funding check, and the local caps the model can
 * never override.
 *
 * `RiskAccount` is a faithful port of the official fold's `Account`, including
 * FIFO lots and the "every contract opened, long or short, ties up its price"
 * collateral rule. The orchestrator uses it for two jobs:
 *
 *   1. answering "would the referee settle this?" before signing anything, so we
 *      do not post trades that void for `funds`;
 *   2. tracking our own 150 accounts from the referee's flow posts, so
 *      `max_open_notional`, `max_qty` and cooldowns are enforced by local code
 *      rather than by hope.
 *
 * The caps live here, not in the strategy or the model layer. DeepSeek output
 * can change thresholds inside the ranges below; it can never raise a cap.
 */
import { Decimal } from './decimal.js';
import { sideSign } from './fee.js';

export interface Lot {
  qty: Decimal;
  px: Decimal;
}

export class RiskAccount {
  readonly key: string;
  cash: Decimal;
  lots: Lot[];
  fees: Decimal;

  constructor(key: string, cash: Decimal, lots: Lot[] = [], fees: Decimal = Decimal.zero()) {
    this.key = key;
    this.cash = cash;
    this.lots = lots;
    this.fees = fees;
  }

  static withMint(key: string, mint: Decimal): RiskAccount {
    return new RiskAccount(key, mint);
  }

  clone(): RiskAccount {
    return new RiskAccount(
      this.key,
      this.cash,
      this.lots.map((lot) => ({ qty: lot.qty, px: lot.px })),
      this.fees,
    );
  }

  /** Net contracts held; positive is long, negative is short. */
  get position(): Decimal {
    let total = Decimal.zero();
    for (const lot of this.lots) total = total.add(lot.qty);
    return total;
  }

  /** Contracts this trade opens rather than closes; side is +1 to buy, -1 to sell. */
  opening(side: 1 | -1, qty: Decimal): Decimal {
    const held = this.position;
    const exposed = Decimal.from(-side).mul(held);
    const closing = Decimal.min(qty, Decimal.max(exposed, Decimal.zero()));
    return qty.sub(closing);
  }

  /**
   * Apply a settled trade. A long lot that is sold returns the sale price; a
   * short lot that is bought back returns its collateral plus the price
   * difference in its favour, or minus it.
   */
  apply(side: 1 | -1, qty: Decimal, px: Decimal, fee: Decimal): void {
    this.cash = this.cash.sub(fee);
    this.fees = this.fees.add(fee);
    let left = qty;
    while (left.gt(0) && this.lots.length > 0) {
      const head = this.lots[0]!;
      if (!head.qty.mul(side).lt(0)) break;
      const size = Decimal.min(left, head.qty.abs());
      // A long lot that is sold returns the sale price; a short lot that is
      // bought back returns its collateral plus the price difference.
      const returned = side < 0 ? px : lotDouble(head.px).sub(px);
      this.cash = this.cash.add(size.mul(returned));
      left = left.sub(size);
      if (size.eq(head.qty.abs())) {
        this.lots.shift();
      } else {
        head.qty = head.qty.add(Decimal.from(side).mul(size));
      }
    }
    if (left.gt(0)) {
      this.cash = this.cash.sub(left.mul(px));
      this.lots.push({ qty: Decimal.from(side).mul(left), px });
    }
  }

  /** Value at a mark: cash plus every open lot marked to `s`. */
  valueAt(s: Decimal): Decimal {
    let total = this.cash;
    for (const lot of this.lots) {
      total = total.add(lot.qty.gt(0) ? lot.qty.mul(s) : lot.qty.neg().mul(lotDouble(lot.px).sub(s)));
    }
    return total;
  }
}

/** 2 * px, kept as a named helper so the lot formulas read like the fold's. */
function lotDouble(px: Decimal): Decimal {
  return px.mul(2);
}

/**
 * The fold's `funds` check, usable before posting.
 *
 * Returns the void reason or null. `accounts` need not be complete for accounts
 * we do not control: for the taker side of an external offer the caller supplies
 * whatever the referee last published, and an unknown account returns `funds`
 * conservatively (never sign against a balance we cannot see).
 */
export function fundsReason(params: {
  maker: RiskAccount | undefined;
  taker: RiskAccount | undefined;
  side: 'buy' | 'sell';
  qty: Decimal;
  px: Decimal;
  close: Decimal;
  feeRate: Decimal;
  selfTrade: boolean;
  makerFee: Decimal;
  takerFee: Decimal;
}): 'funds' | null {
  const sign = sideSign(params.side);
  const { maker, taker, qty, px, makerFee, takerFee } = params;
  if (params.selfTrade) {
    if (!maker) return 'funds';
    const total = makerFee.add(takerFee);
    return maker.cash.lt(total) ? 'funds' : null;
  }
  if (!maker || !taker) return 'funds';
  const makerNeeds = maker.opening(sign, qty).mul(px).add(makerFee);
  const takerNeeds = taker.opening((sign * -1) as 1 | -1, qty).mul(px).add(takerFee);
  return maker.cash.lt(makerNeeds) || taker.cash.lt(takerNeeds) ? 'funds' : null;
}

/**
 * Which side a `funds` void belongs to, and how much we can trust that answer.
 *
 * The referee says only `funds`. It never names the side — one word for "somebody
 * could not cover it". So `refereeFundsSide` is always `unknown`, and anything
 * more specific is a *local reconstruction* that the Lark report must label as
 * such. Getting this wrong in a report is how an operator ends up blaming an
 * owner who was never short.
 */
export type FundsSide = 'maker' | 'taker' | 'both' | 'unknown';
export type FundsSideConfidence = 'high' | 'medium' | 'unknown';

export interface FundsSideAssessment {
  /** The one reason the referee gives. Null when it gave none. */
  refereeReason: 'funds' | null;
  /** Always `unknown`: the referee's post does not distinguish the two sides. */
  refereeFundsSide: 'unknown';
  /** Our own reconstruction from the balances we can see. */
  localFundsSide: FundsSide;
  /**
   * `high` when both sides' balances are known and exactly one (or both) is
   * short; `medium` when neither we can see is short, which means the referee
   * saw something we could not; `unknown` when a balance is missing entirely.
   */
  fundsSideConfidence: FundsSideConfidence;
}

/**
 * Reconstruct which side a `funds` void belonged to, locally.
 *
 * This never overrides the referee: it explains the referee's verdict, and the
 * confidence says how far the explanation can be pushed.
 */
export function assessFundsSide(params: {
  maker: RiskAccount | undefined;
  taker: RiskAccount | undefined;
  side: 'buy' | 'sell';
  qty: Decimal;
  px: Decimal;
  makerFee: Decimal;
  takerFee: Decimal;
  /** Overrides `authority` when this is a refund of our own assessment. */
  authority?: 'referee' | 'local';
}): FundsSideAssessment {
  const base = {
    refereeReason: (params.authority === 'local' ? null : 'funds') as 'funds' | null,
    refereeFundsSide: 'unknown' as const,
  };
  if (!params.maker || !params.taker) {
    return { ...base, localFundsSide: 'unknown', fundsSideConfidence: 'unknown' };
  }
  const sign = sideSign(params.side);
  const makerShort = params.maker.cash.lt(
    params.maker.opening(sign, params.qty).mul(params.px).add(params.makerFee),
  );
  const takerShort = params.taker.cash.lt(
    params.taker.opening((sign * -1) as 1 | -1, params.qty).mul(params.px).add(params.takerFee),
  );
  const localFundsSide: FundsSide =
    makerShort && takerShort ? 'both' : makerShort ? 'maker' : takerShort ? 'taker' : 'unknown';
  return {
    ...base,
    localFundsSide,
    // Neither side short locally but the referee voided it: our mirror is behind
    // the referee's ledger, so the reconstruction is not trustworthy.
    fundsSideConfidence: localFundsSide === 'unknown' ? 'medium' : 'high',
  };
}

/** Local per-agent caps. These are the hard limits; strategies stay inside them. */
export interface RiskCaps {
  /** Largest single trade quantity. */
  maxQty: Decimal;
  /** Largest total open notional across the agent's open contracts. */
  maxOpenNotional: Decimal;
  /** Sweeps to wait after a settled trade before proposing another. */
  cooldownSweeps: number;
  /** Minimum deterministic-strategy confidence required to act. */
  confidenceThreshold: Decimal;
}

export const DEFAULT_RISK_CAPS: Record<string, RiskCaps> = {
  trend_following: caps('25', '8000', 3, '0.55'),
  mean_reversion: caps('20', '6000', 2, '0.55'),
  breakout: caps('20', '6000', 4, '0.6'),
  contrarian: caps('10', '3000', 3, '0.65'),
  external_offer_taker: caps('15', '4500', 1, '0.5'),
};

function caps(maxQty: string, maxOpenNotional: string, cooldownSweeps: number, confidence: string): RiskCaps {
  return {
    maxQty: Decimal.from(maxQty),
    maxOpenNotional: Decimal.from(maxOpenNotional),
    cooldownSweeps,
    confidenceThreshold: Decimal.from(confidence),
  };
}

/** Hard ceilings no code path may exceed, whatever the model suggests. */
export const ABSOLUTE_MAX_QTY = Decimal.from('50');
export const ABSOLUTE_MAX_OPEN_NOTIONAL = Decimal.from('12000');

export interface RiskDecision {
  allowed: boolean;
  reason: string;
  /** Notional the trade would add, when allowed. */
  notionalAdded: Decimal;
}

/**
 * Check a proposed trade against the local caps.
 *
 * Refusals are named so the decision log explains itself: `qty_cap`,
 * `notional_cap`, `cooldown`, `confidence`, `no_reference`, `locked`.
 */
export function checkLocalCaps(params: {
  caps: RiskCaps;
  qty: Decimal;
  px: Decimal;
  reference: Decimal | null;
  confidence: Decimal;
  sweep: number;
  locked: boolean;
  /** Sweep of this agent's last settled trade, if any. */
  lastTradeSweep: number | null;
  openNotional: Decimal;
  conservative: boolean;
}): RiskDecision {
  const none = Decimal.zero();
  if (params.locked) return { allowed: false, reason: 'locked', notionalAdded: none };
  if (params.qty.gt(params.caps.maxQty) || params.qty.gt(ABSOLUTE_MAX_QTY)) {
    return { allowed: false, reason: 'qty_cap', notionalAdded: none };
  }
  if (params.confidence.lt(params.caps.confidenceThreshold)) {
    return { allowed: false, reason: 'confidence', notionalAdded: none };
  }
  if (
    params.lastTradeSweep !== null &&
    params.sweep - params.lastTradeSweep < params.caps.cooldownSweeps
  ) {
    return { allowed: false, reason: 'cooldown', notionalAdded: none };
  }
  if (params.reference === null) {
    return { allowed: false, reason: 'no_reference', notionalAdded: none };
  }
  const notional = params.qty.mul(params.px);
  const cap = Decimal.min(params.caps.maxOpenNotional, ABSOLUTE_MAX_OPEN_NOTIONAL);
  if (params.openNotional.add(notional).gt(cap)) {
    return { allowed: false, reason: 'notional_cap', notionalAdded: none };
  }
  // Conservative mode never widens risk: it caps a trade at a tenth of normal.
  if (params.conservative && notional.gt(cap.div(10))) {
    return { allowed: false, reason: 'conservative_mode', notionalAdded: none };
  }
  return { allowed: true, reason: 'ok', notionalAdded: notional };
}

/**
 * Local view of our own accounts, rebuilt from the referee's flow posts.
 *
 * Only ever tracks the DIDs we control; an unknown key is ignored rather than
 * invented, because a fabricated balance would let us post a trade the referee
 * voids for `funds`.
 */
export class LocalRiskBook {
  private readonly accounts = new Map<string, RiskAccount>();
  private readonly mint: Decimal;
  private readonly feeRate: Decimal;
  private agentByDid: Map<string, string>;

  constructor(options: { mint: Decimal; feeRate: Decimal; didToAgent: Map<string, string> }) {
    this.mint = options.mint;
    this.feeRate = options.feeRate;
    this.agentByDid = options.didToAgent;
  }

  /** Mint an account once the flow post lists it; mints are once per key. */
  observeMint(did: string): boolean {
    if (!this.agentByDid.has(did)) return false;
    if (this.accounts.has(did)) return false;
    this.accounts.set(did, RiskAccount.withMint(did, this.mint));
    return true;
  }

  account(did: string): RiskAccount | undefined {
    return this.accounts.get(did);
  }

  has(did: string): boolean {
    return this.accounts.has(did);
  }

  get size(): number {
    return this.accounts.size;
  }

  openNotional(did: string): Decimal {
    const account = this.accounts.get(did);
    if (!account) return Decimal.zero();
    let total = Decimal.zero();
    for (const lot of account.lots) total = total.add(lot.qty.abs().mul(lot.px));
    return total;
  }

  /**
   * Apply a settled trade to the local mirror. Mirrors the fold exactly, so a
   * divergence in local bookkeeping is caught by the next referee state post
   * rather than by a voided trade.
   */
  applySettled(params: {
    maker: string;
    taker: string;
    side: 'buy' | 'sell';
    qty: Decimal;
    px: Decimal;
    close: Decimal;
    makerFee: Decimal;
    takerFee: Decimal;
  }): void {
    const sign = sideSign(params.side);
    if (params.maker === params.taker) {
      const account = this.accounts.get(params.maker);
      if (!account) return;
      const total = params.makerFee.add(params.takerFee);
      account.cash = account.cash.sub(total);
      account.fees = account.fees.add(total);
      return;
    }
    const maker = this.accounts.get(params.maker);
    if (maker) maker.apply(sign, params.qty, params.px, params.makerFee);
    const taker = this.accounts.get(params.taker);
    if (taker) taker.apply((sign * -1) as 1 | -1, params.qty, params.px, params.takerFee);
  }

  /** Rebuild from scratch, e.g. after a gap invalidated the mirror. */
  reset(): void {
    this.accounts.clear();
  }

  snapshot(): Array<{ did: string; agentId: string; cash: string; position: string; openNotional: string }> {
    return [...this.accounts.values()].map((account) => ({
      did: account.key,
      agentId: this.agentByDid.get(account.key) ?? '<unknown>',
      cash: account.cash.toString(),
      position: account.position.toString(),
      openNotional: this.openNotional(account.key).toString(),
    }));
  }

  get feeRateValue(): Decimal {
    return this.feeRate;
  }
}
