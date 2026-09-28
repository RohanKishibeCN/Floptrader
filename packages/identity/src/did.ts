/**
 * did:key encoding for Ed25519, byte-compatible with technocore.chat.
 *
 *   key   = 32 random bytes
 *   pub   = Ed25519 public key (32 bytes)
 *   bytes = 0xed 0x01 || pub        (multicodec ed25519-pub, varint)
 *   mb    = "z" || base58btc(bytes) (multibase prefix)
 *   did   = "did:key:" || mb
 *
 * The resulting public key multibase is always 48 characters (z6Mk + 44), which
 * is what the official fold regex `did:key:z6Mk[1-9A-HJ-NP-Za-km-z]{44}` expects.
 */
import { ed25519 } from '@noble/curves/ed25519';
import { base58 } from '@scure/base';
import { sha256 } from '@noble/hashes/sha256';

export const ED25519_MULTICODEC = Uint8Array.from([0xed, 0x01]);
export const SEED_BYTES = 32;
export const PUBLIC_KEY_BYTES = 32;

/** The official fold's DID pattern (close_call_fold.py). */
export const DID_PATTERN = /^did:key:z6Mk[1-9A-HJ-NP-Za-km-z]{44}$/;

export class IdentityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'IdentityError';
  }
}

export function assertSeed(seed: Uint8Array): void {
  if (!(seed instanceof Uint8Array) || seed.length !== SEED_BYTES) {
    throw new IdentityError(
      `seed must be exactly ${SEED_BYTES} bytes, got ${seed?.length ?? 'n/a'}`,
    );
  }
}

/** Derive the raw 32-byte Ed25519 public key from a seed. */
export function publicKeyFromSeed(seed: Uint8Array): Uint8Array {
  assertSeed(seed);
  return ed25519.getPublicKey(seed);
}

/** multibase(base58btc) form of an Ed25519 public key. */
export function publicKeyToMultibase(publicKey: Uint8Array): string {
  if (publicKey.length !== PUBLIC_KEY_BYTES) {
    throw new IdentityError(`public key must be ${PUBLIC_KEY_BYTES} bytes`);
  }
  const prefixed = new Uint8Array(ED25519_MULTICODEC.length + publicKey.length);
  prefixed.set(ED25519_MULTICODEC, 0);
  prefixed.set(publicKey, ED25519_MULTICODEC.length);
  return `z${base58.encode(prefixed)}`;
}

/** Parse a multibase Ed25519 public key back to raw bytes. */
export function multibaseToPublicKey(multibase: string): Uint8Array {
  if (typeof multibase !== 'string' || !multibase.startsWith('z')) {
    throw new IdentityError('multibase key must start with the base58btc prefix "z"');
  }
  let decoded: Uint8Array;
  try {
    decoded = base58.decode(multibase.slice(1));
  } catch (error) {
    throw new IdentityError(`multibase key is not valid base58btc: ${String(error)}`);
  }
  if (decoded.length !== ED25519_MULTICODEC.length + PUBLIC_KEY_BYTES) {
    throw new IdentityError(`multibase key decodes to ${decoded.length} bytes, expected 34`);
  }
  if (decoded[0] !== ED25519_MULTICODEC[0] || decoded[1] !== ED25519_MULTICODEC[1]) {
    throw new IdentityError('multibase key is not an ed25519-pub multicodec (0xed01)');
  }
  return decoded.slice(ED25519_MULTICODEC.length);
}

export function publicKeyToDid(publicKey: Uint8Array): string {
  return `did:key:${publicKeyToMultibase(publicKey)}`;
}

export function didFromSeed(seed: Uint8Array): string {
  return publicKeyToDid(publicKeyFromSeed(seed));
}

/** Extract the 32-byte Ed25519 public key from a did:key. */
export function didToPublicKey(did: string): Uint8Array {
  if (typeof did !== 'string' || !did.startsWith('did:key:')) {
    throw new IdentityError('did must start with "did:key:"');
  }
  return multibaseToPublicKey(did.slice('did:key:'.length));
}

export function isDid(value: unknown): value is string {
  if (typeof value !== 'string' || !DID_PATTERN.test(value)) return false;
  try {
    didToPublicKey(value);
    return true;
  } catch {
    return false;
  }
}

/**
 * Key fingerprint: hex sha256 over the raw 32-byte Ed25519 public key.
 * Deterministic, and stable across restarts without touching the seed.
 */
export function fingerprintOf(publicKey: Uint8Array): string {
  return `sha256:${Buffer.from(sha256(publicKey)).toString('hex')}`;
}

export function fingerprintOfDid(did: string): string {
  return fingerprintOf(didToPublicKey(did));
}

/** base64url without padding, the only signature encoding technocore.chat accepts. */
export function encodeSignature(signature: Uint8Array): string {
  return Buffer.from(signature).toString('base64url');
}

export function decodeSignature(text: string): Uint8Array {
  if (typeof text !== 'string' || text.length !== 86 || /[^A-Za-z0-9_-]/.test(text)) {
    throw new IdentityError('signature must be 86 base64url characters without padding');
  }
  const bytes = Buffer.from(text, 'base64url');
  if (bytes.length !== 64) throw new IdentityError('signature must decode to 64 bytes');
  return new Uint8Array(bytes);
}

/** Sign arbitrary UTF-8 bytes with an Ed25519 seed. */
export function signBytes(seed: Uint8Array, message: Uint8Array): Uint8Array {
  assertSeed(seed);
  return ed25519.sign(message, seed);
}

export function verifyBytes(
  signature: Uint8Array,
  message: Uint8Array,
  publicKey: Uint8Array,
): boolean {
  try {
    return ed25519.verify(signature, message, publicKey);
  } catch {
    return false;
  }
}
