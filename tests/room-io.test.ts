/**
 * The room reader and writer, end to end, against the in-memory fake.
 *
 * Two hard requirements live here: the reader must read six rooms through a
 * bounded number of sockets and never step over a gap, and the writer must put
 * every message through one queue with one in-flight POST, a fresh nonce per
 * attempt, and no retry on a permanent refusal.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { signRoomMessage, verifyRoomSignatureForRoom, MemoryNoncePersistence, NonceStore } from '@flop/identity';
import { RefereeVerifier, RoomReader, RoomWriter, TechnocoreClient } from '@flop/technocore';
import { referenceRules } from '@flop/close-call';
import { closeDatabase, createRepositories, openDatabase, type Repositories, type SqliteDatabase } from '@flop/storage';
import { Logger } from '../apps/orchestrator/src/logger.js';
import { FakeTransport } from './support/fake-transport.js';
import { generateAgents } from './support/harness.js';

const BASE = 'http://technocore.test';
const silent = Logger.create({ level: 'fatal' });
const ROOMS = [
  'd-close1-price',
  'd-close1-flow',
  'd-close1-state',
  'd-close1-positions',
  'd-close1-pnl',
  'close1',
];
const referee = generateAgents(1)[0]!;
const PRICE_TEXT = JSON.stringify({
  t: 'price',
  n: 824,
  ref: { px: '223.01', tid: 444195233496965, time: '2026-09-28T08:40:00Z' },
  limits: ['211.86', '234.16'],
});

function ts(seq: number): string {
  return `2026-09-28T08:40:${String(seq).padStart(2, '0')}.000Z`;
}

function flip(signature: string): string {
  return `${signature.slice(0, 85)}${signature.endsWith('A') ? 'Q' : 'A'}`;
}

describe('RoomReader', () => {
  let db: SqliteDatabase;
  let repositories: Repositories;

  beforeEach(() => {
    db = openDatabase({ path: ':memory:' });
    repositories = createRepositories(db);
  });

  afterEach(() => {
    closeDatabase(db);
  });

  function makeReader(
    transport: FakeTransport,
    options: { readConcurrency?: number; fetchImpl?: typeof fetch } = {},
  ): RoomReader {
    const client = new TechnocoreClient({ baseUrl: BASE, fetchImpl: options.fetchImpl ?? transport.fetchImpl });
    const verifier = new RefereeVerifier({ rules: referenceRules(), logger: silent, expectedRefereeDid: referee.did });
    return new RoomReader({
      client,
      db,
      repositories,
      verifier,
      logger: silent,
      rooms: ROOMS,
      readConcurrency: options.readConcurrency ?? 2,
      limit: 50,
      waitSeconds: 0,
      now: () => new Date('2026-09-28T08:40:00Z'),
    });
  }

  it('reads six rooms with at most readConcurrency sockets and one read per room', async () => {
    const transport = new FakeTransport();
    for (const room of ROOMS) transport.enqueue(room, { text: 'hello' });

    // The high-water mark is computed here, outside the transport, so it counts
    // what the reader actually had in flight rather than what the fake believes.
    let active = 0;
    let highWater = 0;
    const counting: typeof fetch = async (input, init) => {
      active += 1;
      highWater = Math.max(highWater, active);
      try {
        return await transport.fetchImpl(input, init);
      } finally {
        active -= 1;
      }
    };

    const reader = makeReader(transport, { readConcurrency: 2, fetchImpl: counting });
    await reader.tick();

    expect(highWater).toBeLessThanOrEqual(2);
    // Two slots are genuinely used; a semaphore that serialised everything would
    // read 1 and hide a regression back to unbounded polling.
    expect(highWater).toBe(2);
    for (const room of ROOMS) expect(transport.requestCount(room)).toBe(1);
    expect(transport.readCount).toBe(6);
  });

  it('adopts a cursor for every room on the first tick and never regresses it', async () => {
    const transport = new FakeTransport();
    for (const room of ROOMS) {
      for (let seq = 1; seq <= 2; seq += 1) transport.enqueue(room, { text: `m${seq}` });
    }
    const reader = makeReader(transport);

    const first = await reader.tick();
    expect(reader.warmedUp).toBe(true);
    expect(first.rooms.every((tick) => tick.cursor.cursor === 2)).toBe(true);
    expect(first.inserted).toBe(ROOMS.length * 2);

    const cursors = first.rooms.map((tick) => tick.cursor.cursor);
    const second = await reader.tick();
    // Nothing new arrived, so nothing is inserted and no cursor moves backwards.
    expect(second.inserted).toBe(0);
    expect(second.rooms.map((tick) => tick.cursor.cursor)).toEqual(cursors);
  });

  it('observes referee posts and rejects a tampered signature', async () => {
    const transport = new FakeTransport();
    transport.room('d-close1-price').appendFrom(PRICE_TEXT, {
      seed: referee.seed,
      did: referee.did,
      nonce: '1',
    });
    const good = signRoomMessage(referee.did, referee.seed, 'd-close1-price', '2', PRICE_TEXT);
    transport.enqueue('d-close1-price', {
      seq: 2,
      ts: ts(2),
      from: good.did,
      text: good.text,
      nonce: good.nonce,
      sig: flip(good.sig),
    });

    const summary = await makeReader(transport).tick();
    expect(summary.observations.some((observation) => observation.record.accepted)).toBe(true);
    const rejected = summary.observations.find((observation) => observation.record.rejectedBecause === 'signature_invalid');
    // A flipped signature must fail verification rather than being trusted for
    // having the right shape.
    expect(rejected).toBeDefined();
    expect(rejected?.record.signatureValid).toBe(false);
  });

  it('records a retained-ring gap and goes unhealthy', async () => {
    const transport = new FakeTransport();
    for (let seq = 1; seq <= 3; seq += 1) transport.enqueue('close1', { seq, text: `m${seq}` });
    const reader = makeReader(transport);
    await reader.tick();

    // Messages 4 and 5 are dropped from the ring before the next read; 6..8 are
    // the oldest thing still retained.
    for (let seq = 4; seq <= 8; seq += 1) transport.enqueue('close1', { seq, text: `m${seq}` });
    transport.room('close1').firstSeqRetained = 6;

    const summary = await reader.tick();
    expect(summary.health.healthy).toBe(false);
    expect(reader.gaps().rooms).toContain('close1');
    expect(reader.gaps().total).toBe(2);
  });
});

describe('RoomWriter', () => {
  /** A writer wired to a fake transport, with a monotonic injected nonce clock. */
  function makeWriter(
    transport: FakeTransport,
    options: {
      fetchImpl?: typeof fetch;
      queueCapacity?: number;
      maxRetries?: number;
      agents: ReturnType<typeof generateAgents>;
    },
  ): RoomWriter {
    const byId = new Map(options.agents.map((agent) => [agent.agentId, agent]));
    let tick = 1_790_000_000_000;
    const nonceStore = new NonceStore({
      persistence: new MemoryNoncePersistence(),
      // Monotonic per call, so a burst never reuses a value across pairs.
      now: () => (tick += 1),
    });
    const client = new TechnocoreClient({ baseUrl: BASE, fetchImpl: options.fetchImpl ?? transport.fetchImpl });
    return new RoomWriter({
      client,
      nonceStore,
      logger: silent,
      signer: (agentId, room, nonce, text) => {
        const agent = byId.get(agentId)!;
        return signRoomMessage(agent.did, agent.seed, room, nonce, text);
      },
      writeRatePerMinute: 1000,
      queueCapacity: options.queueCapacity ?? 200,
      maxRetries: options.maxRetries ?? 4,
    });
  }

  it('sends 25 messages through one queue with distinct, verified, strictly increasing nonces', async () => {
    const transport = new FakeTransport();
    const agents = generateAgents(25);
    const writer = makeWriter(transport, { agents });

    const results = await Promise.all(
      agents.map((agent, index) =>
        writer.enqueue({
          room: 'close1',
          agentId: agent.agentId,
          did: agent.did,
          text: `hello from ${agent.agentId}`,
          priority: 'normal',
          label: `message-${index}`,
        }),
      ),
    );

    expect(results.every((result) => result.ok)).toBe(true);
    const posts = transport.postsFor('close1');
    expect(posts).toHaveLength(25);

    // Every wire body must verify against the room it was posted to.
    for (const post of posts) {
      expect(
        verifyRoomSignatureForRoom(
          post.body.did!,
          post.body.nonce!,
          post.body.text!,
          post.body.sig!,
          'close1',
        ),
      ).toBe(true);
    }

    const nonces = posts.map((post) => post.body.nonce!);
    expect(new Set(nonces).size).toBe(25);
    for (let index = 1; index < nonces.length; index += 1) {
      expect(BigInt(nonces[index]!)).toBeGreaterThan(BigInt(nonces[index - 1]!));
    }

    // One queue, one in-flight POST: the high-water mark must be exactly one.
    expect(transport.maxInFlight).toBe(1);
    expect(writer.stats.attempted).toBe(25);
  });

  it('issues no request outside the queue', async () => {
    const transport = new FakeTransport();
    const agents = generateAgents(5);
    const writer = makeWriter(transport, { agents });

    await Promise.all(
      agents.map((agent) =>
        writer.enqueue({
          room: 'close1',
          agentId: agent.agentId,
          did: agent.did,
          text: `burst ${agent.agentId}`,
          priority: 'normal',
          label: agent.agentId,
        }),
      ),
    );

    // Every served request is a POST; the writer never reads, and never opens a
    // connection outside enqueue/flush.
    expect(transport.requests).toHaveLength(5);
    expect(transport.writeCount).toBe(5);
    expect(transport.readCount).toBe(0);
    expect(transport.requests.every((request) => request.method === 'POST')).toBe(true);
  });

  it('does not retry a permanent refusal and surfaces its first line', async () => {
    const transport = new FakeTransport();
    const agents = generateAgents(1);
    const writer = makeWriter(transport, { agents });
    transport.failNext(403, 1);

    const result = await writer.enqueue({
      room: 'close1',
      agentId: agents[0]!.agentId,
      did: agents[0]!.did,
      text: 'refused',
      priority: 'normal',
      label: 'once',
    });

    expect(result.ok).toBe(false);
    // A single POST, because a 403 is permanent; and the reason is the refusal's
    // own first line, not a generic message.
    expect(transport.writeCount).toBe(1);
    expect(result.reason).toContain('403');
  });

  it('retries a 503 with a fresh nonce', async () => {
    const transport = new FakeTransport();
    const written: Array<Record<string, string>> = [];
    const capture: typeof fetch = async (input, init) => {
      if ((init?.method ?? 'GET').toUpperCase() === 'POST' && typeof init?.body === 'string') {
        written.push(JSON.parse(init.body) as Record<string, string>);
      }
      return transport.fetchImpl(input, init);
    };
    const agents = generateAgents(1);
    const writer = makeWriter(transport, { agents, fetchImpl: capture });
    transport.failNext(503, 1);

    const result = await writer.enqueue({
      room: 'close1',
      agentId: agents[0]!.agentId,
      did: agents[0]!.did,
      text: 'retry me',
      priority: 'normal',
      label: 'retry',
    });

    expect(result.ok).toBe(true);
    expect(result.attempts).toBe(2);
    expect(transport.writeCount).toBe(2);
    expect(written).toHaveLength(2);
    // The first nonce may already have landed even though the 503 arrived; the
    // retry must never reuse it.
    expect(written[0]!.nonce).not.toBe(written[1]!.nonce);
  });

  it('sheds a low-priority write when the queue is full but still sends a critical one', async () => {
    const transport = new FakeTransport();
    let releaseFirst: (() => void) | null = null;
    const gated: typeof fetch = async (input, init) => {
      const isPost = (init?.method ?? 'GET').toUpperCase() === 'POST';
      // Hold the first POST open so the queue actually fills behind it.
      if (isPost && releaseFirst === null) {
        await new Promise<void>((resolve) => {
          releaseFirst = resolve;
        });
      }
      return transport.fetchImpl(input, init);
    };
    const agents = generateAgents(3);
    const writer = makeWriter(transport, { agents, fetchImpl: gated, queueCapacity: 1 });

    const request = (agent: (typeof agents)[number], priority: 'critical' | 'normal' | 'low', label: string) => ({
      room: 'close1',
      agentId: agent.agentId,
      did: agent.did,
      text: label,
      priority,
      label,
    });

    const critical = writer.enqueue(request(agents[0]!, 'critical', 'critical'));
    const normal = writer.enqueue(request(agents[1]!, 'normal', 'normal'));
    const shed = await writer.enqueue(request(agents[2]!, 'low', 'low'));

    expect(shed.shed).toBe(true);
    expect(shed.reason).toBe('queue_full');
    expect(shed.attempts).toBe(0);

    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(releaseFirst).not.toBeNull();
    releaseFirst!();

    // The critical and normal writes still land.
    expect((await critical).ok).toBe(true);
    expect((await normal).ok).toBe(true);
  });
});
