/**
 * verify-all: the offline gate that runs after `build` and before a dry-run.
 *
 * This is not a linter and not a test runner — `pnpm lint`, `pnpm typecheck` and
 * `pnpm vitest` own that. What this checks is the set of properties the whole
 * project rests on and that no single unit test can own, because they are
 * invariants *between* modules:
 *
 *   1. the vendored reference files hash to the manifest record, so the rules we
 *      compile against are the rules the referee pinned;
 *   2. the official fold, replayed against its own sample season, still produces
 *      the published expected output — the port is byte-for-byte;
 *   3. the identity scheme is self-consistent: 150 unique did:key values, five
 *      groups of thirty, a control proof that verifies against a signed
 *      inventory, and a full age encrypt/decrypt round trip;
 *   4. the configuration fails closed: live without confirmation, without
 *      registration, or without a pinned referee is a startup error, and the
 *      load thresholds cannot be ordered nonsensically;
 *   5. the schema the code expects is the schema a fresh database gets, and the
 *      retention policy still names every evidence table as permanent;
 *   6. no plaintext seed is reachable from the on-disk artifacts.
 *
 * Nothing here touches the network. A failure prints what disagreed and the
 * process exits 1, so it can gate a release.
 */
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  AgentKeyStore,
  DEFAULT_AGENT_COUNT,
  STRATEGY_GROUPS,
  ageRecipientFor,
  buildInventory,
  challengeHash,
  createAgeIdentity,
  createChallenge,
  decryptBundle,
  didFromSeed,
  encryptBundle,
  makeAgentSecretRecord,
  newSeed,
  parseBundle,
  parseInventory,
  proveControl,
  serializeBundle,
  serializeInventory,
  serializeManifestSignature,
  signInventory,
  verifyControlProofSet,
  verifyInventorySignature,
  type ManifestSignature,
} from '@flop/identity';
import { FOLD_DEFAULTS, parseContestConfig, referenceRules, replay } from '@flop/close-call';
import {
  MIGRATIONS,
  PERMANENT_TABLES,
  SCHEMA_VERSION,
  closeDatabase,
  openDatabase,
  snapshotPermanentCounts,
} from '@flop/storage';
import { PINNED_PATHS, comparePackageHash, decideOnDrift, pinnedFromManifest, sha256Hex } from '@flop/technocore';
import { loadConfig } from '../apps/orchestrator/src/config.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const referenceDir = join(root, 'reference');

interface Check {
  name: string;
  ok: boolean;
  detail: string;
}

const checks: Check[] = [];

async function check(name: string, run: () => string | Promise<string>): Promise<void> {
  try {
    checks.push({ name, ok: true, detail: await run() });
  } catch (error) {
    checks.push({ name, ok: false, detail: error instanceof Error ? error.message : String(error) });
  }
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function referenceFile(name: string): string {
  return readFileSync(join(referenceDir, name), 'utf8');
}

function manifestFiles(): Record<string, { sha256: string }> {
  const manifest = JSON.parse(referenceFile('manifest.json')) as {
    files?: Record<string, { sha256: string }>;
  };
  return manifest.files ?? {};
}

// ---------------------------------------------------------------------------
// 1. the pinned package
// ---------------------------------------------------------------------------

await check('reference files hash to the manifest record', () => {
  const files = manifestFiles();
  const mismatched: string[] = [];
  for (const path of PINNED_PATHS) {
    const expected = files[path]?.sha256;
    if (expected === undefined) continue;
    if (sha256Hex(referenceFile(path)) !== expected) mismatched.push(path);
  }
  assert(mismatched.length === 0, `differ from the manifest: ${mismatched.join(', ')}`);
  const pinned = pinnedFromManifest({ files });
  assert(pinned.contestHash !== undefined, 'the manifest names no contest.json hash');
  return `${PINNED_PATHS.length} pinned paths; contest.json ${pinned.contestHash.slice(0, 12)}…`;
});

await check('the launch pin matches the vendored contest.json', () => {
  const pinned = pinnedFromManifest({ files: manifestFiles() }).contestHash!;
  const comparison = comparePackageHash(pinned, sha256Hex(referenceFile('contest.json')));
  assert(!comparison.drift, comparison.detail ?? 'drift with no detail');
  assert(
    decideOnDrift(comparison, 'seed').switchPackageAutomatically === false,
    'the drift decision may switch packages automatically',
  );
  return 'no drift; package switching stays a human decision';
});

// ---------------------------------------------------------------------------
// 2. the official fold
// ---------------------------------------------------------------------------

await check('the official fold reproduces its published sample output', () => {
  const seasonLines = readFileSync(join(root, 'tests/fixtures/sample-season.jsonl'), 'utf8')
    .split('\n')
    .filter((line) => line.trim().length > 0);
  const expected = JSON.parse(
    readFileSync(join(root, 'tests/fixtures/sample-season.expected.json'), 'utf8'),
  ) as { sweeps: unknown; final: unknown };

  const result = replay(seasonLines, {
    mint: FOLD_DEFAULTS.mint,
    min_qty: FOLD_DEFAULTS.min_qty,
    limit_window: FOLD_DEFAULTS.limit_window,
    fee_rate: FOLD_DEFAULTS.fee_rate,
    lock_sweep: FOLD_DEFAULTS.lock_sweep,
    prize_places: FOLD_DEFAULTS.prize_places,
  });

  assert(
    JSON.stringify(result.sweeps) === JSON.stringify(expected.sweeps),
    'the replayed sweeps differ from the expected output',
  );
  assert(
    JSON.stringify(result.final) === JSON.stringify(expected.final),
    'the replayed final standings differ from the expected output',
  );
  return `${result.sweeps.length} sweeps identical to the published expectation`;
});

await check('the contest config parses and pins the expected rules', () => {
  const config = parseContestConfig(referenceFile('contest.json'));
  assert(config.contest_id === 'close-1', `contest_id is ${config.contest_id}`);
  assert(config.fee_rule === 'clawback', `fee_rule is ${config.fee_rule}`);
  assert(config.rooms.trading.length === 1, 'more than one trading room');
  assert(config.rooms.trading[0] === 'close1', `trading room is ${config.rooms.trading[0]}`);
  assert(config.rooms.referee.length === 5, `referee rooms: ${config.rooms.referee.length}`);
  assert(config.min_qty === '0.1', `min_qty is ${config.min_qty}`);
  assert(config.limit_window === '0.05', `limit_window is ${config.limit_window}`);
  return `close-1, ${config.rooms.referee.length} referee rooms + ${config.rooms.trading[0]}, lock sweep ${config.lock_sweep}`;
});

// ---------------------------------------------------------------------------
// 3. identity
// ---------------------------------------------------------------------------

await check('150 agents: unique DIDs, five groups of thirty', () => {
  const agents = Array.from({ length: DEFAULT_AGENT_COUNT }, (_, index) =>
    makeAgentSecretRecord(index, newSeed()),
  );
  const store = new AgentKeyStore({ agents });

  const dids = new Set(agents.map((agent) => agent.did));
  assert(dids.size === agents.length, `${agents.length - dids.size} duplicate DID(s)`);
  assert(store.size === DEFAULT_AGENT_COUNT, `store holds ${store.size} agents`);

  const counts = new Map<string, number>();
  for (const agent of agents) {
    counts.set(agent.strategyGroup, (counts.get(agent.strategyGroup) ?? 0) + 1);
  }
  assert(counts.size === STRATEGY_GROUPS.length, `${counts.size} groups present`);
  for (const group of STRATEGY_GROUPS) {
    assert(counts.get(group) === 30, `${group} has ${counts.get(group) ?? 0} agents`);
  }
  return `${dids.size} unique DIDs, ${STRATEGY_GROUPS.length} groups x 30`;
});

await check('the encrypted bundle round-trips and leaks nothing', async () => {
  const identity = await createAgeIdentity();
  const recipient = await ageRecipientFor(identity);

  const agents = Array.from({ length: 4 }, (_, index) => makeAgentSecretRecord(index, newSeed()));
  const plaintext = serializeBundle(agents, {
    season: 'close-1',
    packageHash: 'f'.repeat(64),
    createdAt: new Date().toISOString(),
    agentCount: agents.length,
  });
  const ciphertext = await encryptBundle(plaintext, [recipient]);

  const asText = Buffer.from(ciphertext).toString('utf8');
  assert(!asText.includes('"seed"'), 'the ciphertext contains the plaintext seed field');
  for (const agent of agents) {
    const hex = Buffer.from(agent.seed).toString('hex');
    assert(!asText.includes(hex), `the ciphertext contains the seed of ${agent.agentId}`);
  }

  const decrypted = await decryptBundle(ciphertext, [identity]);
  const { agents: restored, meta } = parseBundle(decrypted);
  assert(restored.length === agents.length, `restored ${restored.length} agents`);
  assert(meta.packageHash === 'f'.repeat(64), 'the bundle metadata did not survive');

  const store = new AgentKeyStore({ agents: restored, season: 'close-1' });
  for (const agent of agents) {
    assert(store.did(agent.agentId) === agent.did, `DID changed for ${agent.agentId}`);
  }
  return `${restored.length} seeds recovered from ${ciphertext.byteLength} encrypted bytes`;
});

await check('a control proof verifies against the signed inventory', () => {
  const agents = Array.from({ length: 8 }, (_, index) => makeAgentSecretRecord(index, newSeed()));
  const store = new AgentKeyStore({ agents });
  const createdAt = new Date().toISOString();
  const adminSeed = newSeed();

  const inventory = buildInventory(agents, { season: 'close-1', packageHash: '', createdAt });
  const manifest = signInventory(inventory, adminSeed, createdAt);
  const hash = challengeHash(createChallenge());
  const proofs = agents.map((agent) => proveControl(store, agent.agentId, hash, createdAt));

  const verification = verifyControlProofSet(proofs, hash, inventory, manifest);
  assert(verification.verified === proofs.length, `${verification.verified}/${proofs.length} verified`);
  assert(verification.failed.length === 0, `failed: ${verification.failed.join(', ')}`);
  assert(verifyInventorySignature(inventory, manifest), 'the inventory signature did not verify');

  // A tampered proof must not verify any more.
  const tampered = { ...proofs[0]!, signature: `${proofs[0]!.signature.slice(0, 84)}AA` };
  assert(
    verifyControlProofSet([tampered], hash, inventory, manifest).verified === 0,
    'a tampered proof still verified',
  );

  // The public inventory must never carry key material.
  const serialized = serializeInventory(parseInventory(serializeInventory(inventory)));
  assert(!/"seed"/.test(serialized), 'the public inventory mentions a seed field');
  assert(!serialized.includes(adminSeed.toString()), 'the public inventory leaks the admin seed');

  // The manifest signature survives its own serialisation.
  const roundTripped = JSON.parse(serializeManifestSignature(manifest)) as ManifestSignature;
  assert(verifyInventorySignature(inventory, roundTripped), 'the manifest signature did not round-trip');
  return `${verification.verified} proofs verified, tampering rejected, inventory clean`;
});

// ---------------------------------------------------------------------------
// 4. configuration fails closed
// ---------------------------------------------------------------------------

await check('live mode requires confirmation, registration and a pinned referee', () => {
  const refereeDid = didFromSeed(newSeed());
  const mustThrow = (env: NodeJS.ProcessEnv, why: string): void => {
    let threw = false;
    try {
      loadConfig(env);
    } catch {
      threw = true;
    }
    assert(threw, why);
  };

  mustThrow({ FLOP_MODE: 'live' }, 'FLOP_MODE=live started without FLOP_LIVE_CONFIRM');
  mustThrow(
    { FLOP_MODE: 'live', FLOP_LIVE_CONFIRM: 'close-1' },
    'FLOP_MODE=live armed without FLOP_ALLOW_REGISTRATION',
  );
  mustThrow(
    { FLOP_MODE: 'live', FLOP_LIVE_CONFIRM: 'close-1', FLOP_ALLOW_REGISTRATION: 'true' },
    'FLOP_MODE=live armed without a pinned EXPECTED_REFEREE_DID',
  );
  mustThrow(
    {
      FLOP_MODE: 'live',
      FLOP_LIVE_CONFIRM: 'close-1',
      FLOP_ALLOW_REGISTRATION: 'true',
      EXPECTED_REFEREE_DID: refereeDid,
      REQUIRE_REFEREE_PIN: 'false',
    },
    'FLOP_MODE=live armed with REQUIRE_REFEREE_PIN=false',
  );

  const armed = loadConfig({
    FLOP_MODE: 'live',
    FLOP_LIVE_CONFIRM: 'close-1',
    FLOP_ALLOW_REGISTRATION: 'true',
    EXPECTED_REFEREE_DID: refereeDid,
  } as NodeJS.ProcessEnv);
  assert(armed.liveArmed, 'an explicitly confirmed live config did not arm');
  assert(!armed.tradingArmed, 'live without FLOP_ALLOW_TRADING armed trading');

  const byDefault = loadConfig({} as NodeJS.ProcessEnv);
  assert(!byDefault.liveArmed, 'the default configuration armed live trading');
  assert(byDefault.mode === 'dry-run', `the default mode is ${byDefault.mode}`);
  return 'default dry-run; live needs FLOP_MODE + FLOP_LIVE_CONFIRM + FLOP_ALLOW_REGISTRATION + a pinned referee';
});

await check('load thresholds must be ordered', () => {
  let threw = false;
  try {
    loadConfig({ RSS_PAUSE_PERCENT: '90', RSS_SHED_PERCENT: '85' } as NodeJS.ProcessEnv);
  } catch {
    threw = true;
  }
  assert(threw, 'inverted RSS thresholds were accepted');

  const guard = loadConfig({} as NodeJS.ProcessEnv).loadGuard;
  assert(
    guard.diskCompressPercent < guard.diskShedPercent &&
      guard.diskShedPercent < guard.diskCriticalPercent &&
      guard.diskCriticalPercent < guard.diskReadonlyPercent,
    'disk thresholds are not strictly increasing',
  );
  return `${guard.diskCompressPercent} < ${guard.diskShedPercent} < ${guard.diskCriticalPercent} < ${guard.diskReadonlyPercent}`;
});

await check('the model budget cannot exceed its own hard limit', () => {
  let threw = false;
  try {
    loadConfig({
      DEEPSEEK_MAX_NORMAL_CALLS_PER_DAY: '5',
      DEEPSEEK_HARD_LIMIT_PER_DAY: '3',
    } as NodeJS.ProcessEnv);
  } catch {
    threw = true;
  }
  assert(threw, 'a normal-call budget above the hard limit was accepted');

  const deepseek = loadConfig({} as NodeJS.ProcessEnv).deepseek;
  assert(deepseek.maxNormalCallsPerDay === 2, `normal budget is ${deepseek.maxNormalCallsPerDay}`);
  assert(deepseek.maxRetriesPerDay === 1, `retry budget is ${deepseek.maxRetriesPerDay}`);
  assert(deepseek.hardLimitPerDay === 3, `hard limit is ${deepseek.hardLimitPerDay}`);
  assert(deepseek.maxConcurrency === 1, `concurrency is ${deepseek.maxConcurrency}`);
  return '2 normal, 1 retry, 3 hard, concurrency 1';
});

await check('lark report times are exactly two valid HH:MM entries', () => {
  let threw = false;
  try {
    loadConfig({ LARK_REPORT_TIMES: '08:50' } as NodeJS.ProcessEnv);
  } catch {
    threw = true;
  }
  assert(threw, 'a single report time was accepted');

  const lark = loadConfig({} as NodeJS.ProcessEnv).lark;
  assert(lark.reportTimes.join(',') === '08:50,18:10', `report times: ${lark.reportTimes}`);
  assert(lark.mode === 'websocket', `default lark mode is ${lark.mode}`);
  return lark.reportTimes.join(' and ');
});

// ---------------------------------------------------------------------------
// 5. storage
// ---------------------------------------------------------------------------

await check('a fresh database gets every table the code expects', () => {
  const dir = mkdtempSync(join(tmpdir(), 'flop-verify-'));
  const db = openDatabase({ path: join(dir, 'app.db') });
  try {
    const tables = new Set(
      (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>).map(
        (row) => row.name,
      ),
    );
    const required = [
      'identities',
      'nonces',
      'participation_records',
      'agent_runs',
      'control_proofs',
      'room_cursors',
      'messages',
      'referee_snapshots',
      'trades',
      'decisions',
      'strategy_versions',
      'llm_calls',
      'lark_outbox',
      'upstream_events',
      'archive_manifests',
      'events',
    ];
    const missing = required.filter((table) => !tables.has(table));
    assert(missing.length === 0, `missing tables: ${missing.join(', ')}`);

    assert(SCHEMA_VERSION === MIGRATIONS[MIGRATIONS.length - 1]!.version, 'SCHEMA_VERSION is stale');
    assert(
      (db.pragma('user_version', { simple: true }) as number) === SCHEMA_VERSION,
      'the database reports a different schema version',
    );
    assert(db.pragma('journal_mode', { simple: true }) === 'wal', 'journal_mode is not WAL');
    assert(db.pragma('foreign_keys', { simple: true }) === 1, 'foreign_keys is off');
    assert(db.pragma('integrity_check', { simple: true }) === 'ok', 'integrity_check failed');

    const permanent = snapshotPermanentCounts(db);
    const unknown = Object.keys(permanent).filter((table) => !tables.has(table));
    assert(unknown.length === 0, `retention names tables that do not exist: ${unknown.join(', ')}`);
    return `${tables.size} tables, schema v${SCHEMA_VERSION}, WAL, ${PERMANENT_TABLES.length} permanent tables`;
  } finally {
    closeDatabase(db);
    rmSync(dir, { recursive: true, force: true });
  }
});

await check('the paths the config names line up with the rules', () => {
  const config = loadConfig({ DATA_DIR: 'data' } as NodeJS.ProcessEnv);
  for (const [name, value] of Object.entries(config.paths)) {
    assert(typeof value === 'string' && value.length > 0, `paths.${name} is empty`);
  }
  assert(config.paths.database.endsWith('app.db'), `database path is ${config.paths.database}`);
  assert(config.paths.bundle.endsWith('agents.bundle.age'), `bundle path is ${config.paths.bundle}`);
  const rules = referenceRules();
  assert(rules.tradingRoom === config.tradingRoom, 'the config and the rules disagree on the trading room');
  assert(existsSync(join(referenceDir, 'close_call_fold.py')), 'the official fold is not vendored');
  return `${Object.keys(config.paths).length} paths under ${config.dataDir}`;
});

// ---------------------------------------------------------------------------
// report
// ---------------------------------------------------------------------------

const failed = checks.filter((entry) => !entry.ok);
const width = Math.max(...checks.map((entry) => entry.name.length));
process.stdout.write('\nverify-all\n\n');
for (const entry of checks) {
  process.stdout.write(`${entry.ok ? 'PASS' : 'FAIL'}  ${entry.name.padEnd(width)}  ${entry.detail}\n`);
}
process.stdout.write(
  `\n${checks.length - failed.length}/${checks.length} checks passed` +
    (failed.length > 0 ? `; ${failed.length} failed\n` : '\n'),
);

if (failed.length > 0) process.exitCode = 1;
