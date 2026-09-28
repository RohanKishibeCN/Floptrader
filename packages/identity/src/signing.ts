/**
 * technocore.chat's Ed25519 did:key signing lane.
 *
 * A signed write carries `{did, sig, nonce, text}` and the signature covers
 * exactly `<room>|<nonce>|<text>` as UTF-8, where `<text>` is the text AFTER the
 * server's single-line sweep — the bytes that actually get stored. Signing the
 * pre-sweep text is the classic failure mode: it will not verify.
 *
 *   sig  = base64url(ed25519_sign(seed, utf8("room|nonce|text"))), 86 chars, unpadded
 *   nonce = 1..19 digits, strictly greater than the last nonce that key used in that room
 */
import {
  IdentityError,
  decodeSignature,
  didToPublicKey,
  encodeSignature,
  signBytes,
  verifyBytes,
} from './did.js';

export const ROOM_PATTERN = /^[a-z0-9][a-z0-9_-]{0,47}$/;
export const NONCE_PATTERN = /^[0-9]{1,19}$/;
export const MAX_MESSAGE_CHARS = 4096;

/**
 * The server's single-line sweep: every character in Unicode general categories
 * Cc, Cf, Cs, Co, Zl and Zp becomes a space, then both ends are trimmed.
 * Applied here so a signature always covers the stored bytes.
 */
const SWEEP_PATTERN = /[\p{Cc}\p{Cf}\p{Cs}\p{Co}\p{Zl}\p{Zp}]/gu;

export function singleLineSweep(text: string): string {
  return text.replace(SWEEP_PATTERN, ' ').trim();
}

export function assertRoomName(room: string): void {
  if (typeof room !== 'string' || !ROOM_PATTERN.test(room)) {
    throw new IdentityError(`invalid room name: ${JSON.stringify(room)}`);
  }
}

export function assertNonce(nonce: string): void {
  if (typeof nonce !== 'string' || !NONCE_PATTERN.test(nonce)) {
    throw new IdentityError(`invalid nonce: ${JSON.stringify(nonce)}`);
  }
}

/** The exact UTF-8 bytes technocore.chat verifies a room signature against. */
export function roomSignaturePayload(room: string, nonce: string, text: string): Uint8Array {
  return new TextEncoder().encode(`${room}|${nonce}|${text}`);
}

export interface SignedRoomMessage {
  did: string;
  sig: string;
  nonce: string;
  text: string;
}

/** Sign a room message after sweeping it. Returns the exact wire envelope. */
export function signRoomMessage(
  did: string,
  seed: Uint8Array,
  room: string,
  nonce: string,
  rawText: string,
): SignedRoomMessage {
  assertRoomName(room);
  assertNonce(nonce);
  const text = singleLineSweep(rawText);
  if (text.length > MAX_MESSAGE_CHARS) {
    throw new IdentityError(`message is ${text.length} chars, over the ${MAX_MESSAGE_CHARS} cap`);
  }
  const signature = signBytes(seed, roomSignaturePayload(room, nonce, text));
  return { did, sig: encodeSignature(signature), nonce, text };
}

/**
 * Verify a signed room message record against the room it was read from.
 *
 * A record with no `sig` field predates the signing lane: treat that as "not
 * re-verifiable", never as "invalid". A record whose DID is no did:key, whose
 * nonce is malformed, or whose signature does not cover `<room>|<nonce>|<text>`
 * is invalid and must be dropped by the caller.
 */
export function verifyRoomSignatureForRoom(
  did: string,
  nonce: string,
  text: string,
  sig: string,
  room: string,
): boolean {
  try {
    assertRoomName(room);
    assertNonce(nonce);
    const publicKey = didToPublicKey(did);
    return verifyBytes(
      decodeSignature(sig),
      roomSignaturePayload(room, nonce, text),
      publicKey,
    );
  } catch {
    return false;
  }
}

/**
 * The signature payload for a note write's signed lane:
 * `<ns>|<key>|<nonce>|<value>`. Only the two ownership namespaces
 * (room-owners, room-allow) accept signed notes; other notes are world-writable.
 */
export function noteSignaturePayload(namespace: string, key: string, nonce: string, value: string): Uint8Array {
  return new TextEncoder().encode(`${namespace}|${key}|${nonce}|${value}`);
}

/** The payload a room ownership claim signs: `room-owners|d-<room>|<nonce>|<did>`. */
export function roomOwnershipPayload(room: string, nonce: string, did: string): Uint8Array {
  return noteSignaturePayload('room-owners', room, nonce, did);
}

/** The payload a room allow-list write signs: `room-allow|d-<room>|<nonce>|<value>`. */
export function roomAllowPayload(room: string, nonce: string, value: string): Uint8Array {
  return noteSignaturePayload('room-allow', room, nonce, value);
}
