/**
 * The daily archive maintenance pass.
 *
 * Order is the spec's order, and it is load-bearing:
 *   1. never prune on a day the report did not go out
 *   2. flush the WAL
 *   3. snapshot the permanent counts BEFORE touching anything
 *   4. gzip the prunable rows to a checksummed archive and verify the checksum
 *   5. only then delete those rows
 *   6. prove the permanent set is intact, or fail loudly
 *   7. clean temporary files
 *   8. report the disk reading
 *
 * An archive is deleted only after an external backup has been checksummed.
 */
import { existsSync, readdirSync, rmSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import {
  DEFAULT_RETENTION,
  assertEvidenceIntact,
  checkpoint,
  deleteChatter,
  deleteDebugEvents,
  fileBytes,
  gzipJsonlToFile,
  selectChatterCandidates,
  sha256File,
  snapshotPermanentCounts,
  type PruneCandidate,
  type Repositories,
  type SqliteDatabase,
} from '@flop/storage';
import type { Config } from './config.js';
import type { Logger } from './logger.js';
import type { LoadGuard, LoadTier } from './load-guard.js';

export interface MaintenanceReport {
  reportId: string;
  flushedWal: boolean;
  checkpointed: boolean;
  dbBytes: number;
  archiveBytes: number;
  chatterArchived: number;
  chatterDeleted: number;
  debugEventsDeleted: number;
  tempFilesRemoved: number;
  diskUsedPercent: number;
  tierAtStart: LoadTier;
  tierAtEnd: LoadTier;
  evidenceIntact: boolean;
  notes: string[];
}

export interface ArchiveMaintenanceOptions {
  config: Config;
  logger: Logger;
  repositories: Repositories;
  db: SqliteDatabase;
  loadGuard: LoadGuard;
  localDids: () => string[];
  now?: () => Date;
}

function stamp(date: Date): string {
  const pad = (n: number, width = 2): string => String(n).padStart(width, '0');
  return (
    `${date.getUTCFullYear()}${pad(date.getUTCMonth() + 1)}${pad(date.getUTCDate())}` +
    `-${pad(date.getUTCHours())}${pad(date.getUTCMinutes())}${pad(date.getUTCSeconds())}`
  );
}

function candidateLine(candidate: PruneCandidate): string {
  return JSON.stringify({
    room: candidate.room,
    seq: candidate.seq,
    ts: candidate.ts,
    text: candidate.text,
    sender_did: candidate.sender_did,
    kind: candidate.kind,
    signature_valid: candidate.signature_valid,
  });
}

export class ArchiveMaintenance {
  private readonly config: Config;
  private readonly logger: Logger;
  private readonly repositories: Repositories;
  private readonly db: SqliteDatabase;
  private readonly loadGuard: LoadGuard;
  private readonly localDids: () => string[];
  private readonly now: () => Date;

  constructor(options: ArchiveMaintenanceOptions) {
    this.config = options.config;
    this.logger = options.logger;
    this.repositories = options.repositories;
    this.db = options.db;
    this.loadGuard = options.loadGuard;
    this.localDids = options.localDids;
    this.now = options.now ?? (() => new Date());
  }

  async run(dailyReportSucceeded: boolean): Promise<MaintenanceReport> {
    const notes: string[] = [];
    const tierAtStart = this.loadGuard.state.tier;
    const reportId = randomUUID();
    const report: MaintenanceReport = {
      reportId,
      flushedWal: false,
      checkpointed: false,
      dbBytes: 0,
      archiveBytes: 0,
      chatterArchived: 0,
      chatterDeleted: 0,
      debugEventsDeleted: 0,
      tempFilesRemoved: 0,
      diskUsedPercent: 0,
      tierAtStart,
      tierAtEnd: tierAtStart,
      evidenceIntact: true,
      notes,
    };

    // 1. History is never pruned on a day the report did not go out.
    if (!dailyReportSucceeded) {
      notes.push('daily report did not succeed; history is never pruned on a day the report did not go out');
      return report;
    }

    // 2. Flush the WAL back into the main database file.
    checkpoint(this.db, 'TRUNCATE');
    report.flushedWal = true;
    report.checkpointed = true;

    // 3. Snapshot the permanent counts before any prune.
    const before = snapshotPermanentCounts(this.db);

    // The load guard can pause compression/archiving; when it has, keep the
    // record intact rather than pruning under pressure.
    if (!this.loadGuard.allow('compression')) {
      notes.push('load guard paused compression/archiving; history retained this pass');
      report.tierAtEnd = this.loadGuard.state.tier;
      report.dbBytes = this.dbBytes();
      report.archiveBytes = this.repositories.archiveManifests.totalBytes();
      report.diskUsedPercent = this.loadGuard.diskUsedPercent(this.config.paths.archive);
      return report;
    }

    const now = this.now();
    const candidates = selectChatterCandidates(this.db, this.localDids(), now, DEFAULT_RETENTION);

    // 4. Archive first: gzip, record the manifest, and only mark verified once
    //    the digest on disk matches what the writer returned.
    let archivedOk = candidates.length === 0;
    let manifestRecorded = false;
    if (candidates.length > 0) {
      const archivePath = join(
        this.config.paths.archive,
        `messages-${stamp(now)}.jsonl.gz`,
      );
      const written = await gzipJsonlToFile(archivePath, candidates.map(candidateLine));
      this.repositories.archiveManifests.record({
        path: archivePath,
        sha256: written.sha256,
        bytes: written.bytes,
        files: candidates.length,
        kind: 'messages',
      });
      manifestRecorded = true;
      const onDisk = sha256File(archivePath);
      archivedOk = onDisk === written.sha256;
      if (archivedOk) {
        this.repositories.archiveManifests.markVerified(archivePath, true, null);
        report.chatterArchived = candidates.length;
      } else {
        notes.push(`archive digest mismatch for ${archivePath}; rows were not deleted`);
      }
    }

    // 5. Delete only what was archived and verified.
    if (archivedOk) {
      report.chatterDeleted = deleteChatter(this.db, candidates);
    }
    report.debugEventsDeleted = deleteDebugEvents(this.db, now, DEFAULT_RETENTION);

    // 6. The permanent set must be provably intact. `archive_manifests` is itself
    //    permanent, and recording the manifest we just wrote is an expected
    //    append rather than a loss, so refresh that one baseline entry first.
    if (manifestRecorded) {
      before.archive_manifests = snapshotPermanentCounts(this.db).archive_manifests ?? 0;
    }
    try {
      assertEvidenceIntact(this.db, before);
      report.evidenceIntact = true;
    } catch (error) {
      report.evidenceIntact = false;
      this.logger.event({
        level: 'fatal',
        source: 'archive-maintenance',
        code: 'sqlite_corrupt',
        message: 'retention violated the permanent set; refusing to continue',
        data: { reportId, error: String(error) },
      });
      throw error;
    }

    // 7. Remove temporary files left by interrupted archive writes.
    report.tempFilesRemoved = this.removeTempFiles();

    // 8. Report the disk reading using the load guard's own source.
    report.diskUsedPercent = this.loadGuard.diskUsedPercent(this.config.paths.archive);
    report.dbBytes = this.dbBytes();
    report.archiveBytes = this.repositories.archiveManifests.totalBytes();
    report.tierAtEnd = this.loadGuard.state.tier;
    return report;
  }

  /** Re-verify every unverified manifest by recomputing its sha256. */
  verifyArchives(): { verified: string[]; failed: string[] } {
    const verified: string[] = [];
    const failed: string[] = [];
    for (const row of this.repositories.archiveManifests.unverified()) {
      const path = String(row.path);
      const expected = String(row.sha256);
      let ok = false;
      try {
        ok = existsSync(path) && sha256File(path) === expected;
      } catch {
        ok = false;
      }
      this.repositories.archiveManifests.markVerified(path, ok, null);
      (ok ? verified : failed).push(path);
    }
    return { verified, failed };
  }

  /**
   * An archive is only deleted after an external backup has been checksummed:
   * the manifest must exist, must be verified, and the supplied backup must be
   * on disk with the same sha256 as the archive.
   */
  deleteArchive(path: string, externalBackupPath: string): void {
    const manifest = this.repositories.archiveManifests.get(path);
    if (!manifest) throw new Error(`no archive manifest for ${path}`);
    if (Number(manifest.verified) !== 1) {
      throw new Error(`refusing to delete an unverified archive: ${path}`);
    }
    if (!externalBackupPath) {
      throw new Error(`refusing to delete ${path} without an external backup path`);
    }
    if (!existsSync(externalBackupPath)) {
      throw new Error(`external backup does not exist: ${externalBackupPath}`);
    }
    if (sha256File(externalBackupPath) !== String(manifest.sha256)) {
      throw new Error(`external backup checksum does not match the archive: ${externalBackupPath}`);
    }
    rmSync(path, { force: true });
    this.repositories.archiveManifests.markDeleted(path);
  }

  private dbBytes(): number {
    const path = this.config.paths.database;
    return existsSync(path) ? fileBytes(path) : 0;
  }

  private removeTempFiles(): number {
    const archive = this.config.paths.archive;
    let removed = 0;

    const tmpDir = join(archive, 'tmp');
    if (existsSync(tmpDir)) {
      for (const entry of readdirSync(tmpDir, { withFileTypes: true })) {
        rmSync(join(tmpDir, entry.name), { recursive: true, force: true });
        removed += 1;
      }
    }
    removed += this.removeTmpSuffix(archive);
    return removed;
  }

  private removeTmpSuffix(dir: string): number {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return 0;
    }
    let removed = 0;
    for (const entry of entries) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name !== 'tmp') removed += this.removeTmpSuffix(full);
      } else if (entry.name.endsWith('.tmp')) {
        rmSync(full, { force: true });
        removed += 1;
      }
    }
    return removed;
  }
}
