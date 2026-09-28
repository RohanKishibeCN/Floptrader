/**
 * Retry, rate limiting and concurrency primitives.
 *
 * Three constraints shape this file:
 *   - technocore.chat enforces a per-IP read and write rate, and answers a
 *     breach with 429. Being polite is cheaper than being throttled.
 *   - a 4xx that names a field (`400 bad from: ...`) is a bug in our encoder, not
 *     a transient fault: retrying it is pointless and noisy.
 *   - a 422 duplicate-text refusal is also permanent for that exact text, so it is
 *     classified as permanent too rather than hammered.
 */
export const PERMANENT_STATUS = new Set([400, 401, 403, 404, 409, 413, 422, 431]);
export const RETRYABLE_STATUS = new Set([408, 425, 429, 500, 502, 503, 504]);

export interface RetryPolicy {
  attempts: number;
  baseDelayMs: number;
  maxDelayMs: number;
  jitterFraction: number;
}

export const DEFAULT_RETRY: RetryPolicy = {
  attempts: 3,
  baseDelayMs: 400,
  maxDelayMs: 15_000,
  jitterFraction: 0.2,
};

export function classifyStatus(status: number): 'ok' | 'retryable' | 'permanent' {
  if (status >= 200 && status < 300) return 'ok';
  if (RETRYABLE_STATUS.has(status)) return 'retryable';
  if (PERMANENT_STATUS.has(status)) return 'permanent';
  return status >= 500 ? 'retryable' : 'permanent';
}

/**
 * Exponential backoff with jitter, capped *after* jitter.
 *
 * The cap must be the last operation: `min(cap, nominal + jitter)`, not
 * `min(cap, nominal) + jitter`. Capping first lets positive jitter push the delay
 * above `maxDelayMs`, which defeats the whole point of the cap — the writer would
 * back off further than the operator configured during exactly the incident the
 * cap exists for.
 *
 * `attempt` is 1-based.
 */
export function backoffDelay(attempt: number, policy: RetryPolicy = DEFAULT_RETRY, random = Math.random): number {
  const nominal = Math.min(policy.maxDelayMs, policy.baseDelayMs * 2 ** Math.max(0, attempt - 1));
  const jitter = nominal * policy.jitterFraction * (random() * 2 - 1);
  return Math.max(0, Math.min(policy.maxDelayMs, Math.round(nominal + jitter)));
}

export interface SleepOptions {
  signal?: AbortSignal;
}

export function sleep(ms: number, options: SleepOptions = {}): Promise<void> {
  return new Promise((resolve, reject) => {
    if (ms <= 0) {
      resolve();
      return;
    }
    const timer = setTimeout(() => {
      options.signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new Error('sleep aborted'));
    };
    options.signal?.addEventListener('abort', onAbort, { once: true });
  });
}

export interface RetryOutcome<T> {
  ok: boolean;
  value?: T;
  error?: string;
  status?: number;
  attempts: number;
  /** True when the failure was classified as permanent. */
  permanent: boolean;
}

export interface RetryOptions {
  policy?: RetryPolicy;
  /** Called before each retry, for logging and metrics. */
  onRetry?: (info: { attempt: number; delayMs: number; reason: string }) => void;
  sleepImpl?: (ms: number) => Promise<void>;
  /** Optional hard budget across all retries, in milliseconds. */
  budgetMs?: number;
  now?: () => number;
}

/**
 * Run `operation` with retries. The operation reports its own status so this can
 * tell a permanent 400 from a retryable 503.
 */
export async function withRetry<T>(
  operation: (attempt: number) => Promise<RetryOutcome<T>>,
  options: RetryOptions = {},
): Promise<RetryOutcome<T>> {
  const policy = options.policy ?? DEFAULT_RETRY;
  const sleepImpl = options.sleepImpl ?? ((ms: number) => sleep(ms));
  const now = options.now ?? (() => Date.now());
  const start = now();
  let last: RetryOutcome<T> = { ok: false, error: 'not attempted', attempts: 0, permanent: false };

  for (let attempt = 1; attempt <= policy.attempts; attempt += 1) {
    const outcome = await operation(attempt);
    last = { ...outcome, attempts: attempt };
    if (outcome.ok) return last;
    if (outcome.permanent) return last;
    if (attempt === policy.attempts) return last;
    const delay = backoffDelay(attempt, policy);
    if (options.budgetMs !== undefined && now() - start + delay > options.budgetMs) {
      return { ...last, error: `${last.error ?? 'failed'} (retry budget exhausted)` };
    }
    options.onRetry?.({ attempt, delayMs: delay, reason: outcome.error ?? `status ${outcome.status}` });
    await sleepImpl(delay);
  }
  return last;
}

/** Counting semaphore. `acquire` resolves when a slot frees up. */
export class Semaphore {
  private available: number;
  private readonly waiters: Array<() => void> = [];

  constructor(limit: number) {
    if (limit < 1) throw new Error('semaphore limit must be at least 1');
    this.available = limit;
  }

  get limit(): number {
    return this.available + this.waiters.length;
  }

  get inUse(): number {
    return this.waiters.length;
  }

  async acquire(): Promise<() => void> {
    if (this.available > 0) {
      this.available -= 1;
      return this.release.bind(this);
    }
    await new Promise<void>((resolve) => this.waiters.push(resolve));
    return this.release.bind(this);
  }

  private release(): void {
    const next = this.waiters.shift();
    if (next) {
      next();
      return;
    }
    this.available += 1;
  }

  async run<T>(fn: () => Promise<T>): Promise<T> {
    const release = await this.acquire();
    try {
      return await fn();
    } finally {
      release();
    }
  }
}

/**
 * Sliding-window rate limiter: at most `limit` acquisitions inside `windowMs`.
 * Used for the write budget (`WRITE_RATE_PER_MINUTE`), which is the one limit the
 * operator can tune without changing the reader.
 */
export class RateLimiter {
  private readonly timestamps: number[] = [];
  private readonly limit: number;
  private readonly windowMs: number;
  private readonly now: () => number;

  constructor(options: { limit: number; windowMs: number; now?: () => number }) {
    if (options.limit < 1) throw new Error('rate limit must be at least 1 per window');
    this.limit = options.limit;
    this.windowMs = options.windowMs;
    this.now = options.now ?? (() => Date.now());
  }

  private prune(): void {
    const cutoff = this.now() - this.windowMs;
    while (this.timestamps.length > 0 && this.timestamps[0]! <= cutoff) this.timestamps.shift();
  }

  /** Milliseconds until the next slot, or 0 when a slot is free now. */
  delayMs(): number {
    this.prune();
    if (this.timestamps.length < this.limit) return 0;
    const oldest = this.timestamps[0]!;
    return Math.max(0, oldest + this.windowMs - this.now());
  }

  tryAcquire(): boolean {
    this.prune();
    if (this.timestamps.length >= this.limit) return false;
    this.timestamps.push(this.now());
    return true;
  }

  async acquire(sleepImpl: (ms: number) => Promise<void> = (ms) => sleep(ms)): Promise<void> {
    for (;;) {
      const delay = this.delayMs();
      if (delay === 0 && this.tryAcquire()) return;
      await sleepImpl(Math.max(delay, 25));
    }
  }

  get used(): number {
    this.prune();
    return this.timestamps.length;
  }
}
