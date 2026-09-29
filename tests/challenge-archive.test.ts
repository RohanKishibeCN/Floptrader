/**
 * The published sweep archive: what it can prove, and what it must never be
 * allowed to decide.
 *
 * The archive is a second copy of swept data, published late. So the tests here
 * are mostly about restraint:
 *
 *   - a `full` record must hash to what `index.json` claims *and* to the hash the
 *     referee signed, or it proves nothing;
 *   - a `redacted` record is checked against the hash `index.json` gives for the
 *     redacted bytes, never against the signed `file` hash — redaction changes
 *     the bytes, so comparing them would fail by construction;
 *   - a 404 is a data gap the caller records, not a failure and not a verdict.
 *
 * Every network call is a stub; nothing here touches the network.
 */
import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import {
  ArchiveClient,
  archiveBytesHash,
  parseArchiveIndex,
  parseArchiveSweepRecord,
  reconcileArchiveSweep,
  verifyArchiveRecord,
  type ArchiveIndexEntry,
} from '@flop/technocore';

class RecordingLogger {
  readonly events: string[] = [];
  debug(): void {}
  info(): void {}
  warn(): void {}
  error(): void {}
  event(record: { code: string }): void {
    this.events.push(record.code);
  }
}

function json(body: unknown): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(body));
}

function hashOf(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/** A fetch that serves a fixed map of path -> bytes, 404 elsewhere. */
function serving(files: Record<string, Uint8Array>): typeof fetch {
  return (async (input: string | URL) => {
    const url = String(input);
    const key = Object.keys(files).find((path) => url.endsWith(path));
    if (key === undefined) return new Response(null, { status: 404 });
    const body = files[key]!;
    return new Response(body, { status: 200 });
  }) as unknown as typeof fetch;
}

const FULL_BYTES = json({ input: { t: 'sweep', n: 824 }, output: { sweep: 824, minted: ['a', 'b'] } });
const FULL_HASH = hashOf(FULL_BYTES);
const REDACTED_BYTES = json({ input: { t: 'sweep', n: 825 }, output: { sweep: 825, minted: [] } });
const REDACTED_HASH = hashOf(REDACTED_BYTES);

const INDEX = {
  sweeps: [
    { n: 824, status: 'full', path: `sweeps/${FULL_HASH}.json`, file: FULL_HASH, size: FULL_BYTES.length },
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

describe('index.json', () => {
  it('reads sweep number, status, path and size, and keeps the sweeps ordered', () => {
    const index = parseArchiveIndex(INDEX);
    expect(index.sweeps).toEqual([824, 825]);
    const full = index.entries.get(824)!;
    expect(full.status).toBe('full');
    expect(full.path).toBe(`sweeps/${FULL_HASH}.json`);
    expect(full.sha256).toBe(FULL_HASH);
    expect(full.size).toBe(FULL_BYTES.length);
  });

  it('prefers the redacted hash for a redacted entry, and records the count', () => {
    const entry = parseArchiveIndex(INDEX).entries.get(825)!;
    expect(entry.status).toBe('redacted');
    expect(entry.sha256).toBe(REDACTED_HASH);
    expect(entry.redactedTrades).toBe(3);
  });

  it('accepts a bare array as well as an object with a sweeps list', () => {
    expect(parseArchiveIndex(INDEX.sweeps).sweeps).toEqual([824, 825]);
    expect(parseArchiveIndex({}).sweeps).toEqual([]);
    expect(parseArchiveIndex(null).sweeps).toEqual([]);
  });
});

describe('verifying one record', () => {
  const fullEntry = (): ArchiveIndexEntry => parseArchiveIndex(INDEX).entries.get(824)!;
  const redactedEntry = (): ArchiveIndexEntry => parseArchiveIndex(INDEX).entries.get(825)!;

  it('accepts a full record whose bytes match both the index and the signed post', () => {
    const verdict = verifyArchiveRecord(fullEntry(), FULL_BYTES, FULL_HASH);
    expect(verdict.ok).toBe(true);
    expect(verdict.actual).toBe(FULL_HASH);
  });

  it('rejects a full record the referee did not sign', () => {
    const verdict = verifyArchiveRecord(fullEntry(), FULL_BYTES, 'c'.repeat(64));
    expect(verdict.ok).toBe(false);
    expect(verdict.reason).toContain('signed post');
  });

  it('rejects tampered bytes', () => {
    const tampered = json({ input: { t: 'sweep', n: 824 }, output: { sweep: 824, minted: ['a', 'b', 'c'] } });
    const verdict = verifyArchiveRecord(fullEntry(), tampered, FULL_HASH);
    expect(verdict.ok).toBe(false);
    expect(verdict.reason).toContain('index.json says');
  });

  it('checks a redacted record against its own hash, never the signed one', () => {
    // The signed `file` hash is still in the entry, but redaction changed the
    // bytes; comparing them would reject every redacted record.
    const verdict = verifyArchiveRecord(redactedEntry(), REDACTED_BYTES, 'b'.repeat(64));
    expect(verdict.ok).toBe(true);
    expect(verdict.actual).toBe(REDACTED_HASH);
  });
});

describe('the client treats a missing record as a data gap', () => {
  it('fetches the index and a record', async () => {
    const logger = new RecordingLogger();
    const client = new ArchiveClient({
      baseUrl: 'https://example.test/close-1',
      logger,
      fetchImpl: serving({ 'index.json': json(INDEX), [`sweeps/${FULL_HASH}.json`]: FULL_BYTES }),
    });

    const index = await client.index();
    expect(index?.sweeps).toEqual([824, 825]);
    const bytes = await client.record(index!.entries.get(824)!);
    expect(bytes === null ? null : archiveBytesHash(bytes)).toBe(FULL_HASH);
    expect(logger.events).toEqual([]);
  });

  it('returns null and records archive_unavailable on a 404, without throwing', async () => {
    const logger = new RecordingLogger();
    const client = new ArchiveClient({
      baseUrl: 'https://example.test/close-1',
      logger,
      fetchImpl: serving({ 'index.json': json(INDEX) }),
    });

    const index = await client.index();
    const missing = await client.record(index!.entries.get(825)!);
    expect(missing).toBeNull();
    expect(logger.events).toContain('archive_unavailable');
  });

  it('never throws when the archive is unreachable', async () => {
    const logger = new RecordingLogger();
    const client = new ArchiveClient({
      baseUrl: 'https://example.test/close-1',
      logger,
      fetchImpl: (async () => {
        throw new Error('dns is down');
      }) as unknown as typeof fetch,
    });

    await expect(client.index()).resolves.toBeNull();
    expect(logger.events).toContain('archive_unavailable');
  });
});

describe('reconciling the archive against our own record', () => {
  it('reports what the archive adds and never marks a mint failed', () => {
    const report = reconcileArchiveSweep({
      sweep: 824,
      localMints: ['a'],
      localSettled: 1,
      localVoid: 1,
      record: { sweep: 824, minted: ['a', 'b'], settled: 2, voided: 0, redacted: false },
    });
    // `b` is a mint we never saw; it is a finding to merge, not a failure.
    expect(report.mintedOnlyInArchive).toEqual(['b']);
    expect(report.mintedOnlyLocally).toEqual([]);
    expect(report.lagSweeps).toBe(0);
    expect(report.archiveSettled).toBe(2);
    expect(report.archiveVoid).toBe(0);
  });

  it('records a local mint the archive does not have, without calling it failed', () => {
    const report = reconcileArchiveSweep({
      sweep: 824,
      localMints: ['a', 'x'],
      localSettled: 0,
      localVoid: 0,
      record: { sweep: 824, minted: ['a'], settled: 0, voided: 0, redacted: false },
    });
    expect(report.mintedOnlyLocally).toEqual(['x']);
    expect(report.mintedOnlyInArchive).toEqual([]);
  });

  it('measures the lag instead of treating it as a failure', () => {
    const report = reconcileArchiveSweep({
      sweep: 900,
      localMints: [],
      localSettled: 0,
      localVoid: 0,
      record: { sweep: 897, minted: [], settled: 0, voided: 1, redacted: false },
    });
    expect(report.lagSweeps).toBe(3);
  });
});

describe('reading a sweep record', () => {
  it('extracts mints, settled and void counts', () => {
    const record = parseArchiveSweepRecord(
      json({
        input: { t: 'sweep', n: 824 },
        output: {
          sweep: 824,
          minted: ['a'],
          trades: [{ reason: 'settled' }, { reason: 'funds' }, { reason: 'limits' }],
        },
      }),
    );
    expect(record?.sweep).toBe(824);
    expect(record?.minted).toEqual(['a']);
    expect(record?.settled).toBe(1);
    expect(record?.voided).toBe(2);
    expect(record?.redacted).toBe(false);
  });

  it('flags a redacted record, whose trade detail is incomplete by design', () => {
    const record = parseArchiveSweepRecord(
      json({ input: { t: 'sweep', n: 825 }, output: { sweep: 825, minted: [], trades: [{ redacted: 'private room' }] } }),
    );
    expect(record?.redacted).toBe(true);
  });

  it('returns null for bytes that are not a sweep record', () => {
    expect(parseArchiveSweepRecord(json({ hello: 'world' }))).toBeNull();
    expect(parseArchiveSweepRecord(new TextEncoder().encode('not json'))).toBeNull();
  });
});
