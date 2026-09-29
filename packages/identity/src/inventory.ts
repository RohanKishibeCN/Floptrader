/**
 * Public agent inventory: what the operator publishes, and what must never leak.
 *
 * `data/public/agents.manifest.json` lists the 150 agents by DID, public key,
 * fingerprint and strategy group. It is signed by an offline admin Ed25519 key
 * into `data/public/agents.manifest.sig`.
 *
 * A guard runs on every export: if the serialised inventory contains a seed,
 * private key, age identity, DeepSeek key or Lark secret, the export fails.
 */
import { sha256 } from '@noble/hashes/sha256';
import { canonicalJson } from './canonical-json.js';
import {
  IdentityError,
  decodeSignature,
  didFromSeed,
  didToPublicKey,
  encodeSignature,
  signBytes,
  verifyBytes,
} from './did.js';
import { AgentPublicRecord, STRATEGY_GROUPS } from './key-store.js';
import { publicKeyToMultibase } from './did.js';

export const INVENTORY_SCHEMA = 'flop-close-call-agent-inventory-v1';
export const MANIFEST_SIGNATURE_SCHEMA = 'flop-close-call-manifest-signature-v1';

export interface AgentInventoryEntry {
  agent_id: string;
  did: string;
  public_key_multibase: string;
  fingerprint: string;
  strategy_group: string;
}

export interface AgentInventory {
  schema: typeof INVENTORY_SCHEMA;
  season: string;
  package_hash: string;
  created_at: string;
  agent_count: number;
  agents: AgentInventoryEntry[];
}

export function buildInventory(
  agents: AgentPublicRecord[],
  meta: { season: string; packageHash: string; createdAt: string },
): AgentInventory {
  return {
    schema: INVENTORY_SCHEMA,
    season: meta.season,
    package_hash: meta.packageHash,
    created_at: meta.createdAt,
    agent_count: agents.length,
    agents: agents.map((agent) => ({
      agent_id: agent.agentId,
      did: agent.did,
      public_key_multibase: agent.publicKeyMultibase,
      fingerprint: agent.fingerprint,
      strategy_group: agent.strategyGroup,
    })),
  };
}

/**
 * Bytes that get signed: the canonical form of the whole inventory, so the
 * signature covers the exact published manifest including its created_at.
 * Re-exporting therefore re-signs, which is the intended flow.
 */
export function inventorySigningPayload(inventory: AgentInventory): Uint8Array {
  return new TextEncoder().encode(canonicalJson(inventory as unknown as Record<string, unknown>));
}

export function inventoryDigest(inventory: AgentInventory): string {
  return `sha256:${Buffer.from(sha256(inventorySigningPayload(inventory))).toString('hex')}`;
}

const FORBIDDEN_PATTERNS: Array<{ name: string; pattern: RegExp }> = [
  { name: 'seed', pattern: /"(seed|seeds|private_key|privateKey|secret_key)"\s*:/i },
  { name: 'age identity', pattern: /AGE-SECRET-KEY-/ },
  { name: 'age identity env', pattern: /AGE_IDENTITY_FILE|AGE_IDENTITY=/ },
  { name: 'deepseek key', pattern: /DEEPSEEK_API_KEY|sk-[A-Za-z0-9]{20,}/ },
  { name: 'lark secret', pattern: /LARK_APP_SECRET|LARK_BOT_ID\s*[:=]/ },
  { name: 'base64 seed blob', pattern: /"(b64|base64)"\s*:\s*"[A-Za-z0-9+/]{43}=?"/ },
];

/**
 * Fail closed if the serialised inventory carries anything secret. This runs on
 * export and again in the test suite, so a refactor cannot quietly widen it.
 */
export function assertNoSecrets(serialized: string): void {
  for (const { name, pattern } of FORBIDDEN_PATTERNS) {
    if (pattern.test(serialized)) {
      throw new IdentityError(`inventory export refused: serialised output matches forbidden ${name}`);
    }
  }
}

export function serializeInventory(inventory: AgentInventory): string {
  const text = `${JSON.stringify(inventory, null, 2)}\n`;
  assertNoSecrets(text);
  return text;
}

export function parseInventory(text: string): AgentInventory {
  const parsed = JSON.parse(text) as AgentInventory;
  if (parsed?.schema !== INVENTORY_SCHEMA) {
    throw new IdentityError(`inventory schema must be ${INVENTORY_SCHEMA}`);
  }
  if (!Array.isArray(parsed.agents)) throw new IdentityError('inventory has no agents array');
  if (parsed.agent_count !== parsed.agents.length) {
    throw new IdentityError('inventory agent_count disagrees with agents array');
  }
  const seen = new Set<string>();
  for (const entry of parsed.agents) {
    if (seen.has(entry.agent_id)) throw new IdentityError(`duplicate agent_id ${entry.agent_id}`);
    seen.add(entry.agent_id);
    const publicKey = didToPublicKey(entry.did);
    if (publicKeyToMultibase(publicKey) !== entry.public_key_multibase) {
      throw new IdentityError(`agent ${entry.agent_id}: multibase does not match DID`);
    }
    if (!(STRATEGY_GROUPS as readonly string[]).includes(entry.strategy_group)) {
      throw new IdentityError(`agent ${entry.agent_id}: unknown strategy_group`);
    }
  }
  return parsed;
}

export interface ManifestSignature {
  schema: typeof MANIFEST_SIGNATURE_SCHEMA;
  signed_at: string;
  inventory_digest: string;
  agent_count: number;
  admin_did: string;
  admin_public_key_multibase: string;
  signature: string;
}

export function signInventory(
  inventory: AgentInventory,
  adminSeed: Uint8Array,
  signedAt: string,
): ManifestSignature {
  const payload = inventorySigningPayload(inventory);
  const adminDid = didFromSeed(adminSeed);
  return {
    schema: MANIFEST_SIGNATURE_SCHEMA,
    signed_at: signedAt,
    inventory_digest: inventoryDigest(inventory),
    agent_count: inventory.agent_count,
    admin_did: adminDid,
    admin_public_key_multibase: publicKeyToMultibase(didToPublicKey(adminDid)),
    signature: encodeSignature(signBytes(adminSeed, payload)),
  };
}

/**
 * Verify an inventory against its manifest.
 *
 * `expectedAdminDid`, when supplied, pins the signing key: a manifest re-signed
 * by a different admin key is rejected even though its own signature is valid.
 * The CLI passes the DID it trusts; verification without a pin only proves the
 * manifest is internally consistent.
 */
export function verifyInventorySignature(
  inventory: AgentInventory,
  manifest: ManifestSignature,
  expectedAdminDid?: string,
): boolean {
  if (manifest?.schema !== MANIFEST_SIGNATURE_SCHEMA) {
    throw new IdentityError(`manifest signature schema must be ${MANIFEST_SIGNATURE_SCHEMA}`);
  }
  if (expectedAdminDid !== undefined && manifest.admin_did !== expectedAdminDid) return false;
  if (manifest.inventory_digest !== inventoryDigest(inventory)) return false;
  if (manifest.agent_count !== inventory.agent_count) return false;
  try {
    const publicKey = didToPublicKey(manifest.admin_did);
    if (publicKeyToMultibase(publicKey) !== manifest.admin_public_key_multibase) return false;
    return verifyBytes(
      decodeSignature(manifest.signature),
      inventorySigningPayload(inventory),
      publicKey,
    );
  } catch {
    return false;
  }
}

export function serializeManifestSignature(manifest: ManifestSignature): string {
  return `${JSON.stringify(manifest, null, 2)}\n`;
}

export const ADMIN_PUBLIC_SCHEMA = 'flop-close-call-admin-public-v1';

/**
 * The offline admin key's public half.
 *
 * The VPS holds this and the signed inventory, and nothing else: it can verify
 * that the inventory is the one the admin signed, but it cannot sign a new one.
 * That is the whole point of separating the two — an inventory signed by the
 * same key that lives on the trading host is not an attestation of anything.
 */
export interface AdminPublicKey {
  schema: typeof ADMIN_PUBLIC_SCHEMA;
  season: string;
  created_at: string;
  admin_did: string;
  admin_public_key_multibase: string;
}

export function buildAdminPublicKey(adminSeed: Uint8Array, season: string, createdAt: string): AdminPublicKey {
  const adminDid = didFromSeed(adminSeed);
  return {
    schema: ADMIN_PUBLIC_SCHEMA,
    season,
    created_at: createdAt,
    admin_did: adminDid,
    admin_public_key_multibase: publicKeyToMultibase(didToPublicKey(adminDid)),
  };
}

export function serializeAdminPublicKey(key: AdminPublicKey): string {
  return `${JSON.stringify(key, null, 2)}\n`;
}

export function parseAdminPublicKey(text: string): AdminPublicKey {
  let parsed: AdminPublicKey;
  try {
    parsed = JSON.parse(text) as AdminPublicKey;
  } catch (error) {
    throw new IdentityError(`admin public key is not valid JSON: ${String(error)}`);
  }
  if (parsed?.schema !== ADMIN_PUBLIC_SCHEMA) {
    throw new IdentityError(`admin public key schema must be ${ADMIN_PUBLIC_SCHEMA}`);
  }
  if (typeof parsed.admin_did !== 'string' || parsed.admin_did.length === 0) {
    throw new IdentityError('admin public key has no admin_did');
  }
  // Round-trip the DID through its public key: a file whose DID and multibase
  // disagree is not describing a key that exists.
  const derived = publicKeyToMultibase(didToPublicKey(parsed.admin_did));
  if (derived !== parsed.admin_public_key_multibase) {
    throw new IdentityError('admin public key multibase does not match its DID');
  }
  return parsed;
}
