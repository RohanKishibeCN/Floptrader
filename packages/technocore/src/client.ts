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
  parseBudgetFooter,
  parseRetryAfter,
  ASSUMED_SERVER_LIMIT,
  MAX_PAGE_SIZE,
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
  /**
   * Reads the service declined to hold, because every long-poll slot was busy.
   *
   * Not an error: the reply is immediate and correct, it just carries no wait.
   * A steady stream of these means the reader is asking for more concurrent
   * long polls than the service will hold, and that re-reading at once is
   * pointless — the contract says to sleep about the wait instead.
   */
  waitNotHeld: number;
  inflight: number;
  maxInflight: number;
}

export interface ReadOptions {
  since?: number;
  limit?: number;
  waitSeconds?: number;
  /**
   * A throwaway counter appended as `&n=`.
   *
   * The service ignores it entirely; it exists so a repeat of an unchanged
   * cursor is a different URL, which is what defeats the response cache an agent
   * harness puts in front of the fetch. Two reads of an idle room with the same
   * `since` are only distinguishable from each other by this.
   */
  cacheBust?: number | string;
  /** Abort a long poll early, e.g. on shutdown. */
  signal?: AbortSignal;
}

export interface ClientReadResult {
  read: RoomRead;
  status: number;
  /** True when the reply was the text/plain fallback and senders are missing. */
  degraded: boolean;
  /**
   * The service's long-poll verdict, or null when it does not apply.
   *
   * The contract is narrow and worth keeping exact: `wait_held` is present
   * **only** on a `wait=` read that returned no messages. `true` means the wait
   * was honoured and the room stayed quiet — poll again with the same `since`.
   * `false` means no long-poll slot was free and the reply was immediate, so a
   * caller that re-reads at once re-reads for nothing and should sleep about the
   * wait it asked for. `null` means neither applies (messages came back, or no
   * wait was requested).
   */
  waitHeld: boolean | null;
  /** The query the request actually carried, for logs. Never the body. */
  query: Record<string, string>;
  /**
   * The response's own `content-type`.
   *
   * Exposed for the contract probe: JSON is the documented shape, and the
   * text/plain fallback is the degraded one. A probe that reported only the
   * parsed result could not tell the two apart.
   */
  contentType: string;
  /**
   * Whether the response carried an `x-room-generation` header.
   *
   * The header is the service's own epoch stamp, volunteered on a read only when
   * the room has been rebuilt. Its presence is contract evidence; its value is
   * not parsed here because a read's generation is not the export's.
   */
  generationHeader: boolean;
}

/** The retained ring, as the export endpoint serves it. */
export interface ExportResult {
  room: string;
  /**
   * `X-Room-Generation`, the epoch the snapshot was taken in, when served.
   *
   * A snapshot from a different generation describes a different room: every
   * seq in it is meaningless against a cursor stamped with another one, so the
   * reader refuses to use it rather than merging incomparable sequences.
   */
  generation: number | null;
  /** The JSONL the service served, capped at the caller's ceiling. */
  jsonl: string;
  bytes: number;
  /** True when the body hit the caller's ceiling and was cut. */
  truncated: boolean;
  /** Complete lines in `jsonl`; a cut trailing line is not counted. */
  lines: number;
}

export class TechnocoreClient {
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;
  private readonly semaphore: Semaphore;
  private readonly userAgent: string;
  private readonly serverLimit: number;
  /** The most recent `# budget:` footer, when the service volunteered one. */
  private lastBudget: { remaining: number; limit: number } | null = null;
  /** The most recent 429's retry delay, in seconds. */
  private lastRetryAfterSeconds: number | null = null;
  /**
   * A monotonic counter stamped on every request as `&n=`.
   *
   * It never resets, never repeats and is never derived from the cursor, so a
   * request can never be answered from a cache of an earlier one.
   */
  private cacheBustCounter = 0;
  private readonly counters = {
    reads: 0,
    writes: 0,
    errors: 0,
    timeouts: 0,
    throttled: 0,
    notModified: 0,
    /** Replies that came back before the long poll they asked for. */
    waitNotHeld: 0,
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

  /**
   * The `limit` ceiling this client will ever put on the wire.
   *
   * The documented protocol maximum (200) wins over the configured one: an
   * operator asking for more does not make the service serve more, and a `limit`
   * the service refused would turn every read into a 400. Raising this is only
   * legitimate once a real server response has been seen to accept it — a client
   * config change on its own is not evidence.
   */
  get limitCeiling(): number {
    return Math.min(MAX_PAGE_SIZE, this.serverLimit);
  }

  stats(): RequestStats {
    return { ...this.counters, inflight: this.semaphore.inUse, maxInflight: this.semaphore.limit };
  }

  /** What the service says about our own budget and throttling, for the report. */
  pacing(): {
    budget: { remaining: number; limit: number } | null;
    retryAfterSeconds: number | null;
    waitNotHeld: number;
    requests: number;
  } {
    return {
      budget: this.lastBudget,
      retryAfterSeconds: this.lastRetryAfterSeconds,
      waitNotHeld: this.counters.waitNotHeld,
      requests: this.cacheBustCounter,
    };
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
    init: RequestInit & { timeoutMs?: number; maxBytes?: number } = {},
  ): Promise<{
    status: number;
    body: string;
    contentType: string;
    headers: Headers;
    truncated: boolean;
  }> {
    const release = await this.semaphore.acquire();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error('request timeout')), init.timeoutMs ?? this.timeoutMs);
    const onExternalAbort = () => controller.abort();
    init.signal?.addEventListener('abort', onExternalAbort, { once: true });
    try {
      const response = await this.fetchImpl(url, { ...init, signal: controller.signal });
      const full = await response.text();
      // The ceiling is applied after the download rather than during it: the
      // server's own ring is the real bound on the bytes (~10 MiB, published as
      // `limits.room_ring_bytes`), so this guards what we *keep and parse*, and
      // it says so rather than pretending to bound the socket.
      const truncated = init.maxBytes !== undefined && full.length > init.maxBytes;
      const body = truncated ? full.slice(0, init.maxBytes) : full;
      if (response.status === 429) this.counters.throttled += 1;
      const retryAfter = response.status === 429 ? parseRetryAfter(body, response.headers.get('retry-after')) : null;
      if (retryAfter !== null) this.lastRetryAfterSeconds = retryAfter;
      const budget = parseBudgetFooter(body);
      if (budget !== null) this.lastBudget = budget;
      return {
        status: response.status,
        body,
        contentType: response.headers.get('content-type') ?? '',
        headers: response.headers,
        truncated,
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

  /**
   * Read a room, preferring JSON and falling back to the text view.
   *
   * Every read carries `since` and a fresh `n`. That pair is the whole
   * cache-safety story: `since` makes the URL move as the room advances, and `n`
   * makes it move even when the room does not, so a reply to this request is
   * never a reply to an earlier one.
   */
  async readRoom(room: string, options: ReadOptions = {}): Promise<ClientReadResult> {
    assertRoom(room);
    this.cacheBustCounter += 1;
    const query = readQuery({
      // Always a cursor: `since=0` means "everything retained", and a bare fetch
      // is the documented case that returns cached bytes.
      since: options.since ?? 0,
      limit: options.limit,
      waitSeconds: options.waitSeconds,
      // The client's own ceiling, so a caller asking for a bigger page than the
      // service supports gets the service's maximum rather than a 400.
      maxLimit: this.serverLimit,
      cacheBust: this.cacheBustCounter,
    });
    const url = `${this.baseUrl}/r/${encodeURIComponent(room)}?${query}`;
    const requestQuery = Object.fromEntries(new URLSearchParams(query));
    this.counters.reads += 1;
    const { status, body, contentType, headers } = await this.request(url, {
      method: 'GET',
      headers: this.headers(),
      // A long poll needs its own, longer deadline.
      timeoutMs: (options.waitSeconds ?? 0) * 1000 + this.timeoutMs,
      signal: options.signal,
    });
    const generationHeader = headers.get('x-room-generation') !== null;

    if (status === 304) {
      // A 304 is not a read we can act on: it says "unchanged", which against a
      // cursor we already hold means nothing new to store. Reported as such
      // rather than as an empty page, so a cached 304 cannot look like progress.
      this.counters.notModified += 1;
      return {
        read: { room, count: 0, first_seq: null, last_seq: null, messages: [] },
        status,
        degraded: false,
        waitHeld: null,
        query: requestQuery,
        contentType,
        generationHeader,
      };
    }
    if (status >= 400) {
      throw new ProtocolError(`read ${room} failed with status ${status}: ${body.slice(0, 200)}`);
    }

    const looksJson = contentType.includes('json') || body.trimStart().startsWith('{');
    if (looksJson) {
      const parsed = parseRoomRead(JSON.parse(body));
      const waitHeld = parsed.wait_held ?? null;
      if (waitHeld === false) this.counters.waitNotHeld += 1;
      return {
        read: parsed,
        status,
        degraded: false,
        waitHeld,
        query: requestQuery,
        contentType,
        generationHeader,
      };
    }
    // Text fallback: the service prepends an untrusted-content banner, and senders
    // are abbreviated, so the result is flagged as degraded and its messages carry
    // no DID. Nothing may be signature-verified from this path.
    const read = parseTextRoomRead(body, room);
    const waitHeld = /wait: not held/.test(body) ? false : null;
    if (waitHeld === false) this.counters.waitNotHeld += 1;
    return { read, status, degraded: true, waitHeld, query: requestQuery, contentType, generationHeader };
  }

  /**
   * Read the whole retained ring as raw JSONL.
   *
   * This is a *snapshot of what is retained right now*, not a replay of what we
   * missed: a range the ring already dropped is not in it, and no export can
   * bring it back. `X-Room-Generation` stamps the epoch, which is what makes the
   * snapshot comparable with our own cursor at all.
   */
  async exportRoom(
    room: string,
    options: { maxBytes?: number; signal?: AbortSignal } = {},
  ): Promise<ExportResult> {
    assertRoom(room);
    const url = `${this.baseUrl}/r/${encodeURIComponent(room)}/export`;
    this.counters.reads += 1;
    const { status, body, headers, truncated } = await this.request(url, {
      method: 'GET',
      headers: this.headers({ accept: 'application/jsonl' }),
      ...(options.maxBytes === undefined ? {} : { maxBytes: options.maxBytes }),
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    });
    if (status >= 400) {
      throw new ProtocolError(`export ${room} failed with status ${status}: ${body.slice(0, 200)}`);
    }
    const raw = headers.get('x-room-generation');
    const parsed = raw === null ? Number.NaN : Number.parseInt(raw, 10);
    const lines = body === '' ? 0 : body.split('\n').filter((line) => line.trim().length > 0).length;
    return {
      room,
      generation: Number.isFinite(parsed) ? parsed : null,
      jsonl: body,
      bytes: body.length,
      truncated,
      // A cut body's trailing line is a fragment, not a record.
      lines: truncated ? Math.max(0, lines - 1) : lines,
    };
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
