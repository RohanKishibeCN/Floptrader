/**
 * SQLite in WAL mode: one file, one writer, many readers, no server.
 *
 * Pragmas are fixed here rather than left to defaults:
 *   journal_mode = WAL          concurrent reader + writer
 *   synchronous  = NORMAL       one fsync per checkpoint, not per commit
 *   busy_timeout = 5000         wait out a competing writer instead of failing
 *   foreign_keys = ON          the schema's references are enforced
 *
 * The connection is also bounded so a 2 vCPU / 4 GB VPS with other tenants
 * cannot be overrun by this process alone: page cache 8 MiB, mmap 64 MiB,
 * temp store in memory, autocheckpoint at 1000 pages.
 */
import Database from 'better-sqlite3';
import { mkdirSync, chmodSync, existsSync } from 'node:fs';
import { dirname } from 'node:path';
import { runMigrations, SCHEMA_VERSION } from './migrations.js';

export type SqliteDatabase = Database.Database;

export interface OpenDatabaseOptions {
  /** ':memory:' for tests, a path for production. */
  path: string;
  /** Apply pending migrations. Default true. */
  migrate?: boolean;
  /** 0o600 by default; the DB holds participation evidence and signatures. */
  fileMode?: number;
  verbose?: (message: string) => void;
}

/**
 * A memoizing `prepare`, and a strong registry of live connections.
 *
 * Two reasons the memoization exists rather than calling `db.prepare` at each call
 * site:
 *
 *   1. **Cost.** The repositories run the same handful of SQL strings thousands of
 *      times per hour. Preparing each time re-parses, re-plans and allocates a new
 *      native `Statement` wrapper on a 2 vCPU box. One prepared statement per
 *      distinct SQL is the standard better-sqlite3 usage.
 *   2. **Bounded object count.** A statement wrapper per call means tens of
 *      thousands of native wrappers churning through GC.
 *
 * `LIVE_DATABASES` holds connections strongly, deliberately, and is released only by
 * `releaseDatabase`. better-sqlite3 finalises native handles from a V8 weak callback,
 * and that callback calls back into the Node environment. If it fires after the
 * environment has been torn down — which is exactly what a final GC at process exit
 * does for an otherwise-unreferenced connection — the addon asserts
 * `(env) != nullptr` and aborts the whole process. Keeping live connections and their
 * statements reachable until the process ends removes that failure mode. The set
 * holds one entry per opened database (one in production), so it is bounded.
 */
const LIVE_DATABASES = new Set<SqliteDatabase>();
const statementCaches = new Map<SqliteDatabase, Map<string, Database.Statement>>();

export function statementCache(db: SqliteDatabase): Map<string, Database.Statement> {
  let cache = statementCaches.get(db);
  if (!cache) {
    cache = new Map();
    statementCaches.set(db, cache);
  }
  return cache;
}

/** Prepare (or reuse) a statement on this connection. */
export function prepareCached(db: SqliteDatabase, sql: string): Database.Statement {
  const cache = statementCache(db);
  let statement = cache.get(sql);
  if (!statement) {
    statement = db.prepare(sql);
    cache.set(sql, statement);
  }
  return statement;
}

/** Count of connections held for the life of the process; a health-check gauge. */
export function liveDatabaseCount(): number {
  return LIVE_DATABASES.size;
}

/**
 * Drop every reference to a connection so it and its statements become collectable.
 * Only safe when the environment will not be torn down before the next GC; the
 * default `closeDatabase` deliberately does not call this.
 */
export function releaseDatabase(db: SqliteDatabase): void {
  LIVE_DATABASES.delete(db);
  statementCaches.delete(db);
}

function installStatementCache(db: SqliteDatabase): void {
  const cache = statementCache(db);
  const nativePrepare = db.prepare.bind(db);
  Object.defineProperty(db, 'prepare', {
    configurable: true,
    writable: false,
    value: (sql: string): Database.Statement => {
      let statement = cache.get(sql);
      if (!statement) {
        statement = nativePrepare(sql);
        cache.set(sql, statement);
      }
      return statement;
    },
  });
}

/**
 * Open a connection and register it, without applying our pragmas or migrations.
 * Used for diagnostics (integrity checks) and backups, which need `readonly` and
 * `fileMustExist` rather than the operational settings — but which must still be
 * registered so their native handles are never finalised after teardown.
 */
export function openRegisteredDatabase(
  path: string,
  options?: ConstructorParameters<typeof Database>[1],
): SqliteDatabase {
  const db = new Database(path, options);
  installStatementCache(db);
  LIVE_DATABASES.add(db);
  return db;
}

export function openDatabase(options: OpenDatabaseOptions): SqliteDatabase {
  const { path } = options;
  if (path !== ':memory:') {
    const parent = dirname(path);
    if (!existsSync(parent)) mkdirSync(parent, { recursive: true, mode: 0o700 });
  }
  const db = openRegisteredDatabase(
    path,
    options.verbose ? { verbose: (message?: unknown) => options.verbose!(String(message)) } : {},
  );
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL');
  db.pragma('busy_timeout = 5000');
  db.pragma('foreign_keys = ON');
  db.pragma('cache_size = -8000');
  db.pragma('mmap_size = 67108864');
  db.pragma('temp_store = MEMORY');
  db.pragma('wal_autocheckpoint = 1000');
  if (path !== ':memory:') {
    try {
      chmodSync(path, options.fileMode ?? 0o600);
    } catch {
      /* best effort; see permissions.ts */
    }
  }
  if (options.migrate !== false) runMigrations(db);
  return db;
}

export interface DatabaseHealth {
  schemaVersion: number;
  journalMode: string;
  integrity: string;
  pageCount: number;
  pageSize: number;
  freelistCount: number;
  walPages: number;
}

export function databaseHealth(db: SqliteDatabase): DatabaseHealth {
  const integrity = db.pragma('integrity_check', { simple: true }) as string;
  return {
    schemaVersion: db.pragma('user_version', { simple: true }) as number,
    journalMode: db.pragma('journal_mode', { simple: true }) as string,
    integrity,
    pageCount: db.pragma('page_count', { simple: true }) as number,
    pageSize: db.pragma('page_size', { simple: true }) as number,
    freelistCount: db.pragma('freelist_count', { simple: true }) as number,
    walPages: db.pragma('wal_checkpoint(PASSIVE)', { simple: false }) as unknown as number,
  };
}

export function expectedSchemaVersion(): number {
  return SCHEMA_VERSION;
}

/** Flush the WAL back into the main database file. Cheap, and safe online. */
export function checkpoint(db: SqliteDatabase, mode: 'PASSIVE' | 'FULL' | 'TRUNCATE' = 'TRUNCATE'): void {
  db.pragma(`wal_checkpoint(${mode})`);
}

export function closeDatabase(db: SqliteDatabase): void {
  try {
    checkpoint(db, 'TRUNCATE');
  } catch {
    /* a checkpoint failure must not block shutdown */
  }
  db.close();
}
