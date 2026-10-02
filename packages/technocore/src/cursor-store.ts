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
import type { Repositories, RoomBootstrapState, RoomCursorRow, SqliteDatabase } from '@flop/storage';
import type { RoomMessage } from './protocol.js';
import { CursorAdvance } from './protocol.js';

export type { RoomBootstrapState };

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
  bootstrapState: RoomBootstrapState;
  firstObservedSeq: number | null;
  lastObservedSeq: number | null;
  gapCount: number;
  lastGapFrom: number | null;
  lastGapTo: number | null;
  bootstrapAt: string | null;
  /** When a contiguous read proved the latest gap is behind us; null while open. */
  gapResolvedAt: string | null;
  /** The `missedTo` of the most recent gap that was resolved. */
  lastResolvedGapTo: number | null;
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
    bootstrapState: row.bootstrap_state,
    firstObservedSeq: row.first_observed_seq,
    lastObservedSeq: row.last_observed_seq,
    gapCount: row.gap_count,
    lastGapFrom: row.last_gap_from,
    lastGapTo: row.last_gap_to,
    bootstrapAt: row.bootstrap_at,
    gapResolvedAt: row.gap_resolved_at,
    lastResolvedGapTo: row.last_resolved_gap_to,
  };
}

/**
 * How far each bootstrap state has escalated.
 *
 * The states only ever move up. `bootstrap_truncated` is a permanent record of
 * how the process started — it is never overwritten by a healthy `ready` — and a
 * later, genuine mid-run gap escalates it to `cursor_gap`. A clean start becomes
 * `ready` and stays there until something actually goes wrong.
 */
const BOOTSTRAP_RANK: Record<RoomBootstrapState, number> = {
  bootstrap_pending: 0,
  ready: 1,
  bootstrap_truncated: 2,
  cursor_gap: 3,
  cursor_reset: 4,
};

/** The escalation-only successor of `current` given what this read did. */
export function nextBootstrapState(
  current: RoomBootstrapState,
  reason: CursorAdvance['reason'],
): RoomBootstrapState {
  const candidate: RoomBootstrapState =
    reason === 'bootstrap_truncated'
      ? 'bootstrap_truncated'
      : reason === 'gap'
        ? 'cursor_gap'
        : reason === 'room_reset'
          ? 'cursor_reset'
          : // `export_recovery` is progress, not an incident: it moves the cursor
            // from a snapshot of the retained ring and must not escalate the state.
            'ready';
  return BOOTSTRAP_RANK[candidate] > BOOTSTRAP_RANK[current] ? candidate : current;
}

/**
 * What one commit actually did, in the four counts that cannot be conflated.
 *
 * `returned` is what the service sent, `inserted` is what reached SQLite, and
 * the difference is duplicates — the same seq arriving twice, which is what a
 * cached reply or a re-read produces. Only `inserted` may be called consumption.
 */
export interface CommitResult {
  /** Messages the caller offered to the commit. */
  returned: number;
  /** Rows actually written. A seq already stored is not counted again. */
  inserted: number;
  /** Offered messages whose seq was already stored. */
  duplicates: number;
  /** Offered messages carrying a signature that verified against the sender. */
  signed: number;
  /** Offered messages carrying a signature that did NOT verify. */
  invalidSignature: number;
  /**
   * Offered messages that were neither stored nor recognised as duplicates.
   *
   * Structurally zero on the current path — every well-formed message is stored
   * and every repeat is a duplicate — and kept so a future rejection cannot go
   * uncounted. It is derived, never asserted.
   */
  rejected: number;
}

export interface CursorStore {
  load(room: string): CursorRecord;
  /**
   * Persist the messages and the advanced cursor atomically.
   *
   * Implementations MUST NOT advance the cursor when the message insert failed,
   * and must report what they actually wrote rather than what they were handed:
   * a caller that equates the two is exactly how a re-read of the same page
   * masquerades as consumption.
   */
  commit(
    room: string,
    messages: RoomMessage[],
    advance: CursorAdvance,
    ingestedAt: string,
  ): CommitResult;
  recordError(room: string, message: string, at: string): void;
  /**
   * Close an open gap on evidence, not on the passage of time.
   *
   * Called only when the message store has been shown to hold every seq in the
   * recorded gap range. A contiguous read does not qualify (that is what the
   * ordinary commit decides), and neither does an export: a snapshot of the
   * retained ring can never contain a range the ring dropped, so it can never
   * close the very gap it is used to work around.
   */
  markGapResolved(room: string, at: string): void;
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

  commit(room: string, messages: RoomMessage[], advance: CursorAdvance, ingestedAt: string): CommitResult {
    const repositories = this.repositories;
    const map = this.mapMessage;
    let inserted = 0;
    let duplicates = 0;
    let signed = 0;
    let invalidSignature = 0;

    // One transaction: either the messages land and the cursor moves, or neither
    // happens. A cursor that outran its messages is a silent data loss.
    const transaction = this.db.transaction(() => {
      for (const message of messages) {
        const classified = map
          ? map(room, message, ingestedAt)
          : { senderDid: message.from ?? null, nonce: null, sig: null, kind: 'chatter', signatureValid: null };
        if (classified.signatureValid === true) signed += 1;
        if (classified.signatureValid === false) invalidSignature += 1;
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
        else duplicates += 1;
      }
      const current = repositories.roomCursors.ensure(room);
      const isGap = advance.reason === 'gap';
      // The only evidence that a recorded gap is behind us: a contiguous read
      // (`ok`) that resumed while the room already had a gap. An empty read is
      // not evidence — nothing arriving is not the same as being caught up — and
      // an old, already-resolved gap is left alone so a restart cannot re-open it.
      const resolvedNow =
        !isGap && advance.reason === 'ok' && current.gap_count > 0 && current.gap_resolved_at === null;
      const firstObserved =
        advance.firstSeq === null
          ? current.first_observed_seq
          : current.first_observed_seq === null
            ? advance.firstSeq
            : Math.min(current.first_observed_seq, advance.firstSeq);
      const lastObserved =
        advance.lastSeq === null
          ? current.last_observed_seq
          : current.last_observed_seq === null
            ? advance.lastSeq
            : Math.max(current.last_observed_seq, advance.lastSeq);
      repositories.roomCursors.update(room, {
        cursor: advance.cursor,
        generation: advance.generation,
        first_seq: advance.firstSeq,
        last_seq: advance.lastSeq,
        gap: advance.gap,
        room_reset: advance.roomReset ? 1 : 0,
        consecutive_errors: 0,
        last_ok_at: ingestedAt,
        bootstrap_state: nextBootstrapState(current.bootstrap_state, advance.reason),
        first_observed_seq: firstObserved,
        last_observed_seq: lastObserved,
        gap_count: isGap ? current.gap_count + 1 : current.gap_count,
        last_gap_from: isGap ? (advance.missedFrom ?? null) : current.last_gap_from,
        last_gap_to: isGap ? (advance.missedTo ?? null) : current.last_gap_to,
        bootstrap_at: current.bootstrap_at ?? ingestedAt,
        // A new gap re-opens the flag; only a contiguous read closes it.
        gap_resolved_at: isGap ? null : resolvedNow ? ingestedAt : current.gap_resolved_at,
        last_resolved_gap_to: resolvedNow
          ? (current.last_gap_to ?? current.last_resolved_gap_to)
          : current.last_resolved_gap_to,
      });
    });
    transaction();
    return {
      returned: messages.length,
      inserted,
      duplicates,
      signed,
      invalidSignature,
      rejected: messages.length - inserted - duplicates,
    };
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

  markGapResolved(room: string, at: string): void {
    const current = this.repositories.roomCursors.ensure(room);
    if (current.gap_resolved_at !== null) return;
    this.repositories.roomCursors.update(room, {
      gap_resolved_at: at,
      last_resolved_gap_to: current.last_gap_to ?? current.last_resolved_gap_to,
    });
    // The gap count, the recorded range and the total are deliberately untouched:
    // a resolved gap is still a gap that happened, and the record is permanent.
  }

  all(): CursorRecord[] {
    return this.repositories.roomCursors.all().map(toCursorRecord);
  }
}

export interface CursorHealth {
  healthy: boolean;
  reasons: string[];
  /**
   * The total size of the gaps still *open*.
   *
   * A gap that has been closed by a contiguous read contributes nothing here any
   * more — but it is still recorded, per room, in `roomsWithHistoricalGaps` and
   * in the room's own `gapCount`, so the audit never loses it.
   */
  totalGap: number;
  /**
   * Rooms whose latest gap is still open: no contiguous read has resumed past
   * it. This is the "are we still losing messages *now*" set, and it is the only
   * gap set that holds risk back.
   */
  roomsWithActiveUnresolvedGaps: string[];
  /**
   * Rooms a gap happened in and was later closed. Permanent and never cleared:
   * the loss is a fact about how the process started, not a licence to forget.
   */
  roomsWithHistoricalGaps: string[];
  /** Every room that ever carried a gap, open or closed. The permanent record. */
  roomsWithGaps: string[];
  roomsReset: string[];
  maxConsecutiveErrors: number;
}

/**
 * The reader's go/no-go.
 *
 * A *closed* gap and an *open* one are not the same fact, and conflating them is
 * how a process parks itself in conservative mode forever: a gap that happened
 * once and was provably resumed past is part of the audit, not a reason to stop
 * taking new risk. Only an active unresolved gap, a room reset, or a room
 * failing its reads in a row does that.
 *
 * The historical record stays in `roomsWithHistoricalGaps`, `roomsWithGaps` and
 * each room's own persisted `gapCount`; nothing here deletes or zeroes it.
 */
export function cursorHealth(cursors: CursorRecord[], maxConsecutiveErrors = 5): CursorHealth {
  const reasons: string[] = [];
  const roomsWithGaps: string[] = [];
  const roomsWithActiveUnresolvedGaps: string[] = [];
  const roomsWithHistoricalGaps: string[] = [];
  const roomsReset: string[] = [];
  let totalGap = 0;
  let worstErrors = 0;
  for (const cursor of cursors) {
    const recorded = cursor.gap > 0 || cursor.gapCount > 0;
    // `gap` is the size of the latest advance's loss, so only an open one has
    // magnitude; a closed gap keeps its place in the lists below, not here.
    if (cursor.gap > 0) totalGap += cursor.gap;
    if (recorded) roomsWithGaps.push(cursor.room);
    // A gap is active until a contiguous read has been proven past it. `gap === 0`
    // alone is not the test: a cursor can resume without the flag ever closing.
    if (recorded && cursor.gapResolvedAt === null) roomsWithActiveUnresolvedGaps.push(cursor.room);
    else if (recorded) roomsWithHistoricalGaps.push(cursor.room);
    if (cursor.roomReset) roomsReset.push(cursor.room);
    worstErrors = Math.max(worstErrors, cursor.consecutiveErrors);
  }
  if (roomsWithActiveUnresolvedGaps.length > 0) {
    reasons.push(`cursor gap in ${roomsWithActiveUnresolvedGaps.join(',')}`);
  }
  if (roomsReset.length > 0) reasons.push(`room reset in ${roomsReset.join(',')}`);
  if (worstErrors >= maxConsecutiveErrors) reasons.push(`read errors: ${worstErrors} consecutive`);
  return {
    healthy: reasons.length === 0,
    reasons,
    totalGap,
    roomsWithActiveUnresolvedGaps,
    roomsWithHistoricalGaps,
    roomsWithGaps,
    roomsReset,
    maxConsecutiveErrors: worstErrors,
  };
}
