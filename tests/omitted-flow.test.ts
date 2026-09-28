/**
 * The omitted-flow state machine, the signature/DID gates, the package pin and
 * the reference-jump guard — driven with real signed referee posts.
 *
 * The point of these tests is that a missing `flow` post is `mint_unknown`, never
 * `failed`, and that every way the referee can disagree with our pinned view puts
 * the verifier into conservative mode without ever widening risk. The posts are
 * built with the same `signRoomMessage` the live service verifies against, so a
 * gate that only checks that *a* signature exists would fail here.
 */
import { describe, expect, it } from 'vitest';
import { signRoomMessage } from '@flop/identity';
import {
  RefereeVerifier,
  type RefereeVerifierOptions,
  type RoomMessage,
} from '@flop/technocore';
import {
  referenceRules,
  type RefereeFlow,
  type RefereePrice,
  type RefereeSeed,
} from '@flop/close-call';
import { Logger } from '../apps/orchestrator/src/logger.js';
import { generateAgents } from './support/harness.js';

const silent = Logger.create({ level: 'fatal' });
const referee = generateAgents(1)[0]!;
const other = generateAgents(2)[1]!;
const mints = generateAgents(4).slice(2).map((agent) => agent.did);

const PRICE_ROOM = 'd-close1-price';
const FLOW_ROOM = 'd-close1-flow';

function ts(seq: number): string {
  return `2026-09-28T08:40:${String(seq).padStart(2, '0')}.000Z`;
}

/**
 * The exact price shape the live referee emits, including the extra keys
 * (`age_s`, `applied`, `for`) the published schema tolerates via passthrough.
 */
function pricePayload(patch: Partial<RefereePrice> = {}): RefereePrice {
  return {
    t: 'price',
    n: 824,
    ref: { px: '223.01', tid: 444195233496965, time: '2026-09-28T08:40:00Z' },
    limits: ['211.86', '234.16'],
    global: '221.22',
    file: 'a'.repeat(64),
    age_s: 0,
    applied: '223.13',
    for: 825,
    ...patch,
  };
}

function priceAt(n: number, px: string, limits: [string, string] = ['211.86', '234.16']): RefereePrice {
  return pricePayload({ n, ref: { px, tid: 444195233496965, time: '2026-09-28T08:40:00Z' }, limits });
}

function flowPayload(n: number, dids: string[]): RefereeFlow {
  return { t: 'flow', n, mints: dids, rooms: [], file: 'f'.repeat(64) };
}

function seedPayload(packageHash: string): RefereeSeed {
  return {
    t: 'seed',
    season: 'close-1',
    price: '223.01',
    trade: { time: '2026-09-25T12:05:00Z', tid: 1 },
    package: packageHash,
    rooms: [],
  };
}

/** A correctly signed referee post, or an unsigned one when asked. */
function post(
  room: string,
  payload: object,
  options: { seq: number; nonce: string; signature?: boolean },
): RoomMessage {
  const text = JSON.stringify(payload);
  if (options.signature === false) {
    return { seq: options.seq, ts: ts(options.seq), from: referee.did, text, nonce: options.nonce };
  }
  const signed = signRoomMessage(referee.did, referee.seed, room, options.nonce, text);
  return { seq: options.seq, ts: ts(options.seq), from: signed.did, text: signed.text, nonce: signed.nonce, sig: signed.sig };
}

function verifier(options: Partial<RefereeVerifierOptions> = {}): RefereeVerifier {
  return new RefereeVerifier({
    rules: referenceRules(),
    logger: silent,
    expectedRefereeDid: referee.did,
    ...options,
  });
}

describe('omitted flow', () => {
  it('is complete once a flow arrives for the sweep', () => {
    const engine = verifier();
    engine.observe(PRICE_ROOM, post(PRICE_ROOM, pricePayload({ n: 824 }), { seq: 1, nonce: '1' }));
    engine.observe(FLOW_ROOM, post(FLOW_ROOM, flowPayload(824, mints), { seq: 2, nonce: '2' }));

    expect(engine.hasFlowFor(824)).toBe(true);
    expect(engine.mintsFor(824)).toEqual(mints);
    expect(engine.reconcileSweeps(0)).toEqual([{ sweep: 824, status: 'complete' }]);
  });

  it('classifies a price with no flow as mint_unknown, never failed', () => {
    const engine = verifier();
    engine.observe(PRICE_ROOM, post(PRICE_ROOM, priceAt(10, '223.01'), { seq: 1, nonce: '1' }));
    // A later sweep means the grace window for sweep 10 has elapsed.
    engine.observe(PRICE_ROOM, post(PRICE_ROOM, priceAt(11, '223.20'), { seq: 2, nonce: '2' }));

    const results = engine.reconcileSweeps();
    expect(results).toContainEqual({ sweep: 10, status: 'mint_unknown' });
    expect(results.some((result) => result.status === 'complete')).toBe(false);
    // The verifier records the reason and goes conservative, but the mints are
    // "unknown", not "failed": the ledger simply lacks an input.
    expect(engine.state.conservative).toBe(true);
    expect(engine.state.conservativeReasons.join(' ')).toContain('flow_omitted');
  });
});

describe('referee identity gates', () => {
  it('rejects an unsigned referee post and enters conservative mode', () => {
    const engine = verifier();
    const observation = engine.observe(
      PRICE_ROOM,
      post(PRICE_ROOM, pricePayload(), { seq: 1, nonce: '1', signature: false }),
    );
    expect(observation?.record.rejectedBecause).toBe('signature_invalid');
    expect(observation?.record.accepted).toBe(false);
    expect(observation?.enteredConservativeMode).toBe(true);
    expect(engine.state.conservative).toBe(true);
    expect(engine.state.conservativeReasons.join(' ')).toContain('referee_signature_invalid');
  });

  it('rejects a valid signature from a DID that is not the pinned referee', () => {
    const engine = verifier();
    // The signature is genuinely valid for `other.did`; the refusal is that the
    // sender is not the referee we pinned, not that the crypto failed.
    const text = JSON.stringify(pricePayload());
    const signed = signRoomMessage(other.did, other.seed, PRICE_ROOM, '1', text);
    const observation = engine.observe(PRICE_ROOM, {
      seq: 1,
      ts: ts(1),
      from: signed.did,
      text: signed.text,
      nonce: signed.nonce,
      sig: signed.sig,
    });

    expect(observation?.record.signatureValid).toBe(true);
    expect(observation?.record.rejectedBecause).toBe('unexpected_referee_did');
    expect(engine.state.conservative).toBe(true);
  });
});

describe('package pin', () => {
  it('treats a seed hash that disagrees with the pin as drift and pauses', () => {
    const pinned = 'a'.repeat(64);
    const engine = verifier({ expectedPackageHash: pinned });
    const observation = engine.observe(PRICE_ROOM, post(PRICE_ROOM, seedPayload('b'.repeat(64)), { seq: 1, nonce: '1' }));

    expect(observation?.packageDrift).toBe(true);
    expect(engine.state.packageHash).toBe('b'.repeat(64));
    expect(engine.state.expectedPackageHash).toBe(pinned);
    // This is the "pause active trading on a package hash mismatch" behaviour.
    expect(engine.state.conservative).toBe(true);
    expect(engine.state.conservativeReasons.join(' ')).toContain('package_hash_drift');
  });
});

describe('market snapshot', () => {
  it('publishes the posted limits verbatim, the reference, the ordered history and degraded=true', () => {
    const engine = verifier({ expectedPackageHash: 'a'.repeat(64) });
    // Drift puts us in conservative mode; the snapshot must reflect it.
    engine.observe(PRICE_ROOM, post(PRICE_ROOM, seedPayload('b'.repeat(64)), { seq: 1, nonce: '1' }));
    engine.observe(
      PRICE_ROOM,
      post(PRICE_ROOM, priceAt(10, '223.01', ['211.86', '234.16']), { seq: 2, nonce: '2' }),
    );
    engine.observe(
      PRICE_ROOM,
      post(PRICE_ROOM, priceAt(11, '223.20', ['212.04', '234.36']), { seq: 3, nonce: '3' }),
    );

    const snapshot = engine.snapshot(new Date('2026-09-28T08:40:03Z'));
    // The limits are asserted exactly as posted — never recomputed as ref ± 5%.
    expect(snapshot.limits?.low.toString()).toBe('212.04');
    expect(snapshot.limits?.high.toString()).toBe('234.36');
    expect(snapshot.reference?.toString()).toBe('223.20');
    expect(snapshot.history.map(String)).toEqual(['223.01', '223.20']);
    expect(snapshot.globalPx?.toString()).toBe('221.22');
    expect(snapshot.sweep).toBe(11);
    expect(snapshot.degraded).toBe(true);
    expect(snapshot.degradedReason).toContain('package_hash_drift');
  });
});

describe('reference jump guard', () => {
  it('flags a >25% move, ignores a normal move, and clears when calm returns', () => {
    const engine = verifier();
    engine.observe(PRICE_ROOM, post(PRICE_ROOM, priceAt(1, '223.01'), { seq: 1, nonce: '1' }));
    expect(engine.snapshot().degraded).toBe(false);

    // A normal move does not trip the guard.
    engine.observe(PRICE_ROOM, post(PRICE_ROOM, priceAt(2, '223.50'), { seq: 2, nonce: '2' }));
    expect(engine.state.conservative).toBe(false);
    expect(engine.state.conservativeReasons).not.toContain('reference_jump');

    // ~79% in one sweep is implausible and must be treated as an anomaly.
    engine.observe(PRICE_ROOM, post(PRICE_ROOM, priceAt(3, '400.00'), { seq: 3, nonce: '3' }));
    expect(engine.state.conservative).toBe(true);
    expect(engine.state.conservativeReasons).toContain('reference_jump');
    expect(engine.snapshot().degraded).toBe(true);
    expect(engine.snapshot().degradedReason).toContain('reference_jump');

    // A later normal move clears the reason and leaves conservative mode.
    engine.observe(PRICE_ROOM, post(PRICE_ROOM, priceAt(4, '400.50'), { seq: 4, nonce: '4' }));
    expect(engine.state.conservative).toBe(false);
    expect(engine.snapshot().degraded).toBe(false);
  });
});
