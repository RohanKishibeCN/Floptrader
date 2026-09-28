/**
 * The Lark WebSocket client, driven by a fake transport.
 *
 * The point of these tests is that the connection lifecycle is fully testable
 * without a network: one connection only, a backoff that grows and is capped,
 * a stop that actually stops, and heartbeat staleness. The real SDK transport is
 * never exercised here.
 */
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
  backoffDelayMs,
  nominalBackoffMs,
  type LarkWebSocketClientOptions,
  type WsFactory,
  type WsLike,
  type WsTransportOptions,
} from '../apps/orchestrator/src/lark.js';
import { Logger } from '../apps/orchestrator/src/logger.js';
import { cleanup, tempDir } from './support/harness.js';

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
  });

  it('reports a heartbeat older than the timeout as stale', async () => {
    vi.useFakeTimers();
    const { factory, transports } = makeFactory();
    const client = new LarkWebSocketClient(options({ wsFactory: factory }));

    await client.start();
    // No heartbeat yet: unknown age, not stale.
    expect(client.status.sinceLastHeartbeatMs).toBeNull();
    expect(client.status.heartbeatStale).toBe(false);

    transports[0]!.options.onHeartbeat();
    expect(client.status.heartbeatStale).toBe(false);

    await vi.advanceTimersByTimeAsync(HEARTBEAT_TIMEOUT_MS + 1);
    expect(client.status.sinceLastHeartbeatMs).toBeGreaterThan(HEARTBEAT_TIMEOUT_MS);
    expect(client.status.heartbeatStale).toBe(true);
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
