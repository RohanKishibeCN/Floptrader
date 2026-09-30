/**
 * The published sweep archive, actually polled — under a budget.
 *
 * `packages/technocore`'s `ArchiveClient` and `verifyArchiveRecord` are the
 * mechanism; this is the schedule and the bookkeeping. Four properties are the
 * whole point of the class:
 *
 *   1. **It runs off the trading path.** The monitor owns its own timer
 *      (`ARCHIVE_CHECK_INTERVAL_MINUTES`, 15 by default) and never sits between
 *      a tick and a trade. A check that hangs or throws is recorded and the
 *      reader/writer are untouched.
 *   2. **It is an audit source, not an authority.** Nothing here writes to
 *      `messages`, `referee_snapshots` or `participation_records`. A verified
 *      archive record cannot overwrite a referee message we already checked, and
 *      a missing record cannot mark a mint, a trade or an owner registration as
 *      failed — a 404 is `archive_unavailable`, full stop.
 *   3. **A `full` record has to agree with the referee too.** The bytes must hash
 *      to what `index.json` claims *and* to the `file` hash on the referee's own
 *      signed post for that sweep. A `redacted` record is checked against its own
 *      hash only, because redaction changes the bytes by construction.
 *   4. **One pass is a bounded batch, never a backfill.** The public archive has
 *      published well over a thousand sweeps — several GiB. A check downloads at
 *      most `ARCHIVE_MAX_RECORDS_PER_CHECK` records and at most
 *      `ARCHIVE_MAX_BYTES_PER_CHECK` bytes, with at least one request per
 *      `ARCHIVE_MAX_REQUESTS_PER_MINUTE` window between request starts. The
 *      newest sweeps and the historical backlog are separate: the head of the
 *      index is always covered first, and the backlog is walked in
 *      `ARCHIVE_BACKFILL_MODE` order, resuming from wherever the last pass left
 *      off because a settled sweep is skipped.
 */
import type { Repositories, ArchiveSweepRow } from '@flop/storage';
import { ArchiveClient, verifyArchiveRecord, type ArchiveIndexEntry } from '@flop/technocore';
import type { Config } from './config.js';
import type { Logger } from './logger.js';

/**
 * How many sweeps at the head of the index count as "latest".
 *
 * Small on purpose: a live contest only ever needs the newest few sweeps
 * promptly, and everything older is backlog. This is a window, not a budget — the
 * per-check record cap still governs how much is actually downloaded.
 */
export const LATEST_WINDOW = 5;

/** Why a bounded pass stopped before exhausting the backlog. */
export type ArchiveStopReason = 'records' | 'bytes' | null;

export interface ArchiveCheckSummary {
  at: string;
  /** False when `index.json` itself could not be read; nothing else was attempted. */
  checked: boolean;
  latestIndexSweep: number | null;
  latestVerifiedSweep: number | null;
  lagSweeps: number | null;
  /** Sweeps the index names that are still not verified. */
  pendingCount: number;
  /** Sweeps the archive answered 404 for; a data gap, never a failure. */
  unavailableCount: number;
  /** Sweeps whose bytes did not hash to what was claimed; a finding, not a gap. */
  mismatchCount: number;
  /** Entries downloaded (or 404'd) this pass. */
  fetched: number;
  verified: number;
  unavailable: number;
  hashMismatch: number;
  bytesThisCheck: number;
  bytesToday: number;
  /** Which budget ended the pass early, if any. */
  stoppedBy: ArchiveStopReason;
  error: string | null;
}

export interface ChallengeArchiveMonitorOptions {
  config: Config;
  logger: Logger;
  repositories: Repositories;
  /** The local sweep, so the lag is measured rather than assumed. */
  localSweep: () => number | null;
  /** Injected for tests; the archive is a different host from technocore. */
  fetchImpl?: typeof fetch;
  now?: () => Date;
  /** Injected for tests so the request-rate gate is deterministic. */
  sleep?: (ms: number) => Promise<void>;
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  });
}

export class ChallengeArchiveMonitor {
  private readonly config: Config;
  private readonly logger: Logger;
  private readonly repositories: Repositories;
  private readonly localSweep: () => number | null;
  private readonly fetchImpl: typeof fetch | undefined;
  private readonly now: () => Date;
  private readonly sleep: (ms: number) => Promise<void>;

  private timer: ReturnType<typeof setInterval> | null = null;
  private inFlight: Promise<ArchiveCheckSummary> | null = null;
  private last: ArchiveCheckSummary | null = null;
  /** When the next request may start, in epoch ms. Enforces the rate limit. */
  private nextRequestAt = 0;

  constructor(options: ChallengeArchiveMonitorOptions) {
    this.config = options.config;
    this.logger = options.logger;
    this.repositories = options.repositories;
    this.localSweep = options.localSweep;
    this.fetchImpl = options.fetchImpl;
    this.now = options.now ?? (() => new Date());
    this.sleep = options.sleep ?? defaultSleep;
  }

  /** Start the independent timer. Nothing is fetched until a check runs. */
  start(): void {
    if (this.timer) return;
    const periodMs = Math.max(1, this.config.archive.checkIntervalMinutes) * 60_000;
    this.timer = setInterval(() => {
      // A failure here can only be recorded: it must never reach the scheduler,
      // the reader or the writer.
      void this.check().catch((error: unknown) => {
        this.logger.event({
          level: 'warn',
          source: 'challenge-archive',
          code: 'archive_check_failed',
          message: 'archive check threw; the reader and writer are unaffected',
          data: { error: error instanceof Error ? error.message : String(error) },
        });
      });
    }, periodMs);
    this.timer.unref?.();
    this.logger.event({
      level: 'info',
      source: 'challenge-archive',
      code: 'archive_monitor_started',
      message: `archive monitor started (every ${this.config.archive.checkIntervalMinutes} min)`,
      data: {
        baseUrl: this.config.archive.baseUrl,
        intervalMinutes: this.config.archive.checkIntervalMinutes,
        maxRecordsPerCheck: this.config.archive.maxRecordsPerCheck,
        maxBytesPerCheck: this.config.archive.maxBytesPerCheck,
        maxRequestsPerMinute: this.config.archive.maxRequestsPerMinute,
        backfillMode: this.config.archive.backfillMode,
      },
    });
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  get running(): boolean {
    return this.timer !== null;
  }

  /** The last completed check, in memory. The report reads the tables instead. */
  get lastSummary(): ArchiveCheckSummary | null {
    return this.last;
  }

  /**
   * One pass. Single-flighted and never throws: a broken archive is a recorded
   * gap, not a crash.
   */
  async check(): Promise<ArchiveCheckSummary> {
    const existing = this.inFlight;
    if (existing) return existing;
    const run = this.checkOnce().catch((error: unknown): ArchiveCheckSummary => {
      const at = this.now().toISOString();
      const detail = error instanceof Error ? error.message : String(error);
      this.recordError(at, detail);
      return {
        at,
        checked: false,
        latestIndexSweep: null,
        latestVerifiedSweep: this.repositories.archiveSweeps.maxVerifiedSweep(),
        lagSweeps: null,
        pendingCount: 0,
        unavailableCount: this.repositories.archiveSweeps.unavailableSweeps().length,
        mismatchCount: this.repositories.archiveSweeps.mismatchedSweeps().length,
        fetched: 0,
        verified: 0,
        unavailable: 0,
        hashMismatch: 0,
        bytesThisCheck: 0,
        bytesToday: this.bytesTodaySoFar(),
        stoppedBy: null,
        error: detail,
      };
    });
    this.inFlight = run;
    try {
      return await run;
    } finally {
      this.inFlight = null;
    }
  }

  private async checkOnce(): Promise<ArchiveCheckSummary> {
    const at = this.now().toISOString();
    const client = new ArchiveClient({
      baseUrl: this.config.archive.baseUrl,
      logger: this.logger,
      ...(this.fetchImpl ? { fetchImpl: this.fetchImpl } : {}),
      timeoutMs: this.config.technoCore.requestTimeoutMs,
    });

    const summary: ArchiveCheckSummary = {
      at,
      checked: false,
      latestIndexSweep: null,
      latestVerifiedSweep: this.repositories.archiveSweeps.maxVerifiedSweep(),
      lagSweeps: null,
      pendingCount: 0,
      unavailableCount: 0,
      mismatchCount: 0,
      fetched: 0,
      verified: 0,
      unavailable: 0,
      hashMismatch: 0,
      bytesThisCheck: 0,
      bytesToday: 0,
      stoppedBy: null,
      error: null,
    };

    await this.gate();
    const index = await client.index();
    if (index === null) {
      // The index itself is missing: a data gap, never a contest failure.
      summary.error = 'archive_unavailable';
      this.recordError(at, 'archive_unavailable');
      this.last = summary;
      return summary;
    }

    summary.checked = true;
    const sweeps = index.sweeps;
    summary.latestIndexSweep = sweeps.length > 0 ? sweeps[sweeps.length - 1]! : null;

    // The work list: everything the index names that is not already settled.
    const pending: ArchiveIndexEntry[] = [];
    for (const sweep of sweeps) {
      const entry = index.entries.get(sweep)!;
      if (this.isSettled(entry)) continue;
      pending.push(entry);
    }

    const work = this.order(pending, summary.latestIndexSweep);
    const maxAge = this.config.archive.maxRecordsPerCheck;
    const maxBytes = this.config.archive.maxBytesPerCheck;

    for (const entry of work) {
      if (summary.fetched >= maxAge) {
        summary.stoppedBy = 'records';
        break;
      }
      if (summary.bytesThisCheck >= maxBytes) {
        summary.stoppedBy = 'bytes';
        break;
      }
      await this.gate();
      const outcome = await this.fetchOne(client, entry, summary);
      summary.fetched += 1;
      if (outcome === 'verified') summary.verified += 1;
      else if (outcome === 'unavailable') summary.unavailable += 1;
      else summary.hashMismatch += 1;
    }

    summary.latestVerifiedSweep = this.repositories.archiveSweeps.maxVerifiedSweep();
    summary.pendingCount = this.repositories.archiveSweeps.pendingCount(sweeps);
    summary.unavailableCount = this.repositories.archiveSweeps.unavailableSweeps().length;
    summary.mismatchCount = this.repositories.archiveSweeps.mismatchedSweeps().length;
    const local = this.localSweep();
    summary.lagSweeps =
      local !== null && summary.latestIndexSweep !== null
        ? Math.max(0, local - summary.latestIndexSweep)
        : null;

    const day = at.slice(0, 10);
    const previous = this.repositories.archiveState.get();
    summary.bytesToday =
      previous?.bytes_today_day === day ? (previous.bytes_today ?? 0) + summary.bytesThisCheck : summary.bytesThisCheck;

    this.repositories.archiveState.set({
      latestIndexSweep: summary.latestIndexSweep,
      latestVerifiedSweep: summary.latestVerifiedSweep,
      lagSweeps: summary.lagSweeps,
      pendingCount: summary.pendingCount,
      unavailableCount: summary.unavailableCount,
      mismatchCount: summary.mismatchCount,
      bytesThisCheck: summary.bytesThisCheck,
      bytesToday: summary.bytesToday,
      bytesTodayDay: day,
      lastCheckAt: at,
      lastError: null,
    });

    if (summary.hashMismatch > 0) {
      this.logger.event({
        level: 'warn',
        source: 'challenge-archive',
        code: 'archive_hash_mismatch',
        message: `${summary.hashMismatch} archive record(s) did not hash to what was claimed`,
        data: { sweeps: this.repositories.archiveSweeps.mismatchedSweeps() },
      });
    }

    this.last = summary;
    return summary;
  }

  /**
   * A settled sweep is skipped only when *every* field the entry could change
   * under still matches: status, path, the hash it claims and the size it
   * advertises. Any change means the bytes behind the entry moved, so the record
   * is re-downloaded and re-verified rather than trusted from the old row.
   */
  private isSettled(entry: ArchiveIndexEntry): boolean {
    const previous = this.repositories.archiveSweeps.get(entry.sweep);
    if (previous === undefined || previous.verified !== 1) return false;
    return (
      previous.status === entry.status &&
      (previous.path ?? null) === entry.path &&
      (previous.expected_sha256 ?? null) === entry.sha256 &&
      (previous.expected_size ?? null) === entry.size
    );
  }

  /**
   * Order the pending entries into three phases, all sharing one budget:
   *
   *   1. **mismatch retries** — a sweep whose bytes did not verify is retried
   *      first, so a finding is always chased even when the backlog is huge;
   *   2. **the latest window** — the newest `LATEST_WINDOW` sweeps, newest first,
   *      so a live contest is never reading a stale head;
   *   3. **the backlog** — everything older, in `backfillMode` order.
   */
  private order(pending: ArchiveIndexEntry[], latestIndexSweep: number | null): ArchiveIndexEntry[] {
    const isMismatch = (entry: ArchiveIndexEntry): boolean => {
      const previous: ArchiveSweepRow | undefined = this.repositories.archiveSweeps.get(entry.sweep);
      return previous !== undefined && previous.verified === 0 && previous.unavailable === 0;
    };
    const mismatch = pending.filter(isMismatch).sort((a, b) => a.sweep - b.sweep);

    const floor = latestIndexSweep === null ? -1 : latestIndexSweep - LATEST_WINDOW;
    const rest = pending.filter((entry) => !isMismatch(entry));
    const latest = rest.filter((entry) => entry.sweep > floor).sort((a, b) => b.sweep - a.sweep);
    const latestSweeps = new Set(latest.map((entry) => entry.sweep));
    const backfill = rest
      .filter((entry) => !latestSweeps.has(entry.sweep))
      .sort((a, b) =>
        this.config.archive.backfillMode === 'oldest_first' ? a.sweep - b.sweep : b.sweep - a.sweep,
      );

    return [...mismatch, ...latest, ...backfill];
  }

  /**
   * Wait until the request-rate window allows another request, then reserve the
   * next slot. The gate covers `index.json` as well as the records, so a check
   * cannot burst past the configured rate.
   */
  private async gate(): Promise<void> {
    const nowMs = this.now().getTime();
    if (this.nextRequestAt > nowMs) {
      await this.sleep(this.nextRequestAt - nowMs);
    }
    this.nextRequestAt = this.now().getTime() + this.minIntervalMs();
  }

  private minIntervalMs(): number {
    const perMinute = Math.max(1, this.config.archive.maxRequestsPerMinute);
    return Math.ceil(60_000 / perMinute);
  }

  private bytesTodaySoFar(): number {
    const day = this.now().toISOString().slice(0, 10);
    const previous = this.repositories.archiveState.get();
    return previous?.bytes_today_day === day ? previous.bytes_today ?? 0 : 0;
  }

  private async fetchOne(
    client: ArchiveClient,
    entry: ArchiveIndexEntry,
    summary: ArchiveCheckSummary,
  ): Promise<'verified' | 'unavailable' | 'mismatch'> {
    const at = this.now().toISOString();
    const bytes = await client.record(entry);
    if (bytes === null) {
      this.repositories.archiveSweeps.upsert({
        sweep: entry.sweep,
        status: entry.status,
        path: entry.path,
        expected_sha256: entry.sha256,
        expected_size: entry.size,
        actual_sha256: null,
        verified: 0,
        redacted_trades: entry.redactedTrades,
        fetched_at: at,
        unavailable: 1,
        error: 'archive_unavailable',
      });
      return 'unavailable';
    }
    summary.bytesThisCheck += bytes.byteLength;

    // A `full` record must also match the hash on the referee's signed post.
    // `verifyArchiveRecord` ignores the signed hash for a redacted record, by
    // design: redaction changed the bytes.
    const refereeFileHash = this.refereeFileHash(entry.sweep);
    const verdict = verifyArchiveRecord(entry, bytes, refereeFileHash);
    this.repositories.archiveSweeps.upsert({
      sweep: entry.sweep,
      status: entry.status,
      path: entry.path,
      expected_sha256: verdict.expected,
      expected_size: entry.size,
      actual_sha256: verdict.actual,
      verified: verdict.ok ? 1 : 0,
      redacted_trades: entry.redactedTrades,
      fetched_at: at,
      unavailable: 0,
      error: verdict.reason,
    });

    if (!verdict.ok) {
      this.logger.event({
        level: 'warn',
        source: 'challenge-archive',
        code: 'archive_hash_mismatch',
        message: `sweep ${entry.sweep} (${entry.status}) did not verify: ${verdict.reason}`,
        data: {
          sweep: entry.sweep,
          status: entry.status,
          expected: verdict.expected,
          actual: verdict.actual,
          reason: verdict.reason,
        },
      });
      return 'mismatch';
    }
    return 'verified';
  }

  /**
   * The `file` hash the referee signed for a sweep, when we saw a signed post
   * that carried one. Never invented: a sweep whose post we never read returns
   * null, and a `full` record is then checked against the index alone.
   */
  private refereeFileHash(sweep: number): string | null {
    for (const row of this.repositories.referee.signedForSweep(sweep)) {
      let payload: unknown;
      try {
        payload = JSON.parse(row.payload);
      } catch {
        continue;
      }
      const file = (payload as { file?: unknown }).file;
      if (typeof file === 'string' && file.trim().length > 0) return file.trim();
    }
    return null;
  }

  private recordError(at: string, detail: string): void {
    const previous = this.repositories.archiveState.get();
    this.repositories.archiveState.set({
      latestIndexSweep: previous?.latest_index_sweep ?? null,
      latestVerifiedSweep: previous?.latest_verified_sweep ?? null,
      lagSweeps: previous?.lag_sweeps ?? null,
      pendingCount: previous?.pending_count ?? 0,
      unavailableCount: previous?.unavailable_count ?? 0,
      mismatchCount: previous?.mismatch_count ?? 0,
      bytesThisCheck: 0,
      bytesToday: previous?.bytes_today ?? 0,
      bytesTodayDay: previous?.bytes_today_day ?? null,
      lastCheckAt: at,
      lastError: detail,
    });
    this.logger.event({
      level: 'warn',
      source: 'challenge-archive',
      code: 'archive_check_failed',
      message: 'archive check failed; the archive is an audit source and this changes nothing',
      data: { error: detail },
    });
  }
}
