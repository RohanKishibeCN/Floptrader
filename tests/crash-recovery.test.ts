/**
 * Crash recovery: `kill -9`, then the same directory again.
 *
 * A 2 vCPU VPS with other tenants will not get a graceful shutdown every time.
 * The process may die between any two statements, so the guarantees have to hold
 * without a clean close:
 *
 *   - every committed row is still there, because SQLite's WAL is the recovery
 *     log and the next connection replays it;
 *   - `integrity_check` says `ok`, so nothing was half-written;
 *   - the second process does not re-register anyone (the participation floor is
 *     idempotent), does not lower a nonce (the counter is monotonic in SQL), and
 *     does not lose a room cursor (a lost cursor would re-read or skip messages);
 *   - no trade id appears twice.
 *
 * The kill is modelled by simply not stopping the first runtime: no `stop()`, no
 * `checkpoint()`, no `close()`. That leaves the WAL on disk exactly as a SIGKILL
 * would, and the second harness opens the same files.
 */
import { existsSync, writeFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  databaseHealth,
  openDatabase,
  openRegisteredDatabase,
} from '@flop/storage';
import { buildHarness, type Harness } from './support/orchestrator.js';
import { cleanup, tempDir } from './support/harness.js';

const AGENTS = 15;

interface Snapshot {
  identities: number;
  participation: number;
  readback: number;
  nonces: number;
  registrationPosts: number;
  cursors: Array<{ room: string; cursor: number; generation: number; firstSeq: number | null; lastSeq: number | null; gap: number }>;
  nonceBy: Record<string, string | null>;
}

function snapshot(h: Harness): Snapshot {
  const repositories = h.runtime.repositories;
  const nonceBy: Record<string, string | null> = {};
  for (const agentId of h.runtime.keyStore.agentIds) {
    const did = h.runtime.keyStore.did(agentId);
    nonceBy[did] = repositories.nonces.getLastNonce(did, h.config.tradingRoom);
  }
  return {
    identities: repositories.identities.count(),
    participation: repositories.participation.count(),
    readback: repositories.participation.countWithReadback(),
    nonces: repositories.nonces.count(),
    registrationPosts: h.transport.postsFor('close1').length,
    cursors: repositories.roomCursors.all().map((row) => ({
      room: row.room,
      cursor: row.cursor,
      generation: row.generation,
      firstSeq: row.first_seq,
      lastSeq: row.last_seq,
      gap: row.gap,
    })),
    nonceBy,
  };
}

/** Nonces compare numerically, so length first and then lexically. */
function nonceAtLeast(after: string | null, before: string | null): boolean {
  if (after === null) return false;
  if (before === null) return true;
  if (after.length !== before.length) return after.length > before.length;
  return after >= before;
}

describe('a hard kill, then a restart over the same files', () => {
  const dir = tempDir('flop-crash-');
  let before: Snapshot;
  let cursorsAtKill: Snapshot['cursors'];
  let walExistedAtKill: boolean;
  let databasePath: string;
  /** The killed process: deliberately never stopped, so the WAL stays put. */
  let killed: Harness;
  let restarted: Harness;
  let restartedPosts: number;

  beforeAll(async () => {
    killed = await buildHarness({ agentCount: AGENTS, dir });
    // Two ticks: the first posts the registrations, the second reads close1 and
    // confirms the readback evidence for each of them.
    await killed.runtime.scheduler.runTick();
    await killed.runtime.scheduler.runTick();
    before = snapshot(killed);
    cursorsAtKill = before.cursors;
    databasePath = killed.config.paths.database;
    walExistedAtKill = existsSync(`${databasePath}-wal`);
    restartedPosts = 0;

    // A sanity check on the fixture itself: the first process really did the
    // work the rest of the file reasons about.
    expect(before.identities).toBe(AGENTS);
    expect(before.registrationPosts).toBe(AGENTS);
    expect(before.readback).toBe(AGENTS);
    expect(before.nonces).toBe(AGENTS);

    // SIGKILL. Nothing is flushed, nothing is closed.
    restarted = await buildHarness({ agentCount: AGENTS, dir });
    await restarted.runtime.scheduler.runTick();
    restartedPosts = restarted.transport.postsFor('close1').length;
  }, 120_000);

  afterAll(async () => {
    try {
      await restarted.dispose();
    } catch {
      /* reported by the test, not by teardown */
    }
    try {
      killed.runtime.db.close();
    } catch {
      /* the harness may already have closed it */
    }
    cleanup(dir);
  });

  it('leaves a WAL the next process can recover from', () => {
    // Not flushed on the way out: that is what makes the next open a recovery.
    expect(walExistedAtKill).toBe(true);

    // A fresh, independent connection — as a diagnostic tool would open it.
    const probe = openRegisteredDatabase(databasePath, { readonly: true });
    try {
      expect(probe.pragma('integrity_check', { simple: true })).toBe('ok');
      expect(probe.pragma('user_version', { simple: true })).toBeGreaterThan(0);
    } finally {
      probe.close();
    }
  });

  it('finds every committed row after the kill', () => {
    const repositories = restarted.runtime.repositories;
    expect(repositories.identities.count()).toBe(before.identities);
    expect(repositories.participation.count()).toBe(before.participation);
    // The evidence each agent needs is the part that must never be lost.
    expect(repositories.participation.countWithReadback()).toBe(before.readback);
    // Readback before the lock advances the row to `before_lock_confirmed`.
    expect(repositories.participation.countByStatus().before_lock_confirmed).toBe(AGENTS);
    expect(repositories.participation.countByStatus().failed).toBeUndefined();
    expect(repositories.nonces.count()).toBe(before.nonces);
    expect(repositories.agentRuns.count()).toBeGreaterThanOrEqual(AGENTS);
  });

  it('re-registers nobody: the participation floor is idempotent', () => {
    expect(restartedPosts).toBe(0);
    expect(restarted.runtime.repositories.participation.count()).toBe(before.participation);
  });

  it('never lowers a nonce, and leaves no duplicate trade id', () => {
    for (const [did, previous] of Object.entries(before.nonceBy)) {
      const now = restarted.runtime.repositories.nonces.getLastNonce(
        did,
        restarted.config.tradingRoom,
      );
      expect(nonceAtLeast(now, previous), `nonce for ${did} went backwards`).toBe(true);
    }

    const duplicates = restarted.runtime.db
      .prepare('SELECT COUNT(*) AS n FROM (SELECT id FROM trades GROUP BY id HAVING COUNT(*) > 1)')
      .get() as { n: number };
    expect(duplicates.n).toBe(0);
  });

  it('keeps every room cursor, so nothing is re-read or skipped', () => {
    const after = restarted.runtime.repositories.roomCursors.all();
    expect(after.map((row) => row.room).sort()).toEqual(cursorsAtKill.map((row) => row.room).sort());

    for (const held of cursorsAtKill) {
      const row = after.find((candidate) => candidate.room === held.room)!;
      expect(row.cursor, `${held.room} lost its cursor`).toBe(held.cursor);
      expect(row.generation).toBe(held.generation);
      expect(row.gap).toBe(held.gap);
      // A cursor reset to zero is the failure this test exists to rule out.
      expect(row.room_reset).toBe(0);
    }
    expect(restarted.runtime.repositories.roomCursors.totalGaps()).toBe(0);
    expect(restarted.runtime.repositories.roomCursors.anyGap()).toBe(false);
  });

  it('re-applies the operational pragmas on the next open', () => {
    const probe = openDatabase({ path: databasePath, migrate: false });
    try {
      const health = databaseHealth(probe);
      expect(health.journalMode).toBe('wal');
      expect(health.integrity).toBe('ok');
      expect(probe.pragma('synchronous', { simple: true })).toBe(1); // NORMAL
      expect(probe.pragma('busy_timeout', { simple: true })).toBe(5000);
      expect(probe.pragma('foreign_keys', { simple: true })).toBe(1);
    } finally {
      probe.close();
    }
  });

  it('reports the same schema version the code expects', () => {
    const health = databaseHealth(restarted.runtime.db);
    expect(health.schemaVersion).toBeGreaterThan(0);
    expect(health.integrity).toBe('ok');
  });

  it('derives the same DIDs again, so the surviving evidence stays attributable', () => {
    // The bundle is re-decrypted from scratch on the second start. If the seeds
    // did not reproduce the same DIDs, the 15 registration rows already in the
    // database would belong to keys nothing in this process holds.
    for (const agentId of restarted.runtime.keyStore.agentIds) {
      const did = restarted.runtime.keyStore.did(agentId);
      expect(restarted.runtime.repositories.identities.get(agentId)?.did).toBe(did);
      expect(restarted.runtime.repositories.participation.get(agentId)?.did).toBe(did);
    }
  });
});

describe('a database file that is not a database', () => {
  it('fails closed rather than starting with no state', () => {
    const dir = tempDir('flop-corrupt-');
    const path = `${dir}/app.db`;
    writeFileSync(path, 'this is not a sqlite file');
    try {
      expect(() => openDatabase({ path })).toThrow();
    } finally {
      cleanup(dir);
    }
  });

  it('refuses to open a missing file when it must exist', () => {
    const dir = tempDir('flop-missing-');
    try {
      expect(() =>
        openRegisteredDatabase(`${dir}/absent.db`, { readonly: true, fileMustExist: true }),
      ).toThrow();
    } finally {
      cleanup(dir);
    }
  });
});
