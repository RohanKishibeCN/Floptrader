/**
 * Encrypted key backup: the 150 seeds, age-encrypted to two recipients.
 *
 *   secrets/agents.bundle.age          VPS runtime recovery key
 *                                      offline admin recovery key
 *
 * The plaintext bundle only ever exists in memory. `identities backup` and
 * `identities restore` are the only paths that touch the ciphertext, and there is
 * deliberately no command that writes a plaintext seed to disk.
 */
import { readFileSync } from 'node:fs';
import { Decrypter, Encrypter, generateIdentity, identityToRecipient } from 'age-encryption';
import { sha256 } from '@noble/hashes/sha256';
import {
  IdentityError,
  assertSeed,
  didFromSeed,
  fingerprintOf,
  publicKeyFromSeed,
  publicKeyToMultibase,
} from './did.js';
import {
  AgentSecretRecord,
  STRATEGY_GROUPS,
  StrategyGroup,
} from './key-store.js';

export const BUNDLE_SCHEMA = 'flop-close-call-agent-bundle-v1';

export interface BundleMeta {
  season: string;
  packageHash: string;
  createdAt: string;
  agentCount: number;
}

interface BundleAgent {
  agent_id: string;
  seed: string;
  did: string;
  public_key_multibase: string;
  fingerprint: string;
  strategy_group: string;
}

interface BundleDocument {
  schema: string;
  season: string;
  package_hash: string;
  created_at: string;
  agent_count: number;
  agents: BundleAgent[];
}

export function serializeBundle(agents: AgentSecretRecord[], meta: BundleMeta): string {
  const document: BundleDocument = {
    schema: BUNDLE_SCHEMA,
    season: meta.season,
    package_hash: meta.packageHash,
    created_at: meta.createdAt,
    agent_count: agents.length,
    agents: agents.map((agent) => ({
      agent_id: agent.agentId,
      seed: Buffer.from(agent.seed).toString('base64'),
      did: agent.did,
      public_key_multibase: agent.publicKeyMultibase,
      fingerprint: agent.fingerprint,
      strategy_group: agent.strategyGroup,
    })),
  };
  return JSON.stringify(document, null, 1);
}

/**
 * Parse and fully validate a plaintext bundle. Any structural problem, wrong
 * seed length, or DID/seed disagreement is fatal: we would rather refuse to
 * start than run 150 agents on unrecoverable key material.
 */
export function parseBundle(json: string): { agents: AgentSecretRecord[]; meta: BundleMeta } {
  let document: BundleDocument;
  try {
    document = JSON.parse(json) as BundleDocument;
  } catch (error) {
    throw new IdentityError(`bundle is not valid JSON: ${String(error)}`);
  }
  if (document?.schema !== BUNDLE_SCHEMA) {
    throw new IdentityError(`bundle schema must be ${BUNDLE_SCHEMA}`);
  }
  if (!Array.isArray(document.agents) || document.agents.length === 0) {
    throw new IdentityError('bundle contains no agents');
  }
  if (document.agent_count !== document.agents.length) {
    throw new IdentityError(
      `bundle agent_count ${document.agent_count} disagrees with ${document.agents.length} entries`,
    );
  }
  const seenIds = new Set<string>();
  const seenDids = new Set<string>();
  const agents: AgentSecretRecord[] = document.agents.map((entry, index) => {
    const label = entry?.agent_id ?? `#${index}`;
    if (typeof entry?.agent_id !== 'string' || entry.agent_id.length === 0) {
      throw new IdentityError(`agent ${label}: missing agent_id`);
    }
    if (seenIds.has(entry.agent_id)) throw new IdentityError(`duplicate agent_id ${entry.agent_id}`);
    seenIds.add(entry.agent_id);
    const seed = new Uint8Array(Buffer.from(String(entry.seed ?? ''), 'base64'));
    assertSeed(seed);
    const derivedDid = didFromSeed(seed);
    if (derivedDid !== entry.did) {
      throw new IdentityError(`agent ${label}: seed does not derive the recorded DID`);
    }
    if (seenDids.has(derivedDid)) throw new IdentityError(`duplicate DID ${derivedDid}`);
    seenDids.add(derivedDid);
    const publicKey = publicKeyFromSeed(seed);
    const multibase = publicKeyToMultibase(publicKey);
    if (multibase !== entry.public_key_multibase) {
      throw new IdentityError(`agent ${label}: public key multibase mismatch`);
    }
    if (!(STRATEGY_GROUPS as readonly string[]).includes(entry.strategy_group)) {
      throw new IdentityError(`agent ${label}: unknown strategy_group ${entry.strategy_group}`);
    }
    return {
      agentId: entry.agent_id,
      did: derivedDid,
      publicKeyMultibase: multibase,
      fingerprint: fingerprintOf(publicKey),
      strategyGroup: entry.strategy_group as StrategyGroup,
      seed,
    };
  });
  return {
    agents,
    meta: {
      season: document.season,
      packageHash: document.package_hash,
      createdAt: document.created_at,
      agentCount: agents.length,
    },
  };
}

export async function createAgeIdentity(): Promise<string> {
  return generateIdentity();
}

export async function ageRecipientFor(identity: string): Promise<string> {
  return identityToRecipient(identity);
}

/**
 * The one line of an age identity file that is actually the key.
 *
 * `age-keygen` writes a short file format — `# created: …`, `# public key: …`,
 * then the secret key — while `age-encryption`'s `generateIdentity()` returns the
 * bare key alone. Both are accepted, and both are reduced to exactly the secret
 * key line, so the same parser serves a file written by either tool.
 */
export const AGE_SECRET_KEY_PREFIX = 'AGE-SECRET-KEY-1';

/**
 * Extract the single `AGE-SECRET-KEY-1…` line from the text of an age identity
 * file.
 *
 * Exactly one is required. Zero means the file is not an identity (a public key,
 * an empty file, a placeholder); more than one means we cannot tell which key
 * the operator meant, and guessing would either fail to decrypt or decrypt with
 * a key they did not intend. Both are refusals.
 *
 * The error text names `source` and never the key material: a startup failure
 * must not become a way to print a secret into a log or a terminal.
 */
export function parseAgeIdentity(text: string, source: string): string {
  const keys = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.startsWith(AGE_SECRET_KEY_PREFIX));
  if (keys.length === 0) {
    throw new IdentityError(
      `no ${AGE_SECRET_KEY_PREFIX} line found in ${source}; an age identity file must contain exactly one`,
    );
  }
  if (keys.length > 1) {
    throw new IdentityError(
      `${source} contains ${keys.length} ${AGE_SECRET_KEY_PREFIX} lines; exactly one is required`,
    );
  }
  return keys[0]!;
}

/**
 * Read and validate an age identity file.
 *
 * Used everywhere `AGE_IDENTITY_FILE` is consulted, so the "exactly one key"
 * rule and the "never echo the key" rule hold on every path.
 */
export function readAgeIdentityFile(path: string): string {
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch (error) {
    throw new IdentityError(
      `could not read the age identity at ${path}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  return parseAgeIdentity(text, path);
}

/** Encrypt the plaintext bundle to N age recipients. */
export async function encryptBundle(plaintext: string, recipients: string[]): Promise<Uint8Array> {
  if (recipients.length < 1) throw new IdentityError('encryptBundle needs at least one recipient');
  const encrypter = new Encrypter();
  for (const recipient of recipients) encrypter.addRecipient(recipient);
  return encrypter.encrypt(new TextEncoder().encode(plaintext));
}

/** Decrypt with whichever of the supplied identities matches. */
export async function decryptBundle(
  ciphertext: Uint8Array,
  identities: string[],
): Promise<string> {
  if (identities.length < 1) throw new IdentityError('decryptBundle needs at least one identity');
  const decrypter = new Decrypter();
  for (const identity of identities) decrypter.addIdentity(identity);
  try {
    const plaintext = await decrypter.decrypt(ciphertext);
    return new TextDecoder().decode(plaintext);
  } catch (error) {
    throw new IdentityError(`could not decrypt bundle with the supplied age identities: ${String(error)}`);
  }
}

export function bundleDigest(ciphertext: Uint8Array): string {
  return `sha256:${Buffer.from(sha256(ciphertext)).toString('hex')}`;
}

// ---------------------------------------------------------------------------
// offline admin key
// ---------------------------------------------------------------------------

/**
 * The inventory-signing key, which is deliberately *not* one of the 150 agent
 * keys: the manifest's authority has to be separate from the identities it
 * lists, or a compromised agent key could re-sign the inventory.
 *
 * The plaintext document only ever exists in memory between decryption and use;
 * on disk it lives age-encrypted to the same two recipients as the agent bundle.
 */
export const ADMIN_KEY_SCHEMA = 'flop-close-call-admin-key-v1';

export function serializeAdminKey(seed: Uint8Array, createdAt: string): string {
  assertSeed(seed);
  return `${JSON.stringify(
    {
      schema: ADMIN_KEY_SCHEMA,
      created_at: createdAt,
      seed: Buffer.from(seed).toString('base64'),
      did: didFromSeed(seed),
      public_key_multibase: publicKeyToMultibase(publicKeyFromSeed(seed)),
    },
    null,
    1,
  )}\n`;
}

export function parseAdminKey(text: string): Uint8Array {
  let document: { schema?: unknown; seed?: unknown; did?: unknown };
  try {
    document = JSON.parse(text) as typeof document;
  } catch (error) {
    throw new IdentityError(`admin key is not valid JSON: ${String(error)}`);
  }
  if (document.schema !== ADMIN_KEY_SCHEMA) {
    throw new IdentityError(`admin key schema must be ${ADMIN_KEY_SCHEMA}`);
  }
  const seed = new Uint8Array(Buffer.from(String(document.seed ?? ''), 'base64'));
  assertSeed(seed);
  const derived = didFromSeed(seed);
  if (typeof document.did === 'string' && document.did !== derived) {
    throw new IdentityError('admin key seed does not derive the recorded DID');
  }
  return seed;
}
