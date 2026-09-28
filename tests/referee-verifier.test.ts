/**
 * The referee verifier: what it believes, what it refuses, and how it degrades.
 *
 * The referee is the authority on contest state, and every one of its posts
 * arrives as ordinary room traffic signed by its DID. So the tests here are
 * about the three things that keep the process honest:
 *
 *   - nothing is believed unless the signature covers `<room>|<nonce>|<text>`
 *     for the room it came from, and the sender is the referee DID;
 *   - anything anomalous — a drift in the pinned package hash, a reference that
 *     jumps or goes non-positive, a sweep whose flow was omitted — puts the
 *     verifier into conservative mode, which never widens risk;
 *   - a sweep with a price but no flow is `mint_unknown`, never a failure.
 *
 * The reader is not stopped by any of this. Reading is how we learn the problem
 * is over, and the last test in the file makes that explicit.
 */
import { describe, expect, it } from 'vitest';
import { Decimal, referenceRules } from '@flop/close-call';
import { RefereeVerifier, comparePackageHash, decideOnDrift, normalizeHash } from '@flop/technocore';
import { didFromSeed } from '@flop/identity';
import { Logger } from '../apps/orchestrator/src/logger.js';
import { FakeReferee } from './support/orchestrator.js';
import { FakeTransport, type RoomMessageLike } from './support/fake-transport.js';

const silent = Logger.create({ level: 'fatal' });
const rules = referenceRules();
const PRICE_ROOM = 'd-close1-price';
const FLOW_ROOM = 'd-close1-flow';
const STATE_ROOM = 'd-close1-state';
const PIN = 'a'.repeat(64);

const refereeSeed = new Uint8Array(32).fill(11);
const refereeDid = didFromSeed(refereeSeed);
const impostorSeed = new Uint8Array(32).fill(13);
const impostorDid = didFromSeed(impostorSeed);

/** A transport, a signing referee, and a verifier pinned to that referee. */
function setup(options: { pin?: boolean; packageHash?: string } = {}) {
  const transport = new FakeTransport();
  const referee = new FakeReferee(transport);
  const verifier = new RefereeVerifier({
    rules,
    logger: silent,
    expectedRefereeDid: options.pin === false ? null : refereeDid,
    ...(options.packageHash === undefined ? {} : { expectedPackageHash: options.packageHash }),
  });
  return { transport, referee, verifier };
}

/** The messages a room currently retains, in order. */
function retained(transport: FakeTransport, room: string): RoomMessageLike[] {
  return transport.room(room).messagesSince(0);
}

function last(transport: FakeTransport, room: string): RoomMessageLike {
  const messages = retained(transport, room);
  return messages[messages.length - 1]!;
}

describe('signature and identity', () => {
  it('believes a signed seed and fixes the referee DID on the first verified post', () => {
    const { transport, referee, verifier } = setup({ pin: false });
    expect(verifier.state.refereeDid).toBeNull();

    referee.seedPost(PIN);
    const observation = verifier.observe(STATE_ROOM, last(transport, STATE_ROOM));

    expect(observation).not.toBeNull();
    expect(observation!.record.accepted).toBe(true);
    expect(observation!.record.signatureValid).toBe(true);
    expect(observation!.seed?.package).toBe(PIN);
    expect(verifier.state.refereeDid).toBe(refereeDid);
    expect(verifier.state.packageHash).toBe(PIN);
    // Nothing was pinned ahead of the seed, so the seed's hash becomes the pin.
    expect(verifier.state.expectedPackageHash).toBe(PIN);
    expect(verifier.state.conservative).toBe(false);
  });

  it('refuses a message whose signature covers a different room', () => {
    const { transport, verifier } = setup();
    // Signed for close1, then replayed into the price room.
    const foreign = transport.room('close1').appendFrom(
      JSON.stringify({ t: 'price', n: 10, ref: { px: '200', time: 'x', tid: 't' }, limits: ['190', '210'] }),
      { seed: refereeSeed, did: refereeDid, nonce: 1 },
    );
    const replayed = transport.room(PRICE_ROOM).append({ ...foreign, seq: 1 });

    const observation = verifier.observe(PRICE_ROOM, replayed);
    expect(observation!.record.signatureValid).toBe(false);
    expect(observation!.record.rejectedBecause).toBe('signature_invalid');
    expect(verifier.state.conservative).toBe(true);
    expect(verifier.state.conservativeReasons).toContain('referee_signature_invalid');
    // Nothing about the market was learned from it.
    expect(verifier.state.reference).toBeNull();
  });

  it('refuses an unsigned referee post', () => {
    const { transport, verifier } = setup();
    const unsigned = transport.enqueue(PRICE_ROOM, {
      text: JSON.stringify({ t: 'price', n: 1, ref: { px: '200', time: 'x', tid: 't' }, limits: ['190', '210'] }),
      from: refereeDid,
    });
    expect(verifier.observe(PRICE_ROOM, unsigned)!.record.signatureValid).toBe(false);
    expect(verifier.state.conservative).toBe(true);
  });

  it('refuses a valid signature from an unexpected DID', () => {
    const { transport, verifier } = setup();
    transport.room(STATE_ROOM).appendFrom(
      JSON.stringify({
        t: 'seed',
        season: 'close-1',
        price: '200',
        trade: { time: 'x', tid: 't' },
        package: PIN,
        rooms: [],
      }),
      { seed: impostorSeed, did: impostorDid, nonce: 1 },
    );
    const observation = verifier.observe(STATE_ROOM, last(transport, STATE_ROOM));
    expect(observation!.record.signatureValid).toBe(true);
    expect(observation!.record.rejectedBecause).toBe('unexpected_referee_did');
    expect(verifier.state.conservativeReasons).toContain('referee_did_mismatch');
    expect(verifier.state.refereeDid).toBe(refereeDid);
  });

  it('ignores anything that is not a referee post', () => {
    const { transport, verifier } = setup();
    const chatter = transport.enqueue(PRICE_ROOM, { text: 'gm', from: refereeDid });
    const owner = transport.enqueue(PRICE_ROOM, {
      text: JSON.stringify({ t: 'owner', season: 'close-1', key: refereeDid }),
      from: refereeDid,
    });
    const broken = transport.enqueue(PRICE_ROOM, { text: '{not json', from: refereeDid });

    for (const message of [chatter, owner, broken]) {
      expect(verifier.observe(PRICE_ROOM, message)).toBeNull();
    }
    expect(verifier.state.conservative).toBe(false);
    expect(verifier.state.currentSweep).toBeNull();
  });

  it('treats a well-shaped but invalid payload as noise, not as state', () => {
    const { transport, verifier } = setup();
    // `limits` must be a two-tuple of amounts; one value is a schema failure.
    transport.room(PRICE_ROOM).appendFrom(
      JSON.stringify({ t: 'price', n: 5, ref: { px: '200', time: 'x', tid: 't' }, limits: ['190'] }),
      { seed: refereeSeed, did: refereeDid, nonce: 1 },
    );
    expect(verifier.observe(PRICE_ROOM, last(transport, PRICE_ROOM))).toBeNull();
    expect(verifier.state.reference).toBeNull();
  });
});

describe('prices, limits and the sweep clock', () => {
  it('adopts the published limits rather than recomputing them', () => {
    const { transport, referee, verifier } = setup();
    referee.seedPost(PIN);
    verifier.observe(STATE_ROOM, last(transport, STATE_ROOM));

    // Deliberately not exactly ±5%: the referee enforces these numbers.
    referee.price(824, '223.01', ['211.86', '234.16']);
    verifier.observe(PRICE_ROOM, last(transport, PRICE_ROOM));

    const state = verifier.state;
    expect(state.currentSweep).toBe(824);
    expect(state.reference?.toString()).toBe('223.01');
    expect(state.limits?.low.toString()).toBe('211.86');
    expect(state.limits?.high.toString()).toBe('234.16');
    expect(state.historyLength).toBe(1);
    expect(state.conservative).toBe(false);
  });

  it('goes conservative on a non-positive reference', () => {
    const { transport, referee, verifier } = setup();
    referee.price(1, '0.01', ['0', '0.02']);
    // The schema allows "0"; a reference of zero is the anomaly under test.
    transport.room(PRICE_ROOM).appendFrom(
      JSON.stringify({ t: 'price', n: 2, ref: { px: '0', time: 'x', tid: 't' }, limits: ['0', '0'] }),
      { seed: refereeSeed, did: refereeDid, nonce: 99 },
    );
    verifier.observe(PRICE_ROOM, last(transport, PRICE_ROOM));
    expect(verifier.state.conservativeReasons).toContain('reference_anomaly');
  });

  it('goes conservative on a reference jump, and recovers on a normal move', () => {
    const { transport, referee, verifier } = setup();
    referee.price(10, '200');
    verifier.observe(PRICE_ROOM, last(transport, PRICE_ROOM));
    expect(verifier.state.conservative).toBe(false);

    referee.price(11, '260'); // +30%, beyond the 25% guard
    verifier.observe(PRICE_ROOM, last(transport, PRICE_ROOM));
    expect(verifier.state.conservativeReasons).toContain('reference_jump');

    referee.price(12, '265'); // +1.9%: the guard clears
    verifier.observe(PRICE_ROOM, last(transport, PRICE_ROOM));
    expect(verifier.state.conservativeReasons).not.toContain('reference_jump');
    expect(verifier.state.conservative).toBe(false);
  });

  it('reports the lock once the sweep passes it', () => {
    const { transport, referee, verifier } = setup();
    referee.price(rules.lockSweep, '200');
    verifier.observe(PRICE_ROOM, last(transport, PRICE_ROOM));
    expect(verifier.state.locked).toBe(false);

    referee.price(rules.lockSweep + 1, '200');
    verifier.observe(PRICE_ROOM, last(transport, PRICE_ROOM));
    expect(verifier.state.locked).toBe(true);
    expect(verifier.snapshot(new Date()).locked).toBe(true);
  });
});

describe('the package pin', () => {
  it('adopts the seed hash when nothing was pinned', () => {
    const { transport, referee, verifier } = setup({ pin: false });
    referee.seedPost(PIN);
    verifier.observe(STATE_ROOM, last(transport, STATE_ROOM));
    expect(verifier.state.expectedPackageHash).toBe(PIN);
    expect(verifier.state.conservative).toBe(false);
  });

  it('enters conservative mode on drift and never adopts the new hash as the pin', () => {
    const drifted = 'c'.repeat(64);
    const { transport, referee, verifier } = setup({ packageHash: PIN });
    referee.seedPost(drifted);

    const observation = verifier.observe(STATE_ROOM, last(transport, STATE_ROOM));
    expect(observation!.packageDrift).toBe(true);
    expect(observation!.enteredConservativeMode).toBe(true);
    expect(verifier.state.conservativeReasons).toContain('package_hash_drift');
    expect(verifier.state.expectedPackageHash).toBe(PIN);
    expect(verifier.state.packageHash).toBe(drifted);
    expect(decideOnDrift(comparePackageHash(PIN, drifted), 'seed').action).toBe('pause_trading_and_alert');
  });

  it('stays clear when the seed agrees with the pin', () => {
    const { transport, referee, verifier } = setup({ packageHash: PIN });
    referee.seedPost(PIN);
    const observation = verifier.observe(STATE_ROOM, last(transport, STATE_ROOM));
    expect(observation!.packageDrift).toBe(false);
    expect(verifier.state.conservative).toBe(false);
  });

  it('notices a pin applied after the fact', () => {
    const { transport, referee, verifier } = setup({ pin: false });
    referee.seedPost('d'.repeat(64));
    verifier.observe(STATE_ROOM, last(transport, STATE_ROOM));
    expect(verifier.state.conservative).toBe(false);

    verifier.pin({ packageHash: PIN });
    expect(verifier.state.conservativeReasons).toContain('package_hash_drift');
  });
});

describe('flows, mints and omitted sweeps', () => {
  it('records the mints a flow names', () => {
    const { transport, referee, verifier } = setup();
    const minted = [refereeDid, impostorDid];
    referee.flow(20, minted);
    const observation = verifier.observe(FLOW_ROOM, last(transport, FLOW_ROOM));

    expect(observation!.mints).toEqual(minted);
    expect(verifier.mintsFor(20)).toEqual(minted);
    expect(verifier.hasFlowFor(20)).toBe(true);
    expect([...verifier.observedMints()].sort()).toEqual([...minted].sort());
  });

  it('calls a price-without-flow sweep mint_unknown, not failed', () => {
    const { transport, referee, verifier } = setup();
    referee.price(100, '200');
    verifier.observe(PRICE_ROOM, last(transport, PRICE_ROOM));
    referee.price(101, '200');
    verifier.observe(PRICE_ROOM, last(transport, PRICE_ROOM));

    const results = verifier.reconcileSweeps();
    expect(results).toEqual([{ sweep: 100, status: 'mint_unknown' }]);
    expect(verifier.mintsFor(100)).toEqual([]);
    expect(verifier.state.conservativeReasons).toContain('flow_omitted');
  });

  it('does not settle a sweep that is still inside the grace period', () => {
    const { transport, referee, verifier } = setup();
    referee.price(100, '200');
    verifier.observe(PRICE_ROOM, last(transport, PRICE_ROOM));
    referee.price(101, '200');
    verifier.observe(PRICE_ROOM, last(transport, PRICE_ROOM));

    expect(verifier.reconcileSweeps(2)).toEqual([]);
  });

  it('marks a sweep complete once its flow arrives', () => {
    const { transport, referee, verifier } = setup();
    referee.price(100, '200');
    verifier.observe(PRICE_ROOM, last(transport, PRICE_ROOM));
    referee.flow(100, [refereeDid]);
    verifier.observe(FLOW_ROOM, last(transport, FLOW_ROOM));
    referee.price(101, '200');
    verifier.observe(PRICE_ROOM, last(transport, PRICE_ROOM));

    expect(verifier.reconcileSweeps()).toEqual([{ sweep: 100, status: 'complete' }]);
  });
});

describe('conservative mode', () => {
  it('accumulates reasons and only clears the one named', () => {
    const { verifier } = setup();
    verifier.enterConservative('alpha', 'a');
    verifier.enterConservative('beta', 'b');
    expect(verifier.state.conservative).toBe(true);

    verifier.clearConservative('alpha');
    expect(verifier.state.conservative).toBe(true);
    expect(verifier.state.conservativeReasons).toEqual(['beta']);

    verifier.clearConservative('beta');
    expect(verifier.state.conservative).toBe(false);
  });

  it('degrades the snapshot rather than stopping the reader', () => {
    const { transport, referee, verifier } = setup();
    referee.price(1, '200');
    verifier.observe(PRICE_ROOM, last(transport, PRICE_ROOM));

    verifier.enterConservative('flow_omitted', 'sweep 0 posted a price but no flow');
    const degraded = verifier.snapshot(new Date('2026-09-28T12:00:00Z'));
    expect(degraded.degraded).toBe(true);
    expect(degraded.degradedReason).toContain('flow_omitted');
    // The market view is still published; the risk layer is what refuses.
    expect(degraded.reference?.toString()).toBe('200');

    // And a later price still lands, which is how the mode is escaped.
    referee.price(2, '201');
    verifier.observe(PRICE_ROOM, last(transport, PRICE_ROOM));
    expect(verifier.state.currentSweep).toBe(2);
  });

  it('reports the age of the last accepted post', () => {
    const { transport, referee, verifier } = setup();
    referee.price(1, '200');
    verifier.observe(PRICE_ROOM, last(transport, PRICE_ROOM));
    const ts = last(transport, PRICE_ROOM).ts;
    const later = new Date(Date.parse(ts) + 42_000);
    expect(verifier.snapshot(later).ageSeconds).toBe(42);
  });
});

describe('the package comparison helper', () => {
  it('treats two absences as no claim and one absence as drift', () => {
    expect(comparePackageHash(null, null).drift).toBe(false);
    expect(comparePackageHash(null, PIN).drift).toBe(true);
    expect(comparePackageHash(PIN, null).drift).toBe(true);
    expect(comparePackageHash(`sha256:${PIN}`, PIN).drift).toBe(false);
    expect(normalizeHash(`SHA256:${PIN.toUpperCase()}`)).toBe(PIN);
  });

  it('never switches the package automatically, whatever the role', () => {
    const drifted = comparePackageHash(PIN, 'e'.repeat(64));
    for (const role of ['seed', 'upstream'] as const) {
      expect(decideOnDrift(drifted, role).switchPackageAutomatically).toBe(false);
    }
    expect(decideOnDrift(drifted, 'upstream').action).toBe('pause_active_trading');
    expect(decideOnDrift(comparePackageHash(PIN, PIN), 'seed').action).toBe('continue');
  });

  it('uses Decimal for the reference so no float ever enters the window', () => {
    const { transport, referee, verifier } = setup();
    referee.price(1, '0.07', ['0.06', '0.08']);
    verifier.observe(PRICE_ROOM, last(transport, PRICE_ROOM));
    expect(verifier.state.reference?.toString()).toBe('0.07');
    expect(verifier.state.reference!.eq(Decimal.from('0.07'))).toBe(true);
  });
});
