/**
 * Database backup and archive-manifest primitives.
 *
 * Two rules the operator surface depends on:
 *   1. A backup is only "done" once it has been re-opened and integrity-checked.
 *      A file that exists is not a backup.
 *   2. Nothing is deleted until its archive manifest carries a sha256, a byte
 *      count and a verified flag.
 */
import { createHash } from 'node:crypto';
import { closeSync, openSync, readSync, statSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { createGzip } from 'node:zlib';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import { createWriteStream } from 'node:fs';
import type { SqliteDatabase } from './database.js';
import { openRegisteredDatabase } from './database.js';

export interface BackupResult {
  path: string;
  bytes: number;
  sha256: string;
  integrity: string;
  ok: boolean;
}

export async function backupDatabase(db: SqliteDatabase, destination: string): Promise<BackupResult> {
  await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
  await db.backup(destination);
  const integrity = verifyDatabaseFile(destination);
  return {
    path: destination,
    bytes: statSync(destination).size,
    sha256: sha256File(destination),
    integrity: integrity.integrity,
    ok: integrity.ok,
  };
}

export interface IntegrityResult {
  ok: boolean;
  integrity: string;
  error?: string;
}

/** Re-open a database file in read-only mode and run SQLite's own check. */
export function verifyDatabaseFile(path: string): IntegrityResult {
  let handle: SqliteDatabase | undefined;
  try {
    handle = openRegisteredDatabase(path, { readonly: true, fileMustExist: true });
    const integrity = handle.pragma('integrity_check', { simple: true }) as string;
    return { ok: integrity === 'ok', integrity };
  } catch (error) {
    return { ok: false, integrity: 'unreadable', error: String(error) };
  } finally {
    handle?.close();
  }
}

/** Streaming sha256 over a file, returned as `sha256:<hex>`. */
export function sha256File(path: string): string {
  const hash = createHash('sha256');
  const size = statSync(path).size;
  const chunkSize = 1024 * 1024;
  const scratch = Buffer.alloc(chunkSize);
  const handle = openSync(path, 'r');
  try {
    let offset = 0;
    while (offset < size) {
      const bytes = readSync(handle, scratch, 0, Math.min(chunkSize, size - offset), offset);
      if (bytes <= 0) break;
      hash.update(scratch.subarray(0, bytes));
      offset += bytes;
    }
  } finally {
    closeSync(handle);
  }
  return `sha256:${hash.digest('hex')}`;
}

export function sha256Text(text: string): string {
  return `sha256:${createHash('sha256').update(text, 'utf8').digest('hex')}`;
}

/** gzip a JSONL body to a file. */
export async function gzipJsonlToFile(
  path: string,
  lines: Iterable<string>,
): Promise<{ path: string; bytes: number; sha256: string }> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const body = `${[...lines].join('\n')}\n`;
  await pipeline(Readable.from([body]), createGzip({ level: 6 }), createWriteStream(path, { mode: 0o600 }));
  return { path, bytes: statSync(path).size, sha256: sha256File(path) };
}

export function fileBytes(path: string): number {
  return statSync(path).size;
}
