/**
 * The shared writer: one queue, one in-flight write, one rate limit.
 *
 * All 150 agents write through this. There is no per-agent poster and no second
 * queue, because 150 concurrent signers on a 2 vCPU box would breach the service's
 * write rate immediately and the operator would be throttled during the exact
 * minutes that matter.
 *
 * The order of operations on every write is deliberate:
 *
 *   1. **reserve the nonce** — the counter is persisted before anything is signed,
 *      so a crash between signing and posting can never reissue one. This is the
 *      `nonce rollback = 0` criterion.
 *   2. sign, then post.
 *   3. on a retryable failure, retry with a **fresh nonce**: the previous one may
 *      have been accepted even though the reply was lost, and reusing it is
 *      exactly what the service's nonce rule forbids.
 *   4. on a permanent refusal (400/403/422), do not retry: the first line names
 *      the offending field, and hammering it is noise. Record it and move on.
 *
 * The queue depth is exposed for the load guard's `writer queue > 100` rule.
 */
import { NonceStore } from '@flop/identity';
import type { SignedEnvelope } from './protocol.js';
import { TechnocoreClient } from './client.js';
import { RateLimiter, backoffDelay, sleep } from './retry.js';
import type { PostResult, TechnocoreLogger } from './protocol.js';

export interface WriteRequest {
  room: string;
  agentId: string;
  did: string;
  text: string;
  /**
   * Higher runs first. `critical` is for participation evidence — an owner
   * registration that must land before the lock — and is never shed.
   */
  priority: 'critical' | 'normal' | 'low';
  /** Correlation id for the audit trail. */
  label: string;
}

export interface WriteResult {
  ok: boolean;
  room: string;
  agentId: string;
  label: string;
  seq?: number;
  nonce: string;
  attempts: number;
  status?: number;
  reason?: string;
  /** True when the message was never attempted, e.g. the queue was full. */
  shed?: boolean;
}

export interface RoomWriterOptions {
  client: TechnocoreClient;
  nonceStore: NonceStore;
  logger: TechnocoreLogger;
  /** Sign `<room>|<nonce>|<text>` with the agent's key. */
  signer: (agentId: string, room: string, nonce: string, text: string) => SignedEnvelope;
  /** Writes per minute across all agents. */
  writeRatePerMinute?: number;
  /** Retries per message, on top of the first attempt. */
  maxRetries?: number;
  /** Queue capacity; beyond this, low-priority writes are shed. */
  queueCapacity?: number;
}

const PRIORITY_RANK: Record<WriteRequest['priority'], number> = { critical: 0, normal: 1, low: 2 };

export class RoomWriter {
  private readonly client: TechnocoreClient;
  private readonly nonceStore: NonceStore;
  private readonly logger: TechnocoreLogger;
  private readonly signer: RoomWriterOptions['signer'];
  private readonly limiter: RateLimiter;
  private readonly maxRetries: number;
  private readonly capacity: number;
  private readonly results = new Map<string, WriteResult>();
  private readonly pending: WriteRequest[] = [];
  private readonly waiters = new Map<WriteRequest, { resolve: () => void; reject: (error: Error) => void }>();
  private running = false;
  private counters = { attempted: 0, succeeded: 0, failed: 0, shed: 0, retried: 0 };

  constructor(options: RoomWriterOptions) {
    this.client = options.client;
    this.nonceStore = options.nonceStore;
    this.logger = options.logger;
    this.signer = options.signer;
    this.maxRetries = options.maxRetries ?? 4;
    this.capacity = options.queueCapacity ?? 200;
    this.limiter = new RateLimiter({
      limit: options.writeRatePerMinute ?? 180,
      windowMs: 60_000,
    });
  }

  get depth(): number {
    return this.pending.length;
  }

  get stats(): {
    attempted: number;
    succeeded: number;
    failed: number;
    shed: number;
    retried: number;
    depth: number;
    rateUsedLastMinute: number;
  } {
    return { ...this.counters, depth: this.pending.length, rateUsedLastMinute: this.limiter.used };
  }

  /**
   * Queue a message. Resolves once it has been attempted to completion (or shed),
   * so a caller that awaits gets the real outcome.
   */
  async enqueue(request: WriteRequest): Promise<WriteResult> {
    if (this.pending.length >= this.capacity && request.priority === 'low') {
      this.counters.shed += 1;
      this.logger.event({
        level: 'warn',
        source: 'room-writer',
        code: 'write_shed',
        message: `writer queue full (${this.pending.length}); shedding low-priority ${request.label}`,
        data: { room: request.room, agentId: request.agentId, label: request.label },
      });
      return {
        ok: false,
        room: request.room,
        agentId: request.agentId,
        label: request.label,
        nonce: '0',
        attempts: 0,
        shed: true,
        reason: 'queue_full',
      };
    }

    // Everything up to the first await is synchronous, so a request can never be
    // pushed into a queue that the pump has already decided is empty.
    const done = new Promise<void>((resolve, reject) => {
      this.waiters.set(request, { resolve, reject });
      this.pending.push(request);
      // Insert in priority order; Array#sort is stable, so FIFO holds within a tier.
      this.pending.sort((a, b) => PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority]);
    });

    await this.pump();
    await done;
    return (
      this.results.get(keyOf(request)) ?? {
        ok: false,
        room: request.room,
        agentId: request.agentId,
        label: request.label,
        nonce: '0',
        attempts: 0,
        reason: 'no_result',
      }
    );
  }

  /**
   * Drain the queue with a single in-flight write. If a drain is already running,
   * this returns as soon as the running pump is done, and the caller then waits on
   * its own completion promise.
   */
  async flush(): Promise<void> {
    await this.pump();
  }

  private async pump(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      for (;;) {
        const request = this.pending.shift();
        if (!request) return;
        const waiter = this.waiters.get(request);
        this.waiters.delete(request);
        try {
          const result = await this.writeOnce(request);
          this.results.set(keyOf(request), result);
          waiter?.resolve();
        } catch (error) {
          waiter?.reject(error instanceof Error ? error : new Error(String(error)));
        }
        if (this.results.size > 1024) {
          // Bound the result cache; callers that care have already awaited.
          const keys = [...this.results.keys()].slice(0, this.results.size - 512);
          for (const key of keys) this.results.delete(key);
        }
      }
    } finally {
      this.running = false;
    }
  }

  /** Post one message with retries, reserving a fresh nonce per attempt. */
  private async writeOnce(request: WriteRequest): Promise<WriteResult> {
    let last: WriteResult = {
      ok: false,
      room: request.room,
      agentId: request.agentId,
      label: request.label,
      nonce: '0',
      attempts: 0,
      reason: 'not_attempted',
    };

    for (let attempt = 1; attempt <= this.maxRetries + 1; attempt += 1) {
      // Reserve before signing, every attempt. A retry after a lost reply must not
      // reuse the nonce that probably already landed.
      const nonce = this.nonceStore.allocate(request.did, request.room);
      const envelope = this.signer(request.agentId, request.room, nonce, request.text);
      await this.limiter.acquire();
      this.counters.attempted += 1;

      let result: PostResult;
      try {
        result = await this.client.postSigned(request.room, envelope);
      } catch (error) {
        result = { ok: false, status: 0, reason: String(error), retryable: !this.nonceStore.isDirty };
      }

      last = {
        ok: result.ok,
        room: request.room,
        agentId: request.agentId,
        label: request.label,
        seq: result.seq,
        nonce,
        attempts: attempt,
        status: result.status,
        reason: result.reason,
      };

      if (result.ok) {
        this.counters.succeeded += 1;
        return last;
      }

      const permanent = result.status !== 0 && !result.retryable;
      if (permanent) {
        this.counters.failed += 1;
        this.logger.event({
          level: 'error',
          source: 'room-writer',
          code: 'write_rejected',
          message: `technocore refused ${request.label}: ${result.reason ?? 'no reason given'}`,
          data: { room: request.room, agentId: request.agentId, status: result.status, reason: result.reason },
        });
        return last;
      }

      if (attempt > this.maxRetries) break;
      this.counters.retried += 1;
      const delay = backoffDelay(attempt, {
        attempts: this.maxRetries,
        baseDelayMs: 500,
        maxDelayMs: 20_000,
        jitterFraction: 0.2,
      });
      this.logger.warn(
        { room: request.room, label: request.label, attempt, delay },
        `retrying write after ${result.reason ?? 'transport failure'}`,
      );
      await sleep(delay);
    }

    this.counters.failed += 1;
    return last;
  }

  /** Write immediately and synchronously, bypassing the queue. */
  async writeNow(request: WriteRequest): Promise<WriteResult> {
    const result = await this.writeOnce(request);
    this.results.set(keyOf(request), result);
    return result;
  }

  /** Counters for the Lark report and the health endpoint. */
  snapshot(): Record<string, number> {
    return {
      attempted: this.counters.attempted,
      succeeded: this.counters.succeeded,
      failed: this.counters.failed,
      shed: this.counters.shed,
      retried: this.counters.retried,
      depth: this.pending.length,
      rateUsedLastMinute: this.limiter.used,
    };
  }
}

function keyOf(request: WriteRequest): string {
  return `${request.room}\u0000${request.agentId}\u0000${request.label}`;
}
