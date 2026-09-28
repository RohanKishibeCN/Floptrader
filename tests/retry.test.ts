/**
 * Retry, backoff, concurrency and rate limiting.
 *
 * These primitives decide whether the orchestrator hammers a throttled service
 * (bad) or backs off politely (good), and whether it can exceed its in-flight
 * budget (very bad). The assertions here pin the exact numbers rather than
 * ranges, because "roughly exponential" is not a contract a retry loop can rely
 * on.
 */
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_RETRY,
  PERMANENT_STATUS,
  RETRYABLE_STATUS,
  RateLimiter,
  Semaphore,
  backoffDelay,
  classifyStatus,
  withRetry,
  type RetryPolicy,
} from '@flop/technocore';
import { fakeClock } from './support/harness.js';

describe('classifyStatus', () => {
  it('treats 2xx as ok', () => {
    expect(classifyStatus(200)).toBe('ok');
    expect(classifyStatus(201)).toBe('ok');
    expect(classifyStatus(204)).toBe('ok');
  });

  it('treats 429, 408 and server errors as retryable', () => {
    for (const status of [429, 500, 502, 503, 504, 408]) {
      expect(classifyStatus(status)).toBe('retryable');
    }
    // Every retryable status must be in the exported set, or a caller that
    // consults the set instead of this function would disagree.
    for (const status of RETRYABLE_STATUS) expect(classifyStatus(status)).toBe('retryable');
  });

  it('treats a named-field 4xx as permanent', () => {
    // 400/403/404/409/422 are the encoder's bug or a lost compare-and-set, not a
    // transient fault: retrying them is noise.
    for (const status of [400, 403, 404, 409, 422]) {
      expect(classifyStatus(status)).toBe('permanent');
    }
    for (const status of PERMANENT_STATUS) expect(classifyStatus(status)).toBe('permanent');
  });

  it('falls back to permanent for 4xx and retryable for unknown 5xx', () => {
    expect(classifyStatus(418)).toBe('permanent');
    expect(classifyStatus(599)).toBe('retryable');
  });
});

describe('backoffDelay', () => {
  const policy: RetryPolicy = { attempts: 6, baseDelayMs: 1000, maxDelayMs: 8000, jitterFraction: 0.25 };
  const nominal = (attempt: number): number => Math.min(policy.maxDelayMs, policy.baseDelayMs * 2 ** (attempt - 1));

  it('grows exponentially and caps the nominal delay', () => {
    // random() === 0.5 is the midpoint: no jitter, so the raw schedule shows.
    const delays = [1, 2, 3, 4, 5, 6].map((attempt) => backoffDelay(attempt, policy, () => 0.5));
    expect(delays).toEqual([1000, 2000, 4000, 8000, 8000, 8000]);
  });

  it('keeps every value inside ±jitterFraction of the nominal value, and inside the cap', () => {
    // The lower edge is nominal * (1 - fraction); the upper edge is clamped by
    // maxDelayMs, because the cap is applied *after* jitter.
    const low = [1, 2, 3, 4, 5, 6].map((attempt) => backoffDelay(attempt, policy, () => 0));
    const high = [1, 2, 3, 4, 5, 6].map((attempt) => backoffDelay(attempt, policy, () => 1));
    expect(low).toEqual([750, 1500, 3000, 6000, 6000, 6000]);
    expect(high).toEqual([1250, 2500, 5000, 8000, 8000, 8000]);

    for (let attempt = 1; attempt <= 6; attempt += 1) {
      const base = nominal(attempt);
      const lo = backoffDelay(attempt, policy, () => 0);
      const hi = backoffDelay(attempt, policy, () => 1);
      expect(lo).toBeGreaterThanOrEqual(Math.floor(base * (1 - policy.jitterFraction)));
      expect(hi).toBeLessThanOrEqual(Math.max(base, policy.maxDelayMs));
      expect(hi).toBeLessThanOrEqual(policy.maxDelayMs);
    }
  });

  it('never exceeds maxDelayMs, however large the jitter or the attempt number', () => {
    // The cap is the last operation. Capping the *nominal* value and then adding
    // positive jitter would let the delay exceed the configured ceiling, which is
    // exactly the ceiling the operator relies on during an incident.
    for (let attempt = 1; attempt <= 20; attempt += 1) {
      for (const random of [0, 0.25, 0.5, 0.75, 1]) {
        expect(backoffDelay(attempt, policy, () => random)).toBeLessThanOrEqual(policy.maxDelayMs);
      }
    }
    // With maximal jitter the capped attempts sit exactly on the ceiling.
    expect(backoffDelay(6, policy, () => 1)).toBe(policy.maxDelayMs);
    expect(backoffDelay(6, policy, () => 0.5)).toBe(policy.maxDelayMs);
    expect(backoffDelay(6, policy, () => 0)).toBeLessThanOrEqual(policy.maxDelayMs);
  });

  it('never returns a negative delay, and attempt 0 is treated as the first attempt', () => {
    expect(backoffDelay(1, policy, () => 0)).toBeGreaterThanOrEqual(0);
    expect(backoffDelay(0, policy, () => 0.5)).toBe(backoffDelay(1, policy, () => 0.5));
  });
});

describe('withRetry', () => {
  const policy: RetryPolicy = { attempts: 4, baseDelayMs: 1000, maxDelayMs: 8000, jitterFraction: 0 };

  it('stops immediately on a permanent outcome', async () => {
    const sleeps: number[] = [];
    let calls = 0;
    const result = await withRetry<string>(
      async () => {
        calls += 1;
        return { ok: false, permanent: true, status: 400, error: '400 bad text', attempts: 0 };
      },
      { policy, sleepImpl: async (ms) => void sleeps.push(ms) },
    );

    expect(calls).toBe(1);
    expect(sleeps).toEqual([]);
    expect(result.permanent).toBe(true);
    expect(result.attempts).toBe(1);
  });

  it('retries exactly policy.attempts times on a retryable outcome, sleeping between only', async () => {
    const sleeps: number[] = [];
    let calls = 0;
    const result = await withRetry<string>(
      async () => {
        calls += 1;
        return { ok: false, permanent: false, status: 503, error: '503 unavailable', attempts: 0 };
      },
      { policy, sleepImpl: async (ms) => void sleeps.push(ms) },
    );

    expect(calls).toBe(policy.attempts);
    // Four attempts means three waits; never a sleep after the final attempt.
    expect(sleeps).toEqual([1000, 2000, 4000]);
    expect(result.attempts).toBe(4);
    expect(result.ok).toBe(false);
  });

  it('returns the first successful value without sleeping', async () => {
    const sleeps: number[] = [];
    const result = await withRetry<string>(async () => ({ ok: true, value: 'accepted', permanent: false, attempts: 0 }), {
      policy,
      sleepImpl: async (ms) => void sleeps.push(ms),
    });
    expect(result.ok).toBe(true);
    expect(result.value).toBe('accepted');
    expect(sleeps).toEqual([]);
  });

  it('stops within budgetMs rather than spending the whole retry schedule', async () => {
    const clock = fakeClock(0);
    const sleeps: number[] = [];
    let calls = 0;
    const result = await withRetry<string>(
      async () => {
        calls += 1;
        return { ok: false, permanent: false, status: 500, error: '500 boom', attempts: 0 };
      },
      {
        policy: { attempts: 5, baseDelayMs: 1000, maxDelayMs: 8000, jitterFraction: 0 },
        budgetMs: 2500,
        now: clock.now,
        // Real time would make this test slow; instead advance the injected clock
        // by exactly what the retry would have waited.
        sleepImpl: async (ms) => {
          sleeps.push(ms);
          clock.advance(ms);
        },
      },
    );

    // Attempt 1 fails (1000ms wait, within budget), attempt 2's 2000ms wait would
    // take the elapsed total to 3000ms, past the 2500ms budget, so it stops.
    expect(calls).toBe(2);
    expect(sleeps).toEqual([1000]);
    expect(result.attempts).toBe(2);
    expect(result.error).toContain('retry budget exhausted');
  });
});

describe('Semaphore', () => {
  it('never allows more than `limit` concurrent holders', async () => {
    const semaphore = new Semaphore(3);
    let active = 0;
    let highWater = 0;

    const tasks = Array.from({ length: 50 }, () =>
      semaphore.run(async () => {
        active += 1;
        highWater = Math.max(highWater, active);
        // Yield so other holders can overlap; without the yield a bug in the
        // semaphore would be masked.
        await new Promise<void>((resolve) => setTimeout(resolve, 1));
        active -= 1;
      }),
    );
    await Promise.all(tasks);

    expect(highWater).toBe(3);
    // All 50 ran, and every slot was returned.
    expect(active).toBe(0);
    expect(semaphore.inUse).toBe(0);
  });

  it('releases the slot when the wrapped task throws', async () => {
    const semaphore = new Semaphore(1);
    await expect(semaphore.run(async () => {
      throw new Error('boom');
    })).rejects.toThrow('boom');

    // A leaked slot would deadlock every later caller; the next acquisition must
    // succeed immediately.
    await expect(semaphore.run(async () => 'ok')).resolves.toBe('ok');
    expect(semaphore.inUse).toBe(0);
  });
});

describe('RateLimiter', () => {
  it('allows exactly `limit` acquisitions per window then reports a wait', () => {
    const clock = fakeClock(0);
    const limiter = new RateLimiter({ limit: 3, windowMs: 1000, now: clock.now });

    expect(limiter.tryAcquire()).toBe(true);
    expect(limiter.tryAcquire()).toBe(true);
    expect(limiter.tryAcquire()).toBe(true);
    // The fourth inside the same window is refused...
    expect(limiter.tryAcquire()).toBe(false);
    // ...and the limiter says how long until the oldest slot ages out.
    expect(limiter.delayMs()).toBe(1000);
    expect(limiter.used).toBe(3);
  });

  it('slides the window as the clock advances', () => {
    const clock = fakeClock(0);
    const limiter = new RateLimiter({ limit: 2, windowMs: 1000, now: clock.now });
    expect(limiter.tryAcquire()).toBe(true);
    expect(limiter.tryAcquire()).toBe(true);
    expect(limiter.tryAcquire()).toBe(false);

    // 999ms on, one slot is still held but is 1ms from expiry.
    clock.advance(999);
    expect(limiter.delayMs()).toBe(1);
    expect(limiter.tryAcquire()).toBe(false);

    // A full window later both original acquisitions have aged out.
    clock.advance(1);
    expect(limiter.delayMs()).toBe(0);
    expect(limiter.tryAcquire()).toBe(true);
  });

  it('exposes the configured defaults', () => {
    // A zero-attempt retry policy would never call the operation; the default
    // must be a real retry loop.
    expect(DEFAULT_RETRY.attempts).toBeGreaterThan(1);
    expect(DEFAULT_RETRY.maxDelayMs).toBeGreaterThanOrEqual(DEFAULT_RETRY.baseDelayMs);
  });
});
