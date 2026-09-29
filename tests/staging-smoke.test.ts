/**
 * The optional real-network staging acceptance run.
 *
 * Everything else in this repository is driven by a fake transport: the reader,
 * the writer, the archive client and the Lark socket are all exercised offline.
 * That is enough to prove the logic, and it is deliberately **not** enough to
 * claim live trading is safe. This file is the one place that dials real
 * endpoints, and it is off unless it is asked for explicitly:
 *
 * ```bash
 * STAGING_SMOKE_TEST=true \
 * TECHNO_CORE_BASE_URL=https://technocore.chat \
 * STAGING_ROOM=smoke-<something-unique> \
 * CHALLENGE_ARCHIVE_BASE_URL=https://challenges.technocore.chat/close-1 \
 * LARK_APP_ID=... LARK_APP_SECRET=... LARK_BOT_ID=... LARK_CHAT_ID=... \
 * npx vitest run tests/staging-smoke.test.ts
 * ```
 *
 * Three rules make it safe to run by hand:
 *   1. it never posts into a contest room — `STAGING_ROOM` is refused if it names
 *      `close1` or one of the referee rooms;
 *   2. it never registers one of the 150 contest owners: it generates a throwaway
 *      agent for the staging room;
 *   3. when the switch is off every test is skipped, so `pnpm test` is unchanged.
 *
 * Until a run of this file has completed against real endpoints, no claim that
 * live trading is allowed is made anywhere in this repository.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { canonicalJson, didFromSeed, signRoomMessage } from '@flop/identity';
import {
  ArchiveClient,
  TechnocoreClient,
  classifyStatus,
  withRetry,
  type SignedEnvelope,
} from '@flop/technocore';
import { createRepositories, openDatabase } from '@flop/storage';
import {
  LarkOpenApiNotifier,
  LarkOutbox,
  LarkWebSocketClient,
} from '../apps/orchestrator/src/lark.js';
import { loadConfig } from '../apps/orchestrator/src/config.js';
import { Logger } from '../apps/orchestrator/src/logger.js';

const ENABLED = (process.env.STAGING_SMOKE_TEST ?? '').trim().toLowerCase() === 'true';
/** `describe.skip` when the switch is off: the default `pnpm test` is untouched. */
const staging = ENABLED ? describe : describe.skip;

const BASE_URL = (process.env.TECHNO_CORE_BASE_URL ?? 'https://technocore.chat').replace(/\/+$/, '');
const STAGING_ROOM = (process.env.STAGING_ROOM ?? '').trim();
const ARCHIVE_URL = (
  process.env.CHALLENGE_ARCHIVE_BASE_URL ?? 'https://challenges.technocore.chat/close-1'
).replace(/\/+$/, '');

/** A staging room must never be a contest room. */
const CONTEST_ROOMS = new Set([
  'close1',
  'd-close1-price',
  'd-close1-flow',
  'd-close1-positions',
  'd-close1-pnl',
  'd-close1-state',
]);

const silent = Logger.create({ level: 'fatal' });
/** A throwaway owner: this run never touches one of the 150 contest identities. */
const SMOKE_SEED = new Uint8Array(32).fill(0x5a);
const SMOKE_DID = didFromSeed(SMOKE_SEED);

function smokeRoom(): string {
  if (STAGING_ROOM.length === 0) throw new Error('STAGING_SMOKE_TEST requires STAGING_ROOM');
  if (CONTEST_ROOMS.has(STAGING_ROOM)) {
    throw new Error(`refusing to use the contest room ${STAGING_ROOM} for a staging smoke test`);
  }
  return STAGING_ROOM;
}

/** A temporary SQLite file, so the outbox half is exercised against the real schema. */
function tempDb(): { db: ReturnType<typeof openDatabase>; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), 'flop-staging-'));
  return { db: openDatabase({ path: join(dir, 'app.db') }), dir };
}

staging('staging: the live gates are still the four-gate contract', () => {
  it('refuses to arm trading from a single variable', () => {
    expect(() => loadConfig({ FLOP_ALLOW_TRADING: 'true' })).toThrow(/FLOP_ALLOW_TRADING/);
    expect(() => loadConfig({ FLOP_MODE: 'live', FLOP_LIVE_CONFIRM: 'close-1' })).toThrow(
      /FLOP_ALLOW_REGISTRATION/,
    );
    const armed = loadConfig({
      FLOP_MODE: 'live',
      FLOP_LIVE_CONFIRM: 'close-1',
      FLOP_ALLOW_REGISTRATION: 'true',
      FLOP_ALLOW_TRADING: 'true',
      EXPECTED_REFEREE_DID: SMOKE_DID,
    });
    expect(armed.tradingArmed).toBe(true);
  });
});

staging('staging: technocore', () => {
  it('posts one signed owner registration and reads back the exact bytes', async () => {
    const room = smokeRoom();
    const client = new TechnocoreClient({ baseUrl: BASE_URL, timeoutMs: 20_000, maxInflight: 2 });
    const nonce = String(Date.now());
    const text = canonicalJson({ t: 'owner', season: 'close-1', key: SMOKE_DID });
    const signed = signRoomMessage(SMOKE_DID, SMOKE_SEED, room, nonce, text);
    const envelope: SignedEnvelope = {
      did: signed.did,
      nonce: signed.nonce,
      sig: signed.sig,
      text: signed.text,
    };

    const posted = await client.postSigned(room, envelope);
    expect(posted.ok).toBe(true);
    expect(posted.status).toBeGreaterThanOrEqual(200);
    expect(posted.status).toBeLessThan(300);

    const read = await client.readRoom(room, { since: 0, limit: 200 });
    const echo = read.read.messages.find(
      (message) => message.nonce !== undefined && String(message.nonce) === nonce,
    );
    expect(echo).toBeDefined();
    expect(echo!.from).toBe(SMOKE_DID);
    expect(echo!.text).toBe(signed.text);
    expect(typeof echo!.seq).toBe('number');
  });

  it('uses a fresh nonce for the next message', () => {
    const room = smokeRoom();
    const first = signRoomMessage(SMOKE_DID, SMOKE_SEED, room, String(Date.now()), 'nonce-a');
    const second = signRoomMessage(SMOKE_DID, SMOKE_SEED, room, String(Date.now() + 1), 'nonce-b');
    expect(second.nonce).not.toBe(first.nonce);
    expect(classifyStatus(429)).toBe('retryable');
    expect(classifyStatus(404)).toBe('permanent');
  });

  it('retries a 429 once and then succeeds against the real room', async () => {
    const room = smokeRoom();
    let calls = 0;
    // The service's own 429 is injected in front of the real transport: the retry
    // ladder is what is under test, the endpoint is real.
    const wrapped: typeof fetch = async (input, init) => {
      calls += 1;
      if (calls === 1) return new Response('429 slow down', { status: 429 });
      return fetch(input, init);
    };
    const throttled = new TechnocoreClient({ baseUrl: BASE_URL, timeoutMs: 20_000, fetchImpl: wrapped });

    const outcome = await withRetry<number>(
      async () => {
        try {
          const result = await throttled.readRoom(room, { limit: 1 });
          return { ok: true, value: result.read.count, attempts: 1, permanent: false };
        } catch (error) {
          return {
            ok: false,
            error: error instanceof Error ? error.message : String(error),
            attempts: 1,
            permanent: false,
          };
        }
      },
      { policy: { attempts: 3, baseDelayMs: 100, maxDelayMs: 500, jitterFraction: 0 } },
    );

    expect(calls).toBeGreaterThanOrEqual(2);
    expect(outcome.ok).toBe(true);
  });

  it('bounds a hung request with a deadline', async () => {
    const impatient = new TechnocoreClient({ baseUrl: BASE_URL, timeoutMs: 1 });
    await expect(impatient.readRoom(smokeRoom())).rejects.toThrow();
  });
});

staging('staging: the published archive', () => {
  it('parses index.json and verifies the latest record it has published', async () => {
    const client = new ArchiveClient({ baseUrl: ARCHIVE_URL, logger: silent, timeoutMs: 20_000 });
    const index = await client.index();
    expect(index).not.toBeNull();
    expect(Array.isArray(index!.sweeps)).toBe(true);
    // A lagging archive is a data gap, never a failure: an empty index passes.
    if (index!.sweeps.length === 0) return;

    const latest = index!.entries.get(index!.sweeps[index!.sweeps.length - 1]!)!;
    const bytes = await client.record(latest);
    if (bytes === null) return; // 404: recorded as archive_unavailable, not a failure
    expect(bytes.length).toBeGreaterThan(0);
  });

  it('treats a missing record as a gap rather than a failure', async () => {
    const client = new ArchiveClient({ baseUrl: ARCHIVE_URL, logger: silent, timeoutMs: 20_000 });
    const missing = await client.record({
      sweep: -1,
      status: 'full',
      path: 'sweeps/does-not-exist.json',
      sha256: '0'.repeat(64),
      size: null,
      redactedTrades: null,
    });
    expect(missing).toBeNull();
  });
});

staging('staging: lark', () => {
  let db: ReturnType<typeof openDatabase> | undefined;
  let dir = '';

  beforeAll(() => {
    const opened = tempDb();
    db = opened.db;
    dir = opened.dir;
  });

  afterAll(() => {
    try {
      db?.close();
    } catch {
      /* already closed */
    }
    if (dir.length > 0) rmSync(dir, { recursive: true, force: true });
  });

  it('connects the WebSocket, sends a report through the Open API, and de-duplicates by report_id', async () => {
    const chatId = process.env.LARK_CHAT_ID ?? '';
    const appId = process.env.LARK_APP_ID ?? '';
    const appSecret = process.env.LARK_APP_SECRET ?? '';
    expect(appId.length).toBeGreaterThan(0);
    expect(appSecret.length).toBeGreaterThan(0);
    expect(chatId.length).toBeGreaterThan(0);

    const socket = new LarkWebSocketClient({
      appId,
      appSecret,
      botId: process.env.LARK_BOT_ID ?? '',
      logger: silent,
      reconnectMinMs: 500,
      reconnectMaxMs: 5_000,
      heartbeatTimeoutMs: 300_000,
    });
    await socket.start();
    expect(socket.status.state).toBe('connected');

    const notifier = new LarkOpenApiNotifier({ appId, appSecret, chatId, logger: silent });
    const reportId = `staging-${Date.now()}`;
    const sent = await notifier.sendText(`staging smoke ${reportId}`);
    expect(sent.ok).toBe(true);

    const repositories = createRepositories(db!);
    const outbox = new LarkOutbox({ repositories, notifier, logger: silent });
    // The UNIQUE report_id is the duplicate guard: the second enqueue is a no-op.
    expect(outbox.enqueue(reportId, 'staging', `staging smoke ${reportId}`)).toBe(true);
    expect(outbox.enqueue(reportId, 'staging', `staging smoke ${reportId}`)).toBe(false);
    const flushed = await outbox.flush(5);
    expect(flushed.failed).toBe(0);

    await socket.stop();
    expect(socket.status.state).toBe('stopped');
  });
});

staging('staging: the process-level plumbing the network cannot cover', () => {
  it('has the tables, the columns and the re-post queue the six workstreams need', () => {
    const { db, dir } = tempDb();
    try {
      const repositories = createRepositories(db);
      expect(repositories.archiveState.get()).toBeUndefined();
      expect(repositories.archiveSweeps.count()).toBe(0);
      expect(repositories.reposts.count()).toBe(0);
      const columns = db.prepare('PRAGMA table_info(trades)').all() as Array<{ name: string }>;
      const names = columns.map((column) => column.name);
      expect(names).toContain('referee_funds_side');
      expect(names).toContain('local_funds_side');
      expect(names).toContain('funds_side_confidence');
      // The schema version is the build's own, and the database agrees.
      expect(db.pragma('user_version', { simple: true })).toBe(3);
    } finally {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
