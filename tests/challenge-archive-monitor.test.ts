/**
 * The published sweep archive, actually scheduled.
 *
 * `challenge-archive.test.ts` proves the client, the parser and the hash
 * verifier in isolation. This file proves the *wiring*: that a monitor exists in
 * the running process, that it records what it found into SQLite, and — just as
 * importantly — that it can never decide anything about the contest:
 *
 *   - a 404 is `archive_unavailable`, never a failed mint, trade or owner;
 *   - a `full` record must agree with the referee's own signed `file` hash;
 *   - a `redacted` record is checked against its own hash only;
 *   - nothing the archive says overwrites a message read from a Technocore room;
 *   - a broken archive cannot stop the scheduler.
 *
 * Every network call is a stub. Nothing here touches the network.
 */
import { createHash } from 'node:crypto';
import { rmSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import { buildHarness, HARNESS_PACKAGE_HASH, type Harness } from './support/orchestrator.js';
import { tempDir } from './support/harness.js';

function json(body: unknown): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(body));
}

function hashOf(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/** A fetch that serves a fixed path→bytes map and answers 404 everywhere else. */
function serving(files: Record<string, Uint8Array>): typeof fetch {
  return (async (input: string | URL) => {
    const url = String(input);
    const key = Object.keys(files).find((path) => url.endsWith(path));
    if (key === undefined) return new Response(null, { status: 404 });
    return new Response(files[key]!, { status: 200 });
  }) as unknown as typeof fetch;
}

const FULL_BYTES = json({
  input: { t: 'sweep', n: 824 },
  output: { sweep: 824, minted: ['owner-a'], trades: [{ reason: 'settled' }] },
});
const FULL_HASH = hashOf(FULL_BYTES);
const REDACTED_BYTES = json({
  input: { t: 'sweep', n: 825 },
  output: { sweep: 825, minted: [], trades: [{ redacted: 'private room' }] },
});
const REDACTED_HASH = hashOf(REDACTED_BYTES);

let harness: Harness | undefined;

afterEach(async () => {
  if (harness) await harness.dispose();
  harness = undefined;
});

/** A harness whose archive serves exactly the sweeps given. */
async function archiveHarness(options: {
  files: Record<string, Uint8Array>;
  env?: Record<string, string>;
  dir?: string;
  archiveSleep?: (ms: number) => Promise<void>;
}): Promise<Harness> {
  const built = await buildHarness({
    agentCount: 4,
    ...(options.dir ? { dir: options.dir } : {}),
    ...(options.archiveSleep ? { archiveSleep: options.archiveSleep } : {}),
    env: {
      FLOP_ALLOW_REGISTRATION: 'false',
      MAX_DISCOVERED_ROOMS: '2',
      ...options.env,
    },
    archiveFetchImpl: serving(options.files),
  });
  harness = built;
  return built;
}

/** One signed price post whose payload names the hash the archive must match. */
function seedSignedPrice(h: Harness, sweep: number, fileHash: string): void {
  h.referee.post('d-close1-price', {
    t: 'price',
    season: 'close-1',
    n: sweep,
    ref: { px: '225.10', time: '2026-09-28T12:00:00Z', tid: `t${sweep}` },
    limits: ['213.85', '236.36'],
    file: fileHash,
    applied: '225.10',
    for: sweep + 1,
  });
}

function archiveSweepRow(h: Harness, sweep: number) {
  return h.runtime.repositories.archiveSweeps.get(sweep);
}

describe('the archive monitor is real, and bounded', () => {
  it('is constructed by the runtime and can be started and stopped', async () => {
    harness = await buildHarness({ agentCount: 4 });
    expect(harness.runtime.archiveMonitor).toBeDefined();
    expect(harness.runtime.archiveMonitor.running).toBe(false);

    harness.runtime.archiveMonitor.start();
    expect(harness.runtime.archiveMonitor.running).toBe(true);
    harness.runtime.archiveMonitor.stop();
    expect(harness.runtime.archiveMonitor.running).toBe(false);
  });

  it('reads index.json, verifies a full and a redacted record, and records the lag', async () => {
    // The signed price for sweep 824 pins the archive's `full` bytes.
    const index = {
      sweeps: [
        {
          n: 824,
          status: 'full',
          path: `sweeps/${FULL_HASH}.json`,
          file: FULL_HASH,
          size: FULL_BYTES.length,
        },
        {
          n: 825,
          status: 'redacted',
          path: `redacted/${REDACTED_HASH}.json`,
          file: 'b'.repeat(64),
          sha256: REDACTED_HASH,
          redacted: 3,
        },
      ],
    };
    const h = await archiveHarness({
      files: {
        'index.json': json(index),
        [`sweeps/${FULL_HASH}.json`]: FULL_BYTES,
        [`redacted/${REDACTED_HASH}.json`]: REDACTED_BYTES,
      },
    });
    // A local sweep past the archive's, so the lag is measurable.
    h.referee.seedPost(HARNESS_PACKAGE_HASH);
    seedSignedPrice(h, 824, FULL_HASH);
    h.referee.price(830, '225.10');
    await h.runtime.reader.tick();
    expect(h.runtime.reader.verifier.state.currentSweep).toBe(830);

    const summary = await h.runtime.archiveMonitor.check();

    expect(summary.checked).toBe(true);
    expect(summary.latestIndexSweep).toBe(825);
    expect(summary.verified).toBe(2);
    expect(summary.unavailable).toBe(0);
    expect(summary.hashMismatch).toBe(0);
    expect(summary.lagSweeps).toBe(5);

    const full = archiveSweepRow(h, 824)!;
    expect(full.verified).toBe(1);
    expect(full.actual_sha256).toBe(FULL_HASH);
    expect(full.expected_sha256).toBe(FULL_HASH);
    expect(full.unavailable).toBe(0);
    expect(full.error).toBeNull();

    // A redacted record is checked against its own hash, never the signed one.
    const redacted = archiveSweepRow(h, 825)!;
    expect(redacted.verified).toBe(1);
    expect(redacted.actual_sha256).toBe(REDACTED_HASH);
    expect(redacted.redacted_trades).toBe(3);

    const state = h.runtime.repositories.archiveState.get()!;
    expect(state.latest_index_sweep).toBe(825);
    expect(state.latest_verified_sweep).toBe(825);
    expect(state.lag_sweeps).toBe(5);
    expect(state.last_error).toBeNull();
  });

  it('rejects a full record the referee did not sign', async () => {
    const index = {
      sweeps: [
        {
          n: 824,
          status: 'full',
          path: `sweeps/${FULL_HASH}.json`,
          file: FULL_HASH,
          size: FULL_BYTES.length,
        },
      ],
    };
    const h = await archiveHarness({
      files: { 'index.json': json(index), [`sweeps/${FULL_HASH}.json`]: FULL_BYTES },
    });
    h.referee.seedPost(HARNESS_PACKAGE_HASH);
    // The referee's own post pinned a *different* hash for that sweep.
    seedSignedPrice(h, 824, 'c'.repeat(64));
    await h.runtime.reader.tick();

    const summary = await h.runtime.archiveMonitor.check();

    // The bytes match index.json, so only the signed hash can reject it.
    expect(summary.hashMismatch).toBe(1);
    expect(summary.verified).toBe(0);
    const row = archiveSweepRow(h, 824)!;
    expect(row.verified).toBe(0);
    expect(row.actual_sha256).toBe(FULL_HASH);
    expect(row.expected_sha256).toBe('c'.repeat(64));
    expect(row.error).toContain('signed post');
  });

  it('records a 404 as archive_unavailable and never as a failure', async () => {
    const index = {
      sweeps: [
        {
          n: 824,
          status: 'full',
          path: `sweeps/${FULL_HASH}.json`,
          file: FULL_HASH,
          size: FULL_BYTES.length,
        },
      ],
    };
    // index.json is served; the record itself is not.
    const h = await archiveHarness({ files: { 'index.json': json(index) } });
    h.referee.seedPost(HARNESS_PACKAGE_HASH);
    h.referee.flow(1, [h.runtime.keyStore.did(h.runtime.keyStore.agentIds[0]!)]);
    await h.runtime.reader.tick();

    const participationBefore = h.runtime.repositories.participation.all();
    const summary = await h.runtime.archiveMonitor.check();

    expect(summary.unavailable).toBe(1);
    expect(summary.verified).toBe(0);
    expect(summary.hashMismatch).toBe(0);

    const row = archiveSweepRow(h, 824)!;
    expect(row.unavailable).toBe(1);
    expect(row.verified).toBe(0);
    expect(row.error).toBe('archive_unavailable');
    // Nothing became a failure: no participation row moved, and no mint verdict
    // was written anywhere.
    expect(h.runtime.repositories.participation.all()).toEqual(participationBefore);
    expect(
      h.runtime.db.prepare('SELECT COUNT(*) AS n FROM referee_anomalies').get(),
    ).toEqual({ n: 0 });
  });

  it('never overwrites a message that a Technocore room already verified', async () => {
    const index = {
      sweeps: [
        {
          n: 824,
          status: 'full',
          path: `sweeps/${FULL_HASH}.json`,
          file: FULL_HASH,
          size: FULL_BYTES.length,
        },
      ],
    };
    const h = await archiveHarness({
      files: { 'index.json': json(index), [`sweeps/${FULL_HASH}.json`]: FULL_BYTES },
    });
    h.referee.seedPost(HARNESS_PACKAGE_HASH);
    seedSignedPrice(h, 824, FULL_HASH);
    await h.runtime.reader.tick();

    const messagesBefore = h.runtime.db
      .prepare('SELECT COUNT(*) AS n, COALESCE(SUM(seq),0) AS s FROM messages')
      .get();
    const refereeBefore = h.runtime.db
      .prepare('SELECT COUNT(*) AS n FROM referee_snapshots')
      .get();
    const referenceBefore = h.runtime.reader.verifier.state.reference?.toString();

    await h.runtime.archiveMonitor.check();

    expect(
      h.runtime.db.prepare('SELECT COUNT(*) AS n, COALESCE(SUM(seq),0) AS s FROM messages').get(),
    ).toEqual(messagesBefore);
    expect(
      h.runtime.db.prepare('SELECT COUNT(*) AS n FROM referee_snapshots').get(),
    ).toEqual(refereeBefore);
    // The archive's view of the sweep is recorded beside ours, never in place of it.
    expect(h.runtime.reader.verifier.state.reference?.toString()).toBe(referenceBefore);
  });

  it('cannot stop the scheduler when the archive is broken', async () => {
    const h = await buildHarness({
      agentCount: 4,
      env: { FLOP_ALLOW_REGISTRATION: 'false' },
      archiveFetchImpl: (async () => {
        throw new Error('dns is down');
      }) as unknown as typeof fetch,
    });
    harness = h;

    const summary = await h.runtime.archiveMonitor.check();
    expect(summary.checked).toBe(false);
    expect(summary.error).toBe('archive_unavailable');
    expect(h.runtime.repositories.archiveState.get()?.last_error).toBe('archive_unavailable');

    // The scheduler still ticks, and the reader still reads.
    const tick = await h.runtime.scheduler.runTick();
    expect(tick.rooms.readErrors).toBe(0);
    expect(tick.trades.dryRun).toBe(0);
  });
});

describe('the archive monitor is a bounded batch, not a backfill', () => {
  /**
   * A deterministic record for one sweep, plus the hash `index.json` must claim.
   *
   * The sweep is written as a fixed-width field so every record is byte-identical
   * in length: that is what lets the byte-budget assertion be exact rather than
   * approximate. The monitor only hashes these bytes, so the shape is free.
   */
  function recordFor(sweep: number, salt = ''): { bytes: Uint8Array; hash: string } {
    const padded = String(sweep).padStart(6, '0');
    const bytes = json({
      input: { t: 'sweep', n: padded, salt },
      output: { sweep: padded, minted: [], trades: [] },
    });
    return { bytes, hash: hashOf(bytes) };
  }

  /** `count` consecutive sweeps from `first`, and the file map that backs them. */
  function series(count: number, first = 1): { index: unknown; files: Record<string, Uint8Array> } {
    const entries: unknown[] = [];
    const files: Record<string, Uint8Array> = {};
    for (let i = 0; i < count; i += 1) {
      const sweep = first + i;
      const { bytes, hash } = recordFor(sweep);
      files[`sweeps/${hash}.json`] = bytes;
      entries.push({ n: sweep, status: 'full', path: `sweeps/${hash}.json`, file: hash, size: bytes.length });
    }
    return { index: { sweeps: entries }, files };
  }

  it('downloads ten records out of a thousand, newest head first then oldest tail', async () => {
    const { index, files } = series(1000);
    const h = await archiveHarness({ files: { 'index.json': json(index), ...files } });

    const summary = await h.runtime.archiveMonitor.check();

    expect(summary.checked).toBe(true);
    expect(summary.fetched).toBe(10);
    expect(summary.verified).toBe(10);
    expect(summary.stoppedBy).toBe('records');
    expect(h.runtime.repositories.archiveSweeps.count()).toBe(10);
    expect(summary.latestIndexSweep).toBe(1000);
    expect(summary.latestVerifiedSweep).toBe(1000);
    expect(summary.pendingCount).toBe(990);
    expect(summary.unavailableCount).toBe(0);
    expect(summary.mismatchCount).toBe(0);
    expect(summary.bytesToday).toBe(summary.bytesThisCheck);

    // The five newest sweeps (the live head) plus the five oldest of the backlog.
    expect(h.runtime.repositories.archiveSweeps.all().map((row) => row.sweep)).toEqual([
      1, 2, 3, 4, 5, 996, 997, 998, 999, 1000,
    ]);

    const state = h.runtime.repositories.archiveState.get()!;
    expect(state.pending_count).toBe(990);
    expect(state.bytes_this_check).toBe(summary.bytesThisCheck);
    expect(state.bytes_today).toBe(summary.bytesToday);
    expect(state.last_error).toBeNull();
  });

  it('stops once the byte budget is spent', async () => {
    const { index, files } = series(1000);
    const recordBytes = recordFor(1).bytes.length;
    const h = await archiveHarness({
      files: { 'index.json': json(index), ...files },
      env: { ARCHIVE_MAX_BYTES_PER_CHECK: String(recordBytes * 3) },
    });

    const summary = await h.runtime.archiveMonitor.check();

    // Three records fit the budget exactly; the fourth would exceed it.
    expect(summary.fetched).toBe(3);
    expect(summary.bytesThisCheck).toBe(recordBytes * 3);
    expect(summary.stoppedBy).toBe('bytes');
    expect(h.runtime.repositories.archiveSweeps.count()).toBe(3);
  });

  it('enforces a minimum interval between every request, index.json included', async () => {
    const { index, files } = series(5);
    let clockMs = Date.parse('2026-09-28T12:00:00.000Z');
    const waits: number[] = [];
    harness = await buildHarness({
      agentCount: 4,
      env: {
        FLOP_ALLOW_REGISTRATION: 'false',
        MAX_DISCOVERED_ROOMS: '2',
        ARCHIVE_MAX_REQUESTS_PER_MINUTE: '6',
      },
      archiveFetchImpl: serving({ 'index.json': json(index), ...files }),
      // The gate measures against this clock, and the injected sleep advances it,
      // so the waits are the gate's own rather than approximate.
      now: () => new Date(clockMs),
      archiveSleep: (ms) => {
        waits.push(ms);
        clockMs += ms;
        return Promise.resolve();
      },
    });

    const summary = await harness.runtime.archiveMonitor.check();

    // Six requests (index + five records) at six per minute: five gates of 10s.
    expect(summary.fetched).toBe(5);
    expect(waits).toEqual([10_000, 10_000, 10_000, 10_000, 10_000]);
  });

  it('re-verifies a sweep when the index entry it was verified against changes', async () => {
    const files: Record<string, Uint8Array> = {};
    const original = recordFor(824);
    const originalEntry = {
      n: 824,
      status: 'full',
      path: `sweeps/${original.hash}.json`,
      file: original.hash,
      size: original.bytes.length,
    };
    files['index.json'] = json({ sweeps: [originalEntry] });
    files[`sweeps/${original.hash}.json`] = original.bytes;

    const h = await archiveHarness({ files });

    const first = await h.runtime.archiveMonitor.check();
    expect(first.fetched).toBe(1);
    expect(h.runtime.repositories.archiveSweeps.get(824)?.actual_sha256).toBe(original.hash);

    // Nothing changed: the settled row is skipped, so nothing is re-downloaded.
    const second = await h.runtime.archiveMonitor.check();
    expect(second.fetched).toBe(0);

    // The archive re-publishes sweep 824 with different bytes. The row is no
    // longer "settled" — status/path/hash/size all moved — so it must be fetched
    // again rather than trusted from the old row.
    const replacement = recordFor(824, 'v2');
    files['index.json'] = json({
      sweeps: [
        {
          n: 824,
          status: 'full',
          path: `sweeps/${replacement.hash}.json`,
          file: replacement.hash,
          size: replacement.bytes.length,
        },
      ],
    });
    files[`sweeps/${replacement.hash}.json`] = replacement.bytes;

    const third = await h.runtime.archiveMonitor.check();
    expect(third.fetched).toBe(1);
    const updated = h.runtime.repositories.archiveSweeps.get(824)!;
    expect(updated.verified).toBe(1);
    expect(updated.actual_sha256).toBe(replacement.hash);
    expect(updated.expected_sha256).toBe(replacement.hash);
  });

  it('resumes the historical backfill from where it stopped, across a restart', async () => {
    const dir = tempDir('flop-archive-restart-');
    const { index, files } = series(20);
    const served = { 'index.json': json(index), ...files };
    const env = { ARCHIVE_MAX_RECORDS_PER_CHECK: '5' };

    let first: Harness | undefined;
    let second: Harness | undefined;
    try {
      first = await archiveHarness({ files: served, dir, env });

      // Pass 1: the live head, newest first.
      await first.runtime.archiveMonitor.check();
      expect(first.runtime.repositories.archiveSweeps.all().map((row) => row.sweep)).toEqual([
        16, 17, 18, 19, 20,
      ]);

      // Pass 2: the backlog, oldest first.
      await first.runtime.archiveMonitor.check();
      expect(first.runtime.repositories.archiveSweeps.all().map((row) => row.sweep)).toEqual([
        1, 2, 3, 4, 5, 16, 17, 18, 19, 20,
      ]);

      // SIGKILL: no stop, no close. The WAL and the archive rows are as they were.
      first.runtime.db.close();

      second = await archiveHarness({ files: served, dir, env });
      const resumed = await second.runtime.archiveMonitor.check();

      // Pass 3 continues at 6, not at 1: the settled rows are skipped, so the
      // backlog cursor is the database, not an in-memory counter.
      expect(resumed.fetched).toBe(5);
      expect(second.runtime.repositories.archiveSweeps.all().map((row) => row.sweep)).toEqual([
        1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 16, 17, 18, 19, 20,
      ]);
    } finally {
      if (second) await second.dispose();
      second = undefined;
      try {
        first?.runtime.db.close();
      } catch {
        /* already closed above */
      }
      first = undefined;
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
