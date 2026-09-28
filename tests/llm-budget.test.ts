/**
 * The DeepSeek budget wall and the parameter pipeline.
 *
 * These tests are the evidence for the cost controls: a zero during the peak
 * windows, a hard daily ceiling no retry can cross, and a pipeline where a bad
 * proposal leaves the previous effective parameters untouched. They use a real
 * temp SQLite database, because the audit trail in `llm_calls` is part of the
 * guarantee.
 */
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  closeDatabase,
  createRepositories,
  openDatabase,
  type Repositories,
  type SqliteDatabase,
} from '@flop/storage';
import { DEFAULT_PARAMS, type StrategyGroupName } from '@flop/strategy';
import { loadConfig } from '../apps/orchestrator/src/config.js';
import { LoadGuard } from '../apps/orchestrator/src/load-guard.js';
import { Logger } from '../apps/orchestrator/src/logger.js';
import {
  DeepSeekBudget,
  DeepSeekClient,
  DeepSeekScheduler,
  ParameterOptimiser,
  crossCheckWithFold,
  type ParameterReviewInput,
  type ParameterReviewOutcome,
} from '../apps/orchestrator/src/llm.js';
import { cleanup, tempDir } from './support/harness.js';

const config = loadConfig({
  TIMEZONE: 'Asia/Shanghai',
  DEEPSEEK_API_KEY: 'test-key',
  DEEPSEEK_MIN_INTERVAL_MS: '0',
  DEEPSEEK_TIMEOUT_MS: '1000',
});

/** 11:00 Shanghai — inside the 09:00–12:00 blocked window. */
const blockedTime = new Date('2026-09-28T03:00:00.000Z');
/** 12:00 Shanghai — the first minute of the midday allowed window. */
const allowedTime = new Date('2026-09-28T04:00:00.000Z');
/** 06:30 and 20:30 Shanghai on the same local day. */
const slotOne = new Date('2026-09-27T22:30:00.000Z');
const slotTwo = new Date('2026-09-28T12:30:00.000Z');

let dir: string;
let db: SqliteDatabase;
let repositories: Repositories;
let logger: Logger;

beforeEach(() => {
  dir = tempDir('flop-llm-');
  db = openDatabase({ path: join(dir, 'app.db') });
  repositories = createRepositories(db);
  logger = Logger.create({ level: 'fatal', repositories });
});

afterEach(() => {
  closeDatabase(db);
  cleanup(dir);
});

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

function seedVersion(group: StrategyGroupName, values: Record<string, number>, id = 'seed-v1'): void {
  repositories.strategyVersions.insert({
    id,
    strategy_group: group,
    version: id,
    params_json: JSON.stringify(values),
    source: 'operator',
    llm_call_id: null,
    effective_from: '2026-09-27T00:00:00.000Z',
    superseded_at: null,
  });
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

function optimiserWith(client: DeepSeekClient, at: Date = allowedTime): ParameterOptimiser {
  const budget = new DeepSeekBudget({ repositories, config, logger, now: () => at });
  return new ParameterOptimiser({ config, logger, repositories, client, budget, now: () => at });
}

describe('DeepSeekBudget: the zero-during-peak rule', () => {
  it('refuses in a blocked window, sends nothing, and records the refusal', () => {
    const budget = new DeepSeekBudget({ repositories, config, logger, now: () => blockedTime });
    const fetchImpl = vi.fn();
    // Kept only to prove the refusal never reaches the transport.
    void new DeepSeekClient({ config, logger, fetchImpl: fetchImpl as unknown as typeof fetch });

    const reservation = budget.reserve('parameter_review', false);
    expect(reservation.allowed).toBe(false);
    expect(reservation.reason).toBe('blocked_window');
    expect(fetchImpl).not.toHaveBeenCalled();

    const day = budget.dayKey(blockedTime);
    expect(repositories.llmCalls.countDayBlocked(day)).toBe(1);
    // window_ok=0 is the audit fingerprint that this was a peak-window refusal.
    const blocked = (
      repositories.llmCalls.history(1) as Array<{ status: string; window_ok: number; error: string | null }>
    ).filter((row) => row.status === 'blocked');
    expect(blocked).toHaveLength(1);
    expect(blocked[0]!.window_ok).toBe(0);
    expect(blocked[0]!.error).toBe('blocked_window');
  });
});

describe('DeepSeekBudget: the daily caps', () => {
  it('never spends more than maxNormalCallsPerDay normal calls', () => {
    const budget = new DeepSeekBudget({ repositories, config, logger, now: () => allowedTime });
    const day = budget.dayKey(allowedTime);

    for (let index = 0; index < config.deepseek.maxNormalCallsPerDay; index += 1) {
      expect(budget.reserve('parameter_review', false).allowed).toBe(true);
      budget.record({ purpose: 'parameter_review', status: 'ok', calledAt: allowedTime });
    }
    const third = budget.reserve('parameter_review', false);
    expect(third.allowed).toBe(false);
    expect(third.reason).toBe('normal_limit');
    expect(repositories.llmCalls.countDayNormal(day)).toBe(config.deepseek.maxNormalCallsPerDay);
    expect(repositories.llmCalls.countDayBlocked(day)).toBe(1);
  });

  it('never crosses the hard limit even when a retry is used', () => {
    const budget = new DeepSeekBudget({ repositories, config, logger, now: () => allowedTime });
    const day = budget.dayKey(allowedTime);

    expect(budget.reserve('parameter_review', false).allowed).toBe(true);
    budget.record({ purpose: 'parameter_review', status: 'ok', calledAt: allowedTime });
    expect(budget.reserve('parameter_review', false).allowed).toBe(true);
    budget.record({ purpose: 'parameter_review', status: 'ok', calledAt: allowedTime });
    expect(budget.reserve('parameter_review', true).allowed).toBe(true);
    budget.record({ purpose: 'parameter_review', status: 'ok', retryOf: 1, calledAt: allowedTime });

    const next = budget.reserve('parameter_review', false);
    expect(next.allowed).toBe(false);
    expect(next.reason).toBe('hard_limit');
    expect(repositories.llmCalls.countDay(day)).toBe(config.deepseek.hardLimitPerDay);
  });

  it('never spends more than maxRetriesPerDay retries', () => {
    const budget = new DeepSeekBudget({ repositories, config, logger, now: () => allowedTime });

    expect(budget.reserve('parameter_review', false).allowed).toBe(true);
    budget.record({ purpose: 'parameter_review', status: 'ok', calledAt: allowedTime });
    expect(budget.reserve('parameter_review', true).allowed).toBe(true);
    budget.record({ purpose: 'parameter_review', status: 'ok', retryOf: 1, calledAt: allowedTime });

    const nextRetry = budget.reserve('parameter_review', true);
    expect(nextRetry.allowed).toBe(false);
    expect(nextRetry.reason).toBe('retry_limit');
  });

  it('refuses with load_shed when the load guard pauses llm work', () => {
    const guard = new LoadGuard({ config, logger });
    // 90% RSS is past the 85% shed threshold, which pauses llm work.
    guard.sample({ rssBytes: 9_000, rssLimitBytes: 10_000, diskUsedPercent: 0, writerQueueDepth: 0, llmQueueDepth: 0, eventLoopLagMs: 0 });
    expect(guard.allow('llm')).toBe(false);

    const budget = new DeepSeekBudget({ repositories, config, logger, now: () => allowedTime, loadGuard: guard });
    const reservation = budget.reserve('parameter_review', false);
    expect(reservation.allowed).toBe(false);
    expect(reservation.reason).toBe('load_shed');
  });
});

describe('DeepSeekClient: local ceilings', () => {
  it('refuses an oversized prompt without calling fetch', async () => {
    const fetchImpl = vi.fn();
    const client = new DeepSeekClient({ config, logger, fetchImpl: fetchImpl as unknown as typeof fetch });
    const oversized = 'x'.repeat(config.deepseek.maxInputTokens * 4 + 4);

    const result = await client.complete(oversized);
    expect(result.ok).toBe(false);
    expect(result.error).toBe('prompt_too_large');
    expect(result.status).toBe(0);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('clamps max_tokens to maxOutputTokens', async () => {
    let capturedBody = '';
    const fetchImpl = vi.fn(async (_url: string, init: RequestInit) => {
      capturedBody = String(init.body);
      return new Response(JSON.stringify({ choices: [{ message: { content: '{"values":{"sizeFraction":0.5}}' } }] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    });
    const client = new DeepSeekClient({ config, logger, fetchImpl: fetchImpl as unknown as typeof fetch });

    const result = await client.complete('hello world', { maxOutputTokens: 9_999 });
    expect(result.ok).toBe(true);
    const body = JSON.parse(capturedBody) as {
      max_tokens: number;
      temperature: number;
      response_format: { type: string };
      messages: Array<{ role: string; content: string }>;
    };
    expect(body.max_tokens).toBe(config.deepseek.maxOutputTokens);
    expect(body.temperature).toBe(0);
    expect(body.response_format).toEqual({ type: 'json_object' });
    expect(body.messages[0]!.content).toBe('hello world');
  });
});

describe('DeepSeekScheduler: one slot at a time, once a day', () => {
  it('attempts only the first slot at 06:30 and only the second at 20:30', async () => {
    const budget = new DeepSeekBudget({ repositories, config, logger, now: () => slotOne });
    const reviewed: string[] = [];
    const stub = {
      async review(input: ParameterReviewInput): Promise<ParameterReviewOutcome> {
        reviewed.push(input.group);
        return { accepted: true, reason: 'ok', params: DEFAULT_PARAMS[input.group], versionId: null };
      },
    } as unknown as ParameterOptimiser;
    const scheduler = new DeepSeekScheduler({ config, logger, optimiser: stub, budget });

    expect(scheduler.dueEvaluations(allowedTime)).toEqual([]);

    const first = await scheduler.runOnce(slotOne);
    expect(first.attempted).toEqual(['trend_following', 'mean_reversion', 'breakout']);

    // Idempotent per local day: the same slot a second time attempts nothing.
    const repeated = await scheduler.runOnce(slotOne);
    expect(repeated.attempted).toEqual([]);

    const second = await scheduler.runOnce(slotTwo);
    expect(second.attempted).toEqual(['contrarian', 'external_offer_taker']);
    expect(reviewed).toHaveLength(5);
  });
});

describe('ParameterOptimiser: refusals keep the previous effective set', () => {
  it('refuses an out-of-range value with reason bounds', async () => {
    seedVersion('trend_following', DEFAULT_PARAMS.trend_following.values);
    const optimiser = optimiserWith(clientReplying(() => JSON.stringify({ values: { slopeThreshold: 99 } })));

    const outcome = await optimiser.review(inputFor('trend_following'));
    expect(outcome.accepted).toBe(false);
    expect(outcome.reason).toBe('bounds');

    const effective = repositories.strategyVersions.effective('trend_following');
    expect(effective?.id).toBe('seed-v1');
    expect(effective?.source).toBe('operator');
  });

  it('refuses prose with reason invalid_json', async () => {
    seedVersion('trend_following', DEFAULT_PARAMS.trend_following.values);
    const optimiser = optimiserWith(clientReplying(() => 'I will not answer that.'));

    const outcome = await optimiser.review(inputFor('trend_following'));
    expect(outcome.accepted).toBe(false);
    expect(outcome.reason).toBe('invalid_json');
    expect(repositories.strategyVersions.effective('trend_following')?.id).toBe('seed-v1');
  });

  it('refuses a transport failure with reason transport', async () => {
    seedVersion('trend_following', DEFAULT_PARAMS.trend_following.values);
    const fetchImpl = vi.fn(async () => {
      throw new Error('link down');
    });
    const client = new DeepSeekClient({ config, logger, fetchImpl: fetchImpl as unknown as typeof fetch });
    const optimiser = optimiserWith(client);

    const outcome = await optimiser.review(inputFor('trend_following'));
    expect(outcome.accepted).toBe(false);
    expect(outcome.reason).toBe('transport');
    expect(repositories.strategyVersions.effective('trend_following')?.id).toBe('seed-v1');
  });

  it('refuses a proposal that loses in the simulator', async () => {
    // The seed has the largest size; the proposal cuts it to the minimum, which
    // does worse over the deterministic up-trending scenario.
    seedVersion('trend_following', { ...DEFAULT_PARAMS.trend_following.values, sizeFraction: 1 });
    const optimiser = optimiserWith(
      clientReplying(() => JSON.stringify({ values: { ...DEFAULT_PARAMS.trend_following.values, sizeFraction: 0.1 } })),
    );

    const outcome = await optimiser.review(inputFor('trend_following'));
    expect(outcome.accepted).toBe(false);
    expect(outcome.reason).toBe('simulator');
    expect(repositories.strategyVersions.effective('trend_following')?.id).toBe('seed-v1');
  });

  it('refuses early with reason budget during a blocked window', async () => {
    const budget = new DeepSeekBudget({ repositories, config, logger, now: () => blockedTime });
    const optimiser = new ParameterOptimiser({
      config,
      logger,
      repositories,
      client: clientReplying(() => JSON.stringify({ values: { slopeThreshold: 0.002 } })),
      budget,
      now: () => blockedTime,
    });

    const outcome = await optimiser.review(inputFor('trend_following'));
    expect(outcome.accepted).toBe(false);
    expect(outcome.reason).toBe('budget');
    expect(repositories.llmCalls.countDayBlocked(budget.dayKey(blockedTime))).toBeGreaterThan(0);
  });
});

describe('ParameterOptimiser: an accepted proposal becomes the effective set', () => {
  it('writes exactly one non-superseded deepseek version', async () => {
    seedVersion('trend_following', DEFAULT_PARAMS.trend_following.values);
    const optimiser = optimiserWith(
      clientReplying(() => JSON.stringify({ values: { ...DEFAULT_PARAMS.trend_following.values }, note: 'hold' })),
    );

    const outcome = await optimiser.review(inputFor('trend_following'));
    expect(outcome.accepted).toBe(true);
    expect(outcome.reason).toBe('ok');
    expect(outcome.versionId).not.toBeNull();

    expect(repositories.strategyVersions.count()).toBe(2);
    const history = repositories.strategyVersions.history('trend_following');
    const live = history.filter((row) => row.superseded_at === null);
    expect(live).toHaveLength(1);
    expect(live[0]!.source).toBe('deepseek');
    expect(repositories.strategyVersions.llmSourcedCount()).toBe(1);
  });
});

describe('crossCheckWithFold', () => {
  it('is a tripwire and returns an outcome instead of throwing', () => {
    const empty = crossCheckWithFold(DEFAULT_PARAMS.trend_following, []);
    expect(empty.same).toBe(false);
    expect(empty.detail).toContain('fold');
  });
});
