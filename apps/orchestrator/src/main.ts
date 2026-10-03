/**
 * The composition root.
 *
 * One process, one database, one reader, one writer, one scheduler. Everything
 * is constructed here and nowhere else, so there is exactly one place to look to
 * answer "what is running, and with which configuration".
 *
 * Startup order is forced by dependency, and the order matters:
 *
 *   1. directories and permissions, before anything writes;
 *   2. the database, because the logger persists events into it;
 *   3. the key store, decrypted from the age bundle — a failure here aborts the
 *      process rather than starting 150 agents we cannot sign for;
 *   4. the rules, read from the vendored `contest.json`, never from the network;
 *   5. transport, then the writer and the reader;
 *   6. the model stack, which is optional and never on the critical path;
 *   7. Lark, health, maintenance;
 *   8. the scheduler, last, because it is the only thing that starts work.
 *
 * Shutdown is the reverse, and it zeroes the in-memory seeds as its final act.
 */
import { readFileSync, existsSync, mkdirSync, writeFileSync, chmodSync } from 'node:fs';
import {
  DEFAULT_RISK_CAPS,
  emptySnapshot,
  parseContestConfig,
  referenceRules,
  rulesFromConfig,
  type Rules,
} from '@flop/close-call';
import {
  AgentKeyStore,
  IdentityError,
  assertFullFleet,
  decryptBundle,
  fleetSummary,
  parseAdminKey,
  parseAdminPublicKey,
  parseBundle,
  parseInventory,
  readAgeIdentityFile,
  verifyInventorySignature,
  type AgentSecretRecord,
  type ManifestSignature,
} from '@flop/identity';
import { openDatabase, createRepositories, type Repositories, type SqliteDatabase } from '@flop/storage';
import { GroupRunner } from '@flop/strategy';
import { TechnocoreClient, computeLocalPackageManifestHash } from '@flop/technocore';
import { ArchiveMaintenance } from './archive-maintenance.js';
import { ChallengeArchiveMonitor } from './challenge-archive-monitor.js';
import { loadConfig, ConfigError, type Config } from './config.js';
import { OrchestratorScheduler } from './scheduler.js';
import { OrchestratorReader } from './reader.js';
import { RuntimeEventNotifier } from './runtime-events.js';
import { OrchestratorWriter } from './writer.js';
import { createHealthServer, type HealthServer } from './health.js';
import { createLarkStack, type LarkStack } from './lark.js';
import { DeepSeekBudget, DeepSeekClient, DeepSeekScheduler, ParameterOptimiser } from './llm.js';
import { LoadGuard } from './load-guard.js';
import { Logger } from './logger.js';
import { UpstreamMonitor } from './upstream-monitor.js';

export interface RuntimeOverrides {
  fetchImpl?: typeof fetch;
  /**
   * The archive lives on a different host from technocore, so it gets its own
   * injected transport. Tests use it to serve a fixed `index.json`.
   */
  archiveFetchImpl?: typeof fetch;
  /**
   * The archive monitor's request-rate gate. Tests inject a no-op (or a
   * clock-advancing) sleep so a bounded batch does not spend real minutes
   * waiting between requests.
   */
  archiveSleep?: (ms: number) => Promise<void>;
  /** Test seams. */
  larkTransport?: Parameters<typeof createLarkStack>[0]['transport'];
  larkNotifierClientFactory?: Parameters<typeof createLarkStack>[0]['notifierClientFactory'];
  now?: () => Date;
  /** Injected disk reading, so the shed ladder can be exercised without filling a disk. */
  readDiskUsage?: (path: string) => number;
  /** Skip binding the health port; used by the soak harness. */
  skipHealth?: boolean;
}

export interface Runtime {
  config: Config;
  logger: Logger;
  db: SqliteDatabase;
  repositories: Repositories;
  keyStore: AgentKeyStore;
  rules: Rules;
  client: TechnocoreClient;
  reader: OrchestratorReader;
  writer: OrchestratorWriter;
  scheduler: OrchestratorScheduler;
  lark: LarkStack;
  /** The immediate-alert channel: runtime events mirrored to the Lark outbox. */
  notifier: RuntimeEventNotifier;
  /** The published sweep archive, polled off the trading path. */
  archiveMonitor: ChallengeArchiveMonitor;
  health: HealthServer | null;
  startedAt: string;
  start(): Promise<void>;
  stop(): Promise<void>;
}

/** Owner-only directories, created before anything is written into them. */
function ensureDirectories(config: Config): void {
  const dirs = [
    config.paths.data,
    config.paths.identities,
    config.paths.public,
    config.paths.participation,
    config.paths.backups,
    config.paths.archive,
    config.secretsDir,
  ];
  for (const dir of dirs) {
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
  }
  try {
    // The secrets directory holds the age identity and the encrypted bundle;
    // nobody but the runtime user may list it.
    chmodSync(config.secretsDir, 0o700);
  } catch {
    /* best effort: a filesystem without POSIX modes is not fatal */
  }
}

/**
 * Read the vendored contest config.
 *
 * Never fetched at runtime: the pin is what keeps a mid-contest rule change from
 * silently altering how we price a trade. A missing or unreadable file falls back
 * to the embedded reference copy in dry-run and says so — but **not** in live. A
 * live process running on embedded rules while the referee quotes the vendored
 * package is a process whose limits are a guess, and the failure would only show
 * up as voided trades.
 */
export function loadRules(config: Config, logger?: Logger): Rules {
  const path = config.contestJsonPath;
  const live = config.mode === 'live';
  if (!existsSync(path)) {
    if (live) {
      throw new ConfigError(`FLOP_MODE=live refuses a missing contest.json at ${path}`);
    }
    logger?.event({
      level: 'warn',
      source: 'main',
      code: 'contest_json_missing',
      message: `no contest.json at ${path}; using the embedded reference copy`,
      data: { path },
    });
    return referenceRules();
  }
  try {
    return rulesFromConfig(parseContestConfig(readFileSync(path, 'utf8')));
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    if (live) {
      throw new ConfigError(`FLOP_MODE=live refuses an unusable contest.json at ${path}: ${detail}`);
    }
    logger?.event({
      level: 'error',
      source: 'main',
      code: 'contest_json_invalid',
      message: `contest.json at ${path} is unusable; using the embedded reference copy`,
      data: { path, error: detail },
    });
    return referenceRules();
  }
}

/**
 * Decrypt the agent bundle and build the key store.
 *
 * Fail-closed at every step: no bundle, no identity file, a decryption failure,
 * or a seed that disagrees with its recorded DID all abort startup. Running with
 * a subset of the agents would quietly break the "150 owners" requirement, and
 * running with a corrupted seed would produce signatures nobody accepts.
 */
function collectAgeIdentities(config: Config): string[] {
  if (config.ageIdentityFile.length === 0 || !existsSync(config.ageIdentityFile)) return [];
  // Exactly one secret key, and a failure that names the file rather than the
  // key. The path itself is unchanged: `AGE_IDENTITY_FILE` still points where it
  // always did.
  return [readAgeIdentityFile(config.ageIdentityFile)];
}

/** The key-store loader the orchestrator, the CLI and the soak harness share. */
export async function loadAgentKeyStoreAsync(
  config: Config,
  logger?: Logger,
): Promise<{ keyStore: AgentKeyStore; meta: { season: string; packageHash: string; createdAt: string } }> {
  const bundlePath = config.paths.bundle;
  if (!existsSync(bundlePath)) {
    throw new IdentityError(
      `no encrypted bundle at ${bundlePath}; run \`pnpm cli identities generate --count 150\` first`,
    );
  }
  const identities = collectAgeIdentities(config);
  if (identities.length === 0) {
    throw new IdentityError(
      'no age identity available: set AGE_IDENTITY_FILE to the VPS runtime recovery key',
    );
  }
  const plaintext = await decryptBundle(new Uint8Array(readFileSync(bundlePath)), identities);
  const { agents, meta } = parseBundle(plaintext);
  const keyStore = new AgentKeyStore({ agents, season: meta.season });
  logger?.event({
    level: 'info',
    source: 'main',
    code: 'key_store_loaded',
    message: `decrypted ${keyStore.size} agent keys`,
    data: { agents: keyStore.size, season: meta.season, packageHash: meta.packageHash },
  });
  return { keyStore, meta };
}

/** The offline admin key, when present. Used only to sign the inventory. */
export async function loadAdminSeed(config: Config): Promise<Uint8Array | null> {
  const path = `${config.secretsDir}/admin.key.age`;
  if (!existsSync(path)) return null;
  const identities = collectAgeIdentities(config);
  if (identities.length === 0) return null;
  const plaintext = await decryptBundle(new Uint8Array(readFileSync(path)), identities);
  return parseAdminKey(plaintext);
}

// ---------------------------------------------------------------------------
// pins
// ---------------------------------------------------------------------------

export interface PackagePin {
  /** The hash the process must be launched against. */
  expected: string;
  /** sha256 of the vendored `reference/manifest.json`. */
  localManifestHash: string;
  /** How many vendored files the manifest's record confirmed. */
  verifiedFiles: number;
}

/**
 * Resolve and cross-check the package pin.
 *
 * Three values must agree before a bundle is usable: the hash recorded in the
 * bundle (what these identities were generated against), the sha256 of the
 * vendored manifest (what this checkout actually contains), and — when the launch
 * record pins one — `EXPECTED_PACKAGE_HASH`. Any disagreement is a manual-release
 * problem; papering over it at startup is how a process ends up trading under
 * rules it never agreed to.
 *
 * Live and dry-run differ in exactly one place: when `EXPECTED_PACKAGE_HASH` is
 * unset. Live has already refused to reach this point without one (see
 * `loadConfig`), so a null here is impossible live; a dry run may proceed against
 * the vendored manifest's own hash, but it is recorded as a warning because the
 * pin was never made explicit.
 */
export function resolvePackagePin(
  config: Config,
  bundlePackageHash: string,
  logger?: Logger,
): PackagePin {
  const local = computeLocalPackageManifestHash(config.referenceDir);
  if (!local.ok || local.manifestHash.length === 0) {
    throw new ConfigError(
      `the vendored package at ${config.referenceDir} does not verify: ${local.problems.join('; ')}`,
    );
  }

  const fromBundle = bundlePackageHash.trim();
  if (fromBundle.length === 0) {
    throw new ConfigError(
      'the bundle records no package hash; regenerate the identities against the vendored reference package',
    );
  }

  // Live cannot get here without a pin: `loadConfig` refuses to arm live without
  // `EXPECTED_PACKAGE_HASH`. Assert it rather than trusting the caller, so a
  // future entry point that skips `loadConfig` still cannot trade unpinned.
  if (config.mode === 'live' && config.expectedPackageHash === null) {
    throw new ConfigError(
      'FLOP_MODE=live requires EXPECTED_PACKAGE_HASH — refusing to run live without an explicit package pin',
    );
  }

  let expected: string;
  if (config.expectedPackageHash !== null) {
    if (local.manifestHash !== config.expectedPackageHash) {
      throw new ConfigError(
        `the vendored package hashes to ${local.manifestHash}, but EXPECTED_PACKAGE_HASH pins ` +
          `${config.expectedPackageHash}; re-vendor the official package as a deliberate release`,
      );
    }
    expected = config.expectedPackageHash;
  } else {
    logger?.event({
      level: 'warn',
      source: 'main',
      code: 'package_pin_implicit',
      message:
        'EXPECTED_PACKAGE_HASH is unset; falling back to the vendored manifest hash — ' +
        'acceptable in dry-run, never in live',
      data: { localManifest: local.manifestHash },
    });
    expected = local.manifestHash;
  }

  if (fromBundle !== expected) {
    throw new ConfigError(
      `the bundle was generated against package ${fromBundle}, but this process pins ${expected}; ` +
        'refusing to start against a different rule set',
    );
  }
  return { expected, localManifestHash: local.manifestHash, verifiedFiles: local.verified.length };
}

/** The admin DID this host trusts: from the environment, else the public-key file. */
export function loadAdminPublicDid(config: Config): string | null {
  if (config.adminPublicKey !== null) return config.adminPublicKey;
  const path = `${config.secretsDir}/admin-public.key`;
  if (!existsSync(path)) return null;
  return parseAdminPublicKey(readFileSync(path, 'utf8')).admin_did;
}

/**
 * Verify the published inventory against the pinned admin key.
 *
 * This host holds no admin private key, so a signature check against a pinned DID
 * is the only thing that makes the inventory an attestation rather than a claim.
 * A present-but-invalid signature is fatal in both modes — it is evidence of
 * tampering, not of an unfinished setup — while a missing one is only fatal live.
 */
export function verifyInventoryPin(
  config: Config,
  adminDid: string | null,
  logger?: Logger,
): { verified: boolean; adminDid: string | null; agents: number } {
  const inventoryPath = `${config.paths.public}/agents.manifest.json`;
  const signaturePath = `${config.paths.public}/agents.manifest.sig`;
  const live = config.mode === 'live';

  if (!existsSync(inventoryPath) || !existsSync(signaturePath)) {
    if (live) {
      throw new ConfigError(
        `FLOP_MODE=live requires a signed public inventory (${inventoryPath} and ${signaturePath})`,
      );
    }
    logger?.event({
      level: 'warn',
      source: 'main',
      code: 'inventory_missing',
      message: 'no signed public inventory yet; the manifest pin is not enforced',
      data: { inventoryPath, signaturePath },
    });
    return { verified: false, adminDid, agents: 0 };
  }

  const inventory = parseInventory(readFileSync(inventoryPath, 'utf8'));
  const manifest = JSON.parse(readFileSync(signaturePath, 'utf8')) as ManifestSignature;

  if (adminDid === null) {
    if (live) {
      throw new ConfigError(
        'FLOP_MODE=live requires ADMIN_PUBLIC_KEY (or secrets/admin-public.key) so the inventory ' +
          'signature can be checked against a key this host does not hold',
      );
    }
    logger?.event({
      level: 'warn',
      source: 'main',
      code: 'admin_key_unpinned',
      message: 'no admin public key configured; the inventory signature is not pinned to a DID',
      data: { adminDid: manifest.admin_did },
    });
    return { verified: false, adminDid: null, agents: inventory.agent_count };
  }

  if (!verifyInventorySignature(inventory, manifest, adminDid)) {
    throw new ConfigError(
      `the public inventory does not verify against the pinned admin ${adminDid} ` +
        `(the file says ${manifest.admin_did}); it was not signed by the offline key`,
    );
  }
  return { verified: true, adminDid, agents: inventory.agent_count };
}

// ---------------------------------------------------------------------------
// key store
// ---------------------------------------------------------------------------

/** Deterministic per-agent tie-break seed; stable across restarts by design. */
export function randomSeedFor(agentId: string): number {
  let hash = 2166136261;
  for (let index = 0; index < agentId.length; index += 1) {
    hash ^= agentId.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return Math.abs(hash) % 1_000_003;
}

/**
 * Mirror the key store into `identities`.
 *
 * Caps come from `DEFAULT_RISK_CAPS`, not from the model: the model can propose
 * strategy *parameters*, but the ceilings on quantity, notional, cooldown and
 * confidence are fixed at launch and are not part of its surface.
 */
export function seedIdentityRows(
  repositories: Repositories,
  keyStore: AgentKeyStore,
  season: string,
): void {
  // 150 rows, one transaction: a half-seeded `identities` table would leave the
  // scheduler unable to find caps for some agents while the health check still
  // reported a populated table.
  repositories.transaction(() => {
    for (const record of keyStore.publicRecords()) {
      const caps = DEFAULT_RISK_CAPS[record.strategyGroup];
      if (!caps) throw new Error(`no risk caps for group ${record.strategyGroup}`);
      repositories.identities.upsert({
        agent_id: record.agentId,
        did: record.did,
        public_key_multibase: record.publicKeyMultibase,
        fingerprint: record.fingerprint,
        strategy_group: record.strategyGroup,
        season,
        risk_tier: record.strategyGroup,
        random_seed: randomSeedFor(record.agentId),
        max_qty: caps.maxQty.toString(),
        max_open_notional: caps.maxOpenNotional.toString(),
        cooldown_sweeps: caps.cooldownSweeps,
        confidence_threshold: caps.confidenceThreshold.toString(),
        strategy_version: 'v1',
        last_run_at: null,
        last_run_week: null,
        enabled: 1,
      });
    }
  });
}

/** Write the per-agent public metadata directories. Never contains a seed. */
export function writeIdentityMetadata(config: Config, records: AgentSecretRecord[]): void {
  for (const record of records) {
    const dir = `${config.paths.identities}/${record.agentId}`;
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
    const document = {
      agent_id: record.agentId,
      did: record.did,
      public_key_multibase: record.publicKeyMultibase,
      fingerprint: record.fingerprint,
      strategy_group: record.strategyGroup,
      season: config.season,
    };
    writeFileSync(`${dir}/metadata.json`, `${JSON.stringify(document, null, 2)}\n`, {
      mode: 0o644,
    });
  }
}

export async function createRuntime(
  config: Config,
  overrides: RuntimeOverrides = {},
): Promise<Runtime> {
  ensureDirectories(config);

  const db = openDatabase({ path: config.paths.database, fileMode: 0o600 });
  const repositories = createRepositories(db);
  // Late-bound: the notifier needs the Lark outbox, which is built further down
  // with the rest of the Lark stack. Until then a nil observer is correct — the
  // events it cares about are runtime conditions, not startup lines.
  const notifierRef: { current: RuntimeEventNotifier | null } = { current: null };
  const logger = Logger.create({
    level: config.logLevel,
    name: 'flop-close-call',
    repositories,
    onEvent: (record) => notifierRef.current?.observe(record),
  });

  const { keyStore, meta } = await loadAgentKeyStoreAsync(config, logger);

  // The season is 150 agents in five groups of thirty. A live process must be
  // exactly that; a dry run may be any size when the operator has said so.
  const fleet =
    config.requireFullFleet || config.mode === 'live'
      ? assertFullFleet(keyStore, config.expectedAgentCount)
      : fleetSummary(keyStore);
  logger.event({
    level: 'info',
    source: 'main',
    code: 'fleet_verified',
    message: `fleet of ${fleet.size} agents`,
    data: { size: fleet.size, groups: fleet.groups, required: config.requireFullFleet || config.mode === 'live' },
  });

  const rules = loadRules(config, logger);
  if (rules.contestId !== config.season) {
    throw new Error(
      `contest.json declares ${rules.contestId} but this build is pinned to ${config.season}`,
    );
  }

  // The package pin binds the bundle, the public inventory and the referee's
  // seed to one rule set. Every disagreement here is fatal.
  const pin = resolvePackagePin(config, meta.packageHash, logger);
  logger.event({
    level: 'info',
    source: 'main',
    code: 'package_pinned',
    message: `package ${pin.expected}`,
    data: { expected: pin.expected, localManifest: pin.localManifestHash, verifiedFiles: pin.verifiedFiles },
  });

  // The VPS holds the admin key's public half only, so this is the whole of its
  // ability to vouch for the inventory.
  const adminDid = loadAdminPublicDid(config);
  const inventory = verifyInventoryPin(config, adminDid, logger);
  logger.event({
    level: 'info',
    source: 'main',
    code: 'inventory_checked',
    message: inventory.verified
      ? `public inventory verified against ${inventory.adminDid}`
      : 'public inventory is not pinned (dry run)',
    data: { verified: inventory.verified, adminDid: inventory.adminDid, agents: inventory.agents },
  });

  // A pinned referee, and a seed that must arrive before any state. Both are the
  // default; the permissive behaviour exists for `adopt_first_sender` dry runs.
  if (config.requireRefereePin && config.expectedRefereeDid === null) {
    // Live already refuses to start without the pin; a dry run may proceed, but
    // it is running without the protection, and that must be visible.
    logger.event({
      level: 'warn',
      source: 'main',
      code: 'referee_unpinned',
      message:
        'REQUIRE_REFEREE_PIN is on but EXPECTED_REFEREE_DID is unset: no referee post will be accepted',
      data: {},
    });
  }

  seedIdentityRows(repositories, keyStore, config.season);

  const now = overrides.now ?? (() => new Date());

  const client = new TechnocoreClient({
    baseUrl: config.technoCore.baseUrl,
    timeoutMs: config.technoCore.requestTimeoutMs,
    maxInflight: config.technoCore.maxInflight,
    // The page-size ceiling, so no caller can put a `limit` on the wire that the
    // service would refuse.
    serverLimit: config.technoCore.serverLimit,
    ...(overrides.fetchImpl ? { fetchImpl: overrides.fetchImpl } : {}),
  });

  const writer = new OrchestratorWriter({
    client,
    keyStore,
    repositories,
    logger,
    writeRatePerMinute: config.technoCore.writeRatePerMinute,
    maxRetries: config.technoCore.writeMaxRetries,
    now,
  });

  // The pins are the launch-time authority: a seed that quotes a different
  // package hash, or a post from a DID other than the pinned referee, puts the
  // process into conservative mode instead of silently switching rule sets.
  const reader = new OrchestratorReader({
    rules,
    client,
    db,
    repositories,
    logger,
    localDids: () => keyStore.didSet(),
    readConcurrency: config.technoCore.readConcurrency,
    waitSeconds: config.technoCore.readWaitSeconds,
    retryDelayMs: config.technoCore.readerRetryDelayMs,
    serverLimit: config.technoCore.serverLimit,
    readLimit: config.technoCore.readLimit,
    tradingRoomLimit: config.technoCore.tradingRoomLimit,
    tradingRoomCatchupLimit: config.technoCore.tradingRoomCatchupLimit,
    catchupMaxRequestsPerSecond: config.technoCore.catchupMaxRequestsPerSecond,
    catchupMaxSeconds: config.technoCore.catchupMaxSeconds,
    fairnessMaxSilenceMs: config.technoCore.fairnessMaxSilenceMs,
    exportRecovery: config.technoCore.exportRecovery,
    exportMaxBytes: config.technoCore.exportMaxBytes,
    exportTimeoutMs: config.technoCore.exportTimeoutMs,
    exportCooldownMs: config.technoCore.exportCooldownMs,
    close1GapPolicy: config.technoCore.close1GapPolicy,
    expectedPackageHash: pin.expected,
    expectedRefereeDid: config.expectedRefereeDid,
    requireRefereePin: config.requireRefereePin,
    maxReferenceAgeSeconds: config.risk.maxReferenceAgeSeconds,
    staleReferenceMode: config.risk.staleReferenceMode,
    maxDiscoveredRooms: config.roomDiscovery.maxRooms,
    dynamicReadConcurrency: config.roomDiscovery.dynamicReadConcurrency,
    externalOfferTakerEnabled: config.externalOfferTakerEnabled,
    localOfferMatchingEnabled: config.localOfferMatchingEnabled,
    live: config.mode === 'live',
    // The seedless participation mode. It does not relax the pin: the referee DID
    // and the package hash must still both be fixed at launch, and every post is
    // still signature-checked against them. It only removes the requirement that
    // the *opening* seed be recoverable, which a late start cannot satisfy.
    lateStart: config.lateStartArmed,
    now,
  });

  // Say which posture we are in, and — when the mode was asked for but did not
  // arm — exactly which switch is missing. A half-configured late start keeps
  // running as a dry run; this line is how the operator learns why.
  if (config.lateStartRequested || config.lateStartArmed) {
    logger.event({
      level: config.lateStartBlockedReason === null ? 'info' : 'warn',
      source: 'main',
      code: config.lateStartArmed ? 'late_start_armed' : 'late_start_blocked',
      message:
        config.lateStartBlockedReason === null
          ? `late-start participation is armed (trading ${config.lateStartTradingArmed ? 'on' : 'off'})`
          : `LATE_START_MODE was requested but did not arm: ${config.lateStartBlockedReason}`,
      data: {
        requested: config.lateStartRequested,
        armed: config.lateStartArmed,
        tradingArmed: config.lateStartTradingArmed,
        blockedReason: config.lateStartBlockedReason,
        allowRegistration: config.allowRegistration,
        allowTrading: config.allowTrading,
      },
    });
  }

  // The official seed lives in `d-close1-price` and the room's retained ring does
  // not reach back to the opening, so a late start has to be given the signed
  // envelope the launch record published. This runs *before* the hydrate: the
  // stored history is only readable once the verifier has a seed, and without it
  // every row below is refused with `seed_required`.
  if (config.refereeSeedBootstrapPath.length > 0) {
    const bootstrap = reader.applySeedBootstrap(config.refereeSeedBootstrapPath);
    logger.event({
      level: bootstrap.ok ? 'info' : 'warn',
      source: 'main',
      code: 'referee_seed_bootstrap',
      message: bootstrap.ok
        ? `the official signed seed bootstrap was accepted (${bootstrap.reason})`
        : `the official signed seed bootstrap was not accepted (${bootstrap.reason}); the referee rooms must supply the seed`,
      data: {
        path: config.refereeSeedBootstrapPath,
        outcome: bootstrap.reason,
        room: bootstrap.room ?? null,
        seq: bootstrap.seq ?? null,
      },
    });
  }

  // Rebuild the market view from the stored referee history *before* anything
  // reads or trades, so a restart resumes at the sweep it left off at rather than
  // at an empty snapshot.
  const hydrated = reader.hydrateFromSnapshots();
  logger.event({
    level: 'info',
    source: 'main',
    code: 'verifier_hydrated',
    message: `replayed ${hydrated.applied} referee posts (${hydrated.skipped} skipped)`,
    data: {
      applied: hydrated.applied,
      skipped: hydrated.skipped,
      sweep: reader.snapshot().sweep,
      reference: reader.snapshot().reference?.toString() ?? null,
    },
  });

  const runner = new GroupRunner({
    repositories,
    logger,
    rules,
    runWindowHours: config.scheduling.runWindowHours,
    now,
  });

  const loadGuard = new LoadGuard({
    config,
    logger,
    getQueueDepths: () => ({
      writer: writer.depth,
      // The model lane is one serialised slot (`DEEPSEEK_MAX_CONCURRENCY=1`) fed
      // by two scheduled windows a day, so a backlog cannot form; the "LLM queue"
      // threshold exists for a future multi-slot topology and is reported as 0.
      llm: 0,
    }),
    ...(overrides.readDiskUsage ? { readDiskUsage: overrides.readDiskUsage } : {}),
    now,
  });

  const budget = new DeepSeekBudget({ repositories, config, logger, loadGuard, now });
  const deepSeekClient = new DeepSeekClient({
    config,
    logger,
    ...(overrides.fetchImpl ? { fetchImpl: overrides.fetchImpl } : {}),
    now,
  });
  const optimiser = new ParameterOptimiser({
    config,
    logger,
    repositories,
    client: deepSeekClient,
    budget,
    loadGuard,
    now,
  });
  const deepSeek = new DeepSeekScheduler({ config, logger, optimiser, budget, now });

  const maintenance = new ArchiveMaintenance({
    config,
    logger,
    repositories,
    db,
    loadGuard,
    localDids: () => [...keyStore.didSet()],
    now,
  });

  const upstream = new UpstreamMonitor({
    config,
    logger,
    repositories,
    ...(overrides.fetchImpl ? { fetchImpl: overrides.fetchImpl } : {}),
    now,
  });

  // The archive is an audit source polled on its own timer: it is deliberately
  // not part of the tick, so a slow or absent archive cannot delay a read, a
  // trade or a registration.
  const archiveMonitor = new ChallengeArchiveMonitor({
    config,
    logger,
    repositories,
    localSweep: () => reader.verifier.state.currentSweep,
    ...(overrides.archiveFetchImpl ? { fetchImpl: overrides.archiveFetchImpl } : {}),
    ...(overrides.archiveSleep ? { sleep: overrides.archiveSleep } : {}),
    now,
  });

  // Lark needs the report builder and the report builder needs the scheduler, so
  // the stack is handed a late-bound closure. It is only ever called from a
  // scheduled window, long after this function has returned.
  let scheduler: OrchestratorScheduler | null = null;
  const lark = createLarkStack({
    config,
    logger,
    repositories,
    buildReport: async () => {
      if (!scheduler) throw new Error('scheduler is not constructed yet');
      return scheduler.buildReport();
    },
    ...(overrides.larkTransport ? { transport: overrides.larkTransport } : {}),
    ...(overrides.larkNotifierClientFactory
      ? { notifierClientFactory: overrides.larkNotifierClientFactory }
      : {}),
  });

  // The immediate-alert channel: the same durable outbox the daily report uses,
  // fed from the structured log. Built here because it needs the outbox.
  const notifier = new RuntimeEventNotifier({ repositories, logger, outbox: lark.outbox, now });
  notifierRef.current = notifier;

  scheduler = new OrchestratorScheduler({
    config,
    logger,
    repositories,
    db,
    keyStore,
    rules,
    client,
    reader,
    writer,
    runner,
    loadGuard,
    budget,
    optimiser,
    deepSeek,
    lark,
    maintenance,
    upstream,
    notifier,
    now,
  });

  const health = overrides.skipHealth
    ? null
    : createHealthServer({ config, logger, scheduler });

  return {
    config,
    logger,
    db,
    repositories,
    keyStore,
    rules,
    client,
    reader,
    writer,
    scheduler,
    lark,
    notifier,
    archiveMonitor,
    health,
    startedAt: now().toISOString(),
    async start(): Promise<void> {
      // Requeue any outbox rows left mid-flight by a crash before anything else.
      const requeued = lark.outbox.recover();
      if (requeued > 0) {
        logger.event({
          level: 'warn',
          source: 'main',
          code: 'outbox_recovered',
          message: `requeued ${requeued} Lark reports left mid-send by a previous run`,
          data: { requeued },
        });
      }
      logger.event({
        level: 'info',
        source: 'main',
        code: 'startup',
        message: `starting in ${config.mode}${config.liveArmed ? ' (live armed)' : ''} under the ${config.profile} profile`,
        data: {
          mode: config.mode,
          profile: config.profile,
          liveArmed: config.liveArmed,
          agents: keyStore.size,
          season: config.season,
          allowRegistration: config.allowRegistration,
          timezone: config.timezone,
        },
      });
      // A profile that overrode an operator's setting says so out loud: silently
      // ignoring `DEEPSEEK_ENABLED=true` would be worse than refusing it.
      if (config.profileOverrides.length > 0) {
        logger.event({
          level: 'warn',
          source: 'main',
          code: 'profile_overrode_settings',
          message: `the ${config.profile} profile closed ${config.profileOverrides.length} requested setting(s)`,
          data: { profile: config.profile, overrides: config.profileOverrides },
        });
      }
      // The WebSocket is an optional status channel: a failure to connect is a
      // warning, never a reason to refuse to start. Reports go out through the
      // Open API and the outbox regardless, and no trading decision reads the
      // socket's state.
      try {
        await lark.start();
      } catch (error) {
        logger.event({
          level: 'warn',
          source: 'main',
          code: 'lark_start_failed',
          message: 'Lark WebSocket did not start; reports are still generated and queued',
          data: { error: error instanceof Error ? error.message : String(error) },
        });
      }
      if (health) await health.start();
      archiveMonitor.start();
      // The reader's own loops start before the scheduler: the agent path reads
      // whatever the reader has stored, and a room that grows faster than one
      // page per scheduler tick must be drained by the reader, not by the tick.
      if (config.technoCore.readerEnabled) reader.startContinuous();
      // A one-off, read-only probe of the live service contract, after the loops
      // start. It sends no write and commits no cursor, so it can never change
      // reader state; the result lands in `/status.reader.serverContract`. A
      // failure is recorded, never a reason to refuse to start.
      if (config.technoCore.readerEnabled) {
        void reader.probeServerContract().catch((error: unknown) => {
          logger.event({
            level: 'warn',
            source: 'main',
            code: 'server_contract_probe_failed',
            message: 'the read-only service contract probe did not complete',
            data: { error: error instanceof Error ? error.message : String(error) },
          });
        });
      }
      scheduler.start();
    },
    async stop(): Promise<void> {
      // Abort the reader's long polls first: the scheduler's tick joins whatever
      // read is in flight, and a shutdown must never wait out a `wait` hold.
      await reader.stopContinuous();
      await scheduler.stop();
      archiveMonitor.stop();
      if (health) await health.stop();
      await lark.stop();
      upstream.stop();
      logger.event({
        level: 'info',
        source: 'main',
        code: 'shutdown',
        message: 'stopping; zeroing in-memory seeds',
        data: {},
      });
      keyStore.destroy();
    },
  };
}

/** Signal handling: shut down cleanly, and never on an unhandled rejection. */
function installSignalHandlers(runtime: Runtime): void {
  let stopping = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (stopping) return;
    stopping = true;
    runtime.logger.event({
      level: 'warn',
      source: 'main',
      code: 'signal_received',
      message: `received ${signal}; shutting down`,
      data: { signal },
    });
    try {
      await runtime.stop();
    } finally {
      process.exit(0);
    }
  };
  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.on(signal, () => {
      void shutdown(signal);
    });
  }
  process.on('unhandledRejection', (reason) => {
    runtime.logger.event({
      level: 'error',
      source: 'main',
      code: 'unhandled_rejection',
      message: 'unhandled promise rejection; the tick that caused it will retry',
      data: { reason: reason instanceof Error ? reason.message : String(reason) },
    });
  });
  process.on('uncaughtException', (error) => {
    runtime.logger.event({
      level: 'fatal',
      source: 'main',
      code: 'uncaught_exception',
      message: 'uncaught exception; exiting so the supervisor can restart cleanly',
      data: { error: error.message, stack: error.stack ?? null },
    });
    void shutdown('uncaughtException');
  });
}

/** Log one line about what the market looks like before the loop starts. */
async function announceMarket(runtime: Runtime): Promise<void> {
  const snapshot = runtime.reader.snapshot() ?? emptySnapshot();
  runtime.logger.event({
    level: 'info',
    source: 'main',
    code: 'market_snapshot',
    message: 'initial market view',
    data: {
      sweep: snapshot.sweep,
      reference: snapshot.reference?.toString() ?? null,
      locked: snapshot.locked,
      degraded: snapshot.degraded,
    },
  });
}

export async function runMain(env: NodeJS.ProcessEnv = process.env): Promise<Runtime> {
  const config = loadConfig(env);
  const runtime = await createRuntime(config);
  await announceMarket(runtime);
  installSignalHandlers(runtime);
  await runtime.start();
  return runtime;
}

function isEntryPoint(): boolean {
  const entry = process.argv[1] ?? '';
  return /main\.(ts|js|mjs)$/.test(entry);
}

if (isEntryPoint()) {
  runMain().catch((error: unknown) => {
    // Startup failures cannot use the persisted logger — the database may be the
    // thing that failed — so this is deliberately a plain stderr write.
    process.stderr.write(
      `flop-close-call: startup failed: ${error instanceof Error ? error.stack ?? error.message : String(error)}\n`,
    );
    process.exit(1);
  });
}
