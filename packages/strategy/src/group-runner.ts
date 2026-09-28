/**
 * Running a group's 30 agents: the only path that produces an `agent_run`.
 *
 * "Each agent must execute a local strategy evaluation at least once every
 * rolling 7x24 hours" is the participation floor for this project, and this
 * module is what satisfies it. A run is:
 *
 *   1. take the current snapshot and the agent's parameters and caps;
 *   2. call the group's deterministic `evaluate`;
 *   3. pass the proposal through the gate;
 *   4. write one `agent_runs` row and one `decisions` row, in a single
 *      transaction, and update `identities.last_run_at`.
 *
 * A run is recorded whether or not it produced a trade: NO_TRADE is a run. That
 * matters because the watchdog's job is to find agents that never ran, not
 * agents that never traded.
 *
 * The window is rolling, not ISO-week. An ISO-week boundary would let an agent
 * run on Sunday night and again on Monday morning and still look compliant while
 * having been silent for 8 days.
 *
 * Nothing in this path calls the model, sends a heartbeat, or posts to
 * technocore. A backfill run is a local evaluation and nothing else.
 */
import type { MarketSnapshot, RiskCaps, Rules } from '@flop/close-call';
import { Decimal } from '@flop/close-call';
import type { Repositories } from '@flop/storage';
import { gateDecision } from './deterministic-gate.js';
import { profileFor } from './profiles.js';
import {
  ExternalOffer,
  GatedAction,
  STRATEGY_GROUP_NAMES,
  StrategyContext,
  StrategyGroupName,
  StrategyLogger,
  StrategyProposal,
} from './types.js';

export type RunSource = 'scheduler' | 'weekly_backfill' | 'manual' | 'soak';

export interface AgentRunInput {
  agentId: string;
  group: StrategyGroupName;
  params: Record<string, Decimal>;
  caps: RiskCaps;
  market: MarketSnapshot;
  position: Decimal;
  cash: Decimal;
  openNotional: Decimal;
  lastTradeSweep: number | null;
  randomSeed: number;
  sameDirectionStreak: number;
  externalOffers: ExternalOffer[];
  sweep: number;
}

export interface RunOutcome {
  agentId: string;
  group: StrategyGroupName;
  runAt: string;
  rollingWindowStart: string;
  source: RunSource;
  proposal: StrategyProposal;
  action: GatedAction;
  runId: number;
  decisionId: number;
}

export interface GroupRunnerOptions {
  repositories: Repositories;
  logger: StrategyLogger;
  rules: Rules;
  /** Rolling window length; 7 * 24 hours by default. */
  runWindowHours?: number;
  now?: () => Date;
}

/** Start of the rolling window that contains `now`. */
export function rollingWindowStart(now: Date, runWindowHours: number): Date {
  return new Date(now.getTime() - runWindowHours * 3600_000);
}

/** The ISO-week label, kept for reporting only — never for compliance. */
export function isoWeekLabel(at: Date): string {
  const date = new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), at.getUTCDate()));
  const day = date.getUTCDay() || 7;
  date.setUTCDate(date.getUTCDate() + 4 - day);
  const yearStart = new Date(Date.UTC(date.getUTCFullYear(), 0, 1));
  const week = Math.ceil(((date.getTime() - yearStart.getTime()) / 86400000 + 1) / 7);
  return `${date.getUTCFullYear()}-W${String(week).padStart(2, '0')}`;
}

export class GroupRunner {
  private readonly repositories: Repositories;
  private readonly logger: StrategyLogger;
  private readonly rules: Rules;
  private readonly runWindowHours: number;
  private readonly now: () => Date;

  constructor(options: GroupRunnerOptions) {
    this.repositories = options.repositories;
    this.logger = options.logger;
    this.rules = options.rules;
    this.runWindowHours = options.runWindowHours ?? 168;
    this.now = options.now ?? (() => new Date());
  }

  /**
   * Order agents deterministically so consecutive ticks rotate through a group
   * without ever repeating an id inside one tick.
   *
   * The take is capped at the group size: a group of three with `perTick` ten
   * must yield three distinct agents, not ten with wrap-around duplicates. Two
   * ticks with the same id would double-count runs and break the per-tick
   * bookkeeping the scheduler does downstream.
   */
  static partition(agentIds: string[], tickIndex: number, perTick: number): string[] {
    const ordered = [...new Set(agentIds)].sort();
    if (perTick <= 0 || ordered.length === 0) return [];
    const start = (((tickIndex * perTick) % ordered.length) + ordered.length) % ordered.length;
    const take = Math.min(perTick, ordered.length);
    const slice: string[] = [];
    for (let offset = 0; offset < take; offset += 1) {
      slice.push(ordered[(start + offset) % ordered.length]!);
    }
    return slice;
  }

  runAgent(input: AgentRunInput, source: RunSource = 'scheduler'): RunOutcome {
    const at = this.now();
    const runAt = at.toISOString();
    const windowStart = rollingWindowStart(at, this.runWindowHours).toISOString();

    const context: StrategyContext = {
      agentId: input.agentId,
      group: input.group,
      sweep: input.sweep,
      market: input.market,
      caps: input.caps,
      params: input.params,
      position: input.position,
      cash: input.cash,
      openNotional: input.openNotional,
      lastTradeSweep: input.lastTradeSweep,
      randomSeed: input.randomSeed,
      sameDirectionStreak: input.sameDirectionStreak,
      externalOffers: input.externalOffers,
    };

    const proposal = profileFor(input.group).evaluate(context);
    const action = gateDecision({ proposal, context, rules: this.rules });

    // A run is one logical event across three tables. If the process dies
    // between them the evidence would be split — an `agent_runs` row whose
    // `decisions` row is missing, or a `last_run_at` that disagrees with both —
    // so all three commit together or not at all.
    const { runId, decisionId } = this.repositories.transaction(() => {
      const runId = this.repositories.agentRuns.insert({
        agent_id: input.agentId,
        run_at: runAt,
        rolling_window_start: windowStart,
        strategy_group: input.group,
        strategy_version: profileFor(input.group).version,
        action: action.intent,
        confidence: action.confidence.toString(),
        reason: action.gate === 'ok' ? action.reason : `${action.reason}:${action.gate}`,
        source,
      });
      const decisionId = this.repositories.decisions.insert({
        agent_id: input.agentId,
        run_at: runAt,
        action: action.intent,
        confidence: action.confidence.toString(),
        reason: action.reason,
        strategy_group: input.group,
        strategy_version: profileFor(input.group).version,
        sweep: input.sweep,
        reference_px: input.market.reference?.toString() ?? null,
        detail: JSON.stringify({
          gate: action.gate,
          side: action.side,
          qty: action.qty?.toString() ?? null,
          px: action.px?.toString() ?? null,
          offerId: action.offer?.terms.id ?? null,
          indicators: action.indicators,
        }),
      });
      this.repositories.identities.recordRun(input.agentId, runAt, isoWeekLabel(at));
      return { runId, decisionId };
    });

    return {
      agentId: input.agentId,
      group: input.group,
      runAt,
      rollingWindowStart: windowStart,
      source,
      proposal,
      action,
      runId,
      decisionId,
    };
  }

  /**
   * Run a batch, swallowing nothing: one agent's failure must not stop the other
   * 29, but every failure is logged and counted so the report can show it.
   */
  runBatch(
    inputs: AgentRunInput[],
    source: RunSource = 'scheduler',
  ): { outcomes: RunOutcome[]; failures: Array<{ agentId: string; error: string }> } {
    const outcomes: RunOutcome[] = [];
    const failures: Array<{ agentId: string; error: string }> = [];
    for (const input of inputs) {
      try {
        outcomes.push(this.runAgent(input, source));
      } catch (error) {
        failures.push({ agentId: input.agentId, error: String(error) });
        this.logger.event({
          level: 'error',
          source: 'group-runner',
          code: 'agent_run_failed',
          message: `agent ${input.agentId} failed to evaluate`,
          data: { agentId: input.agentId, group: input.group, error: String(error) },
        });
      }
    }
    return { outcomes, failures };
  }

  /** Agents that have not run inside the rolling window; the watchdog's query. */
  staleAgents(): Array<{ agentId: string; lastRunAt: string | null; group: string }> {
    const cutoff = rollingWindowStart(this.now(), this.runWindowHours).toISOString();
    return this.repositories.identities.staleSince(cutoff).map((row) => ({
      agentId: row.agent_id,
      lastRunAt: row.last_run_at,
      group: row.strategy_group,
    }));
  }

  /** Per-group run counts inside the window, for the Lark report. */
  groupStats(): Array<{ group: string; runs: number; agents: number }> {
    const since = rollingWindowStart(this.now(), this.runWindowHours).toISOString();
    const rows = this.repositories.agentRuns.byGroupSince(since);
    const byGroup = new Map(rows.map((row) => [row.strategy_group, row]));
    return STRATEGY_GROUP_NAMES.map((group) => ({
      group,
      runs: byGroup.get(group)?.runs ?? 0,
      agents: byGroup.get(group)?.agents ?? 0,
    }));
  }
}

export { STRATEGY_GROUP_NAMES };
