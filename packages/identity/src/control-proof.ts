/**
 * Control proofs for the 150 agents.
 *
 * A challenge is 32 cryptographically secure random bytes, fresh per run. Each
 * agent signs
 *
 *   flop-close-call-control-v1|close-1|<agent_id>|<challenge_hash>|
 *
 * with its own Ed25519 owner key. Verification re-derives the public key from
 * the DID, rebuilds the payload, checks the signature, and checks that the DID
 * really is the one the signed inventory lists for that agent_id.
 *
 * This proves control of the private key right now. It makes no claim about any
 * real-world legal identity, and the documentation says so.
 */
import { randomBytes } from 'node:crypto';
import { sha256 } from '@noble/hashes/sha256';
import {
  IdentityError,
  decodeSignature,
  didToPublicKey,
  encodeSignature,
  verifyBytes,
} from './did.js';
import { AgentKeyStore } from './key-store.js';
import { AgentInventory, verifyInventorySignature, ManifestSignature } from './inventory.js';

export const CONTROL_PROOF_DOMAIN = 'flop-close-call-control-v1';
export const CONTROL_PROOF_SEASON = 'close-1';
export const CHALLENGE_BYTES = 32;

export interface ControlProofRecord {
  agent_id: string;
  did: string;
  challenge_hash: string;
  signature: string;
  created_at: string;
  verified: boolean;
}

export interface ControlProofChallenge {
  schema: 'flop-close-call-control-challenge-v1';
  season: string;
  challenge: string;
  challenge_hash: string;
  created_at: string;
}

export function createChallenge(): Uint8Array {
  return new Uint8Array(randomBytes(CHALLENGE_BYTES));
}

export function challengeHash(challenge: Uint8Array): string {
  if (challenge.length !== CHALLENGE_BYTES) {
    throw new IdentityError(`challenge must be ${CHALLENGE_BYTES} bytes`);
  }
  return `sha256:${Buffer.from(sha256(challenge)).toString('hex')}`;
}

export function newChallengeRecord(now: string = new Date().toISOString()): ControlProofChallenge {
  const challenge = createChallenge();
  return {
    schema: 'flop-close-call-control-challenge-v1',
    season: CONTROL_PROOF_SEASON,
    challenge: Buffer.from(challenge).toString('base64url'),
    challenge_hash: challengeHash(challenge),
    created_at: now,
  };
}

/**
 * The exact payload an agent signs. The trailing `|` before the closing quote is
 * the separator of the empty final field the specification's template
 * `flop-close-call-control-v1|close-1|<agent_id>||` implies; challenge_hash fills
 * the fourth slot so the proof is bound to this run and cannot be replayed.
 */
export function controlProofPayload(agentId: string, challengeHashValue: string): Uint8Array {
  return new TextEncoder().encode(
    `${CONTROL_PROOF_DOMAIN}|${CONTROL_PROOF_SEASON}|${agentId}|${challengeHashValue}|`,
  );
}

export function proveControl(
  store: AgentKeyStore,
  agentId: string,
  challengeHashValue: string,
  createdAt: string = new Date().toISOString(),
): ControlProofRecord {
  const did = store.did(agentId);
  const signature = encodeSignature(
    store.sign(agentId, controlProofPayload(agentId, challengeHashValue)),
  );
  const record: ControlProofRecord = {
    agent_id: agentId,
    did,
    challenge_hash: challengeHashValue,
    signature,
    created_at: createdAt,
    verified: false,
  };
  return { ...record, verified: verifyControlProof(record, challengeHashValue) };
}

/**
 * Verify one proof against the challenge hash. When an expected DID is supplied,
 * the proof must be for exactly that DID.
 */
export function verifyControlProof(
  record: ControlProofRecord,
  challengeHashValue: string,
  expectedDid?: string,
): boolean {
  try {
    if (record.challenge_hash !== challengeHashValue) return false;
    if (expectedDid !== undefined && record.did !== expectedDid) return false;
    const publicKey = didToPublicKey(record.did);
    return verifyBytes(
      decodeSignature(record.signature),
      controlProofPayload(record.agent_id, challengeHashValue),
      publicKey,
    );
  } catch {
    return false;
  }
}

export interface ControlProofVerification {
  total: number;
  verified: number;
  failed: string[];
  /** agent_id -> did, from the signed inventory. */
  inventoryDids: Map<string, string>;
}

/**
 * Verify a whole proof set: every proof passes, every agent_id is present once,
 * the DID matches the signed inventory, and the inventory signature is valid.
 */
export function verifyControlProofSet(
  proofs: ControlProofRecord[],
  challengeHashValue: string,
  inventory: AgentInventory,
  manifest: ManifestSignature,
): ControlProofVerification {
  const failed: string[] = [];
  const inventoryDids = new Map<string, string>();
  for (const entry of inventory.agents) inventoryDids.set(entry.agent_id, entry.did);

  if (!verifyInventorySignature(inventory, manifest)) {
    failed.push('<inventory-signature>');
  }
  if (manifest.agent_count !== inventory.agents.length) {
    failed.push('<inventory-agent-count>');
  }
  const seen = new Set<string>();
  let verified = 0;
  for (const proof of proofs) {
    if (seen.has(proof.agent_id)) {
      failed.push(`<duplicate:${proof.agent_id}>`);
      continue;
    }
    seen.add(proof.agent_id);
    const expectedDid = inventoryDids.get(proof.agent_id);
    if (expectedDid === undefined) {
      failed.push(`<not-in-inventory:${proof.agent_id}>`);
      continue;
    }
    if (verifyControlProof(proof, challengeHashValue, expectedDid)) {
      verified += 1;
    } else {
      failed.push(proof.agent_id);
    }
  }
  for (const agentId of inventoryDids.keys()) {
    if (!seen.has(agentId)) failed.push(`<missing:${agentId}>`);
  }
  return { total: proofs.length, verified, failed, inventoryDids };
}
