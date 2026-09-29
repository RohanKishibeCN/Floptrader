/**
 * The referee's posts, verified.
 *
 * Everything the referee does arrives as an ordinary room message signed by its
 * DID. Three things must therefore line up before anything is believed:
 *
 *   1. the signature covers `<room>|<nonce>|<text>` for the room it came from;
 *   2. the sender is the referee DID — the one the seed fixes, or the one already
 *      pinned, never a DID that merely shows up in a `d-` room;
 *   3. the payload parses as the documented shape.
 *
 * Then the state machine, and this is the part that keeps the money safe:
 *
 *   - the seed's `package` hash must equal the pinned package hash. A mismatch is
 *     drift: conservative mode, a `package_hash_drift` event, and no automatic
 *     switch. The referee is the authority on the contest state, and if it is
 *     quoting a different package, we stop trading until a human looks.
 *   - a sweep that produces a `price` post but no `flow` post leaves that sweep's
 *     mints unknown. That is `mint_unknown`, never `failed`.
 *   - a reference that is non-positive or that jumps beyond any plausible move is
 *     an anomaly: conservative mode.
 *
 * Conservative mode never widens risk. It does not stop the reader — reading is
 * how we find out the problem is over.
 */
import {
  Decimal,
  MAX_REFERENCE_MOVE,
  isLocked,
  parseRefereeMessage,
  type MarketSnapshot,
  type RefereeFinal,
  type RefereeFlow,
  type RefereePrice,
  type RefereeSeed,
  type Rules,
} from '@flop/close-call';
import { verifyRoomSignatureForRoom } from '@flop/identity';
import type { RoomMessage, TechnocoreLogger } from './protocol.js';

export type RefereeKind = 'seed' | 'price' | 'flow' | 'positions' | 'pnl' | 'state' | 'final' | 'other';

export interface VerifiedRefereeRecord {
  room: string;
  seq: number;
  ts: string;
  kind: RefereeKind;
  senderDid: string;
  sweep: number | null;
  payload: unknown;
  signatureValid: boolean;
  accepted: boolean;
  rejectedBecause?: string;
}

export interface RefereeObservation {
  record: VerifiedRefereeRecord;
  /** Set when this post carried a seed. */
  seed?: RefereeSeed;
  price?: RefereePrice;
  flow?: RefereeFlow;
  final?: RefereeFinal;
  /** DIDs minted in this post's sweep, when a flow has been seen for it. */
  mints: string[];
  /** True when this observation put us into conservative mode. */
  enteredConservativeMode: boolean;
  /** True when the seed's package hash disagrees with the pin. */
  packageDrift: boolean;
}

export interface RefereeVerifierOptions {
  rules: Rules;
  logger: TechnocoreLogger;
  /** The package hash fixed at launch, if known ahead of the seed. */
  expectedPackageHash?: string | null;
  /** The referee DID fixed at launch, if known ahead of the seed. */
  expectedRefereeDid?: string | null;
  /** A reference move larger than this fraction is treated as an anomaly. */
  maxReferenceJump?: number;
  /**
   * What to do when no referee DID has been pinned.
   *
   * `adopt_first_sender` mirrors the service's own "the referee is whoever posts
   * the seed" convention and is what a dry run against a throwaway room wants.
   * `reject` refuses every post until an identity is pinned, which is the only
   * safe behaviour for a contest: the `d-` rooms are readable and writable by
   * anyone, so an unpinned verifier accepts a forged seed — and with it a forged
   * package hash, reference price and mint list — from whoever posts first.
   */
  unpinnedPolicy?: 'adopt_first_sender' | 'reject';
  /**
   * Refuse price/flow/final posts until a seed has been accepted.
   *
   * The seed is the post that fixes the season, the package and the referee's
   * trading baseline. Letting a price land first would let a stranger with a
   * valid signature establish the reference the strategy layer then trades on.
   */
  requireSeedBeforeState?: boolean;
}

interface SweepLedger {
  priceSeen: boolean;
  flowSeen: boolean;
  mints: string[];
}

/** What applying one authorised payload produced. */
interface AppliedPayload {
  seed?: RefereeSeed;
  price?: RefereePrice;
  flow?: RefereeFlow;
  final?: RefereeFinal;
  mints: string[];
  packageDrift: boolean;
}

export class RefereeVerifier {
  private readonly rules: Rules;
  private readonly logger: TechnocoreLogger;
  private readonly maxReferenceJump: Decimal;
  private readonly unpinnedPolicy: 'adopt_first_sender' | 'reject';
  private readonly requireSeedBeforeState: boolean;
  private refereeDid: string | null;
  private packageHash: string | null = null;
  private expectedPackageHash: string | null;
  private seedSeen = false;
  private readonly sweeps = new Map<number, SweepLedger>();
  private readonly referenceHistory: Decimal[] = [];
  private currentSweep: number | null = null;
  private reference: Decimal | null = null;
  private limits: { low: Decimal; high: Decimal } | null = null;
  private globalPx: Decimal | null = null;
  private ageSeconds: number | null = null;
  private finalPx: Decimal | null = null;
  private conservative = false;
  private readonly conservativeReasons = new Set<string>();
  private lastRefereeSeq: number | null = null;
  private lastPostAt: string | null = null;

  constructor(options: RefereeVerifierOptions) {
    this.rules = options.rules;
    this.logger = options.logger;
    this.expectedPackageHash = options.expectedPackageHash ?? null;
    this.refereeDid = options.expectedRefereeDid ?? null;
    this.maxReferenceJump = Decimal.from(String(options.maxReferenceJump ?? MAX_REFERENCE_MOVE));
    this.unpinnedPolicy = options.unpinnedPolicy ?? 'adopt_first_sender';
    this.requireSeedBeforeState = options.requireSeedBeforeState ?? false;
  }

  get state(): {
    refereeDid: string | null;
    packageHash: string | null;
    expectedPackageHash: string | null;
    currentSweep: number | null;
    reference: Decimal | null;
    limits: { low: Decimal; high: Decimal } | null;
    globalPx: Decimal | null;
    ageSeconds: number | null;
    finalPx: Decimal | null;
    locked: boolean;
    conservative: boolean;
    conservativeReasons: string[];
    historyLength: number;
    seedSeen: boolean;
  } {
    return {
      refereeDid: this.refereeDid,
      packageHash: this.packageHash,
      expectedPackageHash: this.expectedPackageHash,
      currentSweep: this.currentSweep,
      reference: this.reference,
      limits: this.limits,
      globalPx: this.globalPx,
      ageSeconds: this.ageSeconds,
      finalPx: this.finalPx,
      locked: this.currentSweep !== null && isLocked(this.rules, this.currentSweep),
      conservative: this.conservative,
      conservativeReasons: [...this.conservativeReasons],
      historyLength: this.referenceHistory.length,
      seedSeen: this.seedSeen,
    };
  }

  /** The snapshot the strategy layer consumes. */
  snapshot(now: Date = new Date()): MarketSnapshot {
    const locked = this.currentSweep !== null && isLocked(this.rules, this.currentSweep);
    return {
      sweep: this.currentSweep ?? 0,
      reference: this.reference,
      limits: this.limits,
      history: [...this.referenceHistory],
      globalPx: this.globalPx,
      ageSeconds: this.ageSeconds ?? this.secondsSinceLastPost(now),
      locked,
      degraded: this.conservative,
      degradedReason: [...this.conservativeReasons].join('; ') || null,
      packageHash: this.packageHash,
      refereeDid: this.refereeDid,
    };
  }

  private secondsSinceLastPost(now: Date): number | null {
    if (this.lastPostAt === null) return null;
    return Math.max(0, Math.floor((now.getTime() - Date.parse(this.lastPostAt)) / 1000));
  }

  /** Pin the launch-time values, before any post has been read. */
  pin(expected: { packageHash?: string | null; refereeDid?: string | null }): void {
    if (expected.packageHash !== undefined && expected.packageHash !== null) {
      this.expectedPackageHash = expected.packageHash;
      if (this.packageHash !== null && this.packageHash !== expected.packageHash) {
        this.enterConservative('package_hash_drift', `pinned ${expected.packageHash}, seed said ${this.packageHash}`);
      }
    }
    if (expected.refereeDid !== undefined && expected.refereeDid !== null) {
      if (this.refereeDid !== null && this.refereeDid !== expected.refereeDid) {
        this.enterConservative('referee_did_changed', `pinned ${expected.refereeDid}, saw ${this.refereeDid}`);
      }
      this.refereeDid = expected.refereeDid;
    }
  }

  enterConservative(reason: string, detail: string): void {
    if (!this.conservativeReasons.has(reason)) {
      this.logger.event({
        level: 'warn',
        source: 'referee-verifier',
        code: 'conservative_mode',
        message: `entering conservative mode: ${reason}`,
        data: { reason, detail },
      });
    }
    this.conservativeReasons.add(reason);
    this.conservative = true;
  }

  clearConservative(reason: string): void {
    this.conservativeReasons.delete(reason);
    this.conservative = this.conservativeReasons.size > 0;
  }

  /**
   * Verify and consume one message. `room` must be the room it was read from —
   * the signature covers the room name, so a message replayed into a different
   * room will fail here.
   */
  observe(room: string, message: RoomMessage, expectedRefereeDid?: string): RefereeObservation | null {
    const parsed = parseRefereeMessage(message.text);
    if (parsed === null) return null;
    const kind = parsed.kind as RefereeKind;
    if (!['seed', 'price', 'flow', 'positions', 'pnl', 'state', 'final'].includes(kind)) return null;

    const senderDid = message.from ?? '';
    const nonce = message.nonce === undefined ? '' : String(message.nonce);
    const signatureValid =
      message.sig !== undefined && senderDid.length > 0
        ? verifyRoomSignatureForRoom(senderDid, nonce, message.text, message.sig, room)
        : false;

    const record: VerifiedRefereeRecord = {
      room,
      seq: message.seq,
      ts: message.ts,
      kind,
      senderDid,
      sweep: extractSweep(parsed.value),
      payload: parsed.value,
      signatureValid,
      accepted: false,
    };

    if (!signatureValid) {
      record.rejectedBecause = 'signature_invalid';
      this.enterConservative('referee_signature_invalid', `seq ${message.seq} in ${room} did not verify`);
      return {
        record,
        mints: [],
        enteredConservativeMode: true,
        packageDrift: false,
      };
    }

    const expected = expectedRefereeDid ?? this.refereeDid;
    if (expected === null && this.unpinnedPolicy === 'reject') {
      record.rejectedBecause = 'referee_unpinned';
      this.enterConservative(
        'referee_unpinned',
        `no referee DID is pinned; refusing seq ${message.seq} from ${senderDid} in ${room}`,
      );
      return { record, mints: [], enteredConservativeMode: true, packageDrift: false };
    }
    if (expected !== null && senderDid !== expected) {
      record.rejectedBecause = 'unexpected_referee_did';
      this.enterConservative(
        'referee_did_mismatch',
        `expected ${expected}, got ${senderDid} in ${room}`,
      );
      return { record, mints: [], enteredConservativeMode: true, packageDrift: false };
    }

    // Only when nothing pinned the identity *and* the policy allows it does the
    // first verified post fix who the referee is.
    if (this.refereeDid === null) this.refereeDid = senderDid;

    // The seed carries the season, the package and the referee's baseline. A
    // price that arrives before it has no authority behind it.
    if (this.requireSeedBeforeState && !this.seedSeen && kind !== 'seed') {
      record.rejectedBecause = 'seed_required';
      this.enterConservative(
        'seed_required',
        `refusing a ${kind} post before the seed (seq ${message.seq} in ${room})`,
      );
      return { record, mints: [], enteredConservativeMode: true, packageDrift: false };
    }

    this.lastRefereeSeq = Math.max(this.lastRefereeSeq ?? 0, message.seq);
    this.lastPostAt = message.ts;
    record.accepted = true;

    const observation: RefereeObservation = {
      record,
      mints: [],
      enteredConservativeMode: false,
      packageDrift: false,
    };

    const applied = this.applyPayload(kind, parsed.value);
    if (applied.seed !== undefined) observation.seed = applied.seed;
    if (applied.price !== undefined) observation.price = applied.price;
    if (applied.flow !== undefined) observation.flow = applied.flow;
    if (applied.final !== undefined) observation.final = applied.final;
    observation.mints = applied.mints;

    observation.packageDrift = applied.packageDrift;
    observation.enteredConservativeMode = this.conservative;
    return observation;
  }

  /**
   * Apply an already-authorised referee payload.
   *
   * Shared by `observe` (after the signature and the sender have been checked)
   * and `replay` (for rows this process stored after checking them once). The
   * authorisation is the caller's job; this only does the state machine.
   */
  private applyPayload(kind: RefereeKind, payload: unknown): AppliedPayload {
    const applied: AppliedPayload = { mints: [], packageDrift: false };
    switch (kind) {
      case 'seed': {
        const seed = payload as RefereeSeed;
        applied.seed = seed;
        this.seedSeen = true;
        if (this.packageHash === null) {
          this.packageHash = seed.package;
        }
        if (this.expectedPackageHash !== null && seed.package !== this.expectedPackageHash) {
          applied.packageDrift = true;
          this.enterConservative(
            'package_hash_drift',
            `seed package ${seed.package} != pinned ${this.expectedPackageHash}`,
          );
        } else if (this.expectedPackageHash === null) {
          // Adopting the seed's hash is the same class of hole as adopting the
          // sender's DID: it lets the first post define what we are running.
          if (this.unpinnedPolicy === 'reject') {
            applied.packageDrift = true;
            this.enterConservative(
              'package_hash_unpinned',
              `seed quoted ${seed.package}, but no package hash is pinned`,
            );
          } else {
            this.expectedPackageHash = seed.package;
          }
        }
        break;
      }
      case 'price': {
        const price = payload as RefereePrice;
        applied.price = price;
        this.applyPrice(price);
        break;
      }
      case 'flow': {
        const flow = payload as RefereeFlow;
        applied.flow = flow;
        const sweep = flow.n;
        const ledger = this.sweeps.get(sweep) ?? { priceSeen: false, flowSeen: false, mints: [] };
        ledger.flowSeen = true;
        ledger.mints = [...flow.mints];
        this.sweeps.set(sweep, ledger);
        applied.mints = ledger.mints;
        break;
      }
      case 'final': {
        const final = payload as RefereeFinal;
        applied.final = final;
        this.finalPx = Decimal.from(final.price);
        break;
      }
      default:
        break;
    }
    return applied;
  }

  /**
   * Rebuild in-memory state from rows this process previously verified.
   *
   * A restart reopens the database with the full referee history in it, but the
   * verifier starts empty: without this, the first tick after a crash has no
   * reference price, no history, no sweep and no final price until the referee
   * posts again — and if the season is already over, never. Every row returned by
   * `orderedForReplay` was signature-checked when it was ingested, and this
   * re-checks the two things a restart can still get wrong: that the row is one
   * we accepted, and that the sender is the pinned referee.
   */
  replay(record: {
    seq: number;
    ts: string;
    kind: string;
    senderDid: string;
    payload: unknown;
  }): boolean {
    const kind = record.kind as RefereeKind;
    if (!['seed', 'price', 'flow', 'positions', 'pnl', 'state', 'final'].includes(kind)) {
      return false;
    }
    if (this.refereeDid === null && this.unpinnedPolicy === 'reject') return false;
    if (this.refereeDid !== null && record.senderDid !== this.refereeDid) return false;
    if (this.refereeDid === null) this.refereeDid = record.senderDid;
    if (this.requireSeedBeforeState && !this.seedSeen && kind !== 'seed') return false;

    this.applyPayload(kind, record.payload);
    this.lastRefereeSeq = Math.max(this.lastRefereeSeq ?? 0, record.seq);
    if (this.lastPostAt === null || record.ts > this.lastPostAt) this.lastPostAt = record.ts;
    return true;
  }

  private applyPrice(price: RefereePrice): void {
    const sweep = price.n;
    const ledger = this.sweeps.get(sweep) ?? { priceSeen: false, flowSeen: false, mints: [] };
    ledger.priceSeen = true;
    this.sweeps.set(sweep, ledger);

    const reference = Decimal.from(price.ref.px);
    if (!reference.isPositive()) {
      this.enterConservative('reference_anomaly', `non-positive reference ${price.ref.px}`);
      return;
    }
    const previous = this.reference;
    if (previous !== null) {
      const jump = reference.sub(previous).abs().div(previous);
      if (jump.gt(this.maxReferenceJump)) {
        this.enterConservative(
          'reference_jump',
          `reference moved ${jump.toString()} in one sweep (${previous.toString()} -> ${reference.toString()})`,
        );
      } else {
        this.clearConservative('reference_jump');
      }
    }

    this.currentSweep = sweep;
    this.reference = reference;
    // The published limits are authoritative: the referee enforces exactly these
    // numbers, and recomputing ±5% locally can disagree with them at the cent.
    this.limits = { low: Decimal.from(price.limits[0]), high: Decimal.from(price.limits[1]) };
    this.globalPx = price.global !== undefined ? Decimal.from(price.global) : this.globalPx;
    this.ageSeconds = price.age_s ?? this.ageSeconds;
    this.referenceHistory.push(reference);
    if (this.referenceHistory.length > 512) this.referenceHistory.shift();
  }

  /**
   * Called once per reader cycle. Any sweep that produced a price but no flow
   * leaves its mints unknown: recorded as `mint_unknown`, never as failure, and
   * the reader goes conservative because the ledger's inputs are incomplete.
   */
  reconcileSweeps(graceSweeps = 1): Array<{ sweep: number; status: 'complete' | 'mint_unknown' }> {
    const results: Array<{ sweep: number; status: 'complete' | 'mint_unknown' }> = [];
    if (this.currentSweep === null) return results;
    for (const [sweep, ledger] of this.sweeps) {
      if (!ledger.priceSeen) continue;
      if (sweep > this.currentSweep - graceSweeps) continue;
      if (ledger.flowSeen) {
        results.push({ sweep, status: 'complete' });
        continue;
      }
      results.push({ sweep, status: 'mint_unknown' });
      this.enterConservative('flow_omitted', `sweep ${sweep} posted a price but no flow`);
    }
    return results;
  }

  /** Mints observed for a sweep, or an empty list when the flow is missing. */
  mintsFor(sweep: number): string[] {
    return this.sweeps.get(sweep)?.mints ?? [];
  }

  hasFlowFor(sweep: number): boolean {
    return this.sweeps.get(sweep)?.flowSeen ?? false;
  }

  /** Every local DID that the referee has confirmed minted, newest sweep last. */
  observedMints(): Set<string> {
    const all = new Set<string>();
    for (const ledger of this.sweeps.values()) for (const did of ledger.mints) all.add(did);
    return all;
  }

  get lastSeq(): number | null {
    return this.lastRefereeSeq;
  }
}

function extractSweep(payload: unknown): number | null {
  if (typeof payload !== 'object' || payload === null) return null;
  const value = (payload as { n?: unknown }).n;
  return typeof value === 'number' && Number.isInteger(value) ? value : null;
}
