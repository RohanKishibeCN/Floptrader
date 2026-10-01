/**
 * Cache-safe polling, truthful accounting, and export-assisted recovery.
 *
 * Three claims are pinned here, and each of them is a way the reader could lie
 * about its own health without ever failing:
 *
 *   - **A reply is never a reply to an earlier request.** The service's own
 *     manual warns that an unchanged URL "often returns cached bytes", so every
 *     read carries a cursor *and* a throwaway counter. A page that is served
 *     twice must be recognised as the same page, not as two pages of progress.
 *   - **Returned is not persisted.** A re-read returns the same messages and
 *     stores none of them, and a gap moves the cursor over a range nobody ever
 *     stored. Only rows that reached SQLite are consumption.
 *   - **Export is a snapshot, never a replay.** It can pull a retained backlog in
 *     one round trip, and it can never bring back a range the ring already
 *     dropped — so it may not close the very gap it is used to work around.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  RefereeVerifier,
  RoomReader,
  SqliteCursorStore,
  TechnocoreClient,
  advanceCursor,
} from '@flop/technocore';
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
const ROOM = 'close1';
const referee = generateAgents(1)[0]!;

describe('cache-safe polling', () => {
  it('gives two reads of the same cursor different cache-busting counters', async () => {
    const transport = new FakeTransport();
    const client = new TechnocoreClient({ baseUrl: BASE, fetchImpl: transport.fetchImpl });

    const first = await client.readRoom(ROOM, { since: 0 });
    const second = await client.readRoom(ROOM, { since: 0 });

    // The counter is the only thing that makes the second URL different, and it
    // is the whole reason an unchanged room cannot be answered from a cache.
    expect(first.query.n).toBeDefined();
    expect(second.query.n).toBeDefined();
    expect(first.query.n).not.toBe(second.query.n);
    // Every read carries a cursor, even when there is nothing to resume from:
    // `since=0` means "everything retained", and a bare fetch is the documented
    // shape that returns cached bytes.
    expect(first.query.since).toBe('0');
    expect(second.query.since).toBe('0');
    expect(new URL(transport.requests[0]!.url).searchParams.get('since')).toBe('0');
    expect(new URL(transport.requests[1]!.url).searchParams.get('since')).toBe('0');
  });

  it('counts a re-served page as duplicates and never as consumption', async () => {
    const db = openDatabase({ path: ':memory:' });
    const repositories = createRepositories(db);
    try {
      const transport = new FakeTransport();
      for (let seq = 1; seq <= 3; seq += 1) transport.enqueue(ROOM, { text: `m${seq}` });
      const client = new TechnocoreClient({ baseUrl: BASE, fetchImpl: transport.fetchImpl });
      const first = await client.readRoom(ROOM, { since: 0 });
      // A response cache in front of an unchanged URL answers the second request
      // with the first one's body, byte for byte.
      const cached = await client.readRoom(ROOM, { since: 0 });
      expect(cached.read.messages.map((message) => message.seq)).toEqual(
        first.read.messages.map((message) => message.seq),
      );

      const store = new SqliteCursorStore({ db, repositories });
      const advance = advanceCursor(store.load(ROOM), first.read, 0);
      const at = new Date().toISOString();
      const committed = store.commit(ROOM, first.read.messages, advance, at);
      expect(committed.returned).toBe(3);
      expect(committed.inserted).toBe(3);
      expect(committed.duplicates).toBe(0);

      // The same page, committed again: three messages returned, none stored, and
      // the cursor is exactly where it already was.
      const replay = store.commit(ROOM, cached.read.messages, advance, at);
      expect(replay.returned).toBe(3);
      expect(replay.inserted).toBe(0);
      expect(replay.duplicates).toBe(3);
      expect(store.load(ROOM).cursor).toBe(first.read.messages.at(-1)!.seq);
    } finally {
      closeDatabase(db);
    }
  });

  it('only ever moves a room cursor forward', async () => {
    const db = openDatabase({ path: ':memory:' });
    const repositories = createRepositories(db);
    const transport = new FakeTransport({ readDelayMs: 5 });
    try {
      for (let seq = 1; seq <= 40; seq += 1) transport.enqueue(ROOM, { text: `m${seq}` });
      const reader = new RoomReader({
        client: new TechnocoreClient({ baseUrl: BASE, fetchImpl: transport.fetchImpl }),
        db,
        repositories,
        verifier: new RefereeVerifier({
          rules: referenceRules(),
          logger: silent,
          expectedRefereeDid: referee.did,
        }),
        logger: silent,
        rooms: [ROOM],
        readConcurrency: 1,
        waitSeconds: 10,
        limit: 5,
        retryDelayMs: 5,
      });

      reader.startContinuous();
      await waitFor(
        () => (repositories.roomCursors.get(ROOM)?.cursor ?? 0) >= 40,
        'the reader to drain the room',
        10_000,
      );
      await reader.stopContinuous();

      const since = transport.requests
        .filter((request) => /\/r\/close1\?/.test(request.url))
        .map((request) => Number(new URL(request.url).searchParams.get('since')));
      expect(since.length).toBeGreaterThan(2);
      for (let index = 1; index < since.length; index += 1) {
        expect(since[index]).toBeGreaterThanOrEqual(since[index - 1]!);
      }
      // And nothing was lost on the way: the cursor is the ring head, no gap.
      expect(repositories.roomCursors.get(ROOM)?.gap ?? 0).toBe(0);
    } finally {
      closeDatabase(db);
    }
  });
});

describe('truthful accounting', () => {
  let db: SqliteDatabase;
  let repositories: Repositories;

  beforeEach(() => {
    db = openDatabase({ path: ':memory:' });
    repositories = createRepositories(db);
  });

  afterEach(() => {
    closeDatabase(db);
  });

  function makeReader(transport: FakeTransport) {
    return new RoomReader({
      client: new TechnocoreClient({ baseUrl: BASE, fetchImpl: transport.fetchImpl }),
      db,
      repositories,
      verifier: new RefereeVerifier({
        rules: referenceRules(),
        logger: silent,
        expectedRefereeDid: referee.did,
      }),
      logger: silent,
      rooms: [ROOM],
      readConcurrency: 1,
      waitSeconds: 10,
      limit: 5,
      retryDelayMs: 5,
    });
  }

  it('never counts the messages a gap skipped as persisted', async () => {
    const transport = new FakeTransport({ readDelayMs: 5 });
    for (let seq = 1; seq <= 5; seq += 1) transport.enqueue(ROOM, { text: `m${seq}` });
    const reader = makeReader(transport);

    reader.startContinuous();
    await waitFor(() => (repositories.roomCursors.get(ROOM)?.cursor ?? 0) === 5, 'the first five');

    // The ring drops 6..17 before the reader gets back to the room.
    transport.room(ROOM).firstSeqRetained = 18;
    for (let seq = 18; seq <= 30; seq += 1) transport.enqueue(ROOM, { text: `m${seq}`, seq });

    await waitFor(
      () => (repositories.roomCursors.get(ROOM)?.cursor ?? 0) === 30,
      'the reader to drain what is still retained',
      10_000,
    );
    await reader.stopContinuous();

    const trading = reader.throughputStats().rooms.find((row) => row.room === ROOM)!;
    const persisted = repositories.messages.byKind(ROOM, 'chatter', 0, 500).length;

    // The cursor stepped over thirty seqs; twelve of them were never stored, and
    // those twelve appear only in the gap figures. Persisted is what SQLite got,
    // and it is strictly less than what the cursor walked over — which is exactly
    // the divergence that makes a cursor-only metric dishonest.
    expect(trading.gapMessages).toBe(12);
    expect(trading.cursorSequenceAdvance).toBe(30);
    expect(trading.persistedMessages).toBe(persisted);
    expect(trading.persistedMessages).toBe(18);
    expect(trading.persistedMessages).toBeLessThan(trading.cursorSequenceAdvance);
    // The identity that must always hold: walked = stored + lost.
    expect(trading.persistedMessages + trading.gapMessages).toBe(trading.cursorSequenceAdvance);
  });

  it('keeps a recorded gap on the record for good, however much is read afterwards', async () => {
    const transport = new FakeTransport({ readDelayMs: 5 });
    for (let seq = 1; seq <= 5; seq += 1) transport.enqueue(ROOM, { text: `m${seq}` });
    const reader = makeReader(transport);

    reader.startContinuous();
    await waitFor(() => (repositories.roomCursors.get(ROOM)?.cursor ?? 0) === 5, 'the first five');
    transport.room(ROOM).firstSeqRetained = 9;
    for (let seq = 9; seq <= 12; seq += 1) transport.enqueue(ROOM, { text: `m${seq}`, seq });
    await waitFor(() => (repositories.roomCursors.get(ROOM)?.gap ?? 0) === 3, 'the gap to be recorded');

    // Read well past the gap, contiguously.
    for (let seq = 13; seq <= 30; seq += 1) transport.enqueue(ROOM, { text: `m${seq}`, seq });
    await waitFor(() => (repositories.roomCursors.get(ROOM)?.cursor ?? 0) >= 30, 'the room to be drained');
    await reader.stopContinuous();

    const cursor = repositories.roomCursors.get(ROOM)!;
    // Reading is contiguous again, and the loss is *still* on the record:
    // `gap_count`, the range and the total are the permanent evidence that three
    // messages were lost, and nothing in the reading path may erase them.
    expect(cursor.gap_count).toBe(1);
    expect(cursor.gap).toBe(3);
    expect(cursor.last_gap_from).toBe(6);
    expect(cursor.last_gap_to).toBe(8);
    expect(reader.gaps().rooms).toContain(ROOM);
    expect(reader.gaps().total).toBe(3);
  });

  it('reports a contiguous resume without calling the room recovered', async () => {
    const transport = new FakeTransport({ readDelayMs: 5 });
    for (let seq = 1; seq <= 5; seq += 1) transport.enqueue(ROOM, { text: `m${seq}` });
    const reader = makeReader(transport);

    reader.startContinuous();
    await waitFor(() => (repositories.roomCursors.get(ROOM)?.cursor ?? 0) === 5, 'the first five');
    transport.room(ROOM).firstSeqRetained = 9;
    for (let seq = 9; seq <= 12; seq += 1) transport.enqueue(ROOM, { text: `m${seq}`, seq });
    await waitFor(() => (repositories.roomCursors.get(ROOM)?.gap ?? 0) === 3, 'the gap to be recorded');

    // The very next read finds the room quiet, which is a contiguous read: the
    // reader is inside the retained window again, and that is the entire claim.
    // Nothing new is added after this point, so the state the assertions below
    // read is stable rather than a snapshot of a moving target.
    await waitFor(() => reader.throughputStats().contiguousResumeCount >= 1, 'a contiguous resume');

    const stats = reader.throughputStats();
    expect(stats.unresolvedGap).toBe(true);
    expect(stats.unresolvedGapRooms).toContain(ROOM);
    expect(stats.fullyCaughtUp).toBe(false);
    expect(stats.gapRecoveryCount).toBe(0);
    expect(stats.modeByRoom[ROOM]).toBe('upstream_gap');

    await reader.stopContinuous();
  });
});

describe('export-assisted recovery', () => {
  let db: SqliteDatabase;
  let repositories: Repositories;

  beforeEach(() => {
    db = openDatabase({ path: ':memory:' });
    repositories = createRepositories(db);
  });

  afterEach(() => {
    closeDatabase(db);
  });

  function makeReader(transport: FakeTransport, exportRecovery = true) {
    return new RoomReader({
      client: new TechnocoreClient({ baseUrl: BASE, fetchImpl: transport.fetchImpl }),
      db,
      repositories,
      verifier: new RefereeVerifier({
        rules: referenceRules(),
        logger: silent,
        expectedRefereeDid: referee.did,
      }),
      logger: silent,
      rooms: [ROOM],
      readConcurrency: 1,
      waitSeconds: 10,
      limit: 5,
      retryDelayMs: 5,
      exportRecovery,
      exportMaxBytes: 1_000_000,
      exportTimeoutMs: 1_000,
    });
  }

  /**
   * Drive the room into a recorded gap with a retained backlog behind it.
   *
   * 6 and 7 leave the ring; 8..60 are still retained when the next page is read,
   * so the page carries 8..12 and the cursor stops there while 48 messages sit
   * ahead of it — the shape an export is the right tool for.
   */
  async function driveIntoGap(transport: FakeTransport, reader: RoomReader): Promise<void> {
    for (let seq = 1; seq <= 5; seq += 1) transport.enqueue(ROOM, { text: `m${seq}` });
    reader.startContinuous();
    await waitFor(() => (repositories.roomCursors.get(ROOM)?.cursor ?? 0) === 5, 'the first five');
    transport.room(ROOM).firstSeqRetained = 8;
    for (let seq = 8; seq <= 60; seq += 1) transport.enqueue(ROOM, { text: `m${seq}`, seq });
    await waitFor(() => (repositories.roomCursors.get(ROOM)?.gap ?? 0) === 2, 'the gap to be recorded');
  }

  it('pulls the retained tail in one round trip, and cannot un-lose the gap', async () => {
    const transport = new FakeTransport({ readDelayMs: 5 });
    const reader = makeReader(transport);
    await driveIntoGap(transport, reader);

    // The snapshot carries everything the ring still holds, so the recovery
    // reaches the head far sooner than five messages per request could.
    await waitFor(
      () => (repositories.roomCursors.get(ROOM)?.cursor ?? 0) >= 60,
      'the export to close the retained backlog',
      10_000,
    );
    await reader.stopContinuous();

    const stats = reader.throughputStats();
    expect(stats.exportRecovery.attempts).toBeGreaterThanOrEqual(1);
    expect(stats.exportRecovery.succeeded).toBeGreaterThanOrEqual(1);
    expect(stats.exportRecovery.recoveredMessages).toBeGreaterThan(0);
    expect(repositories.messages.byKind(ROOM, 'chatter', 0, 500).length).toBeGreaterThan(5);

    // And the two messages the ring dropped are still missing, still recorded and
    // still open: no snapshot can bring back what was deleted, so the recovery
    // never closes the very gap it was called in to help with.
    const cursor = repositories.roomCursors.get(ROOM)!;
    expect(cursor.gap).toBe(2);
    expect(cursor.gap_count).toBe(1);
    expect(cursor.last_gap_from).toBe(6);
    expect(cursor.last_gap_to).toBe(7);
    expect(reader.gaps().unresolved).toContain(ROOM);
  });

  it('refuses a snapshot taken in another generation', async () => {
    const transport = new FakeTransport({ readDelayMs: 5 });
    const reader = makeReader(transport);
    // Hold a real generation first: a room announces one when it has been
    // rebuilt, and that held epoch is the only thing a snapshot's stamp can be
    // checked against.
    transport.room(ROOM).generation = 2;
    transport.exportImpl = () =>
      new Response('', {
        status: 200,
        headers: { 'content-type': 'application/jsonl', 'x-room-generation': '99' },
      });

    await driveIntoGap(transport, reader);
    expect(repositories.roomCursors.get(ROOM)?.generation).toBe(2);
    await waitFor(
      () => reader.throughputStats().exportRecovery.generationMismatch >= 1,
      'the generation mismatch to be refused',
      10_000,
    );
    await reader.stopContinuous();

    // A snapshot of a different room holds sequences that mean nothing against
    // our cursor, so it is refused outright and nothing from it is recovered.
    const stats = reader.throughputStats();
    expect(stats.exportRecovery.succeeded).toBe(0);
    expect(stats.exportRecovery.recoveredMessages).toBe(0);
  });

  it('skips malformed records but keeps the good ones', async () => {
    const transport = new FakeTransport({ readDelayMs: 5 });
    const reader = makeReader(transport);
    transport.exportImpl = (room) => {
      const good = room
        .retained()
        .map((message) => JSON.stringify(message))
        .filter((_line, index) => index % 3 !== 1);
      return new Response(['{"not":"a message"}', ...good, 'not json at all'].join('\n'), {
        status: 200,
        headers: {
          'content-type': 'application/jsonl',
          'x-room-generation': String(room.generation),
        },
      });
    };

    await driveIntoGap(transport, reader);
    await waitFor(
      () => reader.throughputStats().exportRecovery.malformedRecords > 0,
      'the malformed records to be counted',
      10_000,
    );
    await reader.stopContinuous();

    const stats = reader.throughputStats();
    // One stranger's bad line is counted and skipped; it never becomes our outage,
    // and it does not cost us the records that were well formed.
    expect(stats.exportRecovery.malformedRecords).toBeGreaterThanOrEqual(2);
    expect(stats.exportRecovery.recoveredMessages).toBeGreaterThan(0);
    expect(repositories.messages.byKind(ROOM, 'chatter', 0, 500).length).toBeGreaterThan(5);
  });

  it('records a snapshot that never arrives, and keeps reading', async () => {
    const transport = new FakeTransport({ readDelayMs: 5 });
    const reader = makeReader(transport);
    // A socket that has been accepted and then goes quiet: the reader's own
    // ceiling on an export is the only thing that ends it.
    transport.exportImpl = (_room, init) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), {
          once: true,
        });
      });

    await driveIntoGap(transport, reader);
    await waitFor(
      () => reader.throughputStats().exportRecovery.failed >= 1,
      'the stalled snapshot to time out',
      15_000,
    );

    const stats = reader.throughputStats();
    expect(stats.exportRecovery.lastError).not.toBeNull();
    // A failed recovery is a recorded failure, not a stop: the read that found the
    // gap still succeeded, and the gap is still named.
    expect(stats.failedReads).toBe(0);
    expect(reader.gaps().rooms).toContain(ROOM);

    await reader.stopContinuous();
  });

  it('does not run at all unless an operator asked for it', async () => {
    const transport = new FakeTransport({ readDelayMs: 5 });
    const reader = makeReader(transport, false);

    await driveIntoGap(transport, reader);
    await reader.stopContinuous();

    expect(reader.throughputStats().exportRecovery.attempts).toBe(0);
    expect(transport.requests.some((request) => request.url.includes('/export'))).toBe(false);
  });
});
