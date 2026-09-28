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
  decryptBundle,
  parseAdminKey,
  parseBundle,
  type AgentSecretRecord,
} from '@flop/identity';
import { openDatabase, createRepositories, type Repositories, type SqliteDatabase } from '@flop/storage';
import { GroupRunner } from '@flop/strategy';
import { TechnocoreClient } from '@flop/technocore';
import { ArchiveMaintenance } from './archive-maintenance.js';
import { loadConfig, type Config } from './config.js';
import { OrchestratorScheduler } from './scheduler.js';
import { OrchestratorReader } from './reader.js';
import { OrchestratorWriter } from './writer.js';
import { createHealthServer, type HealthServer } from './health.js';
import { createLarkStack, type LarkStack } from './lark.js';
import { DeepSeekBudget, DeepSeekClient, DeepSeekScheduler, ParameterOptimiser } from './llm.js';
import { LoadGuard } from './load-guard.js';
import { Logger } from './logger.js';
import { UpstreamMonitor } from './upstream-monitor.js';

export interface RuntimeOverrides {
  fetchImpl?: typeof fetch;
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
 * silently altering how we price a trade. A missing or unreadable file falls
 * back to the embedded reference copy and says so.
 */
export function loadRules(config: Config, logger?: Logger): Rules {
  const path = config.contestJsonPath;
  if (!existsSync(path)) {
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
    const rules = rulesFromConfig(parseContestConfig(readFileSync(path, 'utf8')));
    return rules;
  } catch (error) {
    logger?.event({
      level: 'error',
      source: 'main',
      code: 'contest_json_invalid',
      message: `contest.json at ${path} is unusable; using the embedded reference copy`,
      data: { path, error: error instanceof Error ? error.message : String(error) },
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
  const identities: string[] = [];
  if (config.ageIdentityFile.length > 0 && existsSync(config.ageIdentityFile)) {
    identities.push(readFileSync(config.ageIdentityFile, 'utf8').trim());
  }
  return identities;
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
  const logger = Logger.create({
    level: config.logLevel,
    name: 'flop-close-call',
    repositories,
  });

  const { keyStore, meta } = await loadAgentKeyStoreAsync(config, logger);
  const rules = loadRules(config, logger);
  if (rules.contestId !== config.season) {
    throw new Error(
      `contest.json declares ${rules.contestId} but this build is pinned to ${config.season}`,
    );
  }
  seedIdentityRows(repositories, keyStore, config.season);

  const now = overrides.now ?? (() => new Date());

  const client = new TechnocoreClient({
    baseUrl: config.technoCore.baseUrl,
    timeoutMs: config.technoCore.requestTimeoutMs,
    maxInflight: config.technoCore.maxInflight,
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

  // The pin is whatever the bundle was created against; a seed that quotes a
  // different package hash puts the process into conservative mode instead of
  // silently switching rule sets.
  const reader = new OrchestratorReader({
    rules,
    client,
    db,
    repositories,
    logger,
    localDids: () => keyStore.didSet(),
    readConcurrency: config.technoCore.readConcurrency,
    waitSeconds: config.technoCore.readWaitSeconds,
    expectedPackageHash: meta.packageHash,
    now,
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
        message: `starting in ${config.mode}${config.liveArmed ? ' (live armed)' : ''}`,
        data: {
          mode: config.mode,
          liveArmed: config.liveArmed,
          agents: keyStore.size,
          season: config.season,
          allowRegistration: config.allowRegistration,
          timezone: config.timezone,
        },
      });
      await lark.start();
      if (health) await health.start();
      scheduler.start();
    },
    async stop(): Promise<void> {
      await scheduler.stop();
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
