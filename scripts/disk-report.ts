/**
 * disk-report: what this process is using on the shared VPS, and what it is
 * allowed to do about it.
 *
 * The 2 vCPU / 4 GB box is shared, so "how much disk does this own" has to be
 * answerable without guessing, and the degradation ladder has to be visible
 * before it triggers. The report prints the same reading the load guard uses
 * (`LoadGuard.diskUsedPercent`), the size of each artifact this process owns, the
 * retention windows, and — read-only — exactly how much third-party chatter and
 * how many debug events a maintenance pass *would* archive. It never deletes.
 *
 * Usage:
 *   pnpm disk-report
 *   pnpm disk-report --data-dir /opt/flop-close-call/data
 */
import { existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { loadConfig } from '../apps/orchestrator/src/config.js';
import { Logger } from '../apps/orchestrator/src/logger.js';
import { LoadGuard, type LoadTier } from '../apps/orchestrator/src/load-guard.js';
import {
  DEFAULT_RETENTION,
  EVIDENCE_MESSAGE_KINDS,
  PERMANENT_EVENT_CODES,
  PERMANENT_TABLES,
  openDatabase,
  selectChatterCandidates,
  snapshotPermanentCounts,
  type SqliteDatabase,
} from '@flop/storage';

function flag(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  if (index === -1) return undefined;
  const next = process.argv[index + 1];
  return next === undefined || next.startsWith('--') ? 'true' : next;
}

function bytes(path: string): number {
  try {
    return statSync(path).size;
  } catch {
    return 0;
  }
}

function directoryBytes(path: string): number {
  if (!existsSync(path)) return 0;
  let total = 0;
  for (const entry of readdirSync(path, { withFileTypes: true })) {
    const full = join(path, entry.name);
    total += entry.isDirectory() ? directoryBytes(full) : bytes(full);
  }
  return total;
}

function human(value: number): string {
  const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB'];
  let scaled = value;
  let unit = 0;
  while (scaled >= 1024 && unit < units.length - 1) {
    scaled /= 1024;
    unit += 1;
  }
  return `${scaled.toFixed(unit === 0 ? 0 : 2)} ${units[unit]}`;
}

function localDids(db: SqliteDatabase): string[] {
  try {
    return (db.prepare('SELECT did FROM identities').all() as Array<{ did: string }>).map((row) => row.did);
  } catch {
    return [];
  }
}

function debugEventCandidates(db: SqliteDatabase, now: Date): number {
  const cutoff = new Date(now.getTime() - DEFAULT_RETENTION.debugHours * 3600_000).toISOString();
  const placeholders = PERMANENT_EVENT_CODES.map(() => '?').join(',');
  return (
    db
      .prepare(`SELECT COUNT(*) AS n FROM events WHERE at < ? AND code NOT IN (${placeholders})`)
      .get(cutoff, ...PERMANENT_EVENT_CODES) as { n: number }
  ).n;
}

const env = { ...process.env };
const dataDirFlag = flag('data-dir');
if (dataDirFlag !== undefined && dataDirFlag !== 'true') env.DATA_DIR = dataDirFlag;

const config = loadConfig(env);
const guard = new LoadGuard({ config, logger: Logger.create({ level: 'fatal' }) });

const dataPercent = guard.diskUsedPercent(config.dataDir);
const archivePercent = existsSync(config.paths.archive)
  ? guard.diskUsedPercent(config.paths.archive)
  : dataPercent;

/** Mirrors the load guard's own ladder so the report explains the tier. */
function tierFor(percent: number): LoadTier {
  const thresholds = config.loadGuard;
  if (percent > thresholds.diskReadonlyPercent) return 'readonly';
  if (percent > thresholds.diskCriticalPercent) return 'critical';
  if (percent > thresholds.diskShedPercent) return 'shed_trading';
  if (percent > thresholds.diskCompressPercent) return 'pause_llm';
  return 'normal';
}

const lines: string[] = [];
lines.push(`\ndisk report — ${config.dataDir}\n`);
lines.push(`filesystem at data dir   ${dataPercent.toFixed(1)}% used -> tier ${tierFor(dataPercent)}`);
lines.push(`filesystem at archive     ${archivePercent.toFixed(1)}% used -> tier ${tierFor(archivePercent)}`);
lines.push(
  `ladder                   >${config.loadGuard.diskCompressPercent}% pause model/compression, ` +
    `>${config.loadGuard.diskShedPercent}% stop active trading, ` +
    `>${config.loadGuard.diskCriticalPercent}% critical alert, ` +
    `>${config.loadGuard.diskReadonlyPercent}% read-only`,
);

lines.push('\nown artifacts');
const dbBytes = bytes(config.paths.database);
const walBytes = bytes(`${config.paths.database}-wal`);
const shmBytes = bytes(`${config.paths.database}-shm`);
const archiveBytes = directoryBytes(config.paths.archive);
const secretsBytes = directoryBytes(config.secretsDir);
lines.push(`  sqlite                 ${human(dbBytes).padStart(10)}  ${config.paths.database}`);
lines.push(`  sqlite -wal            ${human(walBytes).padStart(10)}`);
lines.push(`  sqlite -shm            ${human(shmBytes).padStart(10)}`);
lines.push(`  archive                ${human(archiveBytes).padStart(10)}  ${config.paths.archive}`);
lines.push(`  secrets (age bundle)   ${human(secretsBytes).padStart(10)}  ${config.secretsDir}`);
lines.push(`  total                  ${human(dbBytes + walBytes + shmBytes + archiveBytes + secretsBytes).padStart(10)}`);

lines.push('\nretention');
lines.push(
  `  chatter window         ${DEFAULT_RETENTION.chatterHours}h (third-party messages only)`,
);
lines.push(`  debug window           ${DEFAULT_RETENTION.debugHours}h`);
lines.push(`  keep recent per room   ${DEFAULT_RETENTION.keepRecentPerRoom}`);
lines.push(
  `  evidence kinds kept    ${EVIDENCE_MESSAGE_KINDS.join(', ')}`,
);
lines.push(`  permanent tables       ${PERMANENT_TABLES.join(', ')}`);

if (existsSync(config.paths.database)) {
  const db = openDatabase({ path: config.paths.database, migrate: false });
  try {
    const now = new Date();
    const dids = localDids(db);
    const chatter = selectChatterCandidates(db, dids, now, DEFAULT_RETENTION);
    const debugEvents = debugEventCandidates(db, now);
    const permanent = snapshotPermanentCounts(db);

    lines.push('\nwhat a maintenance pass would do (read-only estimate)');
    lines.push(`  local DIDs known       ${dids.length}`);
    lines.push(`  chatter archivable     ${chatter.length} message(s) older than ${DEFAULT_RETENTION.chatterHours}h`);
    lines.push(`  debug events archivable ${debugEvents} event(s) older than ${DEFAULT_RETENTION.debugHours}h`);
    lines.push('  permanent rows (never pruned)');
    for (const [table, count] of Object.entries(permanent)) {
      lines.push(`    ${table.padEnd(22)} ${String(count).padStart(8)}`);
    }

    const health = db.pragma('integrity_check', { simple: true }) as string;
    lines.push(`\nsqlite integrity_check  ${health}`);
    lines.push(`sqlite journal_mode     ${db.pragma('journal_mode', { simple: true }) as string}`);
  } finally {
    db.close();
  }
} else {
  lines.push(`\nno database at ${config.paths.database}; nothing has run yet`);
}

lines.push('');
process.stdout.write(lines.join('\n'));
