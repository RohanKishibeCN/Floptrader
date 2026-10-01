/**
 * close1 catch-up: the reader must be able to drain a room that grows faster
 * than one page, without starving the referee rooms and without inventing
 * success.
 *
 * The shape of the problem is fixed by the service: a read returns at most
 * `limit` messages (200), a long poll holds for `wait=10` seconds, and a room
 * retains a bounded window. So "keeping up" means one thing only — re-reading
 * the moment a page returns until the room is short — and "falling behind" means
 * one thing only — the retained window moved past the cursor and the missing
 * range is recorded as a real gap.
 *
 * These tests pin the throughput, the fairness (a saturated `close1` may never
 * starve the five referee rooms), the bounds (one request per room, no more than
 * `READ_CONCURRENCY` and `MAX_INFLIGHT` in flight, no unbounded growth), and the
 * gap lifecycle: recorded, resolved on evidence, never cleared.
 */
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { RefereeVerifier, RoomReader, SqliteCursorStore, TechnocoreClient } from '@flop/technocore';
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
import { buildHarness, type Harness } from './support/orchestrator.js';
import { cleanup, generateAgents, tempDir, waitFor } from './support/harness.js';

const BASE = 'http://technocore.test';
const silent = Logger.create({ level: 'fatal' });
const REFEREE_ROOMS = ['d-close1-price', 'd-close1-flow', 'd-close1-state', 'd-close1-positions', 'd-close1-pnl'];
const ROOMS = [...REFEREE_ROOMS, 'close1'];
const referee = generateAgents(1)[0]!;
/** The service's own clamp, restated so a regression here is visible. */
const SERVER_LIMIT = 200;

function makeReader(
  db: SqliteDatabase,
  repositories: Repositories,
  transport: FakeTransport,
  options: { readConcurrency?: number; maxInflight?: number; limit?: number } = {},
): RoomReader {
  const client = new TechnocoreClient({
    baseUrl: BASE,
    fetchImpl: transport.fetchImpl,
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
    readConcurrency: options.readConcurrency ?? 6,
    waitSeconds: 10,
    limit: options.limit ?? SERVER_LIMIT,
    retryDelayMs: 5,
    now: () => new Date('2026-09-28T08:40:00Z'),
  });
}

/** Every requested `limit` clause the reader actually put on the wire. */
function requestedLimits(transport: FakeTransport): number[] {
  return transport.requests
    .map((request) => /[?&]limit=(\d+)/.exec(request.url)?.[1])
    .filter((value): value is string => value !== undefined)
    .map((value) => Number.parseInt(value, 10));
}

describe('close1 catch-up', () => {
  let db: SqliteDatabase;
  let repositories: Repositories;

  beforeEach(() => {
    db = openDatabase({ path: ':memory:' });
    repositories = createRepositories(db);
  });

  afterEach(() => {
    closeDatabase(db);
  });

  it('drains a burst well over one page, one 200-message page at a time', async () => {
    const transport = new FakeTransport();
    // 1200 messages: six pages. A tick-driven reader would record a gap at every
    // page boundary; a catching-up reader reads them back to back.
    for (let seq = 1; seq <= 1_200; seq += 1) transport.enqueue('close1', { seq, text: `m${seq}` });
    const reader = makeReader(db, repositories, transport, { readConcurrency: 6 });

    reader.startContinuous();
    await waitFor(
      () => repositories.roomCursors.get('close1')?.cursor === 1_200,
      'the reader to drain all 1200 messages',
    );
    await reader.stopContinuous();

    // Six consecutive pages (200 x 6), never more than the service's clamp.
    expect(transport.requestCount('close1')).toBeGreaterThanOrEqual(6);
    for (const limit of requestedLimits(transport)) expect(limit).toBeLessThanOrEqual(SERVER_LIMIT);

    const stats = reader.throughputStats();
    // Measured on the reader's own rolling window: this is the throughput that
    // decides whether the deployed process can keep up.
    expect(stats.returnedPerMinute).toBeGreaterThanOrEqual(1_200);
    expect(stats.cursorAdvancesPerMinute).toBeGreaterThanOrEqual(6);
    expect(stats.cursorAdvances).toBeGreaterThanOrEqual(6);

    // Catching up is not a gap: the cursor walked the whole retained range.
    expect(reader.gaps().rooms).not.toContain('close1');
    expect(reader.gaps().unresolved).not.toContain('close1');
  });

  it('keeps reading the referee rooms while close1 catches up', async () => {
    const transport = new FakeTransport({ readDelayMs: 1 });
    for (let seq = 1; seq <= 1_200; seq += 1) transport.enqueue('close1', { seq, text: `m${seq}` });
    for (const room of REFEREE_ROOMS) transport.enqueue(room, { text: 'referee' });
    // Deliberately fewer slots than rooms: six loops must share two, which is
    // exactly the situation in which a busy room could starve the others.
    const reader = makeReader(db, repositories, transport, { readConcurrency: 2 });

    reader.startContinuous();
    await waitFor(
      () => repositories.roomCursors.get('close1')?.cursor === 1_200,
      'the reader to drain all 1200 messages',
    );
    await reader.stopContinuous();

    // The five referee rooms were read repeatedly during the same window, not
    // once at the start and then ignored.
    for (const room of REFEREE_ROOMS) {
      expect(transport.requestCount(room)).toBeGreaterThanOrEqual(2);
      expect(reader.throughputStats().lastSuccessByRoom[room]).toBeDefined();
    }
    // And the drain really did happen under contention.
    expect(transport.requestCount('close1')).toBeGreaterThanOrEqual(6);
  });

  it('stays inside its concurrency and MAX_INFLIGHT bounds while draining', async () => {
    const transport = new FakeTransport({ readDelayMs: 1 });
    for (let seq = 1; seq <= 1_200; seq += 1) transport.enqueue('close1', { seq, text: `m${seq}` });

    let active = 0;
    let highWater = 0;
    const base = transport.fetchImpl;
    const counting: typeof fetch = async (input, init) => {
      active += 1;
      highWater = Math.max(highWater, active);
      try {
        return await base(input, init);
      } finally {
        active -= 1;
      }
    };
    const client = new TechnocoreClient({ baseUrl: BASE, fetchImpl: counting, maxInflight: 4 });
    const verifier = new RefereeVerifier({ rules: referenceRules(), logger: silent, expectedRefereeDid: referee.did });
    const reader = new RoomReader({
      client,
      db,
      repositories,
      verifier,
      logger: silent,
      rooms: ROOMS,
      readConcurrency: 6,
      waitSeconds: 10,
      limit: SERVER_LIMIT,
      retryDelayMs: 5,
      now: () => new Date('2026-09-28T08:40:00Z'),
    });

    reader.startContinuous();
    await waitFor(
      () => repositories.roomCursors.get('close1')?.cursor === 1_200,
      'the reader to drain all 1200 messages',
    );
    await reader.stopContinuous();

    expect(highWater).toBeLessThanOrEqual(4); // MAX_INFLIGHT
    expect(reader.throughputStats().activeRequests).toBe(0);
    expect(client.stats().inflight).toBe(0); // no waiter or socket left behind
  });

  it('reports a permanently saturated room as backlog, never as success', async () => {
    const transport = new FakeTransport({ readDelayMs: 1 });
    const reader = makeReader(db, repositories, transport, { readConcurrency: 6 });
    reader.startContinuous();
    await waitFor(() => reader.throughputStats().lastSuccessByRoom['close1'] !== undefined, 'a first read');

    // The room keeps growing faster than the reader can page it: every read comes
    // back saturated. The honest signal is backlog — not "caught up", and not a
    // fabricated gap either, because no retained range was skipped.
    for (let seq = 1; seq <= 2_000; seq += 1) transport.enqueue('close1', { seq, text: `m${seq}` });
    // The fact is about `close1`, so it is read from `close1`'s own row. The
    // reader-wide flag only ever describes whichever room read last, which with
    // six loops says nothing about any particular one.
    const saturated = () =>
      reader.throughputStats().rooms.find((row) => row.room === 'close1')?.pageSaturated === true;
    await waitFor(saturated, 'the saturated page to be reported');
    expect(reader.throughputStats().modeByRoom['close1']).toBe('catching_up');
    expect(reader.gaps().unresolved).not.toContain('close1');

    await reader.stopContinuous();
  });

  it('resolves a gap only on evidence, and never clears the recorded loss', async () => {
    const transport = new FakeTransport({ readDelayMs: 1 });
    for (let seq = 1; seq <= 3; seq += 1) transport.enqueue('close1', { seq, text: `m${seq}` });
    const reader = makeReader(db, repositories, transport, { readConcurrency: 6 });

    reader.startContinuous();
    await waitFor(() => repositories.roomCursors.get('close1')?.cursor === 3, 'the first three');

    // The ring drops 4 and 5 before the reader returns to the room.
    for (let seq = 4; seq <= 8; seq += 1) transport.enqueue('close1', { seq, text: `m${seq}` });
    transport.room('close1').firstSeqRetained = 6;
    await waitFor(() => reader.gaps().unresolved.includes('close1'), 'the gap to be recorded');

    const row = repositories.roomCursors.get('close1')!;
    expect(row.gap_resolved_at).toBeNull();
    expect(row.last_gap_from).toBe(4);
    expect(row.last_gap_to).toBe(5);

    // A contiguous page past the missed range is the only thing that closes it.
    transport.enqueue('close1', { seq: 9, text: 'm9' });
    transport.enqueue('close1', { seq: 10, text: 'm10' });
    await waitFor(() => reader.gaps().recovered.includes('close1'), 'the gap to be resolved');

    const gaps = reader.gaps();
    expect(gaps.unresolved).not.toContain('close1');
    // The loss is still on the record, with its range — resolved is not cleared.
    expect(gaps.rooms).toContain('close1');
    expect(gaps.total).toBe(2);
    expect(repositories.roomCursors.get('close1')!.last_resolved_gap_to).toBe(5);

    await reader.stopContinuous();
  });
});

describe('close1 catch-up, in a whole runtime', () => {
  let dir: string;
  let harness: Harness | null = null;

  beforeEach(() => {
    dir = tempDir('flop-catchup-');
  });

  afterEach(async () => {
    if (harness) await harness.dispose();
    harness = null;
    cleanup(dir);
  });

  it('keeps the writer queue empty and the reader metrics visible while draining', async () => {
    const transport = new FakeTransport({ readDelayMs: 1 });
    harness = await buildHarness({ agentCount: 6, dir, transport });
    const h = harness;
    for (let seq = 1; seq <= 1_200; seq += 1) transport.enqueue('close1', { seq, text: `m${seq}` });

    h.runtime.reader.startContinuous();
    await waitFor(
      () => h.runtime.repositories.roomCursors.get('close1')?.cursor === 1_200,
      'the runtime reader to drain all 1200 messages',
    );
    await h.runtime.scheduler.runTick();

    const status = h.runtime.scheduler.status();
    // The reader writes synchronously inside its own transaction, so a burst of
    // reads must never build a backlog in the writer's queue.
    expect(h.runtime.writer.depth).toBe(0);
    expect(status.reader.returnedPerMinute).toBeGreaterThanOrEqual(1_200);
    expect(status.reader.cursorAdvancesPerMinute).toBeGreaterThanOrEqual(6);
    expect(status.reader.gaps.unresolved).not.toContain('close1');
    // A dry run with no seed is still not ready: catching up does not arm live.
    expect(status.readiness.refereeFeedReady).toBe(false);

    await h.runtime.reader.stopContinuous();
  });

  it('keeps a resolved gap resolved across a restart', async () => {
    const transport = new FakeTransport({ readDelayMs: 1 });
    const cursorPath = () => join(dir, 'data', 'app.db');

    // First process: create a gap, then resolve it with a contiguous read.
    harness = await buildHarness({ agentCount: 6, dir, transport });
    const first = harness;
    for (let seq = 1; seq <= 3; seq += 1) transport.enqueue('close1', { seq, text: `m${seq}` });
    first.runtime.reader.startContinuous();
    await waitFor(
      () => first.runtime.repositories.roomCursors.get('close1')?.cursor === 3,
      'the first three messages',
    );
    for (let seq = 4; seq <= 8; seq += 1) transport.enqueue('close1', { seq, text: `m${seq}` });
    transport.room('close1').firstSeqRetained = 6;
    await waitFor(
      () => first.runtime.reader.gaps().unresolved.includes('close1'),
      'the gap to be recorded',
    );
    transport.enqueue('close1', { seq: 9, text: 'm9' });
    transport.enqueue('close1', { seq: 10, text: 'm10' });
    await waitFor(
      () => first.runtime.reader.gaps().recovered.includes('close1'),
      'the gap to be resolved',
    );
    // Stop and close by hand rather than through `dispose()`: dispose deletes the
    // data directory, and this test exists to read it back.
    await first.runtime.stop();
    first.runtime.db.close();
    harness = null;

    // Second process over the same files: the resolution is durable, so a restart
    // cannot turn a caught-up room back into an unresolved one.
    const reopened = openDatabase({ path: cursorPath() });
    expect(reopened.pragma('user_version', { simple: true })).toBe(8);
    const store = new SqliteCursorStore({ db: reopened, repositories: createRepositories(reopened) });
    const row = store.load('close1');
    expect(row.gapCount).toBe(1);
    expect(row.gapResolvedAt).not.toBeNull();
    expect(row.lastResolvedGapTo).toBe(5);
    expect(row.gap).toBe(2);
    closeDatabase(reopened);
  });
});
