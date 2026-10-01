/**
 * Backlog accounting: is the reader actually keeping up with `close1`, and does
 * it say so truthfully?
 *
 * The measurement this file pins is the one the old metrics could not express.
 * `messagesRead` counts what we *consumed*; a room producing 900 messages a
 * minute and one producing 300 look identical through it, so a reader being left
 * behind looked exactly like a reader keeping up. The producer figure therefore
 * comes from the room's own retained `last_seq`, the consumer figure from the
 * cursor we actually advanced, and "we are losing ground" is the difference
 * across whole sealed windows — never a request count multiplied by a page size.
 *
 * Nothing here is asserted into existence. The double produces a known number of
 * messages on every read of the trading room and the clock is scaled so that one
 * real second is one measured minute, which makes both rates computable in a test
 * that still finishes in seconds.
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
const TRADING = 'close1';
const ROOMS = [
  'd-close1-price',
  'd-close1-flow',
  'd-close1-state',
  'd-close1-positions',
  'd-close1-pnl',
  TRADING,
];
const referee = generateAgents(1)[0]!;

/**
 * One real second is one measured minute.
 *
 * The reader's windows are 60 seconds wide by design, so a test that wants to
 * observe a sealed window without waiting a minute for one has to scale the
 * clock. The loops' own pacing comes from the double's read hold, so scaling the
 * clock changes only what the *measurement* sees and never how the reader behaves.
 */
const TIME_SCALE = 60;

function scaledClock(): () => Date {
  const realStart = Date.now();
  const start = Date.UTC(2026, 8, 28, 8, 40, 0);
  return () => new Date(start + (Date.now() - realStart) * TIME_SCALE);
}

/**
 * Make a room grow by `producePerRead` messages on every read of it.
 *
 * The producer is then a deterministic function of the read count: the room's
 * `last_seq` moves by `producePerRead` per read while the cursor moves by however
 * many messages the page actually carried. Choosing those two numbers is how a
 * test states "the producer outruns the consumer" or "the reader keeps up".
 */
function produceOnRead(transport: FakeTransport, room: string, producePerRead: number): void {
  const base = transport.fetchImpl;
  transport.fetchImpl = async (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const method = (init?.method ?? 'GET').toUpperCase();
    const hit = decodeURIComponent(/\/r\/([^/?]+)/.exec(url)?.[1] ?? '');
    if (method === 'GET' && hit === room) {
      for (let index = 0; index < producePerRead; index += 1) {
        transport.enqueue(room, { text: `produced-${transport.room(room).messages.length}` });
      }
    }
    return base(input, init);
  };
}

describe('reader backlog accounting', () => {
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
      rooms?: string[];
      limit?: number;
      readConcurrency?: number;
      catchupMaxRequestsPerSecond?: number;
      fairnessMaxSilenceMs?: number;
    } = {},
  ): RoomReader {
    const client = new TechnocoreClient({ baseUrl: BASE, fetchImpl: transport.fetchImpl });
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
      rooms: options.rooms ?? ROOMS,
      readConcurrency: options.readConcurrency ?? 6,
      waitSeconds: 10,
      limit: options.limit ?? 50,
      retryDelayMs: 5,
      ...(options.catchupMaxRequestsPerSecond === undefined
        ? {}
        : { catchingUpMaxRequestsPerSecond: options.catchupMaxRequestsPerSecond }),
      ...(options.fairnessMaxSilenceMs === undefined
        ? {}
        : { fairnessMaxSilenceMs: options.fairnessMaxSilenceMs }),
      now: scaledClock(),
    });
  }

  function tradingRoom(reader: RoomReader) {
    return reader.throughputStats().rooms.find((row) => row.room === TRADING)!;
  }

  it('reports a reader that keeps up as fully caught up, with no widening backlog', async () => {
    const transport = new FakeTransport({ readDelayMs: 20 });
    // One message per read against a page far larger than one: the reader drains
    // everything the room produces, so the two rates have to match and the net
    // has to be zero — not "positive but small".
    produceOnRead(transport, TRADING, 1);
    const reader = makeReader(transport, { limit: 50 });

    reader.startContinuous();
    // A rate is only published once a whole window supports it, so the wait is
    // for a sealed window, not merely for the mode.
    await waitFor(
      () => {
        const row = tradingRoom(reader);
        return reader.throughputStats().fullyCaughtUp && row.producerRate > 0 && row.persistedRate > 0;
      },
      'a sealed window on a reader that is level',
      20_000,
    );

    const stats = reader.throughputStats();
    const trading = tradingRoom(reader);
    expect(stats.netBacklogIncreasing).toBe(false);
    expect(stats.catchupState).toBe('fully_caught_up');
    expect(stats.unresolvedGap).toBe(false);
    expect(trading.producerRate).toBeGreaterThan(0);
    expect(trading.persistedRate).toBeGreaterThan(0);
    expect(trading.netPersistBacklogRate).toBeLessThanOrEqual(0);
    expect(trading.pageSaturated).toBe(false);
    expect(trading.mode).toBe('fully_caught_up');

    await reader.stopContinuous();
  });

  it('reports a widening backlog as netBacklogIncreasing and an unattainable catch-up', async () => {
    const LIMIT = 50;
    const transport = new FakeTransport({ readDelayMs: 20 });
    // More produced per read than one page can carry: at this page size the room
    // grows faster than the reader can store it. This is the real `close1`
    // situation, and the report has to name it instead of "catching up".
    produceOnRead(transport, TRADING, LIMIT + 20);
    const reader = makeReader(transport, { limit: LIMIT });

    reader.startContinuous();
    await waitFor(
      () => tradingRoom(reader).positiveBacklogWindows >= 2,
      'two consecutive widening windows',
      20_000,
    );

    const stats = reader.throughputStats();
    const trading = tradingRoom(reader);
    expect(trading.producerRate).toBeGreaterThan(trading.persistedRate);
    expect(trading.netPersistBacklogRate).toBeGreaterThan(0);
    expect(trading.pageSaturated).toBe(true);
    expect(trading.mode).toBe('unattainable');
    expect(stats.netBacklogIncreasing).toBe(true);
    expect(stats.catchupState).toBe('unattainable');
    expect(stats.unattainableRooms).toContain(TRADING);
    expect(stats.estimatedProducerRate).toBeGreaterThan(stats.estimatedPersistedRate);

    await reader.stopContinuous();
  });

  it('never calls a saturated room recovered, however many contiguous pages it reads', async () => {
    const transport = new FakeTransport({ readDelayMs: 20 });
    const reader = makeReader(transport, { limit: 20 });

    for (let seq = 1; seq <= 3; seq += 1) transport.enqueue(TRADING, { seq, text: `m${seq}` });
    reader.startContinuous();
    await waitFor(() => repositories.roomCursors.get(TRADING)?.cursor === 3, 'the first three');

    // The ring drops 4 and 5 before the reader gets back to the room, and the
    // room keeps producing so every page after the gap is full.
    transport.room(TRADING).firstSeqRetained = 6;
    for (let seq = 4; seq <= 400; seq += 1) transport.enqueue(TRADING, { seq, text: `m${seq}` });

    await waitFor(() => reader.throughputStats().contiguousResumeCount >= 1, 'the contiguous resume');
    const stats = reader.throughputStats();
    const trading = tradingRoom(reader);

    // The resume is recorded as exactly that. The pages are still full, so the
    // room is behind: it must not be reported as recovered. Claiming "caught up
    // again" from the resume alone is the failure this separation exists for.
    expect(stats.gapRecoveryCount).toBe(0);
    expect(stats.unresolvedGap).toBe(true);
    expect(stats.unresolvedGapRooms).toContain(TRADING);
    expect(trading.pageSaturated).toBe(true);
    expect(trading.mode).toBe('catching_up');
    expect(reader.health().healthy).toBe(false);

    await reader.stopContinuous();
  });

  it('closes a gap only once the room is level, and re-opens it on the next loss', async () => {
    const transport = new FakeTransport({ readDelayMs: 20 });
    const reader = makeReader(transport, { limit: 20 });

    for (let seq = 1; seq <= 3; seq += 1) transport.enqueue(TRADING, { seq, text: `m${seq}` });
    reader.startContinuous();
    await waitFor(() => repositories.roomCursors.get(TRADING)?.cursor === 3, 'the first three');

    transport.room(TRADING).firstSeqRetained = 6;
    for (let seq = 4; seq <= 8; seq += 1) transport.enqueue(TRADING, { seq, text: `m${seq}` });
    await waitFor(() => reader.gaps().rooms.includes(TRADING), 'the gap to be recorded');
    expect(reader.throughputStats().unresolvedGap).toBe(true);

    // One more contiguous message, then quiet: short pages and a cursor at the
    // retained head, twice over. Only then is the recovery recorded.
    transport.enqueue(TRADING, { seq: 9, text: 'm9' });
    await waitFor(() => reader.throughputStats().gapRecoveryCount === 1, 'the full recovery', 20_000);
    expect(reader.throughputStats().unresolvedGap).toBe(false);
    expect(reader.throughputStats().unresolvedGapRooms).not.toContain(TRADING);

    // A second loss re-opens the room. The counters are not retroactive: the
    // resume count is about the new gap while the recovery count stays put.
    const resumed = repositories.roomCursors.get(TRADING)!.cursor;
    transport.room(TRADING).firstSeqRetained = resumed + 3;
    for (let seq = resumed + 1; seq <= resumed + 5; seq += 1) {
      transport.enqueue(TRADING, { seq, text: `n${seq}` });
    }
    await waitFor(() => reader.throughputStats().unresolvedGap, 'the second loss');
    expect(reader.throughputStats().gapRecoveryCount).toBe(1);
    expect(reader.throughputStats().contiguousResumeCount).toBeGreaterThanOrEqual(1);

    await reader.stopContinuous();
  });

  it('stays unhealthy with an unresolved gap even when the latest page was short', async () => {
    const transport = new FakeTransport({ readDelayMs: 20 });
    const reader = makeReader(transport, { limit: 200 });

    for (let seq = 1; seq <= 3; seq += 1) transport.enqueue(TRADING, { seq, text: `m${seq}` });
    reader.startContinuous();
    await waitFor(() => repositories.roomCursors.get(TRADING)?.cursor === 3, 'the first three');

    transport.room(TRADING).firstSeqRetained = 6;
    for (let seq = 4; seq <= 8; seq += 1) transport.enqueue(TRADING, { seq, text: `m${seq}` });
    await waitFor(() => reader.gaps().rooms.includes(TRADING), 'the gap to be recorded');
    // Let the reader drain the remainder, so the latest page is a short one and
    // the room is genuinely quiet — exactly the shape that used to read as
    // "backlogObserved=false, therefore fine".
    await waitFor(
      () => reader.throughputStats().lastReturnedCountByRoom[TRADING] === 0,
      'the room to go quiet',
    );

    const stats = reader.throughputStats();
    expect(tradingRoom(reader).pageSaturated).toBe(false);
    expect(stats.pageSaturated).toBe(false);
    expect(stats.unresolvedGap).toBe(true);
    expect(stats.unresolvedGapRooms).toContain(TRADING);
    expect(reader.health().healthy).toBe(false);

    await reader.stopContinuous();
  });

  it('keeps reading every referee room while the trading room is saturated', async () => {
    const transport = new FakeTransport({ readDelayMs: 15 });
    // The trading room always has more than a page waiting, so it is never idle.
    // A reader that let the busy room spend the whole budget would stop reading
    // the five empty referee rooms, which is the starvation this pins.
    produceOnRead(transport, TRADING, 120);
    const reader = makeReader(transport, {
      limit: 50,
      catchupMaxRequestsPerSecond: 20,
      // Half a real second at the scaled clock: a room unread for longer than
      // this is starving, and the reader has to say so.
      fairnessMaxSilenceMs: 30_000,
    });

    reader.startContinuous();
    await waitFor(
      () => ROOMS.every((room) => reader.throughputStats().lastSuccessByRoom[room] !== undefined),
      'a first read of every fixed room',
      15_000,
    );
    await new Promise((resolve) => setTimeout(resolve, 1_500));

    const stats = reader.throughputStats();
    expect(stats.modeByRoom[TRADING]).toBe('catching_up');
    // Nothing starved, and no fairness warning was raised for any fixed room.
    expect(stats.silentRooms).toEqual([]);
    for (const room of ROOMS) expect(stats.lastSuccessByRoom[room]).toBeDefined();

    await reader.stopContinuous();
  });

  it('never advances the cursor on a failed read', async () => {
    const transport = new FakeTransport({ readDelayMs: 5 });
    for (let seq = 1; seq <= 5; seq += 1) transport.enqueue(TRADING, { seq, text: `m${seq}` });
    const reader = makeReader(transport, { rooms: [TRADING] });

    transport.failNext(500, 8);
    reader.startContinuous();
    await waitFor(() => reader.throughputStats().failedReads >= 1, 'a failed read');
    expect(repositories.roomCursors.get(TRADING)?.cursor ?? 0).toBe(0);
    expect(reader.throughputStats().lastError).not.toBeNull();

    // Only a read that actually returned may move the cursor.
    await waitFor(() => (repositories.roomCursors.get(TRADING)?.cursor ?? 0) === 5, 'the cursor to advance');
    await reader.stopContinuous();
  });
});

describe('the page-size ceiling', () => {
  it('never asks for a page the service would refuse, however the caller asks', async () => {
    const transport = new FakeTransport();
    const client = new TechnocoreClient({ baseUrl: BASE, fetchImpl: transport.fetchImpl });

    await client.readRoom(TRADING, { limit: 1_000 });
    expect(new URL(transport.requests[0]!.url).searchParams.get('limit')).toBe('200');

    // The documented protocol maximum is the hard ceiling, and a client-side
    // config change is not evidence: `TECHNOCORE_SERVER_LIMIT=500` does not make
    // the service serve 500, and a `limit` it refused would turn every read into
    // a 400. Only a real server response could justify raising this.
    const wider = new TechnocoreClient({
      baseUrl: BASE,
      fetchImpl: transport.fetchImpl,
      serverLimit: 500,
    });
    expect(wider.limitCeiling).toBe(200);
    await wider.readRoom(TRADING, { limit: 2_000 });
    expect(new URL(transport.requests[1]!.url).searchParams.get('limit')).toBe('200');
  });
});
