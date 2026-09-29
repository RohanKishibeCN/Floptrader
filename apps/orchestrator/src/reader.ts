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
import type { Repositories, SqliteDatabase } from '@flop/storage';
import {
  REFEREE_ROOMS,
  REFEREE_STATE_ROOM,
  TRADING_ROOM,
  isLocked,
  parseTradeMessage,
  withinLimits,
  type MarketSnapshot,
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

export class OrchestratorReader {
  readonly verifier: RefereeVerifier;
  readonly roomReader: RoomReader;
  /** The highest owner-registration seq already turned into evidence. */
  private lastRegistrationScanSeq = 0;
  private readonly repositories: Repositories;
  private readonly rules: Rules;
  private readonly localDids: () => Set<string>;
  private readonly now: () => Date;
  private readonly logger: Logger;

  constructor(options: ReaderOptions) {
    this.rules = options.rules;
    this.repositories = options.repositories;
    this.localDids = options.localDids;
    this.now = options.now ?? (() => new Date());
    this.logger = options.logger;

    const requirePin = options.requireRefereePin === true;
    this.verifier = new RefereeVerifier({
      rules: options.rules,
      logger: options.logger,
      expectedPackageHash: options.expectedPackageHash ?? null,
      expectedRefereeDid: options.expectedRefereeDid ?? null,
      unpinnedPolicy: requirePin ? 'reject' : 'adopt_first_sender',
      requireSeedBeforeState: requirePin,
    });
    this.roomReader = new RoomReader({
      client: options.client,
      db: options.db,
      repositories: options.repositories,
      verifier: this.verifier,
      logger: options.logger,
      rooms: roomsFor(options.rules),
      ...(options.readConcurrency === undefined ? {} : { readConcurrency: options.readConcurrency }),
      ...(options.waitSeconds === undefined ? {} : { waitSeconds: options.waitSeconds }),
      limit: Math.min(200, Math.max(1, options.readLimit ?? 200)),
      localDids: options.localDids,
      now: this.now,
    });
  }

  /**
   * One pass over every room, then mirror what was learned into SQLite.
   *
   * Persistence happens after the read so a crash mid-tick loses at most the
   * derived rows, never a cursor: the cursor is committed by the reader itself,
   * inside the same transaction as the messages it covers.
   */
  async tick(): Promise<ReaderTick> {
    const summary = await this.roomReader.tick();
    for (const observation of summary.observations) {
      this.persistObservation(observation);
    }
    const snapshot = this.verifier.snapshot(this.now());
    this.persistSweepState(snapshot);
    this.persistPackagePin();
    return {
      ...summary,
      snapshot,
      externalOffers: this.externalOffers(),
    };
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
      if (snapshot.reference !== null) {
        const px = Decimal.from(terms.px);
        if (!withinLimits(this.rules, px, snapshot.reference)) continue;
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
