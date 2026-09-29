/**
 * The operator CLI.
 *
 * Every identity command is deliberately unhelpful about secrets:
 *
 *   - there is **no** command that writes a plaintext seed anywhere, and none
 *     that prints one. The only way key material crosses the process boundary is
 *     age-encrypted, and only in the two directions that matter: `backup` out,
 *     `restore` in.
 *   - `list-public` and `export-public` work from the *public manifest*, so an
 *     operator without the age key can still see the inventory.
 *   - `generate` refuses to run without at least one age recipient: creating 150
 *     seeds we cannot encrypt would leave plaintext key material behind.
 *
 * Usage:
 *   pnpm cli identities generate --count 150
 *   pnpm cli identities list-public
 *   pnpm cli identities export-public --out data/public/agents.manifest.json
 *   pnpm cli identities sign-inventory
 *   pnpm cli identities backup --out data/backups/agents-close-1.age
 *   pnpm cli identities restore --input data/backups/agents-close-1.age
 *   pnpm cli identities create-challenge
 *   pnpm cli identities prove-control
 *   pnpm cli identities verify-control
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync, chmodSync } from 'node:fs';
import { dirname } from 'node:path';
import {
  AgentKeyStore,
  DEFAULT_AGENT_COUNT,
  ageRecipientFor,
  buildAdminPublicKey,
  buildInventory,
  challengeHash,
  decryptBundle,
  encryptBundle,
  makeAgentSecretRecord,
  newChallengeRecord,
  newSeed,
  parseBundle,
  parseInventory,
  proveControl,
  serializeAdminKey,
  serializeAdminPublicKey,
  serializeBundle,
  serializeInventory,
  serializeManifestSignature,
  signInventory,
  verifyControlProofSet,
  type AgentSecretRecord,
  type ControlProofRecord,
  type ManifestSignature,
} from '@flop/identity';
import { computeLocalPackageManifestHash } from '@flop/technocore';
import { loadConfig, type Config } from './config.js';
import { loadAdminSeed, loadAgentKeyStoreAsync, writeIdentityMetadata } from './main.js';

const HELP = `flop-close-call cli

  identities generate --count 150         create the seeds, the encrypted bundle and the public inventory
  identities list-public                  print the agent id, DID and strategy group of every agent
  identities export-public --out <path>   write the public inventory and its signature to <path>
  identities sign-inventory               (re-)sign the public inventory with the offline admin key
  identities backup --out <path>          re-encrypt the bundle to the configured recipients
  identities restore --input <path>       restore a bundle into secrets/ and rebuild the public files
  identities create-challenge             write a fresh 32-byte control challenge
  identities prove-control                sign the current challenge as all 150 agents
  identities verify-control               verify the stored control proofs
`;

class CliError extends Error {}

function parseArgs(argv: string[]): { command: string[]; flags: Map<string, string> } {
  const command: string[] = [];
  const flags = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]!;
    if (token.startsWith('--')) {
      const [name, inline] = token.slice(2).split('=', 2);
      if (!name) continue;
      if (inline !== undefined) {
        flags.set(name, inline);
        continue;
      }
      const next = argv[index + 1];
      if (next !== undefined && !next.startsWith('--')) {
        flags.set(name, next);
        index += 1;
      } else {
        flags.set(name, 'true');
      }
    } else {
      command.push(token);
    }
  }
  return { command, flags };
}

function requireFlag(flags: Map<string, string>, name: string): string {
  const value = flags.get(name);
  if (value === undefined || value === '') throw new CliError(`--${name} is required`);
  return value;
}

// ---------------------------------------------------------------------------
// paths
// ---------------------------------------------------------------------------

const manifestPath = (config: Config): string => `${config.paths.public}/agents.manifest.json`;
const manifestSigPath = (config: Config): string => `${config.paths.public}/agents.manifest.sig`;
const challengePath = (config: Config): string => `${config.paths.public}/control-challenge.json`;
const proofsPath = (config: Config): string => `${config.paths.participation}/control-proofs.json`;
const adminKeyPath = (config: Config): string => `${config.secretsDir}/admin.key.age`;

function ensureParent(path: string): void {
  const parent = dirname(path);
  if (!existsSync(parent)) mkdirSync(parent, { recursive: true, mode: 0o700 });
}

function writePrivate(path: string, contents: string | Uint8Array): void {
  ensureParent(path);
  writeFileSync(path, contents, { mode: 0o600 });
  chmodSync(path, 0o600);
}

function writePublic(path: string, contents: string): void {
  ensureParent(path);
  // The public manifest is world-readable on purpose: it is the inventory we
  // publish, and it contains no key material.
  writeFileSync(path, contents, { mode: 0o644 });
  chmodSync(path, 0o644);
}

/** The age recipients the bundle is encrypted to: the VPS key and the admin key. */
async function resolveRecipients(config: Config): Promise<string[]> {
  const recipients = new Set<string>();
  for (const value of config.ageRecipients) recipients.add(value.trim());
  if (config.ageIdentityFile.length > 0 && existsSync(config.ageIdentityFile)) {
    const identity = readFileSync(config.ageIdentityFile, 'utf8').trim();
    if (identity.length > 0) recipients.add(await ageRecipientFor(identity));
  }
  return [...recipients].filter((value) => value.length > 0);
}

/**
 * The recipients the *admin* key is encrypted to — never the VPS runtime key.
 *
 * If the runtime key is among them, taking the host is enough to decrypt the
 * admin key and re-sign the inventory, and an inventory signed on the same
 * machine it trades from proves nothing. Falling back to the full set only
 * happens when no separate admin recipient exists, and it is reported.
 */
function adminRecipients(
  config: Config,
  all: string[],
): { recipients: string[]; warning: string | null } {
  const runtime = config.ageRecipientVps;
  const adminOnly = runtime.length > 0 ? all.filter((value) => value !== runtime) : [];
  if (adminOnly.length > 0) return { recipients: adminOnly, warning: null };
  return {
    recipients: all,
    warning:
      'AGE_RECIPIENT_ADMIN is not set (or equals AGE_RECIPIENT_VPS): the admin key is ' +
      'encrypted to the VPS key as well, so the host can decrypt it and re-sign the inventory',
  };
}

const adminPublicPath = (config: Config): string => `${config.secretsDir}/admin-public.key`;

/** Write the admin public half the VPS keeps, and return the admin DID. */
function writeAdminPublicKey(config: Config, adminSeed: Uint8Array, createdAt: string): string {
  const publicKey = buildAdminPublicKey(adminSeed, config.season, createdAt);
  ensureParent(adminPublicPath(config));
  writePublic(adminPublicPath(config), serializeAdminPublicKey(publicKey));
  return publicKey.admin_did;
}

function readManifest(config: Config) {
  const path = manifestPath(config);
  if (!existsSync(path)) {
    throw new CliError(`no public inventory at ${path}; run \`identities generate\` first`);
  }
  return parseInventory(readFileSync(path, 'utf8'));
}

function adminSeedOrThrow(seed: Uint8Array | null): Uint8Array {
  if (!seed) {
    throw new CliError(
      `no admin key: set AGE_IDENTITY_FILE and run \`identities generate\`, which creates ${'secrets/admin.key.age'}`,
    );
  }
  return seed;
}

// ---------------------------------------------------------------------------
// commands
// ---------------------------------------------------------------------------

async function commandGenerate(config: Config, flags: Map<string, string>): Promise<void> {
  const count = Number.parseInt(flags.get('count') ?? String(DEFAULT_AGENT_COUNT), 10);
  if (!Number.isInteger(count) || count <= 0) throw new CliError('--count must be a positive integer');
  // A short fleet is a dry-run convenience, not a contest configuration: the
  // referee counts owners, so generating 2 of 150 is not a partial success.
  if (config.requireFullFleet && count !== config.expectedAgentCount) {
    throw new CliError(
      `refusing to generate ${count} agents: this season requires ${config.expectedAgentCount} ` +
        '(set REQUIRE_FULL_FLEET=false for a dry-run fleet)',
    );
  }

  const recipients = await resolveRecipients(config);
  if (recipients.length === 0) {
    throw new CliError(
      'refusing to generate: no age recipient configured. Set AGE_RECIPIENT_VPS and ' +
        'AGE_RECIPIENT_ADMIN (and/or AGE_IDENTITY_FILE). Plaintext seeds are never written to disk.',
    );
  }
  if (existsSync(config.paths.bundle)) {
    throw new CliError(
      `refusing to overwrite the existing bundle at ${config.paths.bundle}; ` +
        'move it aside first — regenerating identities would orphan every registration',
    );
  }

  // The pin is the official package manifest's own sha256. Computing it here —
  // and refusing to proceed without it — is what binds the bundle, the public
  // inventory and the referee's seed to the same package.
  const pkg = computeLocalPackageManifestHash(config.referenceDir);
  if (!pkg.ok || pkg.manifestHash.length === 0) {
    throw new CliError(
      `refusing to generate: the vendored package at ${config.referenceDir} does not verify — ` +
        pkg.problems.join('; '),
    );
  }

  const agents: AgentSecretRecord[] = [];
  for (let index = 0; index < count; index += 1) {
    agents.push(makeAgentSecretRecord(index, newSeed()));
  }

  const createdAt = new Date().toISOString();
  const inventory = buildInventory(agents, {
    season: config.season,
    packageHash: pkg.manifestHash,
    createdAt,
  });

  // The admin key is generated first and encrypted to the *admin* recipients
  // only. It is the authority that signs the inventory, so it must not be one of
  // the 150 agent keys — and it must not be decryptable by the trading host.
  const adminSeed = newSeed();
  const adminTargets = adminRecipients(config, recipients);
  writePrivate(
    adminKeyPath(config),
    await encryptBundle(serializeAdminKey(adminSeed, createdAt), adminTargets.recipients),
  );
  const adminDid = writeAdminPublicKey(config, adminSeed, createdAt);

  const bundlePlaintext = serializeBundle(agents, {
    season: config.season,
    packageHash: inventory.package_hash,
    createdAt,
    agentCount: agents.length,
  });
  const bundleCiphertext = await encryptBundle(bundlePlaintext, recipients);
  writePrivate(config.paths.bundle, bundleCiphertext);

  writeIdentityMetadata(config, agents);
  writePublic(manifestPath(config), serializeInventory(inventory));
  const manifest = signInventory(inventory, adminSeed, createdAt);
  writePublic(manifestSigPath(config), serializeManifestSignature(manifest));

  const lines = [
    `generated ${agents.length} agents across ${new Set(agents.map((a) => a.strategyGroup)).size} strategy groups`,
    `package:  ${pkg.manifestHash} (reference/manifest.json; ${pkg.verified.length} vendored files verified)`,
    `bundle:   ${config.paths.bundle} (${bundleCiphertext.byteLength} bytes, ${recipients.length} recipient(s))`,
    `admin key: ${adminKeyPath(config)} (encrypted to ${adminTargets.recipients.length} admin recipient(s))`,
    `admin public: ${adminPublicPath(config)} (${adminDid})`,
    `inventory: ${manifestPath(config)}`,
    `signature: ${manifestSigPath(config)} (admin ${manifest.admin_did})`,
    'no plaintext seed was written to disk',
  ];
  if (adminTargets.warning !== null) lines.push(`WARNING: ${adminTargets.warning}`);
  lines.push('');
  process.stdout.write(lines.join('\n'));
}

async function commandListPublic(config: Config): Promise<void> {
  const inventory = readManifest(config);
  const lines = [
    `schema ${inventory.schema}  season ${inventory.season}  agents ${inventory.agent_count}`,
  ];
  for (const agent of inventory.agents) {
    lines.push(`${agent.agent_id}  ${agent.strategy_group}  ${agent.did}`);
  }
  process.stdout.write(`${lines.join('\n')}\n`);
}

async function commandExportPublic(config: Config, flags: Map<string, string>): Promise<void> {
  const out = requireFlag(flags, 'out');
  const inventory = readManifest(config);
  writePublic(out, serializeInventory(inventory));
  const sigPath = manifestSigPath(config);
  if (existsSync(sigPath)) {
    writePublic(`${out}.sig`, readFileSync(sigPath, 'utf8'));
  }
  process.stdout.write(`exported ${inventory.agent_count} agents to ${out}\n`);
}

async function commandSignInventory(config: Config): Promise<void> {
  const inventory = readManifest(config);
  const adminSeed = adminSeedOrThrow(await loadAdminSeed(config));
  const at = new Date().toISOString();
  const manifest = signInventory(inventory, adminSeed, at);
  writePublic(manifestSigPath(config), serializeManifestSignature(manifest));
  const adminDid = writeAdminPublicKey(config, adminSeed, at);
  process.stdout.write(
    `signed ${inventory.agent_count} agents as ${manifest.admin_did}\n` +
      `admin public: ${adminPublicPath(config)} (${adminDid})\n` +
      'copy only this file and the signature to the VPS; the private key stays here\n',
  );
}

async function commandBackup(config: Config, flags: Map<string, string>): Promise<void> {
  const out = requireFlag(flags, 'out');
  const recipients = await resolveRecipients(config);
  if (recipients.length === 0) throw new CliError('no age recipient configured; cannot re-encrypt');
  const { keyStore } = await loadAgentKeyStoreAsync(config);
  const agents = keyStore.agentIds.map((agentId) => {
    const record = keyStore.publicRecord(agentId);
    return keyStore.withSeed(agentId, (seed) => ({ ...record, seed }));
  });
  const plaintext = serializeBundle(agents, {
    season: config.season,
    packageHash: await currentPackageHash(config),
    createdAt: new Date().toISOString(),
    agentCount: agents.length,
  });
  const ciphertext = await encryptBundle(plaintext, recipients);
  writePrivate(out, ciphertext);
  process.stdout.write(`wrote ${agents.length} encrypted seeds to ${out}\n`);
}

async function commandRestore(config: Config, flags: Map<string, string>): Promise<void> {
  const input = requireFlag(flags, 'input');
  if (!existsSync(input)) throw new CliError(`no such file: ${input}`);
  const identities = config.ageIdentityFile.length > 0 ? [readFileSync(config.ageIdentityFile, 'utf8').trim()] : [];
  if (identities.length === 0) {
    throw new CliError('AGE_IDENTITY_FILE must point at the recovery key to restore a bundle');
  }
  const plaintext = await decryptBundle(new Uint8Array(readFileSync(input)), identities);
  const { agents, meta } = parseBundle(plaintext);
  // Constructing the store is the check: it throws on any seed, DID or multibase
  // disagreement, so a successful construction proves the bundle is coherent.
  const store = new AgentKeyStore({ agents, season: config.season });

  writePrivate(config.paths.bundle, readFileSync(input));
  writeIdentityMetadata(config, agents);
  const inventory = buildInventory(agents, {
    season: meta.season,
    packageHash: meta.packageHash,
    createdAt: meta.createdAt,
  });
  writePublic(manifestPath(config), serializeInventory(inventory));
  process.stdout.write(
    `restored ${store.size} agents to ${config.paths.bundle}; public files rewritten\n`,
  );
}

async function commandCreateChallenge(config: Config): Promise<void> {
  const challenge = newChallengeRecord();
  writePublic(challengePath(config), `${JSON.stringify(challenge, null, 2)}\n`);
  process.stdout.write(
    `challenge ${challenge.challenge_hash} written to ${challengePath(config)}\n`,
  );
}

function readChallenge(config: Config, flags: Map<string, string>): { hash: string } {
  const inline = flags.get('challenge');
  if (inline && inline !== 'true') {
    // A fresh challenge supplied on the command line: hash the raw bytes so the
    // proof set is bound to exactly these 32 bytes.
    const bytes = new Uint8Array(Buffer.from(inline, 'base64'));
    return { hash: challengeHash(bytes) };
  }
  const path = challengePath(config);
  if (!existsSync(path)) {
    throw new CliError(`no challenge at ${path}; run \`identities create-challenge\` first`);
  }
  const parsed = JSON.parse(readFileSync(path, 'utf8')) as { challenge_hash?: string };
  if (!parsed.challenge_hash) throw new CliError('the stored challenge is malformed');
  return { hash: parsed.challenge_hash };
}

async function commandProveControl(config: Config, flags: Map<string, string>): Promise<void> {
  const { hash } = readChallenge(config, flags);
  const { keyStore } = await loadAgentKeyStoreAsync(config);
  const at = new Date().toISOString();
  const proofs: ControlProofRecord[] = keyStore.agentIds.map((agentId) =>
    proveControl(keyStore, agentId, hash, at),
  );
  writePrivate(proofsPath(config), `${JSON.stringify({ challenge_hash: hash, proofs }, null, 2)}\n`);
  const verified = proofs.filter((proof) => proof.verified).length;
  process.stdout.write(`proved control for ${verified}/${proofs.length} agents -> ${proofsPath(config)}\n`);
  if (verified !== proofs.length) process.exitCode = 1;
}

async function commandVerifyControl(config: Config): Promise<void> {
  const path = proofsPath(config);
  if (!existsSync(path)) throw new CliError(`no proofs at ${path}; run \`identities prove-control\` first`);
  const document = JSON.parse(readFileSync(path, 'utf8')) as {
    challenge_hash: string;
    proofs: ControlProofRecord[];
  };
  const inventory = readManifest(config);
  const signaturePath = manifestSigPath(config);
  if (!existsSync(signaturePath)) {
    throw new CliError(
      `no inventory signature at ${signaturePath}; run \`identities sign-inventory\` first`,
    );
  }
  const manifest = JSON.parse(readFileSync(signaturePath, 'utf8')) as ManifestSignature;
  const verification = verifyControlProofSet(
    document.proofs,
    document.challenge_hash,
    inventory,
    manifest,
  );

  process.stdout.write(
    [
      `challenge: ${document.challenge_hash}`,
      `inventory signature: ${verification.failed.includes('<inventory-signature>') ? 'INVALID' : 'valid'}`,
      `proofs: ${verification.verified}/${verification.total} verified`,
      `failed: ${verification.failed.length > 0 ? verification.failed.join(', ') : 'none'}`,
      `admin did: ${manifest.admin_did}`,
      '',
    ].join('\n'),
  );
  if (verification.failed.length > 0) process.exitCode = 1;
}

/**
 * The package hash the existing bundle was created against.
 *
 * Refuses an empty one: a bundle generated before this was enforced carries no
 * package binding, and re-encrypting it into a "backup" would preserve that hole
 * rather than fix it.
 */
async function currentPackageHash(config: Config): Promise<string> {
  const { meta } = await loadAgentKeyStoreAsync(config);
  if (meta.packageHash.trim().length === 0) {
    throw new CliError(
      'the bundle carries no package hash; regenerate the identities against the vendored reference package',
    );
  }
  return meta.packageHash;
}

// ---------------------------------------------------------------------------
// entry point
// ---------------------------------------------------------------------------

export async function runCli(argv: string[], env: NodeJS.ProcessEnv = process.env): Promise<number> {
  const { command, flags } = parseArgs(argv);
  const [group, action] = command;
  if (!group || flags.has('help')) {
    process.stdout.write(HELP);
    return 0;
  }
  if (group !== 'identities') throw new CliError(`unknown command group ${group}`);
  if (!action) throw new CliError('identities needs a subcommand; see --help');

  const config = loadConfig(env);
  for (const dir of [config.paths.data, config.paths.public, config.paths.identities, config.paths.participation, config.paths.backups, config.secretsDir]) {
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
  }

  switch (action) {
    case 'generate':
      await commandGenerate(config, flags);
      return 0;
    case 'list-public':
      await commandListPublic(config);
      return 0;
    case 'export-public':
      await commandExportPublic(config, flags);
      return 0;
    case 'sign-inventory':
      await commandSignInventory(config);
      return 0;
    case 'backup':
      await commandBackup(config, flags);
      return 0;
    case 'restore':
      await commandRestore(config, flags);
      return 0;
    case 'create-challenge':
      await commandCreateChallenge(config);
      return 0;
    case 'prove-control':
      await commandProveControl(config, flags);
      return 0;
    case 'verify-control':
      await commandVerifyControl(config);
      return 0;
    default:
      throw new CliError(`unknown identities subcommand ${action}; see --help`);
  }
}

if (process.argv[1] !== undefined && /cli\.(ts|js|mjs)$/.test(process.argv[1])) {
  runCli(process.argv.slice(2))
    .then((code) => process.exit(code))
    .catch((error: unknown) => {
      process.stderr.write(
        `flop-close-call cli: ${error instanceof Error ? error.message : String(error)}\n`,
      );
      process.exit(1);
    });
}
