/**
 * The published sweep archive, actually polled.
 *
 * `packages/technocore`'s `ArchiveClient` and `verifyArchiveRecord` are the
 * mechanism; this is the schedule and the bookkeeping. Three properties are the
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
 */
import type { Repositories } from '@flop/storage';
import { ArchiveClient, verifyArchiveRecord, type ArchiveIndexEntry } from '@flop/technocore';
import type { Config } from './config.js';
import type { Logger } from './logger.js';

export interface ArchiveCheckSummary {
  at: string;
  /** False when `index.json` itself could not be read; nothing else was attempted. */
  checked: boolean;
  latestIndexSweep: number | null;
  latestVerifiedSweep: number | null;
  lagSweeps: number | null;
  /** Entries downloaded (or 404'd) this pass. */
  fetched: number;
  verified: number;
  unavailable: number;
  hashMismatch: number;
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
}

export class ChallengeArchiveMonitor {
  private readonly config: Config;
  private readonly logger: Logger;
  private readonly repositories: Repositories;
  private readonly localSweep: () => number | null;
  private readonly fetchImpl: typeof fetch | undefined;
  private readonly now: () => Date;

  private timer: ReturnType<typeof setInterval> | null = null;
  private inFlight: Promise<ArchiveCheckSummary> | null = null;
  private last: ArchiveCheckSummary | null = null;

  constructor(options: ChallengeArchiveMonitorOptions) {
    this.config = options.config;
    this.logger = options.logger;
    this.repositories = options.repositories;
    this.localSweep = options.localSweep;
    this.fetchImpl = options.fetchImpl;
    this.now = options.now ?? (() => new Date());
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
        fetched: 0,
        verified: 0,
        unavailable: 0,
        hashMismatch: 0,
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
      fetched: 0,
      verified: 0,
      unavailable: 0,
      hashMismatch: 0,
      error: null,
    };

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

    for (const sweep of sweeps) {
      const entry = index.entries.get(sweep)!;
      // Already verified: never re-download, and never re-write a record we hold.
      if (this.repositories.archiveSweeps.get(sweep)?.verified === 1) continue;
      const outcome = await this.fetchOne(client, entry);
      summary.fetched += 1;
      if (outcome === 'verified') summary.verified += 1;
      else if (outcome === 'unavailable') summary.unavailable += 1;
      else summary.hashMismatch += 1;
    }

    summary.latestVerifiedSweep = this.repositories.archiveSweeps.maxVerifiedSweep();
    const local = this.localSweep();
    summary.lagSweeps =
      local !== null && summary.latestIndexSweep !== null
        ? Math.max(0, local - summary.latestIndexSweep)
        : null;

    this.repositories.archiveState.set({
      latestIndexSweep: summary.latestIndexSweep,
      latestVerifiedSweep: summary.latestVerifiedSweep,
      lagSweeps: summary.lagSweeps,
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

  private async fetchOne(
    client: ArchiveClient,
    entry: ArchiveIndexEntry,
  ): Promise<'verified' | 'unavailable' | 'mismatch'> {
    const at = this.now().toISOString();
    const bytes = await client.record(entry);
    if (bytes === null) {
      this.repositories.archiveSweeps.upsert({
        sweep: entry.sweep,
        status: entry.status,
        path: entry.path,
        expected_sha256: entry.sha256,
        actual_sha256: null,
        verified: 0,
        redacted_trades: entry.redactedTrades,
        fetched_at: at,
        unavailable: 1,
        error: 'archive_unavailable',
      });
      return 'unavailable';
    }

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
