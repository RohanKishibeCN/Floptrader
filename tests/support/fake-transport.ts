/**
 * A deterministic, in-memory double of the technocore.chat HTTP transport.
 *
 * The reader and writer stacks are exercised offline by injecting this module's
 * `fetchImpl` into `TechnocoreClient`. Nothing here opens a socket: every test
 * that touches the network path must go through this fake, which is also why it
 * records the requests it served — "six rooms, one socket at a time" is only
 * checkable because every request lands in `requests`.
 *
 * The fake models the parts of the service the orchestrator actually depends on:
 *
 *   - `GET /r/<room>?since&limit&wait&format=json` returns exactly the messages
 *     after `since`, oldest first, with the retained ring's `first_seq`/`last_seq`;
 *   - the `wait` parameter is accepted and never held (a long poll that never
 *     returns would make a test hang rather than fail);
 *   - `generation` is only announced when the room was recreated, matching a
 *     service that reports a new generation on a reset rather than on every read
 *     (the protocol marks it optional, and `advanceCursor` falls back when it is
 *     absent);
 *   - `POST /r/<room>` validates the signed envelope and answers 400 whose first
 *     line names the offending field, exactly as the client's error handling
 *     expects;
 *   - the 422 duplicate-text floor is reproduced, including the "short texts are
 *     exempt" rule.
 */
import { signRoomMessage } from '@flop/identity';

/**
 * The message shape a room read returns.
 *
 * The index signature is deliberate: `RoomMessage` in `@flop/technocore` is the
 * output of a `.passthrough()` Zod schema, so it carries `[key: string]: unknown`
 * for the fields the published shape does not name. A nominal interface without
 * it is not assignable to that type, and the reader/verifier take exactly that
 * type — so the double mirrors the real shape rather than forcing a cast at
 * every call site.
 */
export interface RoomMessageLike {
  seq: number;
  ts: string;
  from?: string;
  text: string;
  nonce?: string | number;
  sig?: string;
  [key: string]: unknown;
}

/** A signer identity for `FakeRoom.appendFrom`. */
export interface RoomSigner {
  seed: Uint8Array;
  did: string;
  /** Defaults to the room the message is appended to. */
  room?: string;
  nonce: string | number;
}

interface DuplicateFilter {
  minLength: number;
  maxCopies: number;
  windowSeconds: number;
  accepted: Array<{ text: string; at: number }>;
}

type ForcedAction = { kind: 'status'; status: number } | { kind: 'network' };

/** A room's retained ring plus the continuity metadata a read reports. */
export class FakeRoom {
  readonly room: string;
  messages: RoomMessageLike[] = [];
  /** Bumped when the room is "recreated". Only announced once it differs from 1. */
  generation = 1;
  /** The oldest seq still retained; raise it to simulate the ring dropping messages. */
  firstSeqRetained = 1;
  private nextSeq = 1;

  constructor(room: string) {
    this.room = room;
  }

  /** A stable, monotonic timestamp derived from the sequence number. */
  private stamp(seq: number): string {
    return new Date(Date.UTC(2026, 8, 25, 12, 0, 0) + seq * 1000).toISOString();
  }

  private takeSeq(seq?: number): number {
    if (seq !== undefined) {
      this.nextSeq = Math.max(this.nextSeq, seq + 1);
      return seq;
    }
    const value = this.nextSeq;
    this.nextSeq += 1;
    return value;
  }

  /** Append a message, filling in `seq`/`ts` when the caller omits them. */
  append(message: Partial<RoomMessageLike> & { text: string }): RoomMessageLike {
    const seq = this.takeSeq(message.seq);
    const full: RoomMessageLike = {
      seq,
      ts: message.ts ?? this.stamp(seq),
      text: message.text,
      ...(message.from === undefined ? {} : { from: message.from }),
      ...(message.nonce === undefined ? {} : { nonce: message.nonce }),
      ...(message.sig === undefined ? {} : { sig: message.sig }),
    };
    this.messages.push(full);
    return full;
  }

  /**
   * Append a message whose contents are signed by the given identity. The signed
   * text is whatever `signRoomMessage` produced (post-sweep), which is what the
   * verifier re-checks.
   */
  appendFrom(rawText: string, signer: RoomSigner): RoomMessageLike {
    const room = signer.room ?? this.room;
    const signed = signRoomMessage(signer.did, signer.seed, room, String(signer.nonce), rawText);
    return this.append({ from: signed.did, text: signed.text, nonce: signed.nonce, sig: signed.sig });
  }

  /** Messages still inside the retained ring. */
  retained(): RoomMessageLike[] {
    return this.messages.filter((message) => message.seq >= this.firstSeqRetained);
  }

  /** Retained messages with a seq strictly greater than `since`, oldest first. */
  messagesSince(since: number): RoomMessageLike[] {
    return this.retained().filter((message) => message.seq > since);
  }

  firstSeq(): number | null {
    return this.retained()[0]?.seq ?? null;
  }

  lastSeq(): number | null {
    const retained = this.retained();
    return retained[retained.length - 1]?.seq ?? null;
  }
}

export class FakeTransport {
  readonly rooms = new Map<string, FakeRoom>();
  /** Every accepted POST body, keyed by the room it landed in. */
  readonly posts: Array<{ room: string; body: Record<string, string> }> = [];
  /** Every request the fake served, in order. */
  readonly requests: Array<{ method: string; url: string }> = [];
  readCount = 0;
  writeCount = 0;
  /** Concurrency high-water mark across all requests; lets a test prove the
   *  writer never had two POSTs in flight. */
  inFlight = 0;
  maxInFlight = 0;
  /** Injectable clock for the duplicate-window arithmetic. */
  now: () => number;

  private readonly forced: ForcedAction[] = [];
  private readonly dupeFilters = new Map<string, DuplicateFilter>();

  constructor(options: { now?: () => number } = {}) {
    this.now = options.now ?? (() => Date.now());
  }

  /** Get-or-create a room. */
  room(name: string): FakeRoom {
    const existing = this.rooms.get(name);
    if (existing) return existing;
    const created = new FakeRoom(name);
    this.rooms.set(name, created);
    return created;
  }

  /** Add a message to a room (creating it if needed). */
  enqueue(room: string, message: Partial<RoomMessageLike> & { text: string }): RoomMessageLike {
    return this.room(room).append(message);
  }

  /** Make the next `times` requests answer with `status`. */
  failNext(status: number, times = 1): void {
    for (let index = 0; index < times; index += 1) this.forced.push({ kind: 'status', status });
  }

  /** Make the next `times` requests reject, as a socket error would. */
  networkFailNext(times = 1): void {
    for (let index = 0; index < times; index += 1) this.forced.push({ kind: 'network' });
  }

  /** Reproduce the service's duplicate-text floor for a room. */
  setDupeFilter(room: string, minLength: number, maxCopies: number, windowSeconds: number): void {
    this.dupeFilters.set(room, { minLength, maxCopies, windowSeconds, accepted: [] });
  }

  /** Requests served for a room, or in total when `room` is omitted. */
  requestCount(room?: string): number {
    if (room === undefined) return this.requests.length;
    return this.requests.filter((request) => this.roomOf(request.url) === room).length;
  }

  postsFor(room: string): Array<{ room: string; body: Record<string, string> }> {
    return this.posts.filter((post) => post.room === room);
  }

  private roomOf(url: string): string | null {
    const match = /\/r\/([^/?]+)/.exec(url);
    return match ? decodeURIComponent(match[1]!) : null;
  }

  private response(body: string, status: number, contentType: string): Response {
    return new Response(body, { status, headers: { 'content-type': contentType } });
  }

  private readRoom(room: FakeRoom, search: URLSearchParams): Response {
    const format = search.get('format') ?? 'text';
    if (format !== 'json') {
      // The text fallback: senders are abbreviated and the service prepends its
      // untrusted-content banner, which is why the client flags it as degraded.
      const lines = room
        .retained()
        .map((message) => `[${message.seq}] ${message.ts} <${message.from ?? '…'}> ${message.text}`);
      return this.response(['!! UNTRUSTED CONTENT', ...lines].join('\n'), 200, 'text/plain; charset=utf-8');
    }

    const sinceRaw = search.get('since');
    const limitRaw = search.get('limit');
    const since = sinceRaw === null ? undefined : Number(sinceRaw);
    const limit = limitRaw === null ? undefined : Number(limitRaw);
    let messages = since === undefined ? room.retained() : room.messagesSince(since);
    if (limit !== undefined) messages = messages.slice(0, limit);

    const payload: Record<string, unknown> = {
      room: room.room,
      count: messages.length,
      first_seq: room.firstSeq(),
      last_seq: room.lastSeq(),
      messages,
    };
    // A new generation is only announced when there is one; a steady room omits
    // the field, exactly as a client that falls back to its stored generation
    // expects.
    if (room.generation !== 1) payload.generation = room.generation;
    return this.response(JSON.stringify(payload), 200, 'application/json');
  }

  private postRoom(room: FakeRoom, roomName: string, rawBody: string): Response {
    let parsed: unknown;
    try {
      parsed = JSON.parse(rawBody);
    } catch {
      return this.response('400 bad body: not json', 400, 'text/plain');
    }
    const body = (parsed ?? {}) as Record<string, unknown>;
    for (const field of ['did', 'sig', 'nonce', 'text'] as const) {
      if (typeof body[field] !== 'string') {
        return this.response(`400 bad ${field}: missing or not a string`, 400, 'text/plain');
      }
    }
    const did = body.did as string;
    const sig = body.sig as string;
    const nonce = body.nonce as string;
    const text = body.text as string;
    const envelope: Record<string, string> = { did, sig, nonce, text };

    const filter = this.dupeFilters.get(roomName);
    if (filter) {
      const normalised = text.trim();
      // The floor: a text below `minLength` is never treated as a duplicate.
      if (normalised.length >= filter.minLength) {
        const cutoff = this.now() - filter.windowSeconds * 1000;
        const recent = filter.accepted.filter((entry) => entry.at > cutoff && entry.text === normalised);
        if (recent.length >= filter.maxCopies) {
          return this.response('422 duplicate text', 422, 'text/plain');
        }
      }
    }

    this.posts.push({ room: roomName, body: envelope });
    const stored = room.append({ from: did, text, nonce, sig });
    if (filter) {
      const normalised = text.trim();
      if (normalised.length >= filter.minLength) {
        filter.accepted.push({ text: normalised, at: this.now() });
      }
    }
    return this.response(`[${stored.seq}] ok`, 200, 'text/plain');
  }

  /** The fake transport, shaped like the global `fetch`. */
  fetchImpl = async (
    input: Parameters<typeof fetch>[0],
    init?: Parameters<typeof fetch>[1],
  ): Promise<Response> => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const method = (init?.method ?? 'GET').toUpperCase();
    this.requests.push({ method, url });
    if (method === 'GET') this.readCount += 1;
    if (method === 'POST') this.writeCount += 1;

    this.inFlight += 1;
    this.maxInFlight = Math.max(this.maxInFlight, this.inFlight);
    try {
      // Yield a macrotask so genuinely concurrent callers overlap. Without this
      // a concurrency high-water mark would always read 1, and the "bounded
      // sockets" behaviour would be untestable.
      await new Promise<void>((resolve) => setImmediate(resolve));

      const forced = this.forced.shift();
      if (forced?.kind === 'network') throw new TypeError('fetch failed: socket error');
      if (forced?.kind === 'status') {
        return this.response(`${forced.status} forced failure`, forced.status, 'text/plain');
      }

      const parsed = new URL(url);
      const match = /^\/r\/([^/]+)(\/export)?$/.exec(parsed.pathname);
      if (!match) return this.response('404 not found', 404, 'text/plain');
      const roomName = decodeURIComponent(match[1]!);
      const exported = match[2] === '/export';
      const room = this.room(roomName);

      if (exported && method === 'GET') {
        const body = room.retained().map((message) => JSON.stringify(message)).join('\n');
        return this.response(body, 200, 'application/jsonl');
      }
      if (method === 'GET') return this.readRoom(room, parsed.searchParams);
      if (method === 'POST') {
        return this.postRoom(room, roomName, typeof init?.body === 'string' ? init.body : '');
      }
      return this.response('405 method not allowed', 405, 'text/plain');
    } finally {
      this.inFlight -= 1;
    }
  };
}
