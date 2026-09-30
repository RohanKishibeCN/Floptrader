/**
 * The Lark WebSocket client, driven by a fake transport.
 *
 * The point of these tests is that the connection lifecycle is fully testable
 * without a network: one connection only, a backoff that grows and is capped,
 * a stop that actually stops, and heartbeat staleness. The real SDK transport is
 * never exercised here.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  closeDatabase,
  createRepositories,
  openDatabase,
  type Repositories,
  type SqliteDatabase,
} from '@flop/storage';
import {
  LarkWebSocketClient,
  SDK_LIFECYCLE_HINTS,
  backoffDelayMs,
  nominalBackoffMs,
  sdkLifecycleLogger,
  type LarkWebSocketClientOptions,
  type WsFactory,
  type WsLike,
  type WsTransportOptions,
} from '../apps/orchestrator/src/lark.js';
import { Logger } from '../apps/orchestrator/src/logger.js';
import { cleanup, tempDir } from './support/harness.js';
import { buildHarness } from './support/orchestrator.js';

const RECONNECT_MIN_MS = 100;
const RECONNECT_MAX_MS = 1_600;
const HEARTBEAT_TIMEOUT_MS = 30_000;

let dir: string;
let db: SqliteDatabase;
let repositories: Repositories;
let logger: Logger;

beforeEach(() => {
  dir = tempDir('flop-lark-ws-');
  db = openDatabase({ path: join(dir, 'app.db') });
  repositories = createRepositories(db);
  logger = Logger.create({ level: 'fatal', repositories });
});

afterEach(() => {
  closeDatabase(db);
  cleanup(dir);
  vi.useRealTimers();
  vi.restoreAllMocks();
});

interface FakeTransport extends WsLike {
  options: WsTransportOptions;
  starts: number;
  stops: number;
}

/** A factory whose transports can signal ready or fail, and record start/stop. */
function makeFactory(behaviour: { ready?: boolean; fail?: boolean } = {}): {
  factory: WsFactory;
  transports: FakeTransport[];
} {
  const transports: FakeTransport[] = [];
  const factory: WsFactory = (options) => {
    const transport: FakeTransport = {
      options,
      starts: 0,
      stops: 0,
      async start() {
        transport.starts += 1;
        if (behaviour.fail) throw new Error('transport failed');
        if (behaviour.ready !== false) options.onReady();
      },
      async stop() {
        transport.stops += 1;
      },
    };
    transports.push(transport);
    return transport;
  };
  return { factory, transports };
}

function options(overrides: Partial<LarkWebSocketClientOptions> = {}): LarkWebSocketClientOptions {
  return {
    appId: 'cli_test',
    // A value that must never appear in a log line; the client only hands it to the SDK.
    appSecret: 'super-secret-value',
    botId: 'bot_test',
    reconnectMinMs: RECONNECT_MIN_MS,
    reconnectMaxMs: RECONNECT_MAX_MS,
    heartbeatTimeoutMs: HEARTBEAT_TIMEOUT_MS,
    logger,
    ...overrides,
  };
}

describe('LarkWebSocketClient connection lifecycle', () => {
  it('opens exactly one connection and reports connected with one attempt', async () => {
    const { factory, transports } = makeFactory();
    const client = new LarkWebSocketClient(options({ wsFactory: factory }));

    await client.start();

    const status = client.status;
    expect(status.state).toBe('connected');
    expect(status.connected).toBe(true);
    expect(status.attempts).toBe(1);
    // The single-connection invariant: one transport, one open connection.
    expect(status.connections).toBe(1);
    expect(transports).toHaveLength(1);
    expect(status.lastConnectedAt).not.toBeNull();
  });

  it('never opens a second connection when start is called twice', async () => {
    const { factory, transports } = makeFactory();
    const client = new LarkWebSocketClient(options({ wsFactory: factory }));

    await client.start();
    await client.start();

    // A second start on a live connection must be a no-op, not a second socket.
    expect(transports).toHaveLength(1);
    expect(client.status.connections).toBe(1);
    expect(client.status.attempts).toBe(1);
  });

  it('stops idempotently and cancels any scheduled reconnect', async () => {
    vi.useFakeTimers();
    const { factory, transports } = makeFactory({ fail: true });
    const client = new LarkWebSocketClient(options({ wsFactory: factory }));

    // The first attempt fails, which schedules a reconnect.
    await client.start();
    expect(transports).toHaveLength(1);
    expect(client.status.state).toBe('reconnecting');

    await client.stop();
    await client.stop();
    await vi.advanceTimersByTimeAsync(RECONNECT_MAX_MS * 10);

    // No new transport was created after stop, even far past every backoff.
    expect(transports).toHaveLength(1);
    expect(client.status.state).toBe('stopped');
  });

  it('reconnects after a transport error with a growing attempt count', async () => {
    vi.useFakeTimers();
    const { factory, transports } = makeFactory({ fail: true });
    const client = new LarkWebSocketClient(options({ wsFactory: factory }));

    await client.start();
    expect(transports).toHaveLength(1);
    expect(client.status.state).toBe('reconnecting');

    // Advancing past the first (minimum) backoff fires exactly one more attempt.
    await vi.advanceTimersByTimeAsync(RECONNECT_MIN_MS * 2);
    expect(transports.length).toBeGreaterThanOrEqual(2);

    // Farther out it keeps retrying, and never holds two connections at once.
    await vi.advanceTimersByTimeAsync(RECONNECT_MAX_MS * 8);
    expect(client.status.attempts).toBe(transports.length);
    expect(client.status.connections).toBe(0);

    // Stop while the fake clock is still installed: a pending reconnect left
    // behind would fire for real once the timers are restored, and log against a
    // database this test's teardown has already closed.
    await client.stop();
    expect(client.status.state).toBe('stopped');
  });

  it('reports a heartbeat older than the timeout as stale', async () => {
    vi.useFakeTimers();
    const { factory } = makeFactory();
    const client = new LarkWebSocketClient(options({ wsFactory: factory }));

    await client.start();
    // A fresh connection is alive by definition: the clock starts at connect, so
    // "stale" means the socket went quiet, not "we have never seen a pong".
    expect(client.status.sinceLastHeartbeatMs).toBe(0);
    expect(client.status.heartbeatStale).toBe(false);

    await vi.advanceTimersByTimeAsync(HEARTBEAT_TIMEOUT_MS + 1);
    expect(client.status.sinceLastHeartbeatMs).toBeGreaterThan(HEARTBEAT_TIMEOUT_MS);
    expect(client.status.heartbeatStale).toBe(true);
  });

  it('reconnects when the transport reports the socket closed', async () => {
    vi.useFakeTimers();
    const { factory, transports } = makeFactory();
    const client = new LarkWebSocketClient(options({ wsFactory: factory }));

    await client.start();
    expect(client.status.connected).toBe(true);

    // The SDK runs with `autoReconnect: false`, so a close is ours to handle:
    // without this the process would keep reporting a connection that is gone.
    transports[0]!.options.onClose('the socket closed');
    expect(client.status.connected).toBe(false);
    expect(client.status.state).toBe('reconnecting');
    expect(client.status.connections).toBe(0);

    await vi.advanceTimersByTimeAsync(RECONNECT_MIN_MS * 2);
    expect(transports.length).toBeGreaterThanOrEqual(2);
    expect(client.status.connected).toBe(true);
  });

  it('stays connecting while no transport has reported readiness', async () => {
    const { factory } = makeFactory({ ready: false });
    const client = new LarkWebSocketClient(options({ wsFactory: factory }));

    await client.start();

    // Nothing claims a connection the client cannot observe.
    expect(client.status.state).toBe('connecting');
    expect(client.status.connected).toBe(false);
    expect(client.status.connections).toBe(1);
  });

  it('keeps the app secret out of every transport error it reports', async () => {
    const { factory } = makeFactory({ fail: true });
    const client = new LarkWebSocketClient(options({ wsFactory: factory }));

    await client.start();

    expect(client.status.lastError).toBe('transport failed');
    expect(client.status.lastError).not.toContain('super-secret-value');

    // A failed connect schedules a real reconnect. Stop the client so that timer
    // cannot outlive this test and log against the closed database afterwards.
    await client.stop();
  });
});

describe('reconnect backoff', () => {
  it('grows non-decreasingly, caps at the maximum, and jitters within ±20%', () => {
    const min = 1_000;
    const max = 60_000;

    const nominals = Array.from({ length: 12 }, (_, index) => nominalBackoffMs(index, min, max));
    expect(nominals[0]).toBe(min);
    for (let index = 1; index < nominals.length; index += 1) {
      expect(nominals[index]!).toBeGreaterThanOrEqual(nominals[index - 1]!);
    }
    // The doubling sequence must saturate at the cap rather than grow forever.
    expect(Math.max(...nominals)).toBe(max);
    expect(nominalBackoffMs(50, min, max)).toBe(max);

    // Whatever the jitter draw, the delay stays within ±20% of the nominal value.
    for (const draw of [0, 0.1, 0.5, 0.9, 0.999_999]) {
      const delay = backoffDelayMs(4, min, max, () => draw);
      const nominal = nominalBackoffMs(4, min, max);
      expect(delay).toBeGreaterThanOrEqual(nominal * 0.8 - 1e-9);
      expect(delay).toBeLessThanOrEqual(nominal * 1.2 + 1e-9);
    }
  });
});

/**
 * The SDK exposes no lifecycle API in the pinned version, so the adapter reads the
 * connection out of the SDK's own log lines. That coupling is deliberate and it
 * has to be checked: an upgrade that renames a line would otherwise leave the
 * client deaf, claiming `connecting` forever with no reconnect.
 */
describe('the SDK lifecycle adapter', () => {
  const sdkPackage = (): { version: string } =>
    JSON.parse(
      readFileSync(join(process.cwd(), 'node_modules/@larksuiteoapi/node-sdk/package.json'), 'utf8'),
    ) as { version: string };

  it('pins the SDK version the adapter was verified against', () => {
    const declared = JSON.parse(readFileSync(join(process.cwd(), 'package.json'), 'utf8')) as {
      dependencies: Record<string, string>;
    };
    // Exact, not a range: the private socket teardown and the log lines below are
    // facts about this version.
    expect(declared.dependencies['@larksuiteoapi/node-sdk']).toBe('1.48.0');
    expect(sdkPackage().version).toBe('1.48.0');
  });

  it('finds every lifecycle hint in the installed SDK build', () => {
    const source = readFileSync(
      join(process.cwd(), 'node_modules/@larksuiteoapi/node-sdk/lib/index.js'),
      'utf8',
    );
    for (const [name, hint] of Object.entries(SDK_LIFECYCLE_HINTS)) {
      expect(source, `the pinned SDK no longer logs "${hint}" (${name})`).toContain(hint);
    }
  });

  it('maps those lines onto the transport hooks, in the SDK’s calling shape', () => {
    const seen: string[] = [];
    const logger = sdkLifecycleLogger({
      onReady: () => seen.push('ready'),
      onClose: (reason) => seen.push(`close:${reason}`),
      onError: () => seen.push('error'),
      onHeartbeat: () => seen.push('pong'),
    });

    // The SDK wraps a supplied logger in its own LoggerProxy, which calls it with
    // every argument packed into a single array — the shape this has to survive.
    logger.trace([['[ws]', 'receive pong']]);
    logger.info([['[ws]', 'ws client ready']]);
    logger.debug([['[ws]', 'ws connect success']]);
    logger.error([['[ws]', 'ws connect failed']]);
    logger.debug([['[ws]', 'client closed']]);
    logger.info([['[ws]', 'some other line nobody promised']]);

    expect(seen).toEqual(['pong', 'ready', 'ready', 'error', 'close:the socket closed']);
  });
});

describe('the socket is an optional status channel, never a startup gate', () => {
  it('starts and keeps reporting when the socket cannot connect', async () => {
    const harness = await buildHarness({
      agentCount: 4,
      env: {
        // A configured Lark, so the stack really tries to open a socket.
        LARK_MODE: 'websocket',
        LARK_WS_ENABLED: 'true',
        LARK_APP_ID: 'cli-test',
        LARK_APP_SECRET: 'secret-test',
        LARK_CHAT_ID: 'oc-test',
        // A long reconnect delay keeps the ladder from firing inside the test;
        // the transport is stopped by the runtime's own shutdown either way.
        LARK_RECONNECT_MIN_MS: '60000',
        LARK_RECONNECT_MAX_MS: '60000',
      },
      // A transport whose very first connect fails, which is the case the start
      // path has to survive: no credentials, a DNS failure, a refused handshake.
      wsFactory: () =>
        ({
          async start(): Promise<void> {
            throw new Error('dns is down');
          },
          async stop(): Promise<void> {},
        }) satisfies WsLike,
    });
    try {
      // The runtime starts: the socket is an optional status channel.
      await expect(harness.runtime.start()).resolves.toBeUndefined();

      const status = harness.runtime.scheduler.status();
      expect(status.lark.connected).toBe(false);
      expect(status.lark.state).not.toBe('connected');

      // The core path is unaffected: a tick still runs and a report still builds.
      const tick = await harness.runtime.scheduler.runTick();
      expect(tick.rooms.readErrors).toBe(0);
      const report = await harness.runtime.scheduler.buildReport();
      expect(report).toBeTruthy();
    } finally {
      await harness.dispose();
    }
  });
});
