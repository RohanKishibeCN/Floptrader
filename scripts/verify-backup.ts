/**
 * verify-backup: prove a bundle on disk really holds the 150 keys the published
 * inventory claims.
 *
 * A backup that has never been restored is not a backup. This decrypts the bundle
 * with the runtime age key, rebuilds the key store (which throws on any seed, DID
 * or multibase disagreement), and cross-checks every agent against the signed
 * public manifest. It is the same check the CLI's `restore` performs, but it
 * leaves the working copy alone — so it is safe to run against the nightly
 * artifact on a live VPS.
 *
 * It exits non-zero on any disagreement, so it can be the "external backup +
 * SHA-256 verification" step before an archive is deleted.
 *
 * Usage:
 *   pnpm verify:backup
 *   pnpm verify:backup --input data/backups/agents-close-1.age
 */
import { existsSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import {
  AgentKeyStore,
  decryptBundle,
  parseAdminPublicKey,
  parseBundle,
  parseInventory,
  verifyInventorySignature,
  type ManifestSignature,
} from '@flop/identity';
import { loadConfig } from '../apps/orchestrator/src/config.js';

function flag(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  if (index === -1) return undefined;
  const next = process.argv[index + 1];
  return next === undefined || next.startsWith('--') ? 'true' : next;
}

const config = loadConfig(process.env);
const input = flag('input') ?? config.paths.bundle;
const manifestPath = `${config.paths.public}/agents.manifest.json`;
const signaturePath = `${config.paths.public}/agents.manifest.sig`;

const problems: string[] = [];

function fail(message: string): void {
  problems.push(message);
  process.stdout.write(`FAIL  ${message}\n`);
}

process.stdout.write(`\nverify-backup\n\n  bundle:    ${input}\n`);

if (!existsSync(input)) {
  process.stdout.write(`  missing:   the bundle does not exist\n\n`);
  process.exit(1);
}
if (config.ageIdentityFile.length === 0 || !existsSync(config.ageIdentityFile)) {
  process.stdout.write(
    `  no age identity: set AGE_IDENTITY_FILE to the recovery key so the bundle can be decrypted\n\n`,
  );
  process.exit(1);
}
if (!existsSync(manifestPath)) {
  process.stdout.write(`  missing:   no public inventory at ${manifestPath}\n\n`);
  process.exit(1);
}

const ciphertext = new Uint8Array(readFileSync(input));
const digest = createHash('sha256').update(ciphertext).digest('hex');
process.stdout.write(`  sha256:    ${digest}\n  bytes:     ${ciphertext.byteLength}\n`);

const identity = readFileSync(config.ageIdentityFile, 'utf8').trim();
let agents: ReturnType<typeof parseBundle>['agents'];
try {
  const plaintext = await decryptBundle(ciphertext, [identity]);
  const parsed = parseBundle(plaintext);
  agents = parsed.agents;
  process.stdout.write(
    `  bundle:    ${agents.length} agents, season ${parsed.meta.season}, ` +
      `package ${parsed.meta.packageHash.slice(0, 12)}…, created ${parsed.meta.createdAt}\n`,
  );
} catch (error) {
  process.stdout.write('\n');
  fail(`the bundle could not be decrypted with ${config.ageIdentityFile}: ${String(error)}`);
  process.exit(1);
}

// Constructing the store is the coherence check: it throws on a bad seed length,
// on a DID that does not derive from its seed, and on a bad multibase form.
let store: AgentKeyStore;
try {
  store = new AgentKeyStore({ agents, season: config.season });
} catch (error) {
  process.stdout.write('\n');
  fail(`the restored key material is not self-consistent: ${String(error)}`);
  process.exit(1);
}

const inventory = parseInventory(readFileSync(manifestPath, 'utf8'));
process.stdout.write(`  inventory: ${inventory.agent_count} agents, schema ${inventory.schema}\n`);

if (inventory.agent_count !== store.size) {
  fail(`the inventory claims ${inventory.agent_count} agents but the bundle holds ${store.size}`);
}

const didsInBundle = new Set(agents.map((agent) => agent.did));
const missingFromBundle: string[] = [];
const mismatchedDids: string[] = [];
for (const entry of inventory.agents) {
  const did = store.agentIds.includes(entry.agent_id) ? store.did(entry.agent_id) : undefined;
  if (did === undefined) {
    missingFromBundle.push(entry.agent_id);
    continue;
  }
  if (did !== entry.did) mismatchedDids.push(entry.agent_id);
}
if (missingFromBundle.length > 0) {
  fail(`${missingFromBundle.length} agent(s) in the inventory are absent from the bundle`);
}
if (mismatchedDids.length > 0) {
  fail(`${mismatchedDids.length} DID(s) in the bundle disagree with the inventory`);
}

const orphaned = agents.filter((agent) => !inventory.agents.some((entry) => entry.agent_id === agent.agentId));
if (orphaned.length > 0) fail(`${orphaned.length} agent(s) in the bundle are not in the inventory`);

if (existsSync(signaturePath)) {
  const manifest = JSON.parse(readFileSync(signaturePath, 'utf8')) as ManifestSignature;
  if (!verifyInventorySignature(inventory, manifest)) {
    fail('the inventory signature does not verify against the public manifest');
  } else {
    process.stdout.write(`  signature: valid (admin ${manifest.admin_did})\n`);
  }
  // The signature proves the file is self-consistent. Only the pinned admin DID
  // proves it was signed by the offline key, and this host holds the public half.
  const adminFile = `${config.secretsDir}/admin-public.key`;
  const adminDid =
    config.adminPublicKey ??
    (existsSync(adminFile) ? parseAdminPublicKey(readFileSync(adminFile, 'utf8')).admin_did : null);
  if (adminDid === null) {
    fail(
      'no ADMIN_PUBLIC_KEY (or secrets/admin-public.key): the inventory is only self-consistent, ' +
        'not proven to be signed by the offline admin key',
    );
  } else if (!verifyInventorySignature(inventory, manifest, adminDid)) {
    fail(`the inventory does not verify against the pinned admin ${adminDid}`);
  } else {
    process.stdout.write(`  attested:  signed by the pinned admin ${adminDid}\n`);
  }
} else {
  fail(`no inventory signature at ${signaturePath}`);
}

// Belt and braces: no plaintext seed may be recoverable from the ciphertext.
const asText = Buffer.from(ciphertext).toString('utf8');
let leaked = 0;
for (const agent of agents) {
  if (asText.includes(Buffer.from(agent.seed).toString('hex'))) leaked += 1;
}
if (leaked > 0) fail(`${leaked} seed(s) are readable in the plaintext of the "encrypted" bundle`);

const distinct = new Set(agents.map((agent) => agent.did));
if (distinct.size !== agents.length) fail(`${agents.length - distinct.size} duplicate DID(s) in the bundle`);
if (distinct.size !== didsInBundle.size) fail('the DID set is inconsistent');

process.stdout.write(
  `\n${problems.length === 0 ? 'PASS' : 'FAIL'}: ` +
    `${store.size} agents verified against the signed inventory\n\n`,
);
if (problems.length > 0) process.exitCode = 1;
