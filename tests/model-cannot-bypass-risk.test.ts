/**
 * "The model cannot bypass the risk engine."
 *
 * This is the load-bearing claim of the DeepSeek integration, and it is a claim
 * about *structure*, not about the model's goodwill. Three separate mechanisms
 * have to hold, and each is asserted here:
 *
 *   1. the model's output shape is the parameter surface and nothing else. It
 *      cannot name a risk cap (`maxQty`, `maxOpenNotional`, `confidenceThreshold`)
 *      on a group that has no such parameter, and it cannot attach extra fields
 *      — a signature, a DID — that ride along beside `values`;
 *   2. every parameter is bounded, and a value that needed clamping is a refusal
 *      rather than a silent adjustment;
 *   3. the risk engine's caps live outside the parameter surface entirely. The
 *      gate floors quantity at `caps.maxQty` whatever `sizeFraction` says, and
 *      `checkLocalCaps` enforces absolute ceilings that hold even if the cap
 *      table itself were wrong.
 *
 * The last test runs the real optimiser against a real database and checks that
 * an accepted proposal touched `strategy_versions` and `llm_calls` — and nothing
 * else. In particular, not the `identities` row that holds the caps.
 */
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ABSOLUTE_MAX_OPEN_NOTIONAL,
  ABSOLUTE_MAX_QTY,
  DEFAULT_RISK_CAPS,
  Decimal,
  checkLocalCaps,
  emptySnapshot,
  referenceRules,
  type RiskCaps,
} from '@flop/close-call';
import {
  DEFAULT_PARAMS,
  PARAM_BOUNDS,
  STRATEGY_GROUP_NAMES,
  asDecimals,
  fallbackParams,
  gateDecision,
  validateParams,
  type StrategyContext,
  type StrategyGroupName,
} from '@flop/strategy';
import {
  closeDatabase,
  createRepositories,
  openDatabase,
  type Repositories,
  type SqliteDatabase,
} from '@flop/storage';
import { loadConfig } from '../apps/orchestrator/src/config.js';
import { Logger } from '../apps/orchestrator/src/logger.js';
import {
  DeepSeekBudget,
  DeepSeekClient,
  ParameterOptimiser,
  type ParameterReviewInput,
} from '../apps/orchestrator/src/llm.js';
import { cleanup, tempDir } from './support/harness.js';

const config = loadConfig({
  TIMEZONE: 'Asia/Shanghai',
  // This test drives the optimiser, which is off by default in the MVP.
  DEEPSEEK_ENABLED: 'true',
  DEEPSEEK_API_KEY: 'test-key',
  DEEPSEEK_MIN_INTERVAL_MS: '0',
  DEEPSEEK_TIMEOUT_MS: '1000',
});

/** 12:00 Shanghai — the first minute of the midday allowed window. */
const allowedTime = new Date('2026-09-28T04:00:00.000Z');

const rules = referenceRules();

let dir: string;
let db: SqliteDatabase;
let repositories: Repositories;
let logger: Logger;

beforeEach(() => {
  dir = tempDir('flop-nobypass-');
  db = openDatabase({ path: join(dir, 'app.db') });
  repositories = createRepositories(db);
  logger = Logger.create({ level: 'fatal', repositories });
});

afterEach(() => {
  closeDatabase(db);
  cleanup(dir);
});

function countRows(table: string): number {
  return (db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
}

/** A normal sweep: a reference price, published limits, no degradation. */
function market() {
  return {
    ...emptySnapshot(),
    sweep: 900,
    reference: Decimal.from('225.10'),
    limits: { low: Decimal.from('213.85'), high: Decimal.from('236.36') },
    history: ['220.00', '221.50', '223.00', '224.20', '225.10'].map((px) => Decimal.from(px)),
    degraded: false,
    degradedReason: null,
  };
}

function contextFor(
  group: StrategyGroupName,
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

function inputFor(group: StrategyGroupName): ParameterReviewInput {
  return {
    group,
    current: { ...DEFAULT_PARAMS[group].values },
    currentVersion: DEFAULT_PARAMS[group].version,
    tradesSettled: 84,
    tradesVoid: 12,
    realisedPnl: '12.34',
    winRate: '0.8750',
    sweepsObserved: 8,
    volatility: '0.006',
  };
}

/** A client whose model reply is whatever `content` returns. */
function clientReplying(content: () => string): DeepSeekClient {
  const fetchImpl = vi.fn(async () => {
    const body = JSON.stringify({
      choices: [{ message: { content: content() } }],
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
    });
    return new Response(body, { status: 200, headers: { 'content-type': 'application/json' } });
  });
  return new DeepSeekClient({ config, logger, fetchImpl: fetchImpl as unknown as typeof fetch });
}

function optimiserWith(client: DeepSeekClient): ParameterOptimiser {
  const budget = new DeepSeekBudget({ repositories, config, logger, now: () => allowedTime });
  return new ParameterOptimiser({
    config,
    logger,
    repositories,
    client,
    budget,
    now: () => allowedTime,
  });
}

function seedOperatorVersion(group: StrategyGroupName, values: Record<string, number>): void {
  repositories.strategyVersions.insert({
    id: 'seed-v1',
    strategy_group: group,
    version: 'seed-v1',
    params_json: JSON.stringify(values),
    source: 'operator',
    llm_call_id: null,
    effective_from: '2026-09-27T00:00:00.000Z',
    superseded_at: null,
  });
}

// ---------------------------------------------------------------------------
// 1. the output shape is the parameter surface
// ---------------------------------------------------------------------------

describe('the model can only reach the parameter surface', () => {
  it('cannot name a risk cap on a group that has no such parameter', () => {
    // These three groups define no parameter with a cap's name, so a proposal
    // that names one is rejected as unknown rather than silently dropped.
    const groups: StrategyGroupName[] = ['trend_following', 'mean_reversion', 'contrarian'];
    for (const group of groups) {
      for (const key of ['maxQty', 'maxOpenNotional', 'confidenceThreshold', 'riskTier']) {
        const outcome = validateParams({ values: { [key]: 9999 } }, group);
        expect(outcome.ok).toBe(false);
        expect(outcome.errors.join(' ')).toContain(`unknown parameter for ${group}: ${key}`);
      }
    }
  });

  it('returns exactly the bound keys, so no extra field can ride along', () => {
    for (const group of STRATEGY_GROUP_NAMES) {
      const atMax: Record<string, number> = {};
      for (const [key, bound] of Object.entries(PARAM_BOUNDS[group])) atMax[key] = bound.max;

      const outcome = validateParams({ values: atMax }, group);
      expect(outcome.ok).toBe(true);
      expect(outcome.clamped).toEqual([]);
      expect(Object.keys(outcome.params!.values).sort()).toEqual(
        Object.keys(PARAM_BOUNDS[group]).sort(),
      );
    }
  });

  it('cannot smuggle a signature or a DID beside its values', async () => {
    seedOperatorVersion('trend_following', DEFAULT_PARAMS.trend_following.values);
    const reply = JSON.stringify({
      values: { ...DEFAULT_PARAMS.trend_following.values },
      note: 'hold',
      sig: 'A'.repeat(86),
      did: 'did:key:z6Mk' + 'A'.repeat(44),
      text: 'owner registration',
    });
    const optimiser = optimiserWith(clientReplying(() => reply));

    const outcome = await optimiser.review(inputFor('trend_following'));
    expect(outcome.accepted).toBe(true);

    const live = repositories.strategyVersions
      .history('trend_following')
      .filter((row) => row.superseded_at === null);
    expect(live).toHaveLength(1);
    const stored = JSON.parse(live[0]!.params_json) as Record<string, unknown>;
    expect(Object.keys(stored).sort()).toEqual(Object.keys(PARAM_BOUNDS.trend_following).sort());
    expect(live[0]!.params_json).not.toContain('sig');
    expect(live[0]!.params_json).not.toContain('did:key');
  });
});

// ---------------------------------------------------------------------------
// 2. every parameter is bounded
// ---------------------------------------------------------------------------

describe('every parameter is bounded, and a clamp is a refusal', () => {
  it('clamps a value above the maximum instead of accepting it', () => {
    for (const group of STRATEGY_GROUP_NAMES) {
      for (const [key, bound] of Object.entries(PARAM_BOUNDS[group])) {
        const outcome = validateParams({ values: { [key]: bound.max * 1000 + 1 } }, group);
        expect(outcome.ok, `${group}.${key}`).toBe(true);
        expect(outcome.clamped.length, `${group}.${key} must be reported as clamped`).toBeGreaterThan(0);
        expect(outcome.params!.values[key]!).toBeLessThanOrEqual(bound.max);
      }
    }
  });

  it('never allows a size fraction above one, so size cannot exceed the quantity cap', () => {
    for (const group of STRATEGY_GROUP_NAMES) {
      // external_offer_taker has no sizeFraction: it takes the offer's size, and
      // bounds the notional it may spend as a fraction of the cap instead.
      const fraction = PARAM_BOUNDS[group].sizeFraction;
      if (fraction) expect(fraction.max).toBeLessThanOrEqual(1);
      expect(PARAM_BOUNDS[group].maxOpenNotionalFraction?.max ?? 0).toBeLessThanOrEqual(1);
      expect(DEFAULT_PARAMS[group].values.sizeFraction ?? 0).toBeLessThanOrEqual(1);
    }
  });

  it('turns a clamped proposal into a refusal before it becomes effective', async () => {
    seedOperatorVersion('trend_following', DEFAULT_PARAMS.trend_following.values);
    const optimiser = optimiserWith(
      clientReplying(() => JSON.stringify({ values: { slopeThreshold: 9999 } })),
    );

    const outcome = await optimiser.review(inputFor('trend_following'));
    expect(outcome.accepted).toBe(false);
    expect(outcome.reason).toBe('bounds');
    expect(repositories.strategyVersions.effective('trend_following')?.id).toBe('seed-v1');
  });
});

// ---------------------------------------------------------------------------
// 3. the caps live outside the parameter surface
// ---------------------------------------------------------------------------

describe('the risk engine holds the caps, not the parameters', () => {
  it('floors quantity at the risk cap when sizeFraction is at its largest allowed value', () => {
    const group: StrategyGroupName = 'trend_following';
    const caps = DEFAULT_RISK_CAPS[group]!;
    const decision = gateDecision({
      proposal: {
        intent: 'MAKE_OFFER',
        side: 'buy',
        sizeFraction: Decimal.from('1'),
        confidence: Decimal.from('0.99'),
        reason: 'test',
        indicators: {},
      },
      context: contextFor(group),
      rules,
    });

    expect(decision.gate).toBe('ok');
    expect(decision.intent).toBe('MAKE_OFFER');
    expect(decision.qty!.lte(caps.maxQty)).toBe(true);
    expect(decision.qty!.eq(caps.maxQty)).toBe(true);
    expect(decision.qty!.toString()).toBe('25.00');
  });

  it('refuses rather than enlarges when sizeFraction is absurd', () => {
    const decision = gateDecision({
      proposal: {
        intent: 'MAKE_OFFER',
        side: 'buy',
        // Far outside the bound. Even a hypothetical hole in the parameter layer
        // must not become a larger trade: the cap check runs after the multiply.
        sizeFraction: Decimal.from('1000000'),
        confidence: Decimal.from('0.99'),
        reason: 'test',
        indicators: {},
      },
      context: contextFor('trend_following'),
      rules,
    });

    expect(decision.intent).toBe('NO_TRADE');
    expect(decision.gate).toBe('qty_cap');
    expect(decision.qty).toBeNull();
  });

  it('enforces absolute ceilings even when the cap table is wrong', () => {
    const inflated: RiskCaps = {
      maxQty: Decimal.from('99999'),
      maxOpenNotional: Decimal.from('9999999'),
      cooldownSweeps: 0,
      confidenceThreshold: Decimal.zero(),
    };

    const oversized = checkLocalCaps({
      caps: inflated,
      qty: ABSOLUTE_MAX_QTY.add('1'),
      px: Decimal.from('1'),
      reference: Decimal.from('1'),
      confidence: Decimal.from('1'),
      sweep: 900,
      locked: false,
      lastTradeSweep: null,
      openNotional: Decimal.zero(),
      conservative: false,
    });
    expect(oversized.allowed).toBe(false);
    expect(oversized.reason).toBe('qty_cap');

    const overNotional = checkLocalCaps({
      caps: inflated,
      // Under the absolute quantity ceiling, over the absolute notional one.
      qty: Decimal.from('10'),
      px: ABSOLUTE_MAX_OPEN_NOTIONAL.add('1'),
      reference: Decimal.from('1'),
      confidence: Decimal.from('1'),
      sweep: 900,
      locked: false,
      lastTradeSweep: null,
      openNotional: Decimal.zero(),
      conservative: false,
    });
    expect(overNotional.allowed).toBe(false);
    expect(overNotional.reason).toBe('notional_cap');
  });

  it('keeps its own cooldown when the parameters disagree', () => {
    const group: StrategyGroupName = 'breakout';
    const caps = DEFAULT_RISK_CAPS[group]!;
    // The strategy parameter allows a longer wait; the risk cap is what applies.
    const decision = gateDecision({
      proposal: {
        intent: 'MAKE_OFFER',
        side: 'buy',
        sizeFraction: Decimal.from('0.1'),
        confidence: Decimal.from('0.99'),
        reason: 'test',
        indicators: {},
      },
      context: contextFor(group, {
        params: asDecimals({ ...fallbackParams(group).values, cooldownSweeps: 12 }),
        sweep: 900,
        lastTradeSweep: 900 - (caps.cooldownSweeps - 1),
      }),
      rules,
    });

    expect(decision.intent).toBe('NO_TRADE');
    expect(decision.gate).toBe('cooldown');
  });
});

// ---------------------------------------------------------------------------
// 4. an accepted proposal touches only its own two tables
// ---------------------------------------------------------------------------

describe('an accepted proposal reaches nothing but strategy_versions and llm_calls', () => {
  it('leaves the identities caps and every trade table untouched', async () => {
    seedOperatorVersion('trend_following', DEFAULT_PARAMS.trend_following.values);

    const caps = DEFAULT_RISK_CAPS.trend_following!;
    repositories.identities.upsert({
      agent_id: 'agent-0001',
      did: 'did:key:z6Mk' + 'A'.repeat(44),
      public_key_multibase: 'z6Mk',
      fingerprint: 'abcd',
      strategy_group: 'trend_following',
      season: 'close-1',
      risk_tier: 'trend_following',
      random_seed: 12345,
      max_qty: caps.maxQty.toString(),
      max_open_notional: caps.maxOpenNotional.toString(),
      cooldown_sweeps: caps.cooldownSweeps,
      confidence_threshold: caps.confidenceThreshold.toString(),
      strategy_version: 'v1',
      last_run_at: null,
      last_run_week: null,
      enabled: 1,
    });
    const before = repositories.identities.get('agent-0001')!;

    const optimiser = optimiserWith(
      clientReplying(() =>
        JSON.stringify({ values: { ...DEFAULT_PARAMS.trend_following.values }, note: 'hold' }),
      ),
    );
    const outcome = await optimiser.review(inputFor('trend_following'));
    expect(outcome.accepted).toBe(true);

    // The caps are byte-identical: nothing the model returned can move them.
    const after = repositories.identities.get('agent-0001')!;
    expect(after.max_qty).toBe(before.max_qty);
    expect(after.max_open_notional).toBe(before.max_open_notional);
    expect(after.cooldown_sweeps).toBe(before.cooldown_sweeps);
    expect(after.confidence_threshold).toBe(before.confidence_threshold);

    // And the review is not a trade path: no trade, message, run or decision.
    expect(countRows('trades')).toBe(0);
    expect(countRows('messages')).toBe(0);
    expect(countRows('agent_runs')).toBe(0);
    expect(countRows('decisions')).toBe(0);
    expect(countRows('owner_registrations')).toBe(0);

    // Only the two tables it owns: one superseded operator row, one live
    // deepseek row, and one accepted call on the local day.
    expect(countRows('strategy_versions')).toBe(2);
    expect(countRows('llm_calls')).toBe(1);
    expect(repositories.llmCalls.countDayNormal('2026-09-28')).toBe(1);
  });
});
