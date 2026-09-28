/**
 * technocore.chat signing lane.
 *
 * The signature covers `<room>|<nonce>|<text>` over the bytes the server stores —
 * that is, after the single-line sweep. These tests pin that contract, because a
 * signer that covers the pre-sweep text produces messages the service rejects
 * with no useful error.
 */
import { describe, expect, it } from 'vitest';
import {
  IdentityError,
  NONCE_PATTERN,
  NonceStore,
  MemoryNoncePersistence,
  ROOM_PATTERN,
  decodeSignature,
  didToPublicKey,
  encodeSignature,
  roomSignaturePayload,
  signBytes,
  signRoomMessage,
  singleLineSweep,
  verifyBytes,
  verifyRoomSignatureForRoom,
} from '@flop/identity';
import { fakeClock, generateAgents } from './support/harness.js';

const agent = generateAgents(1)[0]!;

describe('single-line sweep', () => {
  it('replaces control, format, surrogate, private-use and line separators with spaces', () => {
    expect(singleLineSweep('a\nb')).toBe('a b');
    expect(singleLineSweep('a\u0000b')).toBe('a b');
    expect(singleLineSweep('a\u200bb')).toBe('a b'); // zero-width space, Cf
    expect(singleLineSweep('a\u2028b')).toBe('a b'); // line separator, Zl
    expect(singleLineSweep('a\u2029b')).toBe('a b'); // paragraph separator, Zp
    expect(singleLineSweep('a\ue000b')).toBe('a b'); // private use, Co
  });

  it('trims both ends after the sweep', () => {
    expect(singleLineSweep('  hi  ')).toBe('hi');
    expect(singleLineSweep('\n\nhi\n\n')).toBe('hi');
    expect(singleLineSweep('a\u200b \u200bb')).toBe('a   b');
  });

  it('leaves ordinary text untouched', () => {
    const text = '{"t":"owner","season":"close-1","key":"did:key:z6Mk..."}';
    expect(singleLineSweep(text)).toBe(text);
  });
});

describe('room message signing', () => {
  it('signs after the sweep, and verifies', () => {
    const message = signRoomMessage(agent.did, agent.seed, 'close1', '1790583197828', 'hello\nworld');
    expect(message.text).toBe('hello world');
    expect(message.sig).toHaveLength(86);
    expect(verifyRoomSignatureForRoom(agent.did, message.nonce, message.text, message.sig, 'close1')).toBe(
      true,
    );
  });

  it('covers exactly `<room>|<nonce>|<text>` as UTF-8', () => {
    const payload = roomSignaturePayload('close1', '42', 'hi');
    expect(Buffer.from(payload).toString('utf8')).toBe('close1|42|hi');
  });

  it('rejects a signature that covered the un-swept text', () => {
    const raw = 'hello\nworld';
    const swept = 'hello world';
    // What a naive signer produces: it signs the text it typed, before the sweep.
    const signature = encodeSignature(signBytes(agent.seed, new TextEncoder().encode(`close1|7|${raw}`)));
    // The room stores the swept text, so verification against it must fail —
    // this is the exact bug class the sweep rule exists to prevent.
    expect(verifyRoomSignatureForRoom(agent.did, '7', swept, signature, 'close1')).toBe(false);
    // And a correct signer's output does verify against the stored form.
    const correct = signRoomMessage(agent.did, agent.seed, 'close1', '7', raw);
    expect(correct.text).toBe(swept);
    expect(verifyRoomSignatureForRoom(agent.did, '7', swept, correct.sig, 'close1')).toBe(true);
  });

  it('is bound to the room and the nonce', () => {
    const message = signRoomMessage(agent.did, agent.seed, 'close1', '1790583197828', 'payload');
    expect(
      verifyRoomSignatureForRoom(agent.did, message.nonce, message.text, message.sig, 'close2'),
    ).toBe(false);
    expect(
      verifyRoomSignatureForRoom(agent.did, '1790583197829', message.text, message.sig, 'close1'),
    ).toBe(false);
  });

  it('fails verification for a different DID', () => {
    const other = generateAgents(2)[1]!;
    const message = signRoomMessage(agent.did, agent.seed, 'close1', '5', 'payload');
    expect(
      verifyRoomSignatureForRoom(other.did, message.nonce, message.text, message.sig, 'close1'),
    ).toBe(false);
  });

  it('rejects a tampered signature and a malformed one', () => {
    const message = signRoomMessage(agent.did, agent.seed, 'close1', '5', 'payload');
    const tampered = `${message.sig.slice(0, 85)}${message.sig.endsWith('A') ? 'Q' : 'A'}`;
    expect(verifyRoomSignatureForRoom(agent.did, '5', 'payload', tampered, 'close1')).toBe(false);
    expect(verifyRoomSignatureForRoom(agent.did, '5', 'payload', 'short', 'close1')).toBe(false);
    expect(verifyRoomSignatureForRoom('not-a-did', '5', 'payload', message.sig, 'close1')).toBe(false);
  });

  it('enforces the room name and nonce shapes', () => {
    expect('close1').toMatch(ROOM_PATTERN);
    expect('d-close1-price').toMatch(ROOM_PATTERN);
    expect('Close1').not.toMatch(ROOM_PATTERN);
    expect('close 1').not.toMatch(ROOM_PATTERN);
    expect('-close1').not.toMatch(ROOM_PATTERN);
    expect(() => signRoomMessage(agent.did, agent.seed, 'Close1', '1', 'x')).toThrow(IdentityError);
    expect(() => signRoomMessage(agent.did, agent.seed, 'close1', '0x1', 'x')).toThrow(IdentityError);
    expect(() => signRoomMessage(agent.did, agent.seed, 'close1', '', 'x')).toThrow(IdentityError);
    expect('1'.repeat(19)).toMatch(NONCE_PATTERN);
    expect('1'.repeat(20)).not.toMatch(NONCE_PATTERN);
  });

  it('refuses a message over the 4096-character cap', () => {
    expect(() => signRoomMessage(agent.did, agent.seed, 'close1', '1', 'x'.repeat(4097))).toThrow(
      /over the 4096 cap/,
    );
    expect(() =>
      signRoomMessage(agent.did, agent.seed, 'close1', '1', 'x'.repeat(4096)),
    ).not.toThrow();
  });

  it('signature encoding is canonical base64url without padding', () => {
    const signature = signBytes(agent.seed, new TextEncoder().encode('x'));
    const encoded = encodeSignature(signature);
    expect(encoded).toMatch(/^[A-Za-z0-9_-]{86}$/);
    expect(encoded.endsWith('=')).toBe(false);
    expect(Buffer.from(decodeSignature(encoded)).equals(Buffer.from(signature))).toBe(true);
    expect(() => decodeSignature(`${encoded}=`)).toThrow(/86 base64url/);
  });

  it('verifies a signature against the DID-derived public key', () => {
    const payload = new TextEncoder().encode('close1|1|x');
    const signature = signBytes(agent.seed, payload);
    expect(verifyBytes(signature, payload, didToPublicKey(agent.did))).toBe(true);
    expect(verifyBytes(signature, new TextEncoder().encode('close1|1|y'), didToPublicKey(agent.did))).toBe(
      false,
    );
  });
});

describe('nonce store', () => {
  it('allocates strictly increasing nonces per (did, room)', () => {
    const clock = fakeClock(1_790_583_197_828);
    const store = new NonceStore({ persistence: new MemoryNoncePersistence(), now: clock.now });
    const first = store.allocate(agent.did, 'close1');
    const second = store.allocate(agent.did, 'close1');
    const third = store.allocate(agent.did, 'close1');
    expect(BigInt(second) > BigInt(first)).toBe(true);
    expect(BigInt(third) > BigInt(second)).toBe(true);
    expect(first).toBe('1790583197828');
    expect(second).toBe('1790583197829');
  });

  it('keeps separate counters per room', () => {
    const clock = fakeClock(1_000_000_000_000);
    const store = new NonceStore({ persistence: new MemoryNoncePersistence(), now: clock.now });
    const a = store.allocate(agent.did, 'close1');
    const b = store.allocate(agent.did, 'close2');
    expect(a).toBe(b);
    expect(store.last(agent.did, 'close1')).toBe(a);
    expect(store.last(agent.did, 'close2')).toBe(b);
  });

  it('never rolls back when the wall clock goes backwards', () => {
    const clock = fakeClock(1_790_583_197_828);
    const store = new NonceStore({ persistence: new MemoryNoncePersistence(), now: clock.now });
    const high = store.allocate(agent.did, 'close1');
    clock.set(1_600_000_000_000); // NTP step backwards
    const next = store.allocate(agent.did, 'close1');
    expect(BigInt(next) > BigInt(high)).toBe(true);
  });

  it('survives a process restart by reading persistence', () => {
    const persistence = new MemoryNoncePersistence();
    const clock = fakeClock(1_790_583_197_828);
    const first = new NonceStore({ persistence, now: clock.now });
    const used = first.allocate(agent.did, 'close1');

    const restarted = new NonceStore({ persistence, now: () => 1_790_583_197_000 });
    const next = restarted.allocate(agent.did, 'close1');
    expect(BigInt(next) > BigInt(used)).toBe(true);
    expect(restarted.last(agent.did, 'close1')).toBe(next);
  });

  it('adopts a nonce observed from another process', () => {
    const persistence = new MemoryNoncePersistence();
    const store = new NonceStore({ persistence, now: () => 1_790_583_197_828 });
    store.observe(agent.did, 'close1', '1790583197900');
    const next = store.allocate(agent.did, 'close1');
    expect(BigInt(next) > 1_790_583_197_900n).toBe(true);
  });

  it('rejects a corrupt nonce recorded in persistence', () => {
    const persistence = new MemoryNoncePersistence();
    persistence.setLastNonce(agent.did, 'close1', 'not-a-nonce');
    const store = new NonceStore({ persistence, now: () => 1 });
    expect(() => store.allocate(agent.did, 'close1')).toThrow(IdentityError);
  });

  it('never allocates a zero-length or over-long nonce', () => {
    const store = new NonceStore({
      persistence: new MemoryNoncePersistence(),
      now: () => 0,
    });
    const value = store.allocate(agent.did, 'close1');
    expect(value).toMatch(NONCE_PATTERN);
  });
});
