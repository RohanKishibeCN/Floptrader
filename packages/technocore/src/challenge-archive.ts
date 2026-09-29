/**
 * The published sweep archive, and the rules for trusting it.
 *
 * The contest publishes one record per sweep at `challenges.technocore.chat/
 * close-1`: `index.json` lists every sweep with the hash of its record, and the
 * records themselves sit under `sweeps/<hash>.json` (exact bytes) or
 * `redacted/<hash>.json` (the same record with private-room trades stripped).
 *
 * It is an **audit source, not an authority**. Three rules follow from that, and
 * each one exists because the opposite behaviour loses information:
 *
 *   1. A record never overwrites a referee message we already verified. The
 *      archive is a second copy of something we hold; a disagreement is a
 *      finding to record, not a value to adopt.
 *   2. A record missing from the archive is `archive_unavailable`, never a
 *      failure. Archives lag the contest, and a lagging archive says nothing
 *      about whether a mint happened.
 *   3. A `redacted` record is checked against the hash `index.json` gives *for
 *      that redacted file*. Comparing it to the referee's signed `file` hash
 *      would fail every time by construction, because redaction changes the
 *      bytes. And redaction is one-way: it cannot hand back private-room trades.
 */
import { createHash } from 'node:crypto';
import type { TechnocoreLogger } from './protocol.js';

export type ArchiveStatus = 'full' | 'redacted';

export interface ArchiveIndexEntry {
  sweep: number;
  status: ArchiveStatus;
  /** Path relative to the archive base, as `index.json` gives it. */
  path: string;
  /**
   * The hash this record's bytes must produce.
   *
   * For `full` this is the referee's signed `file` hash. For `redacted` it is the
   * hash of the redacted bytes, which `index.json` publishes separately.
   */
  sha256: string;
  size: number | null;
  /** How many trades were replaced; `index.json` gives this for redacted files. */
  redactedTrades: number | null;
}

export interface ArchiveIndex {
  entries: Map<number, ArchiveIndexEntry>;
  /** The sweeps present, ascending. */
  sweeps: number[];
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function text(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

function integer(value: unknown): number | null {
  return typeof value === 'number' && Number.isInteger(value) ? value : null;
}

/**
 * Parse `index.json`.
 *
 * The field names are taken from the archive's own `README.txt` (`n`, the posted
 * file hash, `status`, `path`, `size`) but the parser tolerates the obvious
 * aliases, because this file is published by a service we do not control and a
 * renamed key should degrade to "one sweep unreadable", not to a crash.
 */
export function parseArchiveIndex(json: unknown): ArchiveIndex {
  const root = asRecord(json);
  const list = Array.isArray(json)
    ? json
    : Array.isArray(root?.sweeps)
      ? (root?.sweeps as unknown[])
      : [];
  const entries = new Map<number, ArchiveIndexEntry>();

  for (const item of list) {
    const row = asRecord(item);
    if (!row) continue;
    const sweep = integer(row.n) ?? integer(row.sweep) ?? integer(row.number);
    if (sweep === null) continue;
    const status: ArchiveStatus = text(row.status) === 'redacted' ? 'redacted' : 'full';
    // For a full record the primary hash is the signed `file` hash; for a
    // redacted one it is the hash `index.json` publishes for the redacted bytes.
    const sha256 = status === 'redacted'
      ? (text(row.sha256) ?? text(row.redacted_sha256) ?? text(row.file))
      : (text(row.file) ?? text(row.sha256) ?? text(row.hash));
    if (sha256 === null) continue;
    const path =
      text(row.path) ??
      (status === 'redacted' ? `redacted/${sha256}.json` : `sweeps/${sha256}.json`);
    entries.set(sweep, {
      sweep,
      status,
      path,
      sha256: sha256.toLowerCase(),
      size: integer(row.size) ?? integer(row.bytes),
      redactedTrades: integer(row.redacted) ?? integer(row.redacted_trades),
    });
  }

  return { entries, sweeps: [...entries.keys()].sort((a, b) => a - b) };
}

export function archiveBytesHash(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

export interface ArchiveVerification {
  ok: boolean;
  status: ArchiveStatus;
  expected: string;
  actual: string;
  /** Set when the check failed, or when a `full` record disagrees with the pin. */
  reason: string | null;
}

/**
 * Check one downloaded record against the hash its index entry claims.
 *
 * `refereeFileHash` is the `file` field of the referee's signed post for that
 * sweep, when we have it. For a `full` record the two must agree as well: the
 * archive claims to hold the exact bytes behind that signature. For a `redacted`
 * record the signed hash is deliberately *not* consulted — redaction changed the
 * bytes, and `index.json` is the only authority on the redacted form.
 */
export function verifyArchiveRecord(
  entry: ArchiveIndexEntry,
  bytes: Uint8Array,
  refereeFileHash: string | null = null,
): ArchiveVerification {
  const actual = archiveBytesHash(bytes);
  if (actual !== entry.sha256) {
    return {
      ok: false,
      status: entry.status,
      expected: entry.sha256,
      actual,
      reason: `the record hashes to ${actual}, but index.json says ${entry.sha256}`,
    };
  }
  if (entry.status === 'full' && refereeFileHash !== null) {
    const pinned = refereeFileHash.toLowerCase();
    if (pinned !== entry.sha256) {
      return {
        ok: false,
        status: entry.status,
        expected: pinned,
        actual,
        reason: `the archive holds ${entry.sha256}, but the signed post pinned ${pinned}`,
      };
    }
  }
  return { ok: true, status: entry.status, expected: entry.sha256, actual, reason: null };
}

export interface ArchiveClientOptions {
  baseUrl: string;
  logger: TechnocoreLogger;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

/**
 * Fetches `index.json` and individual records.
 *
 * Every failure is a return value, never a throw: a missing record is a data gap
 * the caller records, and a throw here would turn "the archive is behind" into
 * "the process crashed".
 */
export class ArchiveClient {
  private readonly baseUrl: string;
  private readonly logger: TechnocoreLogger;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;

  constructor(options: ArchiveClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, '');
    this.logger = options.logger;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.timeoutMs = options.timeoutMs ?? 15_000;
  }

  private async get(path: string): Promise<Uint8Array | null> {
    const url = `${this.baseUrl}/${path.replace(/^\/+/, '')}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await this.fetchImpl(url, { signal: controller.signal });
      if (response.status === 404) {
        // Not a failure: the archive simply has not published it.
        this.logger.event({
          level: 'info',
          source: 'challenge-archive',
          code: 'archive_unavailable',
          message: `the archive has no record at ${path}`,
          data: { path },
        });
        return null;
      }
      if (!response.ok) {
        this.logger.event({
          level: 'warn',
          source: 'challenge-archive',
          code: 'archive_unavailable',
          message: `the archive answered ${response.status} for ${path}`,
          data: { path, status: response.status },
        });
        return null;
      }
      return new Uint8Array(await response.arrayBuffer());
    } catch (error) {
      this.logger.event({
        level: 'warn',
        source: 'challenge-archive',
        code: 'archive_unavailable',
        message: `the archive request for ${path} failed`,
        data: { path, error: error instanceof Error ? error.message : String(error) },
      });
      return null;
    } finally {
      clearTimeout(timer);
    }
  }

  async index(): Promise<ArchiveIndex | null> {
    const bytes = await this.get('index.json');
    if (bytes === null) return null;
    try {
      return parseArchiveIndex(JSON.parse(Buffer.from(bytes).toString('utf8')));
    } catch (error) {
      this.logger.event({
        level: 'warn',
        source: 'challenge-archive',
        code: 'archive_unavailable',
        message: 'index.json is not valid JSON',
        data: { error: error instanceof Error ? error.message : String(error) },
      });
      return null;
    }
  }

  async record(entry: ArchiveIndexEntry): Promise<Uint8Array | null> {
    return this.get(entry.path);
  }
}

/** What one sweep's record says, as far as we can read it. */
export interface ArchiveSweepRecord {
  sweep: number | null;
  minted: string[];
  settled: number;
  voided: number;
  /** True when the record is redacted, so its trade detail is incomplete. */
  redacted: boolean;
}

export function parseArchiveSweepRecord(bytes: Uint8Array): ArchiveSweepRecord | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(bytes).toString('utf8'));
  } catch {
    return null;
  }
  const root = asRecord(parsed);
  const output = asRecord(root?.output);
  if (!root || !output) return null;
  const minted = Array.isArray(output.minted)
    ? output.minted.filter((did): did is string => typeof did === 'string')
    : [];
  const trades = Array.isArray(output.trades) ? output.trades : [];
  let settled = 0;
  let voided = 0;
  for (const trade of trades) {
    const row = asRecord(trade);
    const reason = row === null ? 'settled' : text(row.reason) ?? 'settled';
    if (reason === 'settled') settled += 1;
    else voided += 1;
  }
  return {
    sweep: integer(output.sweep) ?? integer(root.sweep),
    minted,
    settled,
    voided,
    redacted: trades.some((trade) => asRecord(trade)?.redacted !== undefined),
  };
}

export interface ArchiveReconciliation {
  sweep: number;
  /** Minted according to the archive but not seen in a local flow post. */
  mintedOnlyInArchive: string[];
  /** Seen locally but absent from the archive: a finding, never a failure. */
  mintedOnlyLocally: string[];
  /** Archive sweeps behind the local sweep; a lag, not a failure. */
  lagSweeps: number | null;
  localSettled: number;
  localVoid: number;
  archiveSettled: number;
  archiveVoid: number;
}

/**
 * Compare the archive's view of a sweep with ours.
 *
 * The output is deliberately framed as findings, not verdicts. Nothing here can
 * mark a mint failed, because the archive is the *less* authoritative of the two
 * sources: it is a second copy, published late, of messages the referee already
 * signed. What it is genuinely good for is filling a hole — a mint we never saw
 * because a flow post was omitted — and measuring how far behind it is.
 */
export function reconcileArchiveSweep(params: {
  sweep: number;
  localMints: string[];
  localSettled: number;
  localVoid: number;
  record: ArchiveSweepRecord;
}): ArchiveReconciliation {
  const local = new Set(params.localMints);
  const archived = new Set(params.record.minted);
  const latest = params.record.sweep;
  return {
    sweep: params.sweep,
    mintedOnlyInArchive: [...archived].filter((did) => !local.has(did)),
    mintedOnlyLocally: [...local].filter((did) => !archived.has(did)),
    lagSweeps: latest === null ? null : Math.max(0, params.sweep - latest),
    localSettled: params.localSettled,
    localVoid: params.localVoid,
    archiveSettled: params.record.settled,
    archiveVoid: params.record.voided,
  };
}
