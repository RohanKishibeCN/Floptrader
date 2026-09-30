/**
 * Cursor bootstrap: a first start against a room whose history does not reach
 * back to seq 1 is not the same thing as losing messages mid-run.
 *
 * The failure this pins is concrete: a VPS that has never read the room before
 * has `cursor = 0`, the referee's retained window starts at seq 400973, and the
 * naive reading of "the oldest visible seq is far past my cursor" is a
 * 400972-message gap — which would put a brand-new process into conservative
 * mode permanently and block every future registration on that VPS.
 *
 * The distinction is preserved as *data*, not as a special case: the room's
 * `bootstrap_state` is `bootstrap_truncated`, `gap` stays 0, and only a stored
 * cursor that actually existed can produce a real `cursor_gap`.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { join } from 'node:path';
import {
  RefereeVerifier,
  RoomReader,
  SqliteCursorStore,
  TechnocoreClient,
  advanceCursor,
  type RoomMessage,
  type RoomRead,
  type TechnocoreLogger,
} from '@flop/technocore';
import { referenceRules } from '@flop/close-call';
import {
  closeDatabase,
  createRepositories,
  openDatabase,
  type Repositories,
  type SqliteDatabase,
} from '@flop/storage';
import { FakeTransport } from './support/fake-transport.js';
import { cleanup, tempDir } from './support/harness.js';

const BASE = 'http://technocore.test';
const AT = '2026-09-28T12:00:00.000Z';
const FIRST_SEQ = 400973;

interface RecordedEvent {
  level: string;
  code: string;
  data?: Record<string, unknown>;
}

function makeLogger(): { logger: TechnocoreLogger; events: RecordedEvent[] } {
  const events: RecordedEvent[] = [];
  const logger: TechnocoreLogger = {
    debug() {},
    info() {},
    warn() {},
    error() {},
    event(record) {
      events.push({ level: record.level, code: record.code, ...(record.data === undefined ? {} : { data: record.data }) });
    },
  };
  return { logger, events };
}

function message(seq: number): RoomMessage {
  return { seq, ts: `${AT}`, text: `m${seq}` };
}

function read(messages: RoomMessage[], patch: Partial<RoomRead> = {}): RoomRead {
  return {
    room: 'close1',
    count: messages.length,
    first_seq: messages[0]?.seq ?? null,
    last_seq: messages[messages.length - 1]?.seq ?? null,
    messages,
    ...patch,
  };
}

function view(patch: Partial<{ cursor: number; generation: number; gap: number }> = {}) {
  return {
    room: 'close1',
    cursor: patch.cursor ?? 0,
    generation: patch.generation ?? 1,
    firstSeq: 1,
    lastSeq: patch.cursor ?? 0,
    gap: patch.gap ?? 0,
    roomReset: false,
  };
}

describe('advanceCursor distinguishes bootstrap from a lost cursor', () => {
  it('treats a first start past seq 1 as bootstrap_truncated, with no gap', () => {
    const advance = advanceCursor(null, read([message(FIRST_SEQ)], { first_seq: FIRST_SEQ }), 1);
    expect(advance.reason).toBe('bootstrap_truncated');
    expect(advance.gap).toBe(0);
    expect(advance.missedFrom).toBe(1);
    expect(advance.missedTo).toBe(FIRST_SEQ - 1);
  });

  it('treats a stored cursor of 0 the same way', () => {
    const advance = advanceCursor(view({ cursor: 0 }), read([message(FIRST_SEQ)], { first_seq: FIRST_SEQ }), 1);
    expect(advance.reason).toBe('bootstrap_truncated');
    expect(advance.gap).toBe(0);
  });

  it('treats a cursor we actually held as a real gap', () => {
    const advance = advanceCursor(view({ cursor: FIRST_SEQ - 3 }), read([message(FIRST_SEQ)], { first_seq: FIRST_SEQ }), 1);
    expect(advance.reason).toBe('gap');
    expect(advance.gap).toBeGreaterThan(0);
  });

  it('keeps a contiguous read contiguous', () => {
    const advance = advanceCursor(view({ cursor: FIRST_SEQ - 1 }), read([message(FIRST_SEQ)], { first_seq: FIRST_SEQ }), 1);
    expect(advance.reason).toBe('ok');
    expect(advance.gap).toBe(0);
  });
});

describe('the bootstrap state is durable', () => {
  let dir: string;

  beforeEach(() => {
    dir = tempDir('flop-cursor-');
  });

  afterEach(() => {
    cleanup(dir);
  });

  it('survives a restart and is never downgraded by a later healthy read', () => {
    const dbPath = join(dir, 'flop.db');
    let db: SqliteDatabase = openDatabase({ path: dbPath });
    let repositories: Repositories = createRepositories(db);
    const first = new SqliteCursorStore({ db, repositories });
    first.commit(
      'close1',
      [],
      {
        cursor: 0,
        generation: 0,
        firstSeq: FIRST_SEQ,
        lastSeq: FIRST_SEQ + 2,
        gap: 0,
        roomReset: false,
        reason: 'bootstrap_truncated',
        missedFrom: 1,
        missedTo: FIRST_SEQ - 1,
      },
      AT,
    );
    const stored = repositories.roomCursors.get('close1')!;
    expect(stored.bootstrap_state).toBe('bootstrap_truncated');
    expect(stored.gap_count).toBe(0);
    expect(stored.first_observed_seq).toBe(FIRST_SEQ);
    expect(stored.bootstrap_at).not.toBeNull();
    closeDatabase(db);

    db = openDatabase({ path: dbPath });
    repositories = createRepositories(db);
    expect(repositories.roomCursors.get('close1')!.bootstrap_state).toBe('bootstrap_truncated');

    // A later, entirely healthy read must not erase how we started.
    const second = new SqliteCursorStore({ db, repositories });
    second.commit(
      'close1',
      [message(FIRST_SEQ + 3)],
      {
        cursor: FIRST_SEQ + 3,
        generation: 0,
        firstSeq: FIRST_SEQ + 3,
        lastSeq: FIRST_SEQ + 3,
        gap: 0,
        roomReset: false,
        reason: 'ok',
      },
      AT,
    );
    const after = repositories.roomCursors.get('close1')!;
    expect(after.bootstrap_state).toBe('bootstrap_truncated');
    expect(after.cursor).toBe(FIRST_SEQ + 3);
    closeDatabase(db);
  });

  it('escalates a bootstrap to cursor_gap when a genuine gap follows, and counts it', () => {
    const db = openDatabase({ path: ':memory:' });
    const repositories = createRepositories(db);
    const store = new SqliteCursorStore({ db, repositories });
    store.commit(
      'close1',
      [],
      {
        cursor: FIRST_SEQ,
        generation: 0,
        firstSeq: FIRST_SEQ,
        lastSeq: FIRST_SEQ,
        gap: 0,
        roomReset: false,
        reason: 'bootstrap_truncated',
        missedFrom: 1,
        missedTo: FIRST_SEQ - 1,
      },
      AT,
    );
    store.commit(
      'close1',
      [message(FIRST_SEQ + 5)],
      {
        cursor: FIRST_SEQ + 5,
        generation: 0,
        firstSeq: FIRST_SEQ + 5,
        lastSeq: FIRST_SEQ + 5,
        gap: 4,
        roomReset: false,
        reason: 'gap',
        missedFrom: FIRST_SEQ + 1,
        missedTo: FIRST_SEQ + 4,
      },
      AT,
    );
    const row = repositories.roomCursors.get('close1')!;
    expect(row.bootstrap_state).toBe('cursor_gap');
    expect(row.gap_count).toBe(1);
    expect(row.last_gap_from).toBe(FIRST_SEQ + 1);
    expect(row.last_gap_to).toBe(FIRST_SEQ + 4);
    closeDatabase(db);
  });
});

describe('RoomReader bootstrap behaviour', () => {
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
    rooms: string[],
    logger: TechnocoreLogger,
  ): RoomReader {
    const client = new TechnocoreClient({ baseUrl: BASE, fetchImpl: transport.fetchImpl });
    const verifier = new RefereeVerifier({ rules: referenceRules(), logger });
    return new RoomReader({
      client,
      db,
      repositories,
      verifier,
      logger,
      rooms,
      readConcurrency: 1,
      limit: 200,
      waitSeconds: 0,
      now: () => new Date(AT),
    });
  }

  it('records a truncated first read as bootstrap, not as a gap, and stays healthy', async () => {
    const transport = new FakeTransport();
    for (let seq = FIRST_SEQ; seq <= FIRST_SEQ + 2; seq += 1) {
      transport.enqueue('close1', { seq, text: `m${seq}` });
    }
    const { logger, events } = makeLogger();
    const reader = makeReader(transport, ['close1'], logger);

    const summary = await reader.tick();

    // The whole point: a fresh VPS must not go conservative on its first read.
    expect(summary.health.healthy).toBe(true);
    const gaps = reader.gaps();
    expect(gaps.rooms).not.toContain('close1');
    expect(gaps.total).toBe(0);
    expect(gaps.bootstrap).toContain('close1');
    const state = gaps.states.find((entry) => entry.room === 'close1')!;
    expect(state.state).toBe('bootstrap_truncated');
    expect(state.gapCount).toBe(0);
    expect(state.firstObservedSeq).toBe(FIRST_SEQ);
    expect(state.lastObservedSeq).toBe(FIRST_SEQ + 2);

    const row = repositories.roomCursors.get('close1')!;
    expect(row.cursor).toBe(FIRST_SEQ + 2);
    expect(row.gap).toBe(0);
    expect(row.bootstrap_at).not.toBeNull();

    const alerts = events.filter((event) => event.code === 'bootstrap_truncated');
    expect(alerts).toHaveLength(1);
    expect(alerts[0]!.level).toBe('warn');
    // The message names the range but never pretends the history was read.
    expect(String(alerts[0]!.data?.missedTo)).toBe(String(FIRST_SEQ - 1));
  });

  it('does not repeat the bootstrap alert, and keeps reading new messages afterwards', async () => {
    const transport = new FakeTransport();
    for (let seq = FIRST_SEQ; seq <= FIRST_SEQ + 2; seq += 1) {
      transport.enqueue('close1', { seq, text: `m${seq}` });
    }
    const { logger, events } = makeLogger();
    const reader = makeReader(transport, ['close1'], logger);

    await reader.tick();
    // A quiet pass must not re-announce the same fact.
    await reader.tick();
    expect(events.filter((event) => event.code === 'bootstrap_truncated')).toHaveLength(1);

    // Strictly-new messages are read normally once bootstrap has lifted the cursor.
    transport.enqueue('close1', { seq: FIRST_SEQ + 3, text: 'm-new' });
    await reader.tick();
    expect(repositories.roomCursors.get('close1')!.cursor).toBe(FIRST_SEQ + 3);
    expect(repositories.roomCursors.get('close1')!.bootstrap_state).toBe('bootstrap_truncated');
    expect(events.filter((event) => event.code === 'bootstrap_truncated')).toHaveLength(1);
  });

  it('records a truncated referee room the same way', async () => {
    const transport = new FakeTransport();
    for (let seq = FIRST_SEQ; seq <= FIRST_SEQ + 1; seq += 1) {
      transport.enqueue('d-close1-state', { seq, text: `m${seq}` });
    }
    const { logger } = makeLogger();
    const reader = makeReader(transport, ['d-close1-state'], logger);

    const summary = await reader.tick();
    expect(summary.health.healthy).toBe(true);
    expect(reader.gaps().bootstrap).toContain('d-close1-state');
    expect(repositories.roomCursors.get('d-close1-state')!.bootstrap_state).toBe('bootstrap_truncated');
  });

  it('still records a mid-run gap as a gap once a cursor exists', async () => {
    const transport = new FakeTransport();
    for (let seq = 1; seq <= 3; seq += 1) transport.enqueue('close1', { seq, text: `m${seq}` });
    const { logger } = makeLogger();
    const reader = makeReader(transport, ['close1'], logger);

    await reader.tick();
    expect(repositories.roomCursors.get('close1')!.bootstrap_state).toBe('ready');

    // 4 and 5 fall out of the retained ring before the next read.
    for (let seq = 4; seq <= 8; seq += 1) transport.enqueue('close1', { seq, text: `m${seq}` });
    transport.room('close1').firstSeqRetained = 6;

    const summary = await reader.tick();
    expect(summary.health.healthy).toBe(false);
    const gaps = reader.gaps();
    expect(gaps.rooms).toContain('close1');
    expect(gaps.total).toBe(2);
    expect(gaps.bootstrap).not.toContain('close1');
    const row = repositories.roomCursors.get('close1')!;
    expect(row.bootstrap_state).toBe('cursor_gap');
    expect(row.gap_count).toBe(1);
    expect(row.last_gap_from).toBe(4);
    expect(row.last_gap_to).toBe(5);
  });

  it('records a generation change as a cursor reset that is never auto-skipped', async () => {
    const transport = new FakeTransport();
    for (let seq = 1; seq <= 3; seq += 1) transport.enqueue('close1', { seq, text: `m${seq}` });
    const { logger } = makeLogger();
    const reader = makeReader(transport, ['close1'], logger);

    await reader.tick();
    transport.room('close1').generation = 2;
    transport.enqueue('close1', { seq: 4, text: 'm4' });
    await reader.tick();

    expect(reader.gaps().resets).toContain('close1');
    expect(repositories.roomCursors.get('close1')!.bootstrap_state).toBe('cursor_reset');

    // A later clean read does not erase the fact the room was recreated.
    transport.enqueue('close1', { seq: 5, text: 'm5' });
    await reader.tick();
    expect(repositories.roomCursors.get('close1')!.bootstrap_state).toBe('cursor_reset');
  });

  it('classifies a first start at seq 1 as a clean ready room', async () => {
    const transport = new FakeTransport();
    transport.enqueue('close1', { seq: 1, text: 'm1' });
    const { logger, events } = makeLogger();
    const reader = makeReader(transport, ['close1'], logger);

    await reader.tick();
    expect(repositories.roomCursors.get('close1')!.bootstrap_state).toBe('ready');
    expect(reader.gaps().bootstrap).not.toContain('close1');
    expect(events.filter((event) => event.code === 'bootstrap_truncated')).toHaveLength(0);
  });
});
