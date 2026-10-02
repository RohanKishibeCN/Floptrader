/**
 * Cursor continuity: gaps, resets and the atomic commit.
 *
 * "Cursor loss = 0" is an acceptance criterion, and it means two things: a read
 * that skipped a range must be recorded as a gap rather than stepped over, and a
 * cursor must never advance past messages that failed to store. These tests pin
 * both, including the atomicity of the message-insert-plus-cursor-move.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  type CursorAdvance,
  SqliteCursorStore,
  advanceCursor,
  cursorHealth,
  type RoomRead,
  type RoomMessage,
} from '@flop/technocore';
import {
  closeDatabase,
  createRepositories,
  openDatabase,
  type Repositories,
  type SqliteDatabase,
} from '@flop/storage';

function message(seq: number): RoomMessage {
  return { seq, ts: `2026-09-28T08:40:0${seq % 10}.000Z`, text: `m${seq}` };
}

function read(messages: RoomMessage[], patch: Partial<RoomRead> = {}): RoomRead {
  return {
    room: 'r1',
    count: messages.length,
    first_seq: messages[0]?.seq ?? null,
    last_seq: messages[messages.length - 1]?.seq ?? null,
    messages,
    ...patch,
  };
}

function view(patch: Partial<{ cursor: number; generation: number; gap: number }> = {}) {
  return {
    room: 'r1',
    cursor: patch.cursor ?? 0,
    generation: patch.generation ?? 1,
    firstSeq: 1,
    lastSeq: patch.cursor ?? 0,
    gap: patch.gap ?? 0,
    roomReset: false,
  };
}

describe('advanceCursor', () => {
  it('adopts the newest seq on the very first read', () => {
    const advance = advanceCursor(null, read([message(1), message(2)]), 1);
    expect(advance.reason).toBe('first_read');
    expect(advance.cursor).toBe(2);
    expect(advance.gap).toBe(0);
  });

  it('reports a gap with the exact missed range and accumulates rather than resets', () => {
    const first = advanceCursor(view({ cursor: 3 }), read([message(6), message(7)]), 1);
    expect(first.reason).toBe('gap');
    // We had 3; the oldest retained message is 6, so 4 and 5 were dropped unseen.
    expect(first.missedFrom).toBe(4);
    expect(first.missedTo).toBe(5);
    expect(first.gap).toBe(2);
    expect(first.cursor).toBe(7);

    const second = advanceCursor(view({ cursor: first.cursor, gap: first.gap }), read([message(10), message(11)]), 1);
    expect(second.reason).toBe('gap');
    expect(second.missedFrom).toBe(8);
    expect(second.missedTo).toBe(9);
    // The gap count is cumulative: a second gap must not wipe the first.
    expect(second.gap).toBe(4);
  });

  it('reports a generation change as a room reset with no gap', () => {
    const advance = advanceCursor(view({ cursor: 5, generation: 1 }), read([message(6)], { generation: 2 }), 1);
    expect(advance.reason).toBe('room_reset');
    expect(advance.roomReset).toBe(true);
    expect(advance.gap).toBe(0);
    expect(advance.generation).toBe(2);
    expect(advance.cursor).toBe(6);
  });

  it('keeps the previous cursor on an empty read', () => {
    const advance = advanceCursor(view({ cursor: 5 }), read([]), 1);
    expect(advance.reason).toBe('empty');
    expect(advance.cursor).toBe(5);
    expect(advance.gap).toBe(0);
  });

  it('does not clear an accumulated gap just because a read came back empty', () => {
    // A quiet moment is not evidence that a recorded loss went away. Returning
    // `gap: 0` here would make the room look clean while the cursor table still
    // said messages were never read.
    const advance = advanceCursor(view({ cursor: 5, gap: 2 }), read([]), 1);
    expect(advance.reason).toBe('empty');
    expect(advance.gap).toBe(2);
    expect(advance.cursor).toBe(5);
  });

  it('stops at the last message returned, never at the ring newest', () => {
    // `last_seq` is the retained ring's newest, not the page's: a reply capped at
    // `limit` reports seq 500 while carrying only up to 200. Trusting `last_seq`
    // as the cursor would skip 201..500 without recording a gap — a silent loss.
    const firstPage = read([message(1), message(200)], { first_seq: 1, last_seq: 500 });
    const first = advanceCursor(null, firstPage, 1);
    expect(first.cursor).toBe(200);
    expect(first.lastSeq).toBe(500);
    expect(first.reason).toBe('first_read');

    const secondPage = read([message(201), message(400)], { first_seq: 1, last_seq: 500 });
    const second = advanceCursor(view({ cursor: 200 }), secondPage, 1);
    expect(second.cursor).toBe(400);
    expect(second.reason).toBe('ok');
    expect(second.gap).toBe(0);
  });
});

describe('SqliteCursorStore', () => {
  let db: SqliteDatabase;
  let repositories: Repositories;
  let store: SqliteCursorStore;

  beforeEach(() => {
    db = openDatabase({ path: ':memory:' });
    repositories = createRepositories(db);
    store = new SqliteCursorStore({ db, repositories });
  });

  afterEach(() => {
    closeDatabase(db);
  });

  const ok = (cursor: number): CursorAdvance => ({
    cursor,
    generation: 1,
    firstSeq: 1,
    lastSeq: cursor,
    gap: 0,
    roomReset: false,
    reason: 'ok',
  });

  it('commits messages and the cursor in one transaction', () => {
    // Seed a good cursor.
    store.commit('r1', [message(1), message(2)], ok(2), '2026-09-28T08:40:00.000Z');
    expect(repositories.roomCursors.get('r1')!.cursor).toBe(2);

    // A mapMessage that throws on the third message makes the second commit fail
    // part-way. If the insert and the cursor move were not atomic, the cursor
    // would be left at 3 covering a message that never stored.
    const failing = new SqliteCursorStore({
      db,
      repositories,
      mapMessage: (_room, current) => {
        if (current.seq === 3) throw new Error('map failure on seq 3');
        return { senderDid: null, nonce: null, sig: null, kind: 'chatter', signatureValid: null };
      },
    });
    expect(() => failing.commit('r1', [message(3)], ok(3), '2026-09-28T08:40:01.000Z')).toThrow(
      /map failure/,
    );

    expect(repositories.roomCursors.get('r1')!.cursor).toBe(2);
    expect(repositories.messages.count()).toBe(2);
  });

  it('reports health from the stored cursors', () => {
    store.commit('r-ok', [message(1)], ok(1), '2026-09-28T08:40:00.000Z');
    // A store with no gap, no reset and no errors is the go signal.
    expect(cursorHealth(store.all()).healthy).toBe(true);

    store.commit(
      'r-gap',
      [message(6), message(7)],
      {
        cursor: 7,
        generation: 1,
        firstSeq: 6,
        lastSeq: 7,
        gap: 2,
        roomReset: false,
        reason: 'gap',
        missedFrom: 4,
        missedTo: 5,
      },
      '2026-09-28T08:40:00.000Z',
    );
    const afterGap = cursorHealth(store.all());
    expect(afterGap.healthy).toBe(false);
    expect(afterGap.roomsWithGaps).toContain('r-gap');
    expect(afterGap.reasons.join(' ')).toContain('r-gap');
    expect(afterGap.totalGap).toBe(2);

    // Five consecutive read errors is the threshold at which health also names
    // the read-error reason.
    for (let count = 0; count < 5; count += 1) {
      store.recordError('r-gap', 'socket reset', '2026-09-28T08:40:00.000Z');
    }
    const afterErrors = cursorHealth(store.all());
    expect(afterErrors.healthy).toBe(false);
    expect(afterErrors.maxConsecutiveErrors).toBe(5);
    expect(afterErrors.reasons.join(' ')).toContain('read errors: 5 consecutive');
  });

  it('keeps an active gap and a resolved one apart, and never zeroes the record', () => {
    const at = '2026-09-28T08:40:00.000Z';
    // A gap that is still open: the only set that holds risk back.
    store.commit(
      'r-active',
      [message(6), message(7)],
      {
        cursor: 7,
        generation: 1,
        firstSeq: 6,
        lastSeq: 7,
        gap: 2,
        roomReset: false,
        reason: 'gap',
        missedFrom: 4,
        missedTo: 5,
      },
      at,
    );
    const active = cursorHealth(store.all());
    expect(active.healthy).toBe(false);
    expect(active.roomsWithActiveUnresolvedGaps).toEqual(['r-active']);
    expect(active.roomsWithHistoricalGaps).toEqual([]);
    expect(active.roomsWithGaps).toEqual(['r-active']);
    expect(active.totalGap).toBe(2);
    expect(active.reasons.join(' ')).toContain('cursor gap in r-active');

    // A contiguous read is the only thing that closes it. Health recovers, but the
    // loss stays on the record: it is not deleted, and not zeroed.
    store.commit('r-active', [message(8)], ok(8), at);
    const resolved = cursorHealth(store.all());
    expect(resolved.healthy).toBe(true);
    expect(resolved.reasons).toEqual([]);
    expect(resolved.roomsWithActiveUnresolvedGaps).toEqual([]);
    expect(resolved.roomsWithHistoricalGaps).toEqual(['r-active']);
    expect(resolved.roomsWithGaps).toEqual(['r-active']);
    // No *open* gap remains, so the live total is zero...
    expect(resolved.totalGap).toBe(0);
    // ...while the audit keeps both the count and the recorded range.
    expect(store.load('r-active').gapCount).toBe(1);
    expect(store.load('r-active').lastGapTo).toBe(5);
    expect(store.load('r-active').gapResolvedAt).not.toBeNull();
  });

  it('never loses the messages that were actually returned across a gap', () => {
    store.commit('r1', [message(1), message(2), message(3)], ok(3), '2026-09-28T08:40:00.000Z');
    // 4 and 5 were dropped from the ring; 6..8 were returned and must all store.
    store.commit(
      'r1',
      [message(6), message(7), message(8)],
      {
        cursor: 8,
        generation: 1,
        firstSeq: 6,
        lastSeq: 8,
        gap: 2,
        roomReset: false,
        reason: 'gap',
        missedFrom: 4,
        missedTo: 5,
      },
      '2026-09-28T08:40:00.000Z',
    );

    const stored = repositories.messages
      .recent('r1', 20)
      .map((row) => row.seq)
      .sort((left, right) => left - right);
    expect(stored).toEqual([1, 2, 3, 6, 7, 8]);
    expect(repositories.roomCursors.get('r1')!.cursor).toBe(8);
  });
});
