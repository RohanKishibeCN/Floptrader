/**
 * The five fixed strategy groups.
 *
 * The contest rule is exact: 150 agents, five groups, thirty each. Everything
 * else about the strategy layer is a safety property:
 *
 *   - a profile is a pure function of (snapshot, params, caps); the same inputs
 *     must produce the same proposal on every run and after every restart, or
 *     "deterministic" is a claim we cannot keep;
 *   - with no market data, every profile must decline. A strategy that trades on
 *     an empty snapshot is guessing;
 *   - `external_offer_taker` must never create a maker offer — its whole reason
 *     for existing is to take other people's;
 *   - a run is local: no network write, no model call, ever.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  AGENTS_PER_GROUP,
  DEFAULT_AGENT_COUNT,
  STRATEGY_GROUPS,
  assignStrategyGroup,
} from '@flop/identity';
import { DEFAULT_RISK_CAPS, Decimal, emptySnapshot, referenceRules } from '@flop/close-call';
import {
  GroupRunner,
  STRATEGY_GROUP_NAMES,
  asDecimals,
  evaluateGroup,
  fallbackParams,
  gateDecision,
  type StrategyContext,
} from '@flop/strategy';
import { closeDatabase, createRepositories, openDatabase, type Repositories, type SqliteDatabase } from '@flop/storage';
import { Logger } from '../apps/orchestrator/src/logger.js';
import { generateAgents, groupCounts } from './support/harness.js';

const silent = Logger.create({ level: 'fatal' });
const rules = referenceRules();

/** A market with a reference and published limits, i.e. a normal sweep. */
function market(overrides: Partial<ReturnType<typeof emptySnapshot>> = {}) {
  return {
    ...emptySnapshot(),
    sweep: 900,
    reference: Decimal.from('225.10'),
    limits: { low: Decimal.from('213.85'), high: Decimal.from('236.36') },
    history: ['220.00', '221.50', '223.00', '224.20', '225.10'].map((px) => Decimal.from(px)),
    degraded: false,
    degradedReason: null,
    ...overrides,
  };
}

function contextFor(
  group: (typeof STRATEGY_GROUPS)[number],
  overrides: Partial<StrategyContext> = {},
): StrategyContext {
  return {
    agentId: 'agent-0001',
    group,
    sweep: 900,
    market: market(),
    caps: DEFAULT_RISK_CAPS[group]!,
    params: asDecimals(fallbackParams(group).values),
    position: Decimal.zero(),
    cash: rules.mint,
    openNotional: Decimal.zero(),
    lastTradeSweep: null,
    randomSeed: 12345,
    sameDirectionStreak: 0,
    externalOffers: [],
    ...overrides,
  };
}

describe('group composition', () => {
  it('assigns exactly 150 agents to exactly 5 groups of exactly 30', () => {
    expect(STRATEGY_GROUPS).toHaveLength(5);
    expect(STRATEGY_GROUP_NAMES).toEqual([...STRATEGY_GROUPS]);
    expect(DEFAULT_AGENT_COUNT).toBe(150);

    const agents = generateAgents(150, true);
    const counts = groupCounts(agents);
    for (const group of STRATEGY_GROUPS) {
      expect(counts[group]).toBe(AGENTS_PER_GROUP);
      expect(counts[group]).toBe(30);
    }
    expect(Object.keys(counts)).toHaveLength(5);
  });

  it('assigns by index, so the mapping is stable across restarts', () => {
    for (let index = 0; index < 150; index += 1) {
      expect(assignStrategyGroup(index)).toBe(STRATEGY_GROUPS[index % 5]);
    }
    // And a regenerated list produces the same groups: nothing random is involved.
    const first = generateAgents(150, true).map((agent) => agent.strategyGroup);
    const second = generateAgents(150, true).map((agent) => agent.strategyGroup);
    expect(second).toEqual(first);
  });

  it('gives every group its own risk caps, tightest for contrarian', () => {
    const contrarian = DEFAULT_RISK_CAPS.contrarian!;
    for (const group of STRATEGY_GROUPS) {
      const caps = DEFAULT_RISK_CAPS[group]!;
      expect(caps.maxQty.isPositive()).toBe(true);
      expect(caps.maxOpenNotional.isPositive()).toBe(true);
      expect(caps.confidenceThreshold.gt(0)).toBe(true);
      if (group !== 'contrarian') {
        expect(caps.maxQty.lte(contrarian.maxQty)).toBe(false);
      }
    }
    expect(contrarian.maxQty.lte(DEFAULT_RISK_CAPS.breakout!.maxQty)).toBe(true);
  });
});

describe('deterministic evaluation', () => {
  it('is a pure function of its inputs', () => {
    for (const group of STRATEGY_GROUPS) {
      const context = contextFor(group);
      const first = evaluateGroup(group, context);
      const second = evaluateGroup(group, context);
      expect(second).toEqual(first);
      // A different random seed must not change the decision for these profiles:
      // the seed only breaks ties in size, never in direction.
      const reseeded = evaluateGroup(group, { ...context, randomSeed: 999 });
      expect(reseeded.intent).toBe(first.intent);
    }
  });

  it('declines on an empty snapshot for every group', () => {
    for (const group of STRATEGY_GROUPS) {
      const proposal = evaluateGroup(
        group,
        contextFor(group, { market: emptySnapshot(), sweep: 0 }),
      );
      expect(proposal.intent).toBe('NO_TRADE');
      expect(proposal.reason.length).toBeGreaterThan(0);
    }
  });

  it('never lets external_offer_taker create a maker offer', () => {
    // With many plausible markets, and with a stranger's offer in hand, the only
    // thing this group may propose is taking the offer or nothing.
    for (const px of ['213.90', '220.00', '225.10', '230.00', '236.30']) {
      for (const sweep of [800, 900, 1000]) {
        const proposal = evaluateGroup(
          'external_offer_taker',
          contextFor('external_offer_taker', { market: market({ sweep, reference: Decimal.from(px) }) }),
        );
        expect(['NO_TRADE', 'ACCEPT_EXTERNAL']).toContain(proposal.intent);
      }
    }
  });

  it('takes the offer on the favourable side of the reference, and only that one', () => {
    const offer = (side: 'buy' | 'sell', px: string) => ({
      terms: {
        id: `trade-${side}-${px}`,
        maker: 'did:key:z6Mk' + 'A'.repeat(44),
        px,
        qty: '1.00',
        side,
        taker: 'any' as const,
        until: 950,
      },
      makerSig: 'sig',
      room: 'close1',
      seq: 1,
      observedAt: 'now',
    });
    const evaluate = (offers: ReturnType<typeof offer>[]) =>
      evaluateGroup(
        'external_offer_taker',
        contextFor('external_offer_taker', { externalOffers: offers }),
      );

    // The reference is 225.10. A maker buying at 228.00 leaves us +1.29%, and a
    // maker selling at 222.00 leaves us +1.38%. Both are worth taking.
    expect(evaluate([offer('buy', '228.00')]).intent).toBe('ACCEPT_EXTERNAL');
    expect(evaluate([offer('sell', '222.00')]).intent).toBe('ACCEPT_EXTERNAL');
    // The same two offers on the wrong side of the reference are losses and must
    // be refused. This is the direction a denominator of `px` instead of the
    // reference inverts, which would make the group take *only* these.
    expect(evaluate([offer('buy', '222.00')]).intent).toBe('NO_TRADE');
    expect(evaluate([offer('sell', '228.00')]).intent).toBe('NO_TRADE');
    // The reader filters local DIDs out before the strategy ever sees an offer,
    // so with an empty list the group must decline rather than invent one.
    expect(evaluate([]).intent).toBe('NO_TRADE');
  });

  it('prices an in-fleet offer against a threshold of its own', () => {
    const offer = (side: 'buy' | 'sell', px: string, localMaker: boolean) => ({
      terms: {
        id: `trade-${side}-${px}-${localMaker ? 'ours' : 'theirs'}`,
        maker: 'did:key:z6Mk' + 'A'.repeat(44),
        px,
        qty: '1.00',
        side,
        taker: 'any' as const,
        until: 950,
      },
      makerSig: 'sig',
      room: 'close1',
      seq: 1,
      observedAt: 'now',
      ...(localMaker ? { localMaker: true } : {}),
    });
    const evaluate = (offers: ReturnType<typeof offer>[]) =>
      evaluateGroup(
        'external_offer_taker',
        contextFor('external_offer_taker', { externalOffers: offers }),
      );

    // A maker's edge and a taker's edge are zero-sum on one price: a maker posts
    // on its own favourable side, so a stranger's offer at 222.00 (buy) or 228.00
    // (sell) is behind the market by ~1.4% and correctly refused.
    expect(evaluate([offer('buy', '222.00', false)]).intent).toBe('NO_TRADE');
    expect(evaluate([offer('sell', '228.00', false)]).intent).toBe('NO_TRADE');
    // Our own offer is the other half of a bet the fleet is already taking, so it
    // is filled at the maker's own price instead of being expired by the referee:
    // the fleet's net position is unchanged, and the trade settles into two scored
    // accounts rather than scoring nothing. A maker's concession of ~1.4% is
    // inside the 1.5% cap that admits our own 1.25% bootstrap edge.
    expect(evaluate([offer('buy', '222.00', true)]).intent).toBe('ACCEPT_EXTERNAL');
    expect(evaluate([offer('sell', '228.00', true)]).intent).toBe('ACCEPT_EXTERNAL');
    // The cap is real: a price so far from the market that it is no longer a maker
    // price is refused even in-fleet. 5% away is past it.
    expect(evaluate([offer('sell', '236.40', true)]).intent).toBe('NO_TRADE');
    expect(evaluate([offer('buy', '213.85', true)]).intent).toBe('NO_TRADE');
    // And a stranger's offer is still held to the stricter market-edge rule, so
    // the lane that trades with other operators is unchanged.
    expect(evaluate([offer('sell', '228.00', false)]).intent).toBe('NO_TRADE');
  });
});

describe('the deterministic gate', () => {
  it('refuses below the confidence threshold', () => {
    const group = 'breakout' as const;
    const context = contextFor(group);
    const decision = gateDecision({
      proposal: {
        intent: 'MAKE_OFFER',
        side: 'buy',
        sizeFraction: Decimal.from('1'),
        confidence: DEFAULT_RISK_CAPS[group]!.confidenceThreshold.sub('0.01'),
        reason: 'test',
        indicators: {},
      },
      context,
      rules,
    });
    expect(decision.intent).toBe('NO_TRADE');
    expect(decision.gate).toBe('confidence');
  });

  it('refuses a locked sweep, whatever the proposal says', () => {
    const context = contextFor('trend_following', {
      market: market({ sweep: rules.lockSweep + 1, locked: true }),
      sweep: rules.lockSweep + 1,
    });
    const decision = gateDecision({
      proposal: {
        intent: 'MAKE_OFFER',
        side: 'buy',
        sizeFraction: Decimal.from('1'),
        confidence: Decimal.from('0.99'),
        reason: 'test',
        indicators: {},
      },
      context,
      rules,
    });
    expect(decision.intent).toBe('NO_TRADE');
    expect(decision.gate).toBe('locked');
  });

  it('never sizes above the group cap', () => {
    for (const group of STRATEGY_GROUPS) {
      const caps = DEFAULT_RISK_CAPS[group]!;
      const context = contextFor(group);
      const decision = gateDecision({
        proposal: {
          intent: 'MAKE_OFFER',
          side: 'buy',
          sizeFraction: Decimal.from('1'),
          confidence: Decimal.from('1'),
          reason: 'test',
          indicators: {},
        },
        context,
        rules,
      });
      if (decision.qty !== null) {
        expect(decision.qty.lte(caps.maxQty)).toBe(true);
      }
    }
  });
});

describe('the group runner records a run for every agent', () => {
  let db: SqliteDatabase;
  let repositories: Repositories;

  beforeEach(() => {
    db = openDatabase({ path: ':memory:' });
    repositories = createRepositories(db);
  });

  afterEach(() => {
    closeDatabase(db);
  });

  it('writes one agent_run and one decision per agent, and updates last_run_at', () => {
    const runner = new GroupRunner({ repositories, logger: silent, rules });
    const inputs = STRATEGY_GROUPS.flatMap((group, groupIndex) =>
      Array.from({ length: 3 }, (_unused, offset) =>
        runnerInput(group, `agent-${String(groupIndex * 3 + offset + 1).padStart(4, '0')}`),
      ),
    );

    const outcome = runner.runBatch(inputs, 'scheduler');

    expect(outcome.failures).toHaveLength(0);
    expect(outcome.outcomes).toHaveLength(15);
    expect(repositories.agentRuns.count()).toBe(15);
    expect(repositories.decisions.countSince('1970-01-01T00:00:00.000Z')).toBe(15);
    for (const input of inputs) {
      expect(repositories.identities.get(input.agentId)?.last_run_at ?? null).not.toBeNull();
    }
    // The rolling window start is recorded, not an ISO week boundary.
    const row = db
      .prepare('SELECT rolling_window_start FROM agent_runs LIMIT 1')
      .get() as { rolling_window_start: string };
    const now = Date.now();
    const start = Date.parse(row.rolling_window_start);
    expect(now - start).toBeGreaterThan(167 * 3600_000);
    expect(now - start).toBeLessThan(169 * 3600_000);
  });

  it('partitions every agent across consecutive ticks', () => {
    const agentIds = generateAgents(150, true).map((agent) => agent.agentId);
    const seen = new Set<string>();
    for (let tickIndex = 0; tickIndex < 15; tickIndex += 1) {
      for (const agentId of GroupRunner.partition(agentIds, tickIndex, 10)) seen.add(agentId);
    }
    expect(seen.size).toBe(150);
  });

  function runnerInput(group: (typeof STRATEGY_GROUPS)[number], agentId: string) {
    // A real identity per agent: `identities.did` is unique, and the runner's
    // downstream consumers key off the DID rather than the agent id.
    const record = generateAgents(150, true).find((agent) => agent.agentId === agentId)!;
    repositories.identities.upsert({
      agent_id: agentId,
      did: record.did,
      public_key_multibase: record.publicKeyMultibase,
      fingerprint: record.fingerprint,
      strategy_group: group,
      season: 'close-1',
      risk_tier: group,
      random_seed: 1,
      max_qty: DEFAULT_RISK_CAPS[group]!.maxQty.toString(),
      max_open_notional: DEFAULT_RISK_CAPS[group]!.maxOpenNotional.toString(),
      cooldown_sweeps: DEFAULT_RISK_CAPS[group]!.cooldownSweeps,
      confidence_threshold: DEFAULT_RISK_CAPS[group]!.confidenceThreshold.toString(),
      strategy_version: 'v1',
      last_run_at: null,
      last_run_week: null,
      enabled: 1,
    });
    return {
      agentId,
      group,
      params: asDecimals(fallbackParams(group).values),
      caps: DEFAULT_RISK_CAPS[group]!,
      market: market(),
      position: Decimal.zero(),
      cash: rules.mint,
      openNotional: Decimal.zero(),
      lastTradeSweep: null,
      randomSeed: 1,
      sameDirectionStreak: 0,
      externalOffers: [],
      sweep: 900,
    };
  }
});
