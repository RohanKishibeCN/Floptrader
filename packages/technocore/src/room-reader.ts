/**
 * The shared room reader: six rooms, one reader, a bounded number of sockets.
 *
 * "Do not create an unbounded long-poll connection per room" is a hard
 * requirement. This reads every room from one loop with `READ_CONCURRENCY` slots
 * (2 by default), each using `since=<cursor>&wait=<READ_WAIT_SECONDS>` so a quiet
 * room costs one request per ten seconds instead of twenty.
 *
 * Per room it keeps cursor, generation, first_seq, last_seq, gap and room_reset.
 * A gap or a reset is recorded and puts the process into conservative mode; the
 * reader itself never stops, because reading is how the problem is discovered to
 * be over.
 *
 * Every message is classified and — for anything signed — signature-checked
 * before it is stored. Unsigned chatter is stored as `chatter` and is never
 * acted on. Nothing in a message is treated as an instruction.
 */
import type { Repositories, SqliteDatabase } from '@flop/storage';
import { classifyMessage } from '@flop/close-call';
import { verifyRoomSignatureForRoom } from '@flop/identity';
import { TechnocoreClient } from './client.js';
import { cursorHealth, SqliteCursorStore, type CursorHealth, type CursorRecord, type CursorStore } from './cursor-store.js';
import { advanceCursor } from './protocol.js';
import type { RoomMessage, TechnocoreLogger } from './protocol.js';
import type { RefereeObservation } from './referee-verifier.js';
import { RefereeVerifier } from './referee-verifier.js';
import { Semaphore } from './retry.js';

export interface RoomReaderOptions {
  client: TechnocoreClient;
  db: SqliteDatabase;
  repositories: Repositories;
  verifier: RefereeVerifier;
  logger: TechnocoreLogger;
  /** Rooms to read: the five referee rooms and the trading room. */
  rooms: string[];
  /**
   * A dynamic room list, re-read on every pass.
   *
   * The fixed reader keeps `rooms`; the bounded dynamic reader supplies this so
   * a discovered owner room can join and leave the set without rebuilding the
   * reader. It is always evaluated inside the same concurrency cap, so a room
   * appearing mid-pass can never spawn an extra socket.
   */
  roomsProvider?: () => string[];
  /** Max concurrent room reads. Two by default: see the header. */
  readConcurrency?: number;
  /** Long-poll hold, seconds. Clamped to 0..10 by the service. */
  waitSeconds?: number;
  /** Messages per read, clamped to 200 by the service. */
  limit?: number;
  /** Local DIDs, so the reader can flag messages that are ours. */
  localDids?: () => Set<string>;
  now?: () => Date;
}

export interface RoomTick {
  room: string;
  readCount: number;
  inserted: number;
  cursor: CursorRecord;
  advanceReason: string;
  degraded: boolean;
  error?: string;
}

export interface TickSummary {
  at: string;
  rooms: RoomTick[];
  inserted: number;
  observations: RefereeObservation[];
  /** Messages from local DIDs, keyed by room, for the trade ledger. */
  localMessages: Array<{ room: string; message: RoomMessage }>;
  health: CursorHealth;
  errors: number;
}

export class RoomReader {
  private readonly client: TechnocoreClient;
  private readonly cursorStore: CursorStore;
  private readonly verifier: RefereeVerifier;
  private readonly logger: TechnocoreLogger;
  private readonly repositories: Repositories;
  private readonly rooms: string[];
  private readonly roomsProvider: (() => string[]) | null;
  private readonly waitSeconds: number;
  private readonly limit: number;
  private readonly semaphore: Semaphore;
  private readonly localDids: () => Set<string>;
  private readonly now: () => Date;
  private stopped = false;
  private lastSummary: TickSummary | null = null;
  private ticks = 0;

  constructor(options: RoomReaderOptions) {
    this.client = options.client;
    this.repositories = options.repositories;
    this.verifier = options.verifier;
    this.logger = options.logger;
    this.rooms = [...options.rooms];
    this.roomsProvider = options.roomsProvider ?? null;
    this.waitSeconds = Math.min(10, Math.max(0, options.waitSeconds ?? 10));
    this.limit = Math.min(200, Math.max(1, options.limit ?? 50));
    this.semaphore = new Semaphore(Math.max(1, options.readConcurrency ?? 2));
    this.localDids = options.localDids ?? (() => new Set<string>());
    this.now = options.now ?? (() => new Date());
    this.cursorStore = new SqliteCursorStore({
      db: options.db,
      repositories: options.repositories,
      mapMessage: (room, message) => this.classify(room, message),
    });
  }

  /** The classifier the cursor store uses: kind plus signature verdict. */
  private classify(
    room: string,
    message: RoomMessage,
  ): { senderDid: string | null; nonce: string | null; sig: string | null; kind: string; signatureValid: boolean | null } {
    const kind = classifyMessage(message.text);
    const senderDid = message.from ?? null;
    const nonce = message.nonce === undefined ? null : String(message.nonce);
    const sig = message.sig ?? null;
    // No sig means the record predates the signing lane: "not re-verifiable",
    // never "invalid". We store it and decline to trust it.
    const signatureValid =
      sig !== null && senderDid !== null ? verifyRoomSignatureForRoom(senderDid, nonce ?? '', message.text, sig, room) : null;
    return { senderDid, nonce, sig, kind, signatureValid };
  }

  get summary(): TickSummary | null {
    return this.lastSummary;
  }

  get tickCount(): number {
    return this.ticks;
  }

  async start(): Promise<void> {
    this.stopped = false;
  }

  async stop(): Promise<void> {
    this.stopped = true;
  }

  /** One pass over every room, with at most `readConcurrency` reads in flight. */
  async tick(): Promise<TickSummary> {
    const at = this.now().toISOString();
    const localDids = this.localDids();
    // The dynamic set is resolved once per pass: every room in it is read inside
    // the same semaphore, so it cannot widen the socket budget.
    const rooms = this.roomsProvider ? this.roomsProvider() : this.rooms;
    const results = await Promise.all(
      rooms.map((room) => this.semaphore.run(() => this.readRoom(room, localDids))),
    );

    const observations: RefereeObservation[] = [];
    const localMessages: Array<{ room: string; message: RoomMessage }> = [];
    let inserted = 0;
    let errors = 0;
    for (const result of results) {
      inserted += result.inserted;
      if (result.error) errors += 1;
      observations.push(...result.observations);
      localMessages.push(...result.localMessages);
    }

    const health = cursorHealth(this.cursorStore.all());
    if (!health.healthy) {
      this.verifier.enterConservative('cursor_health', health.reasons.join('; '));
    }
    this.verifier.reconcileSweeps();

    this.ticks += 1;
    const summary: TickSummary = {
      at,
      rooms: results.map((result) => result.tick),
      inserted,
      observations,
      localMessages,
      health,
      errors,
    };
    this.lastSummary = summary;
    return summary;
  }

  private async readRoom(
    room: string,
    localDids: Set<string>,
  ): Promise<{
    tick: RoomTick;
    inserted: number;
    observations: RefereeObservation[];
    localMessages: Array<{ room: string; message: RoomMessage }>;
    error?: string;
  }> {
    const previous = this.cursorStore.load(room);
    const observations: RefereeObservation[] = [];
    const localMessages: Array<{ room: string; message: RoomMessage }> = [];
    let advance = advanceCursor(
      previous,
      { room, count: 0, first_seq: null, last_seq: null, messages: [] },
      previous.generation,
    );
    let read: RoomMessage[] = [];
    let degraded = false;
    let error: string | undefined;

    try {
      const result = await this.client.readRoom(room, {
        since: previous.cursor > 0 ? previous.cursor : undefined,
        limit: this.limit,
        waitSeconds: previous.cursor > 0 ? this.waitSeconds : 0,
      });
      read = result.read.messages;
      degraded = result.degraded;
      advance = advanceCursor(previous, result.read, previous.generation);
    } catch (caught) {
      error = String(caught);
      this.cursorStore.recordError(room, error, this.now().toISOString());
    }

    const inserted = error
      ? 0
      : this.cursorStore.commit(room, read, advance, this.now().toISOString());

    if (!error) {
      for (const message of read) {
        // Referee posts are the only messages with a state machine attached.
        if (room.startsWith('d-')) {
          const observation = this.verifier.observe(room, message);
          if (observation) observations.push(observation);
        }
        if (message.from !== undefined && localDids.has(message.from)) {
          localMessages.push({ room, message });
        }
      }
      if (advance.reason === 'bootstrap_truncated') {
        // Fires exactly once per room: the reason can only be
        // `bootstrap_truncated` on the read that lifts the cursor off zero.
        this.logger.event({
          level: 'warn',
          source: 'room-reader',
          code: 'bootstrap_truncated',
          message:
            `${room} opened with truncated history: the retained window starts at seq ${advance.firstSeq}, ` +
            `so seq ${advance.missedFrom}..${advance.missedTo} were never available to this process`,
          data: {
            room,
            firstSeq: advance.firstSeq,
            missedFrom: advance.missedFrom,
            missedTo: advance.missedTo,
          },
        });
      }
      if (advance.reason === 'gap') {
        this.logger.event({
          level: 'warn',
          source: 'room-reader',
          code: 'cursor_gap',
          message: `cursor gap in ${room}: messages ${advance.missedFrom}..${advance.missedTo} were not read`,
          data: { room, from: advance.missedFrom, to: advance.missedTo, totalGap: advance.gap },
        });
      }
      if (advance.reason === 'room_reset') {
        this.logger.event({
          level: 'warn',
          source: 'room-reader',
          code: 'room_reset',
          message: `${room} was recreated: generation ${previous.generation} -> ${advance.generation}`,
          data: { room, previousGeneration: previous.generation, generation: advance.generation },
        });
      }
      if (degraded) {
        this.logger.event({
          level: 'warn',
          source: 'room-reader',
          code: 'room_read_degraded',
          message: `${room} returned the text view; senders are not recoverable from it`,
          data: { room },
        });
      }
    }

    return {
      tick: {
        room,
        readCount: read.length,
        inserted,
        cursor: this.cursorStore.load(room),
        advanceReason: advance.reason,
        degraded,
        ...(error === undefined ? {} : { error }),
      },
      inserted,
      observations,
      localMessages,
      ...(error === undefined ? {} : { error }),
    };
  }

  /** True once the reader has completed at least one pass over every room. */
  get warmedUp(): boolean {
    return this.ticks > 0;
  }

  get isStopped(): boolean {
    return this.stopped;
  }

  /**
   * Per-room cursor state for the status report.
   *
   * `gaps` is the run-time finding (a mid-run loss) and is what enters
   * conservative mode; `bootstrap` is the permanent record of a room whose
   * retained history did not reach back to our start, which is not a loss this
   * process suffered and must not be reported as one.
   */
  gaps(): {
    total: number;
    rooms: string[];
    resets: string[];
    bootstrap: string[];
    states: Array<{
      room: string;
      state: CursorRecord['bootstrapState'];
      gapCount: number;
      lastGapFrom: number | null;
      lastGapTo: number | null;
      firstObservedSeq: number | null;
      lastObservedSeq: number | null;
    }>;
  } {
    const cursors = this.cursorStore.all();
    return {
      total: cursors.reduce((sum, cursor) => sum + cursor.gap, 0),
      rooms: cursors.filter((cursor) => cursor.gap > 0).map((cursor) => cursor.room),
      resets: cursors.filter((cursor) => cursor.roomReset).map((cursor) => cursor.room),
      bootstrap: cursors
        .filter((cursor) => cursor.bootstrapState === 'bootstrap_truncated')
        .map((cursor) => cursor.room),
      states: cursors.map((cursor) => ({
        room: cursor.room,
        state: cursor.bootstrapState,
        gapCount: cursor.gapCount,
        lastGapFrom: cursor.lastGapFrom,
        lastGapTo: cursor.lastGapTo,
        firstObservedSeq: cursor.firstObservedSeq,
        lastObservedSeq: cursor.lastObservedSeq,
      })),
    };
  }
}
