/**
 * Filesystem permission helpers.
 *
 * The secret-handling rules are enforced here rather than by convention:
 *   secrets dir        0700
 *   age identity file  0600
 *   public dir         0755
 *   public manifest    0644
 *   SQLite file        0600
 *   evidence files     0600
 *
 * A directory's mode is set only when that directory is created, and never to a
 * mode without the execute bit: chmod 0644 on a directory removes traversal and
 * makes everything inside it unreachable. That is a footgun worth this comment.
 */
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

export const MODE = {
  secretsDir: 0o700,
  publicDir: 0o755,
  privateKey: 0o600,
  publicFile: 0o644,
} as const;

/** Create a directory if needed, and apply `mode` to it. */
export function ensureDir(path: string, mode: number = MODE.secretsDir): void {
  if (!existsSync(path)) mkdirSync(path, { recursive: true, mode });
  try {
    chmodSync(path, mode);
  } catch {
    // Some filesystems (and some mounted volumes) refuse chmod. Creating with
    // `mode` is still the best effort available, and callers are told so by the
    // `verify-all` permission audit rather than silently.
  }
}

/** Create a file's parent directory. The directory mode is a *directory* mode. */
export function ensureParentDir(filePath: string, dirMode: number): void {
  ensureDir(dirname(filePath), dirMode);
}

export function writePrivateFile(path: string, data: string | Uint8Array): void {
  ensureParentDir(path, MODE.secretsDir);
  writeFileSync(path, data, { mode: MODE.privateKey });
  try {
    chmodSync(path, MODE.privateKey);
  } catch {
    /* best effort, see ensureDir */
  }
}

export function writePublicFile(path: string, data: string | Uint8Array): void {
  ensureParentDir(path, MODE.publicDir);
  writeFileSync(path, data, { mode: MODE.publicFile });
  try {
    chmodSync(path, MODE.publicFile);
  } catch {
    /* best effort */
  }
}

export function readFileText(path: string): string {
  return readFileSync(path, 'utf8');
}
