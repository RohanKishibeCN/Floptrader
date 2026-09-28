/**
 * Archiving room history.
 *
 * The archive is what lets the database shed chatter without losing the record.
 * Two rules:
 *
 *   - an archive is written, hashed, and *verified by re-reading the file* before
 *     anything is deleted;
 *   - the manifest is recorded either way, so a failed verification leaves a
 *     trail rather than a mystery.
 *
 * Registration evidence, trades, referee posts and anything from a local DID never
 * reach this module: they are permanent, and `retention.ts` is what decides that.
 */
import { createReadStream, existsSync, statSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { createGunzip } from 'node:zlib';
import { createInterface } from 'node:readline';
import type { Repositories } from '@flop/storage';
import { gzipJsonlToFile, sha256File } from '@flop/storage';
import type { TechnocoreLogger } from './protocol.js';

export interface ArchiveResult {
  path: string;
  bytes: number;
  sha256: string;
  lines: number;
  verified: boolean;
}

export interface ArchiverOptions {
  repositories: Repositories;
  logger: TechnocoreLogger;
  archiveDir: string;
  now?: () => Date;
}

export class RoomArchiver {
  private readonly repositories: Repositories;
  private readonly logger: TechnocoreLogger;
  private readonly archiveDir: string;
  private readonly now: () => Date;

  constructor(options: ArchiverOptions) {
    this.repositories = options.repositories;
    this.logger = options.logger;
    this.archiveDir = options.archiveDir;
    this.now = options.now ?? (() => new Date());
  }

  private stamp(): string {
    return this.now().toISOString().replace(/[-:]/g, '').replace(/\..+$/, '').replace('T', '-');
  }

  /**
   * Archive a batch of lines. The whole batch goes to one gzip JSONL file; the
   * manifest is only marked verified when the file on disk hashes to what the
   * writer computed.
   */
  async archiveBatch(kind: string, lines: string[]): Promise<ArchiveResult> {
    const dir = join(this.archiveDir, kind);
    await mkdir(dir, { recursive: true, mode: 0o700 });
    const path = join(dir, `${kind}-${this.stamp()}.jsonl.gz`);
    const written = await gzipJsonlToFile(path, lines);
    const recomputed = sha256File(path);
    const verified = recomputed === written.sha256;
    this.repositories.archiveManifests.record({
      path,
      sha256: written.sha256,
      bytes: written.bytes,
      files: lines.length,
      kind,
      created_at: this.now().toISOString(),
    });
    this.repositories.archiveManifests.markVerified(path, verified, null);
    if (!verified) {
      this.logger.event({
        level: 'error',
        source: 'archiver',
        code: 'archive_verify_failed',
        message: `archive ${path} hashed to ${recomputed} but was written as ${written.sha256}`,
        data: { path, written: written.sha256, recomputed },
      });
    }
    return {
      path,
      bytes: written.bytes,
      sha256: written.sha256,
      lines: lines.length,
      verified,
    };
  }

  /**
   * Re-verify every unverified archive by recomputing its digest. Called by the
   * daily maintenance pass; returns the paths that still fail.
   */
  verifyAll(): { verified: string[]; failed: string[] } {
    const verified: string[] = [];
    const failed: string[] = [];
    for (const row of this.repositories.archiveManifests.unverified()) {
      const path = String(row.path);
      if (!existsSync(path)) {
        failed.push(path);
        continue;
      }
      const expected = String(row.sha256);
      const actual = sha256File(path);
      const ok = actual === expected;
      this.repositories.archiveManifests.markVerified(path, ok, null);
      if (ok) verified.push(path);
      else failed.push(path);
    }
    return { verified, failed };
  }

  /** Read an archive back, for a spot check or a replay. */
  async *readArchive(path: string): AsyncGenerator<string> {
    const stream = createReadStream(path).pipe(createGunzip());
    const lines = createInterface({ input: stream, crlfDelay: Infinity });
    for await (const line of lines) {
      if (line.trim().length > 0) yield line;
    }
  }

  /**
   * Delete an archive. Refuses unless the manifest is verified AND an external
   * backup exists whose digest matches: the archive is the last copy of that
   * history, and the operator's own rule is "back it up, hash it, then delete".
   */
  deleteArchive(path: string, externalBackupPath: string | null): { deleted: boolean; reason: string } {
    const manifest = this.repositories.archiveManifests.get(path);
    if (!manifest) return { deleted: false, reason: 'no manifest for that archive' };
    if (Number(manifest.verified) !== 1) {
      return { deleted: false, reason: 'archive manifest is not verified' };
    }
    if (externalBackupPath === null || !existsSync(externalBackupPath)) {
      return { deleted: false, reason: 'no external backup: refusing to delete the only copy' };
    }
    const backupDigest = sha256File(externalBackupPath);
    if (backupDigest !== String(manifest.sha256)) {
      return { deleted: false, reason: 'external backup digest does not match the archive' };
    }
    this.repositories.archiveManifests.markDeleted(path);
    return { deleted: true, reason: 'archived, backed up and verified' };
  }

  totalBytes(): number {
    return this.repositories.archiveManifests.totalBytes();
  }

  sizeOnDisk(path: string): number {
    return existsSync(path) ? statSync(path).size : 0;
  }
}
