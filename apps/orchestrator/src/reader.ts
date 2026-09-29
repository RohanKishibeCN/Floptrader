/**
 * The reader the rest of the process talks to.
 *
 * `@flop/technocore`'s `RoomReader` already does the hard part: one pass over six
 * rooms under a concurrency cap, per-room cursor/generation/gap/reset, signature
 * verification, referee observation. What this module adds is everything the
 * orchestrator needs and the generic reader must not know about:
 *
 *   - it persists every accepted referee post into `referee_snapshots` and
 *     mirrors the live sweep into `sweep_state`, so a restart resumes from the
 *     database rather than from whatever happened to be in memory;
 *   - it pins the seed's package hash into `package_pins`, which is what makes a
 *     later drift visible as data rather than as a surprise;
 *   - it turns the local mirror of `close1` into the two derived views the rest
 *     of the program wants: our own owner-registration readbacks, and the open
 *     external offers that `external_offer_taker` may consider.
 *
 * Everything read from a room is untrusted input. Nothing in a room message is
 * ever interpreted as an instruction — only as data to be signature-checked,
 * classified and stored.
 */
import type { Repositories, RoomRegistryRow, SqliteDatabase } from '@flop/storage';
import {
  REFEREE_ROOMS,
  REFEREE_STATE_ROOM,
  TRADING_ROOM,
  isLocked,
  parseTradeMessage,
  withinLimits,
  withinPublishedLimits,
  type MarketSnapshot,
  type RefereeFlow,
  type Rules,
  type TradeTerms,
} from '@flop/close-call';
import { Decimal, emptySnapshot } from '@flop/close-call';
import { verifyMakerSignature } from '@flop/close-call';
import type { ExternalOffer } from '@flop/strategy';
import {
  RefereeVerifier,
  RoomReader,
  type RefereeObservation,
  type RoomMessage,
  type RoomTick,
  type TechnocoreClient,
  type TickSummary,
} from '@flop/technocore';
import type { Logger } from './logger.js';

export interface ReaderOptions {
  rules: Rules;
  client: TechnocoreClient;
  db: SqliteDatabase;
  repositories: Repositories;
  logger: Logger;
  localDids: () => Set<string>;
  readConcurrency?: number;
  waitSeconds?: number;
  /**
   * Messages per room per pass. 200 is the service's own clamp.
   *
   * This has to be large enough to read back a burst of 150 owner registrations
   * in one pass: at the library default of 50 it would take three ticks, and a
   * registration that is not yet echoed back is not yet evidence.
   */
  readLimit?: number;
  /** Package hash and referee DID fixed at launch, before the first seed. */
  expectedPackageHash?: string | null;
  expectedRefereeDid?: string | null;
  /**
   * Refuse to infer the referee from the first signed post, and refuse
   * price/flow/final posts until a seed has been accepted.
   *
   * Left unset the reader keeps the permissive behaviour, which is what a unit
   * test driving a throwaway room wants. The orchestrator always passes the
   * value from config, where the default is `true`.
   */
  requireRefereePin?: boolean;
  /** How long `age_s` may get before the reference counts as stale. */
  maxReferenceAgeSeconds?: number;
  staleReferenceMode?: 'off' | 'no_new_active_trade';
  /** Cap on listed rooms; beyond it the reader alerts and keeps the fixed set. */
  maxDiscoveredRooms?: number;
  /**
   * Concurrency for the dynamic owner-room reader.
   *
   * Deliberately its own, small budget (`DYNAMIC_ROOM_READ_CONCURRENCY`, 1 by
   * default) and its own reader: a discovered owner room must never queue behind
   * — or in front of — the fixed referee feed.
   */
  dynamicReadConcurrency?: number;
  /** Live mode tightens the `applied`/`for` boundaries in the verifier. */
  live?: boolean;
  now?: () => Date;
}

export interface ReaderTick extends TickSummary {
  /** The market as the strategy layer sees it, after this pass. */
  snapshot: MarketSnapshot;
  /** Open external offers found in `close1`, newest first. */
  externalOffers: ExternalOffer[];
}

/**
 * The rooms this process reads: five referee rooms and the trading room.
 *
 * The state room is read first in every pass. The seed lives there, and the
 * verifier refuses a price or flow that arrives before it, so a pass that reads
 * the price rooms first would reject a perfectly good sweep — the referee posts
 * the seed and the prices between two of our reads, and `contest.json`'s room
 * order is not the referee's posting order.
 */
export function roomsFor(rules: Rules): string[] {
  const referee = rules.refereeRooms.length > 0 ? [...rules.refereeRooms] : [...REFEREE_ROOMS];
  const ordered = [
    ...referee.filter((room) => room === REFEREE_STATE_ROOM),
    ...referee.filter((room) => room !== REFEREE_STATE_ROOM),
  ];
  return [...new Set([...ordered, rules.tradingRoom || TRADING_ROOM])];
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : value === undefined || value === null ? [] : [value];
}

/**
 * The room a flow-post list entry names.
 *
 * The published post uses bare strings; the live one has been seen wrapping them
 * in objects. Both are accepted, and anything else is skipped rather than guessed.
 */
function roomNameOf(entry: unknown): string | null {
  if (typeof entry === 'string' && entry.length > 0) return entry;
  const row = asRecord(entry);
  if (row === null) return null;
  for (const key of ['room', 'r', 'name'] as const) {
    const value = row[key];
    if (typeof value === 'string' && value.length > 0) return value;
  }
  return null;
}

/** Service rooms that are never owner rooms, so they are never "discovered". */
const RESERVED_ROOM_NAMES = new Set(['main', 'lobby', 'system', 'referee', 'announcements']);

/**
 * True for a room we already read unconditionally.
 *
 * The five referee rooms and `close1` are excluded from discovery by name, not
 * by prefix: an owner may legitimately register a room whose name also starts
 * with `d-`, and dropping it on a naming convention would silently stop reading
 * a room the referee listed.
 */
function isReservedRoom(room: string, rules: Rules): boolean {
  if (room === rules.tradingRoom || room === TRADING_ROOM) return true;
  const referee = rules.refereeRooms.length > 0 ? rules.refereeRooms : REFEREE_ROOMS;
  if (referee.includes(room)) return true;
  return RESERVED_ROOM_NAMES.has(room);
}

export class OrchestratorReader {
  readonly verifier: RefereeVerifier;
  readonly roomReader: RoomReader;
  /**
   * The bounded owner-room reader, or null when discovery is disabled.
   *
   * It has its own verifier on purpose: a gap or a reset in a discovered room is
   * not a referee finding, and must not put the whole process into conservative
   * mode. Owner rooms carry no referee posts.
   */
  private readonly dynamicReader: RoomReader | null;
  private readonly fixedRooms: string[];
  /** The dynamic rooms chosen on the last pass, for the report. */
  private dynamicSeen: string[] = [];
  /** The highest owner-registration seq already turned into evidence. */
  private lastRegistrationScanSeq = 0;
  private readonly repositories: Repositories;
  private readonly rules: Rules;
  private readonly localDids: () => Set<string>;
  private readonly now: () => Date;
  private readonly logger: Logger;
  private readonly maxDiscoveredRooms: number | null;

  constructor(options: ReaderOptions) {
    this.rules = options.rules;
    this.repositories = options.repositories;
    this.localDids = options.localDids;
    this.now = options.now ?? (() => new Date());
    this.logger = options.logger;
    this.maxDiscoveredRooms = options.maxDiscoveredRooms ?? null;
    this.fixedRooms = roomsFor(options.rules);

    const requirePin = options.requireRefereePin === true;
    this.verifier = new RefereeVerifier({
      rules: options.rules,
      logger: options.logger,
      expectedPackageHash: options.expectedPackageHash ?? null,
      expectedRefereeDid: options.expectedRefereeDid ?? null,
      unpinnedPolicy: requirePin ? 'reject' : 'adopt_first_sender',
      requireSeedBeforeState: requirePin,
      maxReferenceAgeSeconds: options.maxReferenceAgeSeconds,
      staleReferenceMode: options.staleReferenceMode,
      live: options.live === true,
    });
    this.roomReader = new RoomReader({
      client: options.client,
      db: options.db,
      repositories: options.repositories,
      verifier: this.verifier,
      logger: options.logger,
      rooms: this.fixedRooms,
      ...(options.readConcurrency === undefined ? {} : { readConcurrency: options.readConcurrency }),
      ...(options.waitSeconds === undefined ? {} : { waitSeconds: options.waitSeconds }),
      limit: Math.min(200, Math.max(1, options.readLimit ?? 200)),
      localDids: options.localDids,
      now: this.now,
    });

    this.dynamicReader =
      this.maxDiscoveredRooms === null || this.maxDiscoveredRooms < 1
        ? null
        : new RoomReader({
            client: options.client,
            db: options.db,
            repositories: options.repositories,
            // A sink verifier: dynamic rooms are owner rooms, so nothing in them
            // is a referee post, and a cursor gap there must not widen (or
            // narrow) the fixed reader's view of the contest.
            verifier: new RefereeVerifier({
              rules: options.rules,
              logger: options.logger,
              expectedPackageHash: options.expectedPackageHash ?? null,
              expectedRefereeDid: options.expectedRefereeDid ?? null,
              unpinnedPolicy: 'adopt_first_sender',
              staleReferenceMode: 'off',
            }),
            logger: options.logger,
            rooms: [],
            roomsProvider: () => this.dynamicRoomList(),
            readConcurrency: Math.max(1, options.dynamicReadConcurrency ?? 1),
            ...(options.waitSeconds === undefined ? {} : { waitSeconds: options.waitSeconds }),
            limit: Math.min(200, Math.max(1, options.readLimit ?? 200)),
            localDids: options.localDids,
            now: this.now,
          });

    this.seedRoomRegistry();
  }

  /**
   * The rooms we read unconditionally: five referee rooms plus `close1`.
   *
   * `close1` and the referee set are never subject to the discovery cap, and
   * `close1` is never dropped however the referee's listing changes.
   */
  get fixedRoomList(): string[] {
    return [...this.fixedRooms];
  }

  /** `close1_only` when discovery is off; otherwise the registered rooms we read. */
  get roomScope(): 'close1_only' | 'registered_rooms_plus_close1' {
    return this.dynamicReader === null ? 'close1_only' : 'registered_rooms_plus_close1';
  }

  get dynamicRoomCount(): number {
    return this.dynamicSeen.length;
  }

  get dynamicRooms(): string[] {
    return [...this.dynamicSeen];
  }

  /**
   * Record the rooms we read unconditionally.
   *
   * `close1` never leaves the list — the rules say so — and the five referee
   * rooms are the fixed feed. Seeding them means the registry is a complete view
   * from the first tick, rather than a list that only knows about rooms the
   * referee happened to mention.
   */
  private seedRoomRegistry(): void {
    const now = this.now().toISOString();
    for (const room of this.fixedRooms) {
      const existing = this.repositories.roomRegistry.get(room);
      if (existing) continue;
      this.repositories.roomRegistry.upsert({
        room,
        listed: true,
        lastSeenAt: now,
        source: room === (this.rules.tradingRoom || TRADING_ROOM) ? 'close1' : 'referee',
      });
    }
  }

  /**
   * One pass over every room, then mirror what was learned into SQLite.
   *
   * Persistence happens after the read so a crash mid-tick loses at most the
   * derived rows, never a cursor: the cursor is committed by the reader itself,
   * inside the same transaction as the messages it covers.
   */
  async tick(): Promise<ReaderTick> {
    // The fixed feed first, and on its own: a discovered owner room can never
    // make the referee rooms wait.
    const summary = await this.roomReader.tick();
    for (const observation of summary.observations) {
      this.persistObservation(observation);
    }

    const dynamic = await this.tickDynamicRooms();

    const snapshot = this.verifier.snapshot(this.now());
    this.persistSweepState(snapshot);
    this.persistPackagePin();
    return {
      ...summary,
      inserted: summary.inserted + dynamic.inserted,
      errors: summary.errors + dynamic.errors,
      rooms: [...summary.rooms, ...dynamic.rooms],
      snapshot,
      externalOffers: this.externalOffers(),
    };
  }

  /**
   * One pass over the bounded set of discovered owner rooms.
   *
   * Every failure stays inside this method: the dynamic reader has its own
   * cursor rows and its own verifier, so an unreachable owner room degrades
   * exactly one room and nothing else.
   */
  private async tickDynamicRooms(): Promise<{
    inserted: number;
    errors: number;
    rooms: RoomTick[];
  }> {
    if (this.dynamicReader === null) {
      this.dynamicSeen = [];
      return { inserted: 0, errors: 0, rooms: [] };
    }
    // The room list is resolved inside `roomsProvider`, so the pass and the
    // report always agree about what was read.
    const summary = await this.dynamicReader.tick();
    return { inserted: summary.inserted, errors: summary.errors, rooms: summary.rooms };
  }

  /** The discovered owner rooms, ranked, capped at `MAX_DISCOVERED_ROOMS`. */
  private dynamicRoomList(): string[] {
    const ranked = this.dynamicCandidates();
    const capped =
      this.maxDiscoveredRooms === null ? [] : ranked.slice(0, this.maxDiscoveredRooms);
    this.dynamicSeen = capped.map((row) => row.room);
    return this.dynamicSeen;
  }

  /**
   * Every listed room that is not one we already read unconditionally.
   *
   * The ordering is the documented priority, and each step is a signal we
   * actually hold rather than a guess:
   *
   *   1. a room with a recent signed trade — the one most likely to matter;
   *   2. a room the referee reported a `missed` in, since a local message there
   *      is the case the re-post path exists for;
   *   3. the most recently announced room (`flow.rooms`, then `last_seen_at`);
   *   4. the most recently read room, so a room already in the rotation keeps its
   *      cursor moving rather than being dropped mid-stream.
   *
   * Steps 3 and 4 read the same `last_activity_sweep` from opposite ends, so the
   * "closer to unlisting" tie-break is folded into step 3 and the ordering is
   * deterministic: `room` name last, always.
   */
  private dynamicCandidates(): RoomRegistryRow[] {
    const fixed = new Set(this.fixedRooms);
    const listed = this.repositories.roomRegistry
      .listListed()
      .filter((row) => !fixed.has(row.room) && !isReservedRoom(row.room, this.rules));
    const missed = this.repositories.refereeAnomalies.roomsWithKind('referee_missed');

    const scored = listed.map((row) => {
      const trade = this.repositories.messages.lastOfKind(row.room, 'trade', true);
      return {
        row,
        // A trade's own seq orders two rooms that both have one.
        tradeSeq: trade?.seq ?? -1,
        hasTrade: trade === undefined ? 0 : 1,
        hasMissed: missed.has(row.room) ? 1 : 0,
        activity: row.last_activity_sweep ?? -1,
        seenAt: row.last_seen_at ?? '',
        readAt: this.repositories.roomCursors.get(row.room)?.last_ok_at ?? '',
      };
    });

    scored.sort((a, b) => {
      if (a.hasTrade !== b.hasTrade) return b.hasTrade - a.hasTrade;
      if (a.tradeSeq !== b.tradeSeq) return b.tradeSeq - a.tradeSeq;
      if (a.hasMissed !== b.hasMissed) return b.hasMissed - a.hasMissed;
      if (a.activity !== b.activity) return b.activity - a.activity;
      if (a.seenAt !== b.seenAt) return a.seenAt < b.seenAt ? 1 : -1;
      if (a.readAt !== b.readAt) return a.readAt < b.readAt ? 1 : -1;
      return a.row.room < b.row.room ? -1 : a.row.room > b.row.room ? 1 : 0;
    });

    return scored.map((entry) => entry.row);
  }

  /** The current market view without touching the network. */
  snapshot(): MarketSnapshot {
    try {
      return this.verifier.snapshot(this.now());
    } catch {
      return emptySnapshot();
    }
  }

  /**
   * Open offers posted by other owners in `close1`.
   *
   * This is a *candidate* filter, deliberately not the full acceptance check:
   * it confirms the offer is structurally an open one (`taker:"any"`, no taker
   * signature), that the maker signature verifies, that the maker is not one of
   * our own DIDs, and that the price and clock are still plausible. Funds and
   * caps are checked at accept time, when the accepting agent's own account is
   * in hand.
   */
  externalOffers(): ExternalOffer[] {
    const local = this.localDids();
    const snapshot = this.snapshot();
    const room = this.rules.tradingRoom || TRADING_ROOM;
    const rows = this.repositories.messages.byKind(room, 'trade');

    const offers: ExternalOffer[] = [];
    for (const row of rows) {
      const parsed = parseTradeMessage(row.text);
      if (!parsed) continue;
      const terms = parsed.terms as TradeTerms;
      // Only an open offer: `taker:"any"` and no countersignature yet.
      if (terms.taker !== 'any') continue;
      if (parsed.taker_sig.length > 0) continue;
      // Only strangers. A trade between two of our own DIDs pays two fees and
      // moves nothing between owners.
      if (local.has(terms.maker)) continue;
      if (local.has(parsed.taker)) continue;
      if (!verifyMakerSignature(terms, parsed.maker_sig)) continue;
      const px = Decimal.from(terms.px);
      if (snapshot.nextLimits !== null) {
        if (!withinPublishedLimits(px, snapshot.nextLimits)) continue;
      } else if (snapshot.reference !== null && !withinLimits(this.rules, px, snapshot.reference)) {
        continue;
      }
      if (snapshot.locked) continue;
      if (snapshot.sweep > 0 && snapshot.sweep > terms.until) continue;
      offers.push({
        terms,
        makerSig: parsed.maker_sig,
        room: row.room,
        seq: row.seq,
        observedAt: row.ingested_at,
      });
    }
    // Newest first: a stale offer is the one most likely to be refused for
    // expiry, so it should be considered last.
    offers.sort((a, b) => b.seq - a.seq);
    return offers;
  }

  /**
   * Our own `owner` posts, as echoed back by the room.
   *
   * This is the readback half of the participation record: the registration is
   * only evidence once the room has returned it with a seq and a timestamp, and
   * those are the values stored here.
   */
  ownOwnerRegistrations(): Map<string, { seq: number; ts: string; text: string }> {
    const room = this.rules.tradingRoom || TRADING_ROOM;
    const local = this.localDids();
    const rows = this.repositories.messages.byKind(room, 'owner', this.lastRegistrationScanSeq);
    const found = new Map<string, { seq: number; ts: string; text: string }>();
    let highWater = this.lastRegistrationScanSeq;
    for (const row of rows) {
      highWater = Math.max(highWater, row.seq);
      if (row.sender_did === null || !local.has(row.sender_did)) continue;
      // A signature that failed verification is not a readback.
      if (row.signature_valid === 0) continue;
      if (found.has(row.sender_did)) continue;
      found.set(row.sender_did, { seq: row.seq, ts: row.ts, text: row.text });
    }
    this.lastRegistrationScanSeq = highWater;
    return found;
  }

  /** True once the reader has completed a first pass over every room. */
  get warmedUp(): boolean {
    return this.roomReader.warmedUp;
  }

  /**
   * Rebuild the verifier from the referee history already in SQLite.
   *
   * Called once at startup, before the first network read. The cursor resume
   * point is *after* these posts, so without a replay the process would come back
   * with an empty market view — no reference, no limits, no sweep, no final
   * price — and would stay that way until the referee posted again, which after
   * the lock it never will.
   *
   * `created_at` stands in for the message timestamp (the snapshot table does
   * not store the room's `ts`); it is our ingest time, so an age derived from it
   * is if anything slightly younger than the truth. Nothing gates trading on
   * `ageSeconds`, so that is the conservative direction to be wrong in.
   */
  hydrateFromSnapshots(): { applied: number; skipped: number } {
    let applied = 0;
    let skipped = 0;
    for (const row of this.repositories.referee.orderedForReplay()) {
      let payload: unknown;
      try {
        payload = JSON.parse(row.payload);
      } catch {
        skipped += 1;
        continue;
      }
      const ok = this.verifier.replay({
        seq: row.seq,
        ts: row.created_at,
        kind: row.kind,
        senderDid: row.referee_did,
        payload,
      });
      if (ok) applied += 1;
      else skipped += 1;
    }
    if (applied > 0) {
      this.persistSweepState(this.verifier.snapshot(this.now()));
    }
    return { applied, skipped };
  }

  gaps(): { total: number; rooms: string[]; resets: string[] } {
    return this.roomReader.gaps();
  }

  /** Messages from our own DIDs seen on the last tick, for the trade ledger. */
  localMessages(): Array<{ room: string; message: RoomMessage }> {
    return this.roomReader.summary?.localMessages ?? [];
  }

  private persistObservation(observation: RefereeObservation): void {
    const record = observation.record;
    const now = this.now().toISOString();
    const price = observation.price;
    this.repositories.referee.insertSnapshot({
      room: record.room,
      seq: record.seq,
      sweep: record.sweep ?? observation.price?.n ?? null,
      kind: record.kind,
      payload: JSON.stringify(record.payload ?? null),
      ref_px: price === undefined ? null : price.ref.px,
      limits_low: price === undefined ? null : price.limits[0],
      limits_high: price === undefined ? null : price.limits[1],
      package_hash: observation.seed?.package ?? null,
      referee_did: record.senderDid,
      signature_valid: record.signatureValid ? 1 : 0,
      created_at: now,
    });
    if (observation.flow !== undefined) this.recordFlowAnomalies(observation.flow, now);
    this.recordPriceAnomalies(observation, now);
  }

  /**
   * Record the two live-only holes in a price post.
   *
   * `applied` is the reference a settled trade was checked against and `for` is
   * the sweep the published band belongs to. Both are recorded as anomalies when
   * a live post omits them — the verifier has already entered conservative mode,
   * so this is the durable half of "we saw this and stopped adding risk".
   */
  private recordPriceAnomalies(observation: RefereeObservation, now: string): void {
    const { record } = observation;
    if (observation.appliedMissing) {
      this.repositories.refereeAnomalies.record({
        sweep: record.sweep,
        room: record.room,
        kind: 'applied_missing',
        rawPayload: { seq: record.seq, sweep: record.sweep },
        affectedCount: 1,
      });
      this.logger.event({
        level: 'warn',
        source: 'reader',
        code: 'applied_missing',
        message: `sweep ${record.sweep ?? '-'} posted no \`applied\`; conservative mode, no new active risk`,
        data: { room: record.room, seq: record.seq, sweep: record.sweep, at: now },
      });
    }
    if (observation.limitsForMissing) {
      this.repositories.refereeAnomalies.record({
        sweep: record.sweep,
        room: record.room,
        kind: 'limits_for_missing',
        rawPayload: { seq: record.seq, sweep: record.sweep },
        affectedCount: 1,
      });
      this.logger.event({
        level: 'warn',
        source: 'reader',
        code: 'limits_for_missing',
        message: `sweep ${record.sweep ?? '-'} posted no \`for\`; the band is read-only`,
        data: { room: record.room, seq: record.seq, sweep: record.sweep, at: now },
      });
    }
  }

  /**
   * Record everything a flow post says the referee could not deliver.
   *
   * `unlisted`, `missed` and `omitted` are the referee naming holes in the
   * record, so they are recorded rather than inferred from silence — and none of
   * them is a failure. They mean different things: a room to stop reading, a
   * message that may need re-posting with a fresh nonce, and a list that was cut
   * for length. An `omitted` id may still exist; a `missed` message may still be
   * re-posted before the lock.
   */
  private recordFlowAnomalies(flow: RefereeFlow, now: string): void {
    const raw = flow as unknown as Record<string, unknown>;

    // A room registration is activity: the flow post names the rooms it applied.
    for (const entry of flow.rooms) {
      const room = roomNameOf(entry);
      if (room === null) continue;
      this.repositories.roomRegistry.upsert({
        room,
        listed: true,
        lastActivitySweep: flow.n,
        lastSeenAt: now,
        source: 'flow.rooms',
      });
    }

    // `unlisted`: the referee stopped reading these rooms at this sweep. Reading
    // them after this point would collect messages it will never apply.
    const tradingRoom = this.rules.tradingRoom || TRADING_ROOM;
    for (const entry of asArray(raw.unlisted)) {
      const room = roomNameOf(entry);
      if (room === null) continue;
      // `close1` never leaves the list. A post that says otherwise is a finding,
      // and acting on it would drop the owner registrations that live there.
      if (room === tradingRoom) {
        this.repositories.refereeAnomalies.record({
          sweep: flow.n,
          room,
          kind: 'room_unlisted',
          rawPayload: entry,
          affectedCount: 1,
        });
        this.logger.event({
          level: 'warn',
          source: 'reader',
          code: 'room_unlisted',
          message: `the referee listed ${room} as unlisted at sweep ${flow.n}; ${room} never leaves the list, so it stays`,
          data: { room, sweep: flow.n, ignored: true },
        });
        continue;
      }
      this.repositories.roomRegistry.upsert({
        room,
        listed: false,
        unlistedAt: now,
        lastSeenAt: now,
        source: 'flow.unlisted',
      });
      this.repositories.refereeAnomalies.record({
        sweep: flow.n,
        room,
        kind: 'room_unlisted',
        rawPayload: entry,
        affectedCount: 1,
      });
      this.logger.event({
        level: 'info',
        source: 'reader',
        code: 'room_unlisted',
        message: `the referee unlisted ${room} at sweep ${flow.n}`,
        data: { room, sweep: flow.n },
      });
    }

    // `missed`: messages the referee never read. They do not count, so keeping
    // the payload is what makes a re-post possible with a fresh nonce.
    const missed = asArray(raw.missed);
    if (missed.length > 0) {
      for (const entry of missed) {
        this.repositories.refereeAnomalies.record({
          sweep: flow.n,
          room: roomNameOf(asRecord(entry)?.room ?? entry),
          kind: 'referee_missed',
          rawPayload: entry,
          affectedCount: 1,
        });
      }
      this.logger.event({
        level: 'warn',
        source: 'reader',
        code: 'referee_missed',
        message: `${missed.length} message(s) went unread by the referee at sweep ${flow.n}`,
        data: { sweep: flow.n, count: missed.length },
      });
    }

    // `omitted`: per-list truncation counts. Never treated as absence.
    if (raw.omitted !== undefined) {
      const count = typeof raw.omitted === 'number' ? raw.omitted : asArray(raw.omitted).length;
      this.repositories.refereeAnomalies.record({
        sweep: flow.n,
        room: null,
        kind: 'referee_omitted',
        rawPayload: raw.omitted,
        affectedCount: count,
      });
      this.logger.event({
        level: 'info',
        source: 'reader',
        code: 'referee_omitted',
        message: `the referee omitted ${count} entr(ies) from the sweep ${flow.n} post`,
        data: { sweep: flow.n, omitted: raw.omitted },
      });
    }

    if (this.maxDiscoveredRooms !== null) {
      // Overflow is about the *discovered* set, not the six rooms we read
      // unconditionally: those are never dropped, so counting them would make
      // the alert fire from the first sweep.
      const discovered = this.dynamicCandidates().length;
      if (discovered > this.maxDiscoveredRooms) {
        this.repositories.refereeAnomalies.record({
          sweep: flow.n,
          room: null,
          kind: 'room_overflow',
          rawPayload: { discovered, cap: this.maxDiscoveredRooms },
          affectedCount: discovered,
        });
        this.logger.event({
          level: 'warn',
          source: 'reader',
          code: 'room_overflow',
          message:
            `${discovered} owner rooms are listed, above the cap of ${this.maxDiscoveredRooms}; ` +
            'the fixed referee set and close1 are unchanged and the extra rooms are not polled',
          data: { discovered, cap: this.maxDiscoveredRooms, reading: this.dynamicSeen },
        });
      }
    }
  }

  private persistSweepState(snapshot: MarketSnapshot): void {
    const state = this.verifier.state;
    this.repositories.referee.setSweepState({
      current_sweep: state.currentSweep,
      reference_px: state.reference?.toString() ?? null,
      limit_low: state.limits?.low.toString() ?? snapshot.limits?.low.toString() ?? null,
      limit_high: state.limits?.high.toString() ?? snapshot.limits?.high.toString() ?? null,
      global_px: state.globalPx?.toString() ?? null,
      age_seconds: state.ageSeconds,
      package_hash: state.packageHash,
      referee_did: state.refereeDid,
      final_px: state.finalPx?.toString() ?? null,
      lock_seen:
        state.currentSweep !== null && isLocked(this.rules, state.currentSweep) ? 1 : 0,
      conservative_mode: state.conservative ? 1 : 0,
      conservative_reason: state.conservativeReasons.join('; ') || null,
    });
  }

  /**
   * Record the package hash the referee is quoting.
   *
   * The pin is the authority the process is launched against; the observed hash
   * is what the seed actually says. When they differ, `drift` is set and the
   * orchestrator stops active trading — it never switches package on its own.
   */
  private persistPackagePin(): void {
    const state = this.verifier.state;
    if (state.packageHash === null && state.refereeDid === null) return;
    const existing = this.repositories.upstream.getPin();
    const expected = state.expectedPackageHash ?? existing?.expected_package_hash ?? null;
    const observed = state.packageHash;
    const drift = expected !== null && observed !== null && expected !== observed;
    if (
      existing &&
      existing.expected_package_hash === expected &&
      existing.observed_package_hash === observed &&
      Number(existing.drift) === (drift ? 1 : 0)
    ) {
      return;
    }
    this.repositories.upstream.setPin({
      season: this.rules.season,
      expected_package_hash: expected,
      observed_package_hash: observed,
      referee_did: state.refereeDid,
      pinned_at: existing?.pinned_at ?? this.now().toISOString(),
      drift: drift ? 1 : 0,
      drift_detail: drift ? `expected ${expected}, seed quoted ${observed}` : null,
    });
    if (drift) {
      this.logger.event({
        level: 'error',
        source: 'reader',
        code: 'package_hash_drift',
        message: 'referee seed package hash differs from the pin; manual release required',
        data: { expected, observed },
      });
    }
  }
}
