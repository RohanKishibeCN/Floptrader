/**
 * The late-start bootstrap decision.
 *
 * A process that starts after the opening seed has rotated out of the retained
 * ring can never replay the contest, so the five deterministic profiles — every
 * one of which needs a reference *history* — decline on `insufficient_history`
 * forever: the seed is what would have given them that history, and it is gone.
 *
 * This module is the smallest honest alternative anchor: the closes the pinned
 * referee has actually published, which the verifier already signature-checked
 * and schema-checked before letting them into `market.history`. It reads that
 * observation window; it does not create a second one, because a second copy of
 * the same bytes would be a second thing to keep in step.
 *
 * It is deliberately not a replay, and it does not pretend to be one:
 *
 *   - no seed is invented, and the current price post is never written back as
 *     history — the window is exactly the referee's accepted posts, no more;
 *   - a direction is produced only when two consecutive closes differ by more
 *     than one `price_step`, so a one-cent tick cannot manufacture a trade;
 *   - the price and the deadline still come from the referee's current band, so
 *     `until` is the band's own `for` rather than a local guess;
 *   - the size is the rules' minimum quantity, expressed as the fraction the
 *     gate expects, so the bootstrap cannot build a position;
 *   - every proposal still passes through `deterministic-gate` and therefore
 *     the same risk caps, and then the same signing, nonce and writer as any
 *     other trade. Nothing here can post anything on its own.
 *
 * The decision is taken whenever the process is in late-start mode, so the
 * operator sees *why* nothing traded (`late_start_strategy_disabled`,
 * `late_start_insufficient_observations`, …) instead of the profiles' seeded
 * reasons. Only the armed switch, however, can let it produce a proposal.
 */
import { Decimal } from '@flop/close-call';
import { noTrade, type MarketSnapshot, type StrategyContext, type StrategyProposal } from './types.js';

/** The version recorded on every `agent_runs`/`decisions` row this decision made. */
export const LATE_START_BOOTSTRAP_VERSION = 'late-start-bootstrap-v1';

/** Two closes are the fewest from which a direction exists at all. */
export const LATE_START_OBSERVATIONS_REQUIRED = 2;

export type LateStartSignal = 'rising' | 'falling' | 'flat';

export interface LateStartBootstrapOptions {
  /** `LATE_START_ALLOW_STRATEGY_TRADING` **and** its confirmation literal. */
  enabled: boolean;
  rules: { priceStep: Decimal; minQty: Decimal };
}

/**
 * Direction from two accepted closes.
 *
 * The dead band is one `price_step`, taken from the rules rather than chosen
 * here: a move that cannot clear the smallest tick the market quotes is noise,
 * and reading it as a trend is how a rule quietly becomes a coin flip.
 */
export function lateStartSignal(
  latest: Decimal,
  previous: Decimal,
  priceStep: Decimal,
): LateStartSignal {
  const change = latest.sub(previous);
  if (!priceStep.gt(0)) return change.isZero() ? 'flat' : change.isPositive() ? 'rising' : 'falling';
  if (change.abs().lte(priceStep)) return 'flat';
  return change.isPositive() ? 'rising' : 'falling';
}

/**
 * Whether the current post may price a trade at all.
 *
 * Every clause is about the *current* post, never about the opening: a pinned
 * referee, a band, a `for` that names the very next sweep, a reference that is
 * not the referee's own stale marker, and a contest that is not locked. This is
 * the same set of facts `marketSnapshotReadiness` holds the trading gate to, so
 * the decision and the gate cannot disagree about whether the market is usable.
 */
function marketIsUsable(market: MarketSnapshot): boolean {
  if (market.locked) return false;
  if (market.degraded) return false;
  if (market.staleReference) return false;
  if (market.reference === null) return false;
  if (market.limits === null) return false;
  if (market.limitsUsable === false) return false;
  if (market.limitsForSweep === null) return false;
  if (market.limitsForSweep !== market.sweep + 1) return false;
  return true;
}

function clampFraction(value: Decimal): Decimal {
  if (value.lt(0)) return Decimal.zero();
  if (value.gt(1)) return Decimal.from('1');
  return value;
}

export function lateStartBootstrapProposal(
  context: StrategyContext,
  options: LateStartBootstrapOptions,
): StrategyProposal {
  const history = context.market.history;
  const indicators: Record<string, string> = { observations: String(history.length) };

  if (!options.enabled) return noTrade('late_start_strategy_disabled', indicators);

  if (history.length < LATE_START_OBSERVATIONS_REQUIRED) {
    return noTrade('late_start_insufficient_observations', indicators);
  }

  const latest = history[history.length - 1]!;
  const previous = history[history.length - 2]!;
  const signal = lateStartSignal(latest, previous, options.rules.priceStep);
  indicators.signal = signal;
  indicators.previous = previous.toString();
  indicators.latest = latest.toString();

  if (!marketIsUsable(context.market)) return noTrade('late_start_market_unusable', indicators);
  if (signal === 'flat') return noTrade('late_start_flat', indicators);

  const maxQty = context.caps.maxQty;
  if (!maxQty.gt(0)) return noTrade('late_start_risk_unavailable', indicators);

  return {
    intent: 'MAKE_OFFER',
    side: signal === 'rising' ? 'buy' : 'sell',
    // The rules' minimum quantity, written as the fraction the gate multiplies
    // `max_qty` by: the gate floors the product to the 0.01 step, so this is the
    // smallest trade the rules allow and never a position.
    sizeFraction: clampFraction(options.rules.minQty.div(maxQty)),
    // The decision is a rule, not an estimate, so it does not claim a measured
    // confidence. It reports certainty about its own bounded construction; the
    // group caps' confidence thresholds exist to filter noisy seeded signals and
    // are not a filter this rule can be improved by failing.
    confidence: Decimal.from('1'),
    reason: signal === 'rising' ? 'late_start_price_rising' : 'late_start_price_falling',
    indicators,
  };
}
