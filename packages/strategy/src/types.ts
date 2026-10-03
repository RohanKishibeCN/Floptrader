/**
 * Shared types for the strategy layer.
 *
 * Kept in one file so `profiles.ts`, `parameter-validator.ts`,
 * `deterministic-gate.ts` and `group-runner.ts` can all depend on them without
 * any of them depending on each other.
 */
import type { Decimal as DecimalType, MarketSnapshot, RiskCaps, TradeTerms } from '@flop/close-call';
import { Decimal } from '@flop/close-call';
import { STRATEGY_GROUPS, type StrategyGroup } from '@flop/identity';

export { Decimal };
export type { DecimalType, MarketSnapshot, RiskCaps, TradeTerms };

/** The five close-1 groups, from @flop/identity, which owns the assignment. */
export type StrategyGroupName = StrategyGroup;
export const STRATEGY_GROUP_NAMES: readonly StrategyGroupName[] = STRATEGY_GROUPS;

/**
 * An open offer read from the trading room: `taker:"any"` with a valid maker
 * signature. `external_offer_taker` consumes these, and the maker is normally
 * required not to be one of our own DIDs.
 */
export interface ExternalOffer {
  terms: TradeTerms;
  makerSig: string;
  room: string;
  seq: number;
  /** When the reader saw it, for the audit trail. */
  observedAt: string;
  /**
   * True when the maker is a DID this process owns.
   *
   * Set by the reader from its own key set, never by a message, so an offer
   * cannot claim it. The accept path uses it to tell the one deliberate in-fleet
   * pairing from the ordinary case, where an offer naming one of our own DIDs is
   * refused outright.
   */
  localMaker?: boolean;
}

/** Everything a strategy is allowed to look at. */
export interface StrategyContext {
  agentId: string;
  group: StrategyGroupName;
  sweep: number;
  market: MarketSnapshot;
  caps: RiskCaps;
  params: Record<string, Decimal>;
  /** Net contracts held, from the local mirror of the referee's ledger. */
  position: Decimal;
  cash: Decimal;
  openNotional: Decimal;
  lastTradeSweep: number | null;
  /** Stable per-agent seed, so tie-breaking is reproducible across restarts. */
  randomSeed: number;
  /** Consecutive settled trades in the same direction, for cooldown logic. */
  sameDirectionStreak: number;
  /** Open external offers, already filtered to exclude our own DIDs. */
  externalOffers: ExternalOffer[];
}

export type ProposalIntent = 'NO_TRADE' | 'MAKE_OFFER' | 'ACCEPT_EXTERNAL';

/** What a profile proposes, before the gate turns it into a concrete action. */
export interface StrategyProposal {
  intent: ProposalIntent;
  side: 'buy' | 'sell' | null;
  /** Fraction of the agent's max_qty to offer, in [0, 1]. */
  sizeFraction: Decimal;
  /** 0..1. Compared against the agent's confidence threshold by the gate. */
  confidence: Decimal;
  /** Short machine-readable code, e.g. `trend_up`, `flat`, `volatility_cap`. */
  reason: string;
  indicators: Record<string, string>;
  /** Set only for ACCEPT_EXTERNAL. */
  offer?: ExternalOffer;
}

/** A proposal after the gate: concrete, bounded, and safe to post. */
export interface GatedAction {
  intent: ProposalIntent;
  side: 'buy' | 'sell' | null;
  qty: Decimal | null;
  px: Decimal | null;
  confidence: Decimal;
  reason: string;
  indicators: Record<string, string>;
  offer?: ExternalOffer;
  /** Why the gate refused, when it did. `ok` when the proposal survived. */
  gate: string;
}

export function noTrade(reason: string, indicators: Record<string, string> = {}): StrategyProposal {
  return {
    intent: 'NO_TRADE',
    side: null,
    sizeFraction: Decimal.zero(),
    confidence: Decimal.zero(),
    reason,
    indicators,
  };
}

/**
 * The slice of a logger this package needs. Declared structurally rather than
 * imported so `@flop/strategy` never depends on the orchestrator application;
 * the orchestrator's `Logger` satisfies it without any adapter.
 */
export interface StrategyLogger {
  info(data: Record<string, unknown>, message: string): void;
  warn(data: Record<string, unknown>, message: string): void;
  error(data: Record<string, unknown>, message: string): void;
  event(record: {
    level: 'trace' | 'debug' | 'info' | 'warn' | 'error' | 'fatal';
    source: string;
    code: string;
    message: string;
    data?: Record<string, unknown>;
  }): void;
}
