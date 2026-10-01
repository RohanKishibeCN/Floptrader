/**
 * The continuous reader: the fixed rooms are read by their own loops, not by the
 * agent scheduler's tick.
 *
 * The throughput problem this pins is exact. `close1` grows faster than one
 * `limit`-sized page per 60-second tick, so a tick-driven reader crosses a whole
 * unread range on every page boundary and records it as a real cursor gap. The
 * fix is structural, not a smaller tick: each of the six fixed rooms gets its own
 * long-lived loop that re-reads the instant its previous read returns, bounded by
 * `READ_CONCURRENCY` and by the client's `MAX_INFLIGHT`.
 *
 * What must stay true while that happens: one request per room at a time, a
 * bounded number of sockets, a saturated page reported as backlog (never as a
 * gap), a real loss still recorded as a gap, and a shutdown that aborts every
 * in-flight long poll instead of waiting them out.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { RefereeVerifier, RoomReader, TechnocoreClient } from '@flop/technocore';
import { referenceRules } from '@flop/close-call';
import {
  closeDatabase,
  createRepositories,
  openDatabase,
  type Repositories,
  type SqliteDatabase,
} from '@flop/storage';
import { Logger } from '../apps/orchestrator/src/logger.js';
import { FakeTransport } from './support/fake-transport.js';
import { generateAgents, waitFor } from './support/harness.js';

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

/** Reads in flight, per room and in total, so "bounded sockets" is measurable. */
function countingFetch(base: typeof fetch): {
  fetch: typeof fetch;
  highWater: () => number;
  perRoomHighWater: () => number;
  reset: () => void;
} {
  let active = 0;
  let highWater = 0;
  let perRoomHighWater = 0;
  const perRoom = new Map<string, number>();
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const room = decodeURIComponent(/\/r\/([^/?]+)/.exec(url)?.[1] ?? '');
    active += 1;
    highWater = Math.max(highWater, active);
    const roomActive = (perRoom.get(room) ?? 0) + 1;
    perRoom.set(room, roomActive);
    perRoomHighWater = Math.max(perRoomHighWater, roomActive);
    try {
      return await base(input, init);
    } finally {
      active -= 1;
      perRoom.set(room, roomActive - 1);
    }
  };
  return {
    fetch: fetchImpl,
    highWater: () => highWater,
    perRoomHighWater: () => perRoomHighWater,
    reset: () => {
      highWater = 0;
      perRoomHighWater = 0;
    },
  };
}

describe('RoomReader continuous mode', () => {
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
    options: {
      readConcurrency?: number;
      maxInflight?: number;
      fetchImpl?: typeof fetch;
      limit?: number;
    } = {},
  ): RoomReader {
    const client = new TechnocoreClient({
      baseUrl: BASE,
      fetchImpl: options.fetchImpl ?? transport.fetchImpl,
      ...(options.maxInflight === undefined ? {} : { maxInflight: options.maxInflight }),
    });
    const verifier = new RefereeVerifier({
      rules: referenceRules(),
      logger: silent,
      expectedRefereeDid: referee.did,
    });
    return new RoomReader({
      client,
      db,
      repositories,
      verifier,
      logger: silent,
      rooms: ROOMS,
      readConcurrency: options.readConcurrency ?? 2,
      // The long poll of a real deployment. The double does not hold it, which is
      // the point: the reader's pacing comes from the reply, not from the wait.
      waitSeconds: 10,
      limit: options.limit ?? 200,
      retryDelayMs: 5,
      now: () => new Date('2026-09-28T08:40:00Z'),
    });
  }

  it('reads all six fixed rooms continuously, with no scheduler tick', async () => {
    const transport = new FakeTransport({ readDelayMs: 1 });
    for (const room of ROOMS) transport.enqueue(room, { text: 'hello' });
    const reader = makeReader(transport, { readConcurrency: 6 });

    reader.startContinuous();
    await waitFor(
      () => ROOMS.every((room) => reader.throughputStats().lastSuccessByRoom[room] !== undefined),
      'a first pass over all six rooms',
    );
    // A second pass over every room is the proof it does not wait for a tick.
    await waitFor(
      () => reader.throughputStats().completedReads >= ROOMS.length * 2,
      'a second pass',
    );

    const stats = reader.throughputStats();
    expect(stats.continuousMode).toBe(true);
    expect(stats.running).toBe(true);
    expect(stats.fixedRoomCount).toBe(6);
    expect(reader.tickCount).toBe(0); // tick() was never the driver
    expect(stats.completedReads).toBeGreaterThanOrEqual(ROOMS.length * 2);
    expect(stats.readsPerMinute).toBeGreaterThan(0);

    await reader.stopContinuous();
    expect(reader.continuousMode).toBe(false);
    expect(reader.throughputStats().running).toBe(false);
  });

  it('keeps one request per room and never exceeds READ_CONCURRENCY in flight', async () => {
    const transport = new FakeTransport({ readDelayMs: 2 });
    const counter = countingFetch(transport.fetchImpl);
    const reader = makeReader(transport, { readConcurrency: 2, fetchImpl: counter.fetch });

    reader.startContinuous();
    await waitFor(() => counter.highWater() >= 2, 'two reads in flight at once');
    await waitFor(() => transport.requestCount() >= ROOMS.length * 2, 'a full second pass');
    await reader.stopContinuous();

    // The invariant that makes "one long poll per room" true: a room's next read
    // cannot start until its previous one has returned.
    expect(counter.perRoomHighWater()).toBe(1);
    expect(counter.highWater()).toBeLessThanOrEqual(2);
    // And the cap is genuinely used, so a serialising regression cannot hide.
    expect(counter.highWater()).toBe(2);
  });

  it('still caps the process at MAX_INFLIGHT when READ_CONCURRENCY is higher', async () => {
    const transport = new FakeTransport({ readDelayMs: 2 });
    const counter = countingFetch(transport.fetchImpl);
    const reader = makeReader(transport, {
      readConcurrency: 6,
      maxInflight: 2,
      fetchImpl: counter.fetch,
    });

    reader.startContinuous();
    await waitFor(() => transport.requestCount() >= ROOMS.length * 2, 'a full second pass');
    await reader.stopContinuous();

    // Six room loops, two sockets: the client's cap is the real bound.
    expect(counter.highWater()).toBeLessThanOrEqual(2);
  });

  it('drains a room that outruns one page by re-reading immediately', async () => {
    const transport = new FakeTransport();
    // 500 messages is two full pages of 200 plus a short one: a tick-driven
    // reader would see every page boundary as a gap.
    for (let seq = 1; seq <= 500; seq += 1) transport.enqueue('close1', { seq, text: `m${seq}` });
    const reader = makeReader(transport, { readConcurrency: 6, limit: 200 });

    reader.startContinuous();
    await waitFor(
      () => repositories.roomCursors.get('close1')?.cursor === 500,
      'the reader to drain all 500 messages',
    );
    await reader.stopContinuous();

    // Three consecutive reads, and no gap: the cursor walked the retained range
    // without skipping any of it.
    expect(transport.requestCount('close1')).toBeGreaterThanOrEqual(3);
    expect(reader.gaps().rooms).not.toContain('close1');
    expect(reader.gaps().total).toBe(0);
    expect(reader.throughputStats().returnedPerMinute).toBeGreaterThanOrEqual(500);
  });

  it('reports a sustained page as backlog, and a backlog is not a gap', async () => {
    const transport = new FakeTransport();
    // A thousand messages keeps consecutive pages saturated while the reader
    // works through them, which is what "the reader is behind but catching up"
    // looks like.
    for (let seq = 1; seq <= 1_000; seq += 1) transport.enqueue('close1', { seq, text: `m${seq}` });
    const reader = makeReader(transport, { readConcurrency: 6, limit: 200 });

    reader.startContinuous();
    await waitFor(() => reader.throughputStats().backlogObserved, 'a saturated page');

    // A saturated page says there is more waiting. It never says messages were
    // lost, and it must never be dressed up as cleared — the cursor is real.
    expect(reader.gaps().total).toBe(0);
    expect(reader.gaps().rooms).not.toContain('close1');
    await reader.stopContinuous();
  });

  it('records a real loss as a cursor gap, and a later contiguous read as a resume — not a recovery', async () => {
    const transport = new FakeTransport({ readDelayMs: 2 });
    for (let seq = 1; seq <= 3; seq += 1) transport.enqueue('close1', { seq, text: `m${seq}` });
    const reader = makeReader(transport, { readConcurrency: 6, limit: 200 });

    reader.startContinuous();
    await waitFor(() => repositories.roomCursors.get('close1')?.cursor === 3, 'the first three');

    // The ring drops 4 and 5 before the reader gets back to the room.
    for (let seq = 4; seq <= 8; seq += 1) transport.enqueue('close1', { seq, text: `m${seq}` });
    transport.room('close1').firstSeqRetained = 6;

    await waitFor(() => reader.gaps().rooms.includes('close1'), 'the gap to be recorded');
    const row = repositories.roomCursors.get('close1')!;
    expect(row.bootstrap_state).toBe('cursor_gap');
    expect(row.gap_count).toBe(1);
    expect(row.last_gap_from).toBe(4);
    expect(row.last_gap_to).toBe(5);
    expect(reader.throughputStats().contiguousResumeCount).toBe(0);
    expect(reader.throughputStats().gapRecoveryCount).toBe(0);
    // The gap is open, and that is its own field: this is the fact that
    // `backlogObserved`/`pageSaturated` was never able to express.
    expect(reader.throughputStats().unresolvedGap).toBe(true);
    expect(reader.throughputStats().unresolvedGapRooms).toContain('close1');

    // A contiguous page afterwards is the evidence the reader is back inside the
    // window. The historical gap is not cleared and the room is not declared
    // level; only the resume is recorded.
    transport.enqueue('close1', { seq: 9, text: 'm9' });
    transport.enqueue('close1', { seq: 10, text: 'm10' });
    await waitFor(
      () => reader.throughputStats().contiguousResumeCount === 1,
      'the contiguous resume to be recorded',
    );
    expect(reader.gaps().rooms).toContain('close1');
    expect(reader.gaps().total).toBe(2);

    await reader.stopContinuous();
  });

  it('aborts every in-flight long poll on stop, without recording a read error', async () => {
    const transport = new FakeTransport();
    const HOLD_MS = 30_000;
    // A double whose GET is held open and rejects when its signal aborts — the
    // same shape a real long poll has, and the reason a shutdown must abort.
    const holding: typeof fetch = (input, init) =>
      new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          void transport.fetchImpl(input, init).then(resolve, reject);
        }, HOLD_MS);
        init?.signal?.addEventListener(
          'abort',
          () => {
            clearTimeout(timer);
            reject(new Error('aborted by stop'));
          },
          { once: true },
        );
      });
    const reader = makeReader(transport, { readConcurrency: 6, fetchImpl: holding });

    reader.startContinuous();
    await waitFor(() => reader.throughputStats().activeRequests > 0, 'a long poll in flight');

    const startedAt = Date.now();
    await reader.stopContinuous();
    const elapsed = Date.now() - startedAt;

    // Aborted, not waited out: a systemd `TimeoutStopSec` must never be reached.
    expect(elapsed).toBeLessThan(2_000);
    expect(reader.continuousMode).toBe(false);
    expect(reader.throughputStats().activeRequests).toBe(0);
    // A shutdown is not a failure: an aborted read must not inflate the error
    // streak or trip conservative mode on the way out.
    expect(reader.throughputStats().failedReads).toBe(0);
    expect(reader.throughputStats().lastError).toBeNull();
    expect(reader.health().healthy).toBe(true);
  });
});
