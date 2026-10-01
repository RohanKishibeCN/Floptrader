/**
 * The official technocore.chat contract, pinned.
 *
 * Everything here comes from the published manual, not from what our client
 * happens to do:
 *
 *   - `https://technocore.chat/llms.txt` — PARAMETERS, WAITING, POLLING, TOTAL
 *   - `https://technocore.chat/.well-known/agent.json` — `limits`
 *   - `https://technocore.chat/openapi.json` — the response schema
 *   - the project README — `GET /r/<room>/export` and `X-Room-Generation`
 *
 * The double below is deliberately *not* a convenient fake. It reimplements the
 * documented server: it clamps instead of refusing, falls back to 50 on a junk
 * `limit`, reads a junk `since` as "no cursor", reports `first_seq`/`last_seq`
 * for the retained ring, sends `wait_held` only on an empty `wait=` read, and
 * serves `/export` as JSONL stamped with the room's generation. A test that used
 * a friendlier server would pin our own assumptions back at us.
 *
 * The point of the file is the two properties the live close1 gap turned on: a
 * page cannot be larger than 200, and a request without a changing URL can be
 * answered from a cache.
 */
import { describe, expect, it } from 'vitest';
import {
  ASSUMED_SERVER_LIMIT,
  MAX_PAGE_SIZE,
  MAX_WAIT_SECONDS,
  TechnocoreClient,
  parseBudgetFooter,
  parseRetryAfter,
  readQuery,
} from '@flop/technocore';

const BASE = 'http://technocore.test';

interface Stored {
  seq: number;
  ts: string;
  from: string;
  text: string;
  nonce?: number;
  sig?: string;
}

interface RoomState {
  messages: Stored[];
  nextSeq: number;
  generation: number;
}

/**
 * The documented server, in memory.
 *
 * `holdWait` says whether a free long-poll slot exists. The double never
 * actually sleeps — a test that waited 10 real seconds per empty read would not
 * run — but it reports `wait_held` exactly as the contract defines it, which is
 * the part a caller acts on.
 */
class DocumentedServer {
  readonly rooms = new Map<string, RoomState>();
  /** Every URL served, in order. The query is the interesting part. */
  readonly urls: string[] = [];
  /** Cache keyed by exact URL, standing in for an agent-harness response cache. */
  private readonly cache = new Map<string, { status: number; body: string; type: string }>();
  cacheEnabled = true;
  holdWait = true;
  /** When set, the next read answers 429 with this body. */
  throttleBody: string | null = null;
  /** Free long-poll slots; 0 makes the server answer immediately. */
  waiterSlots = 8;

  room(name: string): RoomState {
    const existing = this.rooms.get(name);
    if (existing) return existing;
    const created: RoomState = { messages: [], nextSeq: 1, generation: 1 };
    this.rooms.set(name, created);
    return created;
  }

  append(room: string, text: string, from = 'someone'): Stored {
    const state = this.room(room);
    const seq = state.nextSeq;
    state.nextSeq += 1;
    const message: Stored = { seq, ts: new Date(Date.UTC(2026, 8, 26, 12, 0, 0) + seq * 1000).toISOString(), from, text };
    state.messages.push(message);
    return message;
  }

  /** The retained ring, oldest first. */
  private retained(room: string): Stored[] {
    return this.room(room).messages;
  }

  private head(room: string): number {
    const retained = this.retained(room);
    return retained[retained.length - 1]?.seq ?? 0;
  }

  private json(payload: unknown, extra: Record<string, string> = {}): Response {
    return new Response(JSON.stringify(payload), {
      status: 200,
      headers: { 'content-type': 'application/json', ...extra },
    });
  }

  /** Advisory parameters: clamped or defaulted, never refused. */
  private read(room: string, params: URLSearchParams): Response {
    const sinceRaw = params.get('since');
    // "anything that is not a non-negative integer ... is read as no cursor at all"
    const since = sinceRaw !== null && /^\d+$/.test(sinceRaw) ? Number.parseInt(sinceRaw, 10) : null;
    const limitRaw = params.get('limit');
    const parsedLimit = limitRaw !== null && /^\d+$/.test(limitRaw) ? Number.parseInt(limitRaw, 10) : null;
    // "a value that is not a non-negative integer falls back to 50, and what
    //  survives is clamped to 1..200"
    const limit = parsedLimit === null ? 50 : Math.min(MAX_PAGE_SIZE, Math.max(1, parsedLimit));
    const waitRaw = params.get('wait');
    const parsedWait = waitRaw === null ? 0 : Number.parseFloat(waitRaw);
    // "Needs `since`. Zero, negative and unparseable all mean no wait."
    const wait = since === null || !Number.isFinite(parsedWait) ? 0 : Math.min(MAX_WAIT_SECONDS, Math.max(0, parsedWait));

    const all = this.retained(room).filter((message) => since === null || message.seq > since);
    // Oldest first, capped from the old end: a client that stores what it is
    // given then never skips a range it could have read.
    const messages = all.slice(0, limit);
    const payload: Record<string, unknown> = {
      room,
      count: messages.length,
      // "Oldest seq in this response"; null when the response carried none.
      first_seq: messages[0]?.seq ?? null,
      // "Pass back as `since` to poll." The room's head, even on an empty reply:
      // "an empty reply's `last_seq` is the room's real head, so the next poll
      //  resumes there instead of waiting on a seq that will not come."
      last_seq: this.head(room),
      messages,
    };
    const state = this.room(room);
    if (state.generation !== 1) payload.generation = state.generation;
    if (messages.length === 0 && wait > 0) {
      // "Present only on a `wait=` read that returned no messages."
      const free = this.holdWait && this.waiterSlots > 0;
      payload.wait_held = free;
    }
    return this.json(payload);
  }

  /** The retained ring as JSONL, stamped with the epoch. */
  private export(room: string): Response {
    const body = this.retained(room)
      .map((message) => JSON.stringify(message))
      .join('\n');
    const state = this.room(room);
    return new Response(body, {
      status: 200,
      headers: {
        'content-type': 'application/jsonl',
        'x-room-generation': String(state.generation),
      },
    });
  }

  private throttle(): Response {
    const body = this.throttleBody ?? '429 rate limited: bucket reads, refill 10/s, retry after 3 seconds\n';
    return new Response(body, {
      status: 429,
      headers: { 'content-type': 'text/plain', 'retry-after': '3' },
    });
  }

  fetchImpl = async (input: Parameters<typeof fetch>[0]): Promise<Response> => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    this.urls.push(url);

    // The response cache an agent harness puts in front of a fetch tool: same
    // URL, same bytes, no matter what the room did in between.
    if (this.cacheEnabled) {
      const hit = this.cache.get(url);
      if (hit) return new Response(hit.body, { status: hit.status, headers: { 'content-type': hit.type } });
    }

    const parsed = new URL(url);
    const exportMatch = /^\/r\/([^/]+)\/export$/.exec(parsed.pathname);
    const readMatch = /^\/r\/([^/]+)$/.exec(parsed.pathname);

    let response: Response;
    if (this.throttleBody !== null && readMatch) {
      response = this.throttle();
    } else if (exportMatch) {
      response = this.export(decodeURIComponent(exportMatch[1]!));
    } else if (readMatch) {
      response = this.read(decodeURIComponent(readMatch[1]!), parsed.searchParams);
    } else {
      response = new Response('404 not found', { status: 404, headers: { 'content-type': 'text/plain' } });
    }

    if (this.cacheEnabled) {
      const body = await response.clone().text();
      this.cache.set(url, { status: response.status, body, type: response.headers.get('content-type') ?? '' });
    }
    return response;
  };
}

function clientFor(server: DocumentedServer, extra: Record<string, unknown> = {}): TechnocoreClient {
  return new TechnocoreClient({ baseUrl: BASE, fetchImpl: server.fetchImpl, ...extra });
}

describe('the documented read contract', () => {
  it('never asks for a page larger than the documented 200', () => {
    expect(MAX_PAGE_SIZE).toBe(200);
    // Our own ceiling is the documented one, and it is not configurable upward
    // past it: 200 is what the service enforces, whatever a local knob says.
    expect(ASSUMED_SERVER_LIMIT).toBe(200);
    const query = new URLSearchParams(readQuery({ since: 0, limit: 1000 }));
    expect(query.get('limit')).toBe('200');
  });

  it('never asks for a hold longer than the documented 10 seconds', () => {
    expect(MAX_WAIT_SECONDS).toBe(10);
    expect(new URLSearchParams(readQuery({ since: 0, waitSeconds: 600 })).get('wait')).toBe('10');
    expect(new URLSearchParams(readQuery({ since: 0, waitSeconds: -5 })).get('wait')).toBe('0');
  });

  it('always carries a cursor, and clamps a cursor past the head', async () => {
    const server = new DocumentedServer();
    server.append('close1', 'one');
    const client = clientFor(server);

    // `since` is always on the wire: a bare fetch is the cached-bytes case.
    expect(new URLSearchParams(readQuery({})).get('since')).toBe('0');
    await client.readRoom('close1', { limit: 10 });
    expect(new URL(server.urls[0]!).searchParams.get('since')).toBe('0');

    // A cursor past the room's newest seq is clamped to it: the reply is empty
    // but still reports the real head, so the next poll can resume there.
    const past = await client.readRoom('close1', { since: 9_999, limit: 10 });
    expect(past.read.count).toBe(0);
    expect(past.read.messages).toHaveLength(0);
    expect(past.read.last_seq).toBe(1);
  });

  it('reads a junk limit as the documented fallback rather than as a refusal', async () => {
    const server = new DocumentedServer();
    for (let index = 0; index < 300; index += 1) server.append('close1', `m${index}`);
    const client = clientFor(server);

    // No `limit` at all is the documented fallback of 50.
    const plain = await client.readRoom('close1', { since: 0 });
    expect(plain.read.count).toBe(50);

    const capped = await client.readRoom('close1', { since: 0, limit: 5_000 });
    expect(capped.read.count).toBe(200);
  });

  it('reports the retained ring through first_seq and last_seq, not the page', async () => {
    const server = new DocumentedServer();
    for (let seq = 1; seq <= 300; seq += 1) server.append('close1', `m${seq}`);
    const client = clientFor(server);

    const page = await client.readRoom('close1', { since: 0, limit: 10 });
    // The page carried 10 messages, but `last_seq` is the room's head: it is
    // what the caller polls with next, and it is how "we are 290 behind" is
    // visible at all.
    expect(page.read.count).toBe(10);
    expect(page.read.first_seq).toBe(1);
    expect(page.read.last_seq).toBe(300);
    // The documented invariant: count is the answer, not the request.
    expect(page.read.messages).toHaveLength(page.read.count);
  });

  it('announces a generation only when the room was recreated', async () => {
    const server = new DocumentedServer();
    server.append('close1', 'one');
    const client = clientFor(server);
    expect((await client.readRoom('close1', { since: 0 })).read.generation).toBeUndefined();

    server.room('close1').generation = 2;
    expect((await client.readRoom('close1', { since: 0 })).read.generation).toBe(2);
  });

  it('takes wait_held as the long-poll verdict, and only when it applies', async () => {
    const server = new DocumentedServer();
    server.append('close1', 'one');
    const client = clientFor(server);

    // Messages came back: `wait_held` does not apply at all.
    const filled = await client.readRoom('close1', { since: 0, waitSeconds: 10 });
    expect(filled.waitHeld).toBeNull();

    // Empty and held: the room really is quiet, so poll again.
    server.waiterSlots = 8;
    const held = await client.readRoom('close1', { since: 1, waitSeconds: 10 });
    expect(held.read.count).toBe(0);
    expect(held.waitHeld).toBe(true);

    // Empty and not held: no long-poll slot was free, so the reply was
    // immediate. Re-reading at once would read for nothing.
    server.waiterSlots = 0;
    const immediate = await client.readRoom('close1', { since: 1, waitSeconds: 10 });
    expect(immediate.waitHeld).toBe(false);
    expect(client.stats().waitNotHeld).toBe(1);
    expect(client.pacing().waitNotHeld).toBe(1);
  });

  it('serves the retained ring as JSONL stamped with the room generation', async () => {
    const server = new DocumentedServer();
    server.append('close1', 'one');
    server.append('close1', 'two');
    server.room('close1').generation = 7;
    const client = clientFor(server);

    const exported = await client.exportRoom('close1');
    expect(exported.generation).toBe(7);
    expect(exported.lines).toBe(2);
    expect(exported.truncated).toBe(false);
    const records = exported.jsonl.split('\n').map((line) => JSON.parse(line) as Stored);
    expect(records.map((record) => record.seq)).toEqual([1, 2]);
    expect(records.map((record) => record.text)).toEqual(['one', 'two']);
  });

  it('reports a generation the export did not stamp as unknown, never as generation 0', async () => {
    const server = new DocumentedServer();
    server.append('close1', 'one');
    server.fetchImpl = async () =>
      new Response('{"seq":1,"ts":"t","from":"x","text":"one"}', {
        status: 200,
        headers: { 'content-type': 'application/jsonl' },
      });
    const client = clientFor(server);
    const exported = await client.exportRoom('close1');
    expect(exported.generation).toBeNull();
  });

  it('cuts an export at the caller byte ceiling and does not count the partial line', async () => {
    const server = new DocumentedServer();
    for (let index = 0; index < 50; index += 1) server.append('close1', `message number ${index}`);
    const client = clientFor(server);

    const exported = await client.exportRoom('close1', { maxBytes: 120 });
    expect(exported.truncated).toBe(true);
    expect(exported.bytes).toBe(120);
    expect(exported.lines).toBeLessThan(50);
  });
});

describe('the documented throttling contract', () => {
  it('surfaces the retry delay from the 429 body, and counts the throttle', async () => {
    const server = new DocumentedServer();
    server.append('close1', 'one');
    server.throttleBody = '429 rate limited: bucket reads, refill 100/s, retry after 4 seconds\n';
    const client = clientFor(server);

    await expect(client.readRoom('close1', { since: 0 })).rejects.toThrow(/status 429/);
    expect(client.stats().throttled).toBe(1);
    expect(client.pacing().retryAfterSeconds).toBe(4);
  });

  it('reads the retry delay out of the body, because a harness shows the body and not the headers', () => {
    expect(parseRetryAfter('429 slow down: retry after 7 seconds', null)).toBe(7);
    expect(parseRetryAfter('429 slow down: retry after 2.5s', null)).toBe(2.5);
    expect(parseRetryAfter('429 no number here', '11')).toBe(11);
    expect(parseRetryAfter('429 nothing at all', null)).toBeNull();
  });

  it('reads the budget footer the service volunteers below a quarter of a bucket', () => {
    expect(parseBudgetFooter('# budget: 120 of 600 reads left this minute')).toEqual({
      remaining: 120,
      limit: 600,
    });
    expect(parseBudgetFooter('ordinary body with no footer')).toBeNull();
  });
});

describe('cache safety', () => {
  it('makes every read a different URL, so a cached page can never be served twice', async () => {
    const server = new DocumentedServer();
    server.append('close1', 'one');
    const client = clientFor(server);

    // Two reads of an idle room: the cursor does not move between them, so
    // `since` is identical and only `n` distinguishes the requests at all.
    const first = await client.readRoom('close1', { since: 1, limit: 10 });
    const second = await client.readRoom('close1', { since: 1, limit: 10 });

    expect(server.urls).toHaveLength(2);
    expect(server.urls[0]).not.toBe(server.urls[1]);
    const firstQuery = new URL(server.urls[0]!).searchParams;
    const secondQuery = new URL(server.urls[1]!).searchParams;
    expect(firstQuery.get('since')).toBe('1');
    expect(secondQuery.get('since')).toBe('1');
    expect(firstQuery.get('n')).not.toBe(secondQuery.get('n'));

    // The tell: a cached reply carries no `n` distinction, so it would have
    // reported the same body. The second read is a fresh one.
    expect(second.status).toBe(200);
    expect(second.read.count).toBe(0);
    expect(first.query.n).not.toBe(second.query.n);
  });

  it('would return stale bytes without the counter, which is why it is always sent', async () => {
    const server = new DocumentedServer();
    server.append('close1', 'one');
    // A fixed URL read twice, the way a client that omitted `n` would.
    const url = `${BASE}/r/close1?since=0&limit=10&format=json`;
    const first = await server.fetchImpl(url);
    const firstBody = await first.text();
    server.append('close1', 'two');
    const secondBody = await (await server.fetchImpl(url)).text();
    expect(secondBody).toBe(firstBody);
  });

  it('never lets a cached reply advance a cursor past what the room actually holds', async () => {
    const server = new DocumentedServer();
    for (let seq = 1; seq <= 5; seq += 1) server.append('close1', `m${seq}`);
    const client = clientFor(server);

    const read = await client.readRoom('close1', { since: 0, limit: 2 });
    // Only what the page carried may ever be treated as read.
    expect(read.read.messages.map((message) => message.seq)).toEqual([1, 2]);
    expect(read.read.last_seq).toBe(5);
  });
});
