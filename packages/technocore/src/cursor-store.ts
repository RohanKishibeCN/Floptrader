/**
 * Room cursors: the durable record of how far each room has been read.
 *
 * "Cursor loss = 0" is an acceptance criterion, so the cursor is written in the
 * same transaction as the messages it covers, and it is never advanced past a
 * range that was not stored. A gap or a room reset is recorded rather than
 * papered over, and `isHealthy()` is what the reader consults before letting a
 * trading strategy act.
 *
 * The SQLite half lives in `@flop/storage`'s `RoomCursorRepository`; this is the
 * domain view the reader and the reader's callers use.
 */
import type { Repositories, RoomCursorRow, SqliteDatabase } from '@flop/storage';
import type { RoomMessage } from './protocol.js';
import { CursorAdvance } from './protocol.js';

export interface CursorRecord {
  room: string;
  cursor: number;
  generation: number;
  firstSeq: number | null;
  lastSeq: number | null;
  gap: number;
  roomReset: boolean;
  consecutiveErrors: number;
  lastOkAt: string | null;
}

export function toCursorRecord(row: RoomCursorRow): CursorRecord {
  return {
    room: row.room,
    cursor: row.cursor,
    generation: row.generation,
    firstSeq: row.first_seq,
    lastSeq: row.last_seq,
    gap: row.gap,
    roomReset: row.room_reset === 1,
    consecutiveErrors: row.consecutive_errors,
    lastOkAt: row.last_ok_at,
  };
}

export interface CursorStore {
  load(room: string): CursorRecord;
  /**
   * Persist the messages and the advanced cursor atomically. Returns the number
   * of newly inserted messages. Implementations MUST NOT advance the cursor when
   * the message insert failed.
   */
  commit(
    room: string,
    messages: RoomMessage[],
    advance: CursorAdvance,
    ingestedAt: string,
  ): number;
  recordError(room: string, message: string, at: string): void;
  all(): CursorRecord[];
}

export interface CursorStoreOptions {
  /** The connection that owns `transaction`, so the commit is atomic. */
  db: SqliteDatabase;
  repositories: Repositories;
  /** Called per message so the caller can classify and verify it. */
  mapMessage?: (room: string, message: RoomMessage, ingestedAt: string) => {
    senderDid: string | null;
    nonce: string | null;
    sig: string | null;
    kind: string;
    signatureValid: boolean | null;
  };
}

export class SqliteCursorStore implements CursorStore {
  private readonly db: SqliteDatabase;
  private readonly repositories: Repositories;
  private readonly mapMessage: CursorStoreOptions['mapMessage'];

  constructor(options: CursorStoreOptions) {
    this.db = options.db;
    this.repositories = options.repositories;
    this.mapMessage = options.mapMessage;
  }

  load(room: string): CursorRecord {
    return toCursorRecord(this.repositories.roomCursors.ensure(room));
  }

  commit(room: string, messages: RoomMessage[], advance: CursorAdvance, ingestedAt: string): number {
    const repositories = this.repositories;
    const map = this.mapMessage;
    let inserted = 0;

    // One transaction: either the messages land and the cursor moves, or neither
    // happens. A cursor that outran its messages is a silent data loss.
    const transaction = this.db.transaction(() => {
      for (const message of messages) {
        const classified = map
          ? map(room, message, ingestedAt)
          : { senderDid: message.from ?? null, nonce: null, sig: null, kind: 'chatter', signatureValid: null };
        const wasInserted = repositories.messages.insert({
          room,
          seq: message.seq,
          ts: message.ts,
          sender_did: classified.senderDid,
          nonce: classified.nonce ?? (message.nonce === undefined ? null : String(message.nonce)),
          sig: classified.sig ?? message.sig ?? null,
          text: message.text,
          kind: classified.kind,
          signature_valid:
            classified.signatureValid === null || classified.signatureValid === undefined
              ? null
              : classified.signatureValid
                ? 1
                : 0,
          ingested_at: ingestedAt,
        });
        if (wasInserted) inserted += 1;
      }
      repositories.roomCursors.update(room, {
        cursor: advance.cursor,
        generation: advance.generation,
        first_seq: advance.firstSeq,
        last_seq: advance.lastSeq,
        gap: advance.gap,
        room_reset: advance.roomReset ? 1 : 0,
        consecutive_errors: 0,
        last_ok_at: ingestedAt,
      });
    });
    transaction();
    return inserted;
  }

  recordError(room: string, message: string, at: string): void {
    const current = this.repositories.roomCursors.ensure(room);
    this.repositories.roomCursors.update(room, {
      consecutive_errors: current.consecutive_errors + 1,
    });
    this.repositories.events.insert({
      at,
      level: 'warn',
      source: 'cursor-store',
      code: 'room_read_error',
      message,
      data: JSON.stringify({ room }),
    });
  }

  all(): CursorRecord[] {
    return this.repositories.roomCursors.all().map(toCursorRecord);
  }
}

export interface CursorHealth {
  healthy: boolean;
  reasons: string[];
  totalGap: number;
  roomsWithGaps: string[];
  roomsReset: string[];
  maxConsecutiveErrors: number;
}

/**
 * The reader's go/no-go. Any gap, any reset, or any room that has failed too many
 * times in a row puts the process into conservative mode: it keeps reading, keeps
 * its state, and stops taking new risk.
 */
export function cursorHealth(cursors: CursorRecord[], maxConsecutiveErrors = 5): CursorHealth {
  const reasons: string[] = [];
  const roomsWithGaps: string[] = [];
  const roomsReset: string[] = [];
  let totalGap = 0;
  let worstErrors = 0;
  for (const cursor of cursors) {
    if (cursor.gap > 0) {
      roomsWithGaps.push(cursor.room);
      totalGap += cursor.gap;
    }
    if (cursor.roomReset) roomsReset.push(cursor.room);
    worstErrors = Math.max(worstErrors, cursor.consecutiveErrors);
  }
  if (roomsWithGaps.length > 0) reasons.push(`cursor gap in ${roomsWithGaps.join(',')}`);
  if (roomsReset.length > 0) reasons.push(`room reset in ${roomsReset.join(',')}`);
  if (worstErrors >= maxConsecutiveErrors) reasons.push(`read errors: ${worstErrors} consecutive`);
  return {
    healthy: reasons.length === 0,
    reasons,
    totalGap,
    roomsWithGaps,
    roomsReset,
    maxConsecutiveErrors: worstErrors,
  };
}
