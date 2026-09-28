/**
 * The DeepSeek idle-window and prompt-safety rules.
 *
 * These are the cheapest guard rails to get wrong and the most expensive to get
 * wrong quietly: a mis-classified window puts a model call into the market peak,
 * and a prompt that carries a DID or a key is a leak. Both are pure functions,
 * so they are asserted directly, at the boundaries and across a DST change.
 */
import { describe, expect, it } from 'vitest';
import { DEFAULT_PARAMS, boundsSummary, type StrategyGroupName } from '@flop/strategy';
import {
  FORBIDDEN_PROMPT_PATTERNS,
  assertPromptSafe,
  buildParameterPrompt,
  isDeepSeekIdleWindow,
  parseParameterResponse,
  type ParameterReviewInput,
} from '../apps/orchestrator/src/llm.js';

const SHANGHAI = 'Asia/Shanghai';

/** Asia/Shanghai is UTC+8 with no DST, so a local HH:MM maps to a fixed UTC. */
function shanghaiAt(local: string): Date {
  const [hour, minute] = local.split(':').map(Number);
  return new Date(Date.UTC(2026, 8, 28, hour! - 8, minute!));
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
    sweepsObserved: 42,
    volatility: '0.006',
  };
}

describe('isDeepSeekIdleWindow in Asia/Shanghai', () => {
  it('allows the idle windows and blocks the peak windows at every boundary', () => {
    // Half-open [from, to): 09:00 and 14:00 are blocked, 12:00 and 18:00 open.
    const allowed = ['08:59', '12:00', '18:00', '00:00'];
    const blocked = ['09:00', '11:59', '14:00', '17:59'];

    for (const local of allowed) {
      const check = isDeepSeekIdleWindow(shanghaiAt(local), SHANGHAI);
      expect(check.localTime, `localTime for ${local}`).toBe(local);
      expect(check.allowed, `expected ${local} to be allowed`).toBe(true);
      expect(check.window).not.toBeNull();
    }
    for (const local of blocked) {
      const check = isDeepSeekIdleWindow(shanghaiAt(local), SHANGHAI);
      expect(check.localTime, `localTime for ${local}`).toBe(local);
      expect(check.allowed, `expected ${local} to be blocked`).toBe(false);
      expect(check.reason).toBe('blocked_window');
    }
  });
});

describe('isDeepSeekIdleWindow across a DST boundary', () => {
  it('reads the wall clock, so the same UTC instant changes side with the offset', () => {
    // 2026-03-08 is the US spring-forward. 13:00Z is standard time (UTC-5) the
    // day before, and daylight time (UTC-4) the day after. A fixed offset would
    // classify one of these wrong; reading the formatted local time does not.
    const before = isDeepSeekIdleWindow(new Date('2026-03-07T13:00:00Z'), 'America/New_York');
    expect(before.localTime).toBe('08:00');
    expect(before.allowed).toBe(true);

    const after = isDeepSeekIdleWindow(new Date('2026-03-09T13:00:00Z'), 'America/New_York');
    expect(after.localTime).toBe('09:00');
    expect(after.allowed).toBe(false);
    expect(after.reason).toBe('blocked_window');
  });

  it('does not invent an 02:xx local time on the spring-forward morning', () => {
    // 06:59Z is 01:59 EST; one minute later the clock jumps straight to 03:00 EDT.
    expect(isDeepSeekIdleWindow(new Date('2026-03-08T06:59:00Z'), 'America/New_York').localTime).toBe('01:59');
    expect(isDeepSeekIdleWindow(new Date('2026-03-08T07:00:00Z'), 'America/New_York').localTime).toBe('03:00');
  });
});

describe('prompt safety', () => {
  const did = 'did:key:z6MkUf3bFjg6czAxRp6xfay1NxUV7CTMmUrNUf3bFjg6czAx';

  it('refuses a prompt that carries key material or a DID', () => {
    expect(() => assertPromptSafe(`maker ${did} asks`)).toThrow(/forbidden/);
    expect(() => assertPromptSafe('AGE-SECRET-KEY-1ABCDEF')).toThrow(/forbidden/);
    expect(() => assertPromptSafe('credential sk-abcdefghijklmnop')).toThrow(/forbidden/);
    expect(() => assertPromptSafe('do not leak the seed please')).toThrow(/forbidden/);
    expect(FORBIDDEN_PROMPT_PATTERNS).toHaveLength(4);
  });

  it('never trips on a prompt this module builds', () => {
    for (const group of Object.keys(DEFAULT_PARAMS) as StrategyGroupName[]) {
      expect(() => assertPromptSafe(buildParameterPrompt(inputFor(group)))).not.toThrow();
    }
  });
});

describe('buildParameterPrompt', () => {
  it('carries the group, every current value and the bounds — and nothing secret', () => {
    const group: StrategyGroupName = 'trend_following';
    const input = inputFor(group);
    const prompt = buildParameterPrompt(input);

    expect(prompt).toContain(group);
    for (const [key, value] of Object.entries(DEFAULT_PARAMS[group].values)) {
      expect(prompt).toContain(`${key}=${value}`);
    }
    expect(prompt).toContain(boundsSummary(group)[0]!);
    expect(prompt).not.toMatch(/did:key:z6Mk/);
    // The design bound is 20 lines; the assertion is deliberately looser than it
    // needs to be so a formatting change does not read as a leak.
    expect(prompt.split('\n').length).toBeLessThan(120);
    expect(prompt.split('\n').length).toBeLessThan(20);
  });
});

describe('parseParameterResponse', () => {
  it('accepts a bare object, a fenced block, and JSON surrounded by prose', () => {
    const bare = parseParameterResponse('{"values":{"sizeFraction":0.5},"note":"fade"}');
    expect(bare.ok).toBe(true);
    expect(bare.values).toEqual({ sizeFraction: 0.5 });
    expect(bare.note).toBe('fade');

    const fenced = parseParameterResponse('```json\n{"values":{"sizeFraction":0.6}}\n```');
    expect(fenced.ok).toBe(true);
    expect(fenced.values).toEqual({ sizeFraction: 0.6 });

    const prose = parseParameterResponse('Sure — here it is: {"values":{"sizeFraction":0.7}} Done.');
    expect(prose.ok).toBe(true);
    expect(prose.values).toEqual({ sizeFraction: 0.7 });
  });

  it('returns ok:false with an error when there is no object to parse', () => {
    const outcome = parseParameterResponse('I would rather not answer that.');
    expect(outcome.ok).toBe(false);
    expect(outcome.values).toBeUndefined();
    expect(outcome.errors.length).toBeGreaterThan(0);
  });
});
