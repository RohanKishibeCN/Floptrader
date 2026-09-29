/**
 * The orchestrator harness: a whole process, offline.
 *
 * Everything a test needs to exercise the real wiring — the real key store, the
 * real SQLite file, the real reader, writer, scheduler, risk book and Lark
 * stack — with only the two network edges replaced by doubles: the technocore
 * HTTP transport and the Lark transport.
 *
 * The key material is genuinely age-encrypted on disk and genuinely decrypted at
 * startup, because "the bundle restores and the process starts from it" is one
 * of the things under test. The seeds are deterministic, so a failure
 * reproduces.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  DEFAULT_AGENT_COUNT,
  ageRecipientFor,
  buildAdminPublicKey,
  buildInventory,
  createAgeIdentity,
  didFromSeed,
  encryptBundle,
  serializeAdminKey,
  serializeAdminPublicKey,
  serializeBundle,
  serializeInventory,
  serializeManifestSignature,
  signInventory,
} from '@flop/identity';
import { computeLocalPackageManifestHash } from '@flop/technocore';
import { loadConfig, type Config } from '../../apps/orchestrator/src/config.js';
import { createRuntime, writeIdentityMetadata, type Runtime, type RuntimeOverrides } from '../../apps/orchestrator/src/main.js';
import type { LarkSendClient, WsFactory } from '../../apps/orchestrator/src/lark.js';
import { cleanup, generateAgents, tempDir } from './harness.js';
import { FakeTransport, type RoomMessageLike } from './fake-transport.js';

/** A Lark sender that records instead of sending; nothing leaves the process. */
export class FakeLarkSender implements LarkSendClient {
  readonly sent: string[] = [];
  failNext = 0;

  async send(_chatId: string, text: string): Promise<{ ok: boolean; messageId?: string; error?: string }> {
    if (this.failNext > 0) {
      this.failNext -= 1;
      return { ok: false, error: 'fake lark transport failure' };
    }
    this.sent.push(text);
    return { ok: true, messageId: `fake-${this.sent.length}` };
  }
}

/**
 * A WebSocket transport that connects nowhere, reports itself ready, and can be
 * told to fail so the reconnect ladder is observable.
 */
export function fakeWsFactory(): WsFactory {
  return (options) => ({
    async start(): Promise<void> {
      // Yield once so the client's own state machine observes an asynchronous
      // handshake, exactly as the SDK's transport does.
      await Promise.resolve();
      options.onReady();
    },
    async stop(): Promise<void> {},
  });
}

/** The referee's deterministic seed, so its DID is stable across the suite. */
export const HARNESS_REFEREE_SEED = new Uint8Array(32).fill(11);
/**
 * The referee DID the harness pins.
 *
 * Production refuses to start live without `EXPECTED_REFEREE_DID`, so the
 * fixture pins the fake referee too: a test that could only ever talk to the
 * unpinned path would not exercise the wiring that matters.
 */
export const HARNESS_REFEREE_DID = didFromSeed(HARNESS_REFEREE_SEED);

/**
 * A referee identity that signs its posts.
 *
 * The verifier refuses unsigned referee traffic, and it pins the referee DID from
 * the first post it verifies — so a test that wants a sweep to exist has to
 * produce genuinely signed posts, not just well-shaped JSON.
 */
export class FakeReferee {
  readonly seed = HARNESS_REFEREE_SEED;
  readonly did = HARNESS_REFEREE_DID;
  private nonce = 0;

  constructor(private readonly transport: FakeTransport) {}

  /** Sign and append an arbitrary referee payload to a room. */
  post(room: string, payload: Record<string, unknown>): RoomMessageLike {
    this.nonce += 1;
    return this.transport.room(room).appendFrom(JSON.stringify(payload), {
      seed: this.seed,
      did: this.did,
      nonce: this.nonce,
    });
  }

  seedPost(packageHash: string, price = '225.10'): RoomMessageLike {
    return this.post('d-close1-state', {
      t: 'seed',
      season: 'close-1',
      price,
      trade: { time: '2026-09-28T12:00:00Z', tid: 't0' },
      package: packageHash,
      rooms: [],
    });
  }

  /** A price post. Limits default to ±5% of `px`, rounded to the cent. */
  price(sweep: number, px: string, limits?: [string, string]): RoomMessageLike {
    const centre = Number.parseFloat(px);
    const low = limits?.[0] ?? (centre * 0.95).toFixed(2);
    const high = limits?.[1] ?? (centre * 1.05).toFixed(2);
    return this.post('d-close1-price', {
      t: 'price',
      season: 'close-1',
      n: sweep,
      ref: { px, time: '2026-09-28T12:00:00Z', tid: `t${sweep}` },
      limits: [low, high],
    });
  }

  flow(sweep: number, mints: string[]): RoomMessageLike {
    return this.post('d-close1-flow', {
      t: 'flow',
      season: 'close-1',
      n: sweep,
      mints,
      rooms: [],
    });
  }
}

export interface HarnessOptions {
  /** Fewer agents than 150 make most tests much cheaper; the default is 150. */
  agentCount?: number;
  /**
   * Reuse an existing data directory instead of making a fresh one. A restart
   * test builds a harness, "kills" it, and builds another over the same files so
   * that what the second process sees is exactly what the first one committed.
   */
  dir?: string;
  /**
   * Reuse an existing fake transport. A restart over the same rooms keeps the
   * room contents — and therefore the sequence numbers the persisted cursors
   * point at — exactly as the real service would.
   */
  transport?: FakeTransport;
  /** A scriptable Lark WebSocket transport, so a drop can be induced on demand. */
  wsFactory?: WsFactory;
  now?: () => Date;
  /** Extra environment; merged last, so a test can override any knob. */
  env?: Record<string, string>;
  /**
   * Start the scheduler. Off by default: `start()` fires an immediate tick, and
   * a test that then calls `runTick()` or `ensureParticipation()` itself would
   * race it — two concurrent passes both try to post 150 registrations, which
   * trips the write rate limit and makes the test slow and non-deterministic
   * rather than wrong. Tests drive ticks explicitly.
   */
  autoStart?: boolean;
}

export interface Harness {
  dir: string;
  config: Config;
  runtime: Runtime;
  transport: FakeTransport;
  referee: FakeReferee;
  lark: FakeLarkSender;
  /**
   * The injected clock. Every timestamp the runtime writes comes from here, so
   * assertions must compare against this rather than `Date.now()` — the harness
   * clock starts at 2026-09-28T12:00:00Z and does not track the wall clock.
   */
  now(): Date;
  /** Advance the clock by `ms`. */
  advance(ms: number): void;
  /** Simulate disk pressure without filling a disk. */
  setDiskUsedPercent(percent: number): void;
  dispose(): Promise<void>;
}

export const REFERENCE_CONTEST_PATH = join(process.cwd(), 'reference', 'contest.json');
export const REFERENCE_DIR = join(process.cwd(), 'reference');

/**
 * The hash the harness pins into the bundle, the inventory and every seed.
 *
 * It is the real sha256 of the vendored `reference/manifest.json`, computed the
 * same way the CLI and `createRuntime` compute it — a stand-in hash would make
 * the harness pass while the production pin rejected the same inputs.
 */
export const HARNESS_PACKAGE_HASH: string = (() => {
  const pin = computeLocalPackageManifestHash(REFERENCE_DIR);
  if (!pin.ok) {
    throw new Error(`the vendored reference package does not verify: ${pin.problems.join('; ')}`);
  }
  return pin.manifestHash;
})();

/**
 * Build a runnable orchestrator in a temp directory.
 *
 * `FLOP_ALLOW_REGISTRATION=true` because the participation pipeline is the point
 * of most of these tests; `FLOP_MODE` stays at its dry-run default so nothing
 * would trade even if it could.
 */
export async function buildHarness(options: HarnessOptions = {}): Promise<Harness> {
  const agentCount = options.agentCount ?? 150;
  const dir = options.dir ?? tempDir('flop-orch-');
  const dataDir = join(dir, 'data');
  const secretsDir = join(dir, 'secrets');
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  mkdirSync(secretsDir, { recursive: true, mode: 0o700 });

  // A real age identity, used both as the encryption recipient and as the
  // runtime key the process decrypts with.
  const identity = await createAgeIdentity();
  const recipient = await ageRecipientFor(identity);
  const identityFile = join(secretsDir, 'runtime.key');
  writeFileSync(identityFile, `${identity}\n`, { mode: 0o600 });

  const agents = generateAgents(agentCount, true);
  const createdAt = new Date('2026-09-25T12:00:00.000Z').toISOString();
  const packageHash = HARNESS_PACKAGE_HASH;

  const bundle = serializeBundle(agents, {
    season: 'close-1',
    packageHash,
    createdAt,
    agentCount: agents.length,
  });
  writeFileSync(join(secretsDir, 'agents.bundle.age'), await encryptBundle(bundle, [recipient]), {
    mode: 0o600,
  });

  // A deterministic admin key, so the manifest signature is reproducible.
  const adminSeed = new Uint8Array(32).fill(7);
  writeFileSync(
    join(secretsDir, 'admin.key.age'),
    await encryptBundle(serializeAdminKey(adminSeed, createdAt), [recipient]),
    { mode: 0o600 },
  );

  const env: NodeJS.ProcessEnv = {
    NODE_ENV: 'test',
    TIMEZONE: 'Asia/Shanghai',
    LOG_LEVEL: 'fatal',
    DATA_DIR: dataDir,
    SECRETS_DIR: secretsDir,
    CONTEST_JSON_PATH: REFERENCE_CONTEST_PATH,
    REFERENCE_DIR,
    AGE_IDENTITY_FILE: identityFile,
    AGE_RECIPIENT_VPS: recipient,
    FLOP_MODE: 'dry-run',
    FLOP_ALLOW_REGISTRATION: 'true',
    // The referee is pinned exactly as production pins it; a fixture that could
    // only ever exercise the permissive path would not test the wiring.
    EXPECTED_REFEREE_DID: HARNESS_REFEREE_DID,
    // The full-fleet rule is enforced for a full-size harness and relaxed for
    // the small fixtures, so both the assertion and the cheaper tests are live.
    REQUIRE_FULL_FLEET: agentCount === DEFAULT_AGENT_COUNT ? 'true' : 'false',
    LARK_MODE: 'off',
    LARK_APP_ID: '',
    LARK_APP_SECRET: '',
    LARK_CHAT_ID: '',
    LARK_REPORT_TIMES: '08:50,18:10',
    TICK_SECONDS: '60',
    HEALTH_PORT: '0',
    ...options.env,
  };
  const config = loadConfig(env);

  // The public inventory, signed by the admin key, exactly as the CLI writes it.
  mkdirSync(config.paths.public, { recursive: true, mode: 0o700 });
  const inventory = buildInventory(agents, { season: 'close-1', packageHash, createdAt });
  writeFileSync(join(config.paths.public, 'agents.manifest.json'), serializeInventory(inventory), {
    mode: 0o644,
  });
  writeFileSync(
    join(config.paths.public, 'agents.manifest.sig'),
    serializeManifestSignature(signInventory(inventory, adminSeed, createdAt)),
    { mode: 0o644 },
  );
  // The public half only. Exactly as the CLI writes it: the VPS verifies the
  // inventory against a DID whose private key never lands on this host.
  writeFileSync(
    join(secretsDir, 'admin-public.key'),
    serializeAdminPublicKey(buildAdminPublicKey(adminSeed, 'close-1', createdAt)),
    { mode: 0o644 },
  );
  writeIdentityMetadata(config, agents);

  const transport = options.transport ?? new FakeTransport();
  const larkSender = new FakeLarkSender();

  let clockMs = options.now ? options.now().getTime() : Date.parse('2026-09-28T12:00:00.000Z');
  const now = (): Date => new Date(clockMs);
  let diskUsedPercent = 10;

  const overrides: RuntimeOverrides = {
    fetchImpl: transport.fetchImpl as unknown as typeof fetch,
    now,
    skipHealth: true,
    readDiskUsage: () => diskUsedPercent,
    larkTransport: options.wsFactory ?? fakeWsFactory(),
    larkNotifierClientFactory: () => larkSender,
  };

  const runtime = await createRuntime(config, overrides);
  if (options.autoStart === true) await runtime.start();

  return {
    dir,
    config,
    runtime,
    transport,
    referee: new FakeReferee(transport),
    lark: larkSender,
    now,
    advance(ms: number): void {
      clockMs += ms;
    },
    setDiskUsedPercent(percent: number): void {
      diskUsedPercent = percent;
    },
    async dispose(): Promise<void> {
      try {
        await runtime.stop();
      } catch {
        /* the test's own assertion is the useful failure */
      }
      try {
        runtime.db.close();
      } catch {
        /* already closed */
      }
      cleanup(dir);
    },
  };
}

/** The referee rooms the harness pre-creates, so a read is never a 404. */
export const HARNESS_ROOMS = [
  'd-close1-price',
  'd-close1-flow',
  'd-close1-positions',
  'd-close1-pnl',
  'd-close1-state',
  'close1',
];
