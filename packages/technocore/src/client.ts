/**
 * The HTTP client for technocore.chat.
 *
 * One shared client for the whole process: reads and writes go through it, the
 * in-flight count is capped by a semaphore, and every request has a deadline. The
 * reader must not open one long poll per room — six rooms with an unbounded poll
 * each is how a small VPS runs out of sockets.
 *
 * `fetchImpl` is injectable, which is what lets `fake-transport.test.ts` exercise
 * the whole reader and writer stack offline against a deterministic transport.
 */
import {
  ProtocolError,
  PostResult,
  RoomRead,
  SignedEnvelope,
  assertRoom,
  classifyPost,
  parseRoomRead,
  parseTextRoomRead,
  readQuery,
  signedEnvelopeBody,
  ASSUMED_SERVER_LIMIT,
} from './protocol.js';
import { Semaphore } from './retry.js';

export interface TechnocoreClientOptions {
  baseUrl: string;
  timeoutMs?: number;
  /** Hard cap on concurrent requests across the whole process. */
  maxInflight?: number;
  /**
   * The largest `limit` the read endpoint will accept.
   *
   * This is the last line of defence for the page size, and it exists so that no
   * caller can raise `limit` past what the service actually supports: a refused
   * `limit` is a 400 on every read, which is a worse failure than a small page.
   * `ASSUMED_SERVER_LIMIT` (200) unless an operator has confirmed otherwise.
   */
  serverLimit?: number;
  fetchImpl?: typeof fetch;
  userAgent?: string;
}

export interface RequestStats {
  reads: number;
  writes: number;
  errors: number;
  timeouts: number;
  throttled: number;
  notModified: number;
  inflight: number;
  maxInflight: number;
}

export interface ReadOptions {
  since?: number;
  limit?: number;
  waitSeconds?: number;
  /** Abort a long poll early, e.g. on shutdown. */
  signal?: AbortSignal;
}

export interface ClientReadResult {
  read: RoomRead;
  status: number;
  /** True when the reply was the text/plain fallback and senders are missing. */
  degraded: boolean;
  waitHeld: boolean;
}

export class TechnocoreClient {
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;
  private readonly semaphore: Semaphore;
  private readonly userAgent: string;
  private readonly serverLimit: number;
  private readonly counters = {
    reads: 0,
    writes: 0,
    errors: 0,
    timeouts: 0,
    throttled: 0,
    notModified: 0,
  };

  constructor(options: TechnocoreClientOptions) {
    if (!options.baseUrl) throw new ProtocolError('baseUrl is required');
    this.baseUrl = options.baseUrl.replace(/\/+$/, '');
    this.timeoutMs = options.timeoutMs ?? 15_000;
    this.fetchImpl = options.fetchImpl ?? ((...args) => fetch(...args));
    this.semaphore = new Semaphore(options.maxInflight ?? 6);
    this.serverLimit = Math.max(1, options.serverLimit ?? ASSUMED_SERVER_LIMIT);
    this.userAgent = options.userAgent ?? 'flop-close-call-orchestrator/0.1 (+close-1)';
  }

  /** The `limit` ceiling this client will ever put on the wire. */
  get limitCeiling(): number {
    return this.serverLimit;
  }

  stats(): RequestStats {
    return { ...this.counters, inflight: this.semaphore.inUse, maxInflight: this.semaphore.limit };
  }

  private headers(extra: Record<string, string> = {}): Record<string, string> {
    return { accept: 'application/json', 'user-agent': this.userAgent, ...extra };
  }

  /**
   * Perform a request under the in-flight cap and a deadline. The deadline is
   * enforced by combining the caller's signal with an `AbortSignal.timeout`, so a
   * hung socket cannot pin a slot forever.
   */
  private async request(
    url: string,
    init: RequestInit & { timeoutMs?: number } = {},
  ): Promise<{ status: number; body: string; contentType: string }> {
    const release = await this.semaphore.acquire();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error('request timeout')), init.timeoutMs ?? this.timeoutMs);
    const onExternalAbort = () => controller.abort();
    init.signal?.addEventListener('abort', onExternalAbort, { once: true });
    try {
      const response = await this.fetchImpl(url, { ...init, signal: controller.signal });
      const body = await response.text();
      if (response.status === 429) this.counters.throttled += 1;
      return {
        status: response.status,
        body,
        contentType: response.headers.get('content-type') ?? '',
      };
    } catch (error) {
      if (controller.signal.aborted) this.counters.timeouts += 1;
      this.counters.errors += 1;
      throw error instanceof Error ? error : new Error(String(error));
    } finally {
      clearTimeout(timer);
      init.signal?.removeEventListener('abort', onExternalAbort);
      release();
    }
  }

  /** Read a room, preferring JSON and falling back to the text view. */
  async readRoom(room: string, options: ReadOptions = {}): Promise<ClientReadResult> {
    assertRoom(room);
    const query = readQuery({
      since: options.since,
      limit: options.limit,
      waitSeconds: options.waitSeconds,
      // The client's own ceiling, so a caller asking for a bigger page than the
      // service supports gets the service's maximum rather than a 400.
      maxLimit: this.serverLimit,
    });
    const url = `${this.baseUrl}/r/${encodeURIComponent(room)}?${query}`;
    this.counters.reads += 1;
    const { status, body, contentType } = await this.request(url, {
      method: 'GET',
      headers: this.headers(),
      // A long poll needs its own, longer deadline.
      timeoutMs: (options.waitSeconds ?? 0) * 1000 + this.timeoutMs,
      signal: options.signal,
    });

    if (status === 304) {
      this.counters.notModified += 1;
      return {
        read: { room, count: 0, first_seq: null, last_seq: null, messages: [] },
        status,
        degraded: false,
        waitHeld: false,
      };
    }
    if (status >= 400) {
      throw new ProtocolError(`read ${room} failed with status ${status}: ${body.slice(0, 200)}`);
    }

    const looksJson = contentType.includes('json') || body.trimStart().startsWith('{');
    if (looksJson) {
      const parsed = parseRoomRead(JSON.parse(body));
      return { read: parsed, status, degraded: false, waitHeld: parsed.wait_held ?? false };
    }
    // Text fallback: the service prepends an untrusted-content banner, and senders
    // are abbreviated, so the result is flagged as degraded and its messages carry
    // no DID. Nothing may be signature-verified from this path.
    const read = parseTextRoomRead(body, room);
    return { read, status, degraded: true, waitHeld: /wait: not held/.test(body) };
  }

  /** Read the whole retained ring as raw JSONL. Used only by the archiver. */
  async exportRoom(room: string): Promise<string> {
    assertRoom(room);
    const url = `${this.baseUrl}/r/${encodeURIComponent(room)}/export`;
    this.counters.reads += 1;
    const { status, body } = await this.request(url, { method: 'GET', headers: this.headers({ accept: 'application/jsonl' }) });
    if (status >= 400) {
      throw new ProtocolError(`export ${room} failed with status ${status}: ${body.slice(0, 200)}`);
    }
    return body;
  }

  /** POST a signed message. The body carries did/sig/nonce/text, nothing else. */
  async postSigned(room: string, envelope: SignedEnvelope, signal?: AbortSignal): Promise<PostResult> {
    assertRoom(room);
    const body = JSON.stringify(signedEnvelopeBody(envelope));
    const url = `${this.baseUrl}/r/${encodeURIComponent(room)}`;
    this.counters.writes += 1;
    const { status, body: responseBody } = await this.request(url, {
      method: 'POST',
      headers: this.headers({ 'content-type': 'application/json' }),
      body,
      signal,
    });
    return classifyPost(status, responseBody);
  }

  /** A generic JSON GET, for /config, /rooms and /.well-known/agent.json. */
  async getJson<T = unknown>(path: string): Promise<T> {
    const url = `${this.baseUrl}${path.startsWith('/') ? path : `/${path}`}`;
    this.counters.reads += 1;
    const { status, body } = await this.request(url, { method: 'GET', headers: this.headers() });
    if (status >= 400) {
      throw new ProtocolError(`GET ${path} failed with status ${status}: ${body.slice(0, 200)}`);
    }
    return JSON.parse(body) as T;
  }

  /** The service's own published limits, for the dashboard and the report. */
  async serviceConfig(): Promise<Record<string, unknown>> {
    return this.getJson<Record<string, unknown>>('/config');
  }
}
