/**
 * cost-report: what the model actually cost, and whether the budget held.
 *
 * The DeepSeek rule is not "use it sparingly", it is a small set of hard numbers:
 * at most two normal calls a day, at most one retry, a hard ceiling of three, one
 * call in flight, and the model is never called inside the blocked windows. Every
 * one of those is recorded in `llm_calls`, so this report is a query rather than
 * an estimate — and it exits non-zero when a day broke a limit, so it can be used
 * as a gate.
 *
 * A call attempted inside a blocked window is stored with `window_ok = 0` and
 * status `blocked`; those rows must never exist for an *attempted* call, which is
 * what the "off-window calls" column counts.
 *
 * Usage:
 *   pnpm cost-report                       # the configured database
 *   pnpm cost-report --db data/app.db      # an explicit file
 *   pnpm cost-report --days 7
 */
import { existsSync } from 'node:fs';
import { loadConfig } from '../apps/orchestrator/src/config.js';
import { openDatabase, type SqliteDatabase } from '@flop/storage';

/** Statuses that mean the request actually left the process for the model. */
const ATTEMPTED = `('ok','failed','timeout','invalid')`;

interface DayRow {
  day: string;
  normal: number;
  retries: number;
  total: number;
  offWindow: number;
  blocked: number;
  accepted: number;
  prompt: number;
  completion: number;
  totalTokens: number;
  latency: number;
  models: string;
}

function flag(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  if (index === -1) return undefined;
  const next = process.argv[index + 1];
  return next === undefined || next.startsWith('--') ? 'true' : next;
}

function query(db: SqliteDatabase, days: number): DayRow[] {
  return db
    .prepare(
      `SELECT day,
              SUM(CASE WHEN status IN ${ATTEMPTED} AND retry_of IS NULL THEN 1 ELSE 0 END) AS normal,
              SUM(CASE WHEN retry_of IS NOT NULL THEN 1 ELSE 0 END) AS retries,
              SUM(CASE WHEN status IN ${ATTEMPTED} THEN 1 ELSE 0 END) AS total,
              SUM(CASE WHEN status IN ${ATTEMPTED} AND window_ok = 0 THEN 1 ELSE 0 END) AS offWindow,
              SUM(CASE WHEN status = 'blocked' THEN 1 ELSE 0 END) AS blocked,
              SUM(accepted) AS accepted,
              SUM(prompt_tokens) AS prompt,
              SUM(completion_tokens) AS completion,
              SUM(total_tokens) AS totalTokens,
              SUM(latency_ms) AS latency,
              GROUP_CONCAT(DISTINCT model) AS models
         FROM llm_calls
        GROUP BY day
        ORDER BY day DESC
        LIMIT ?`,
    )
    .all(days) as DayRow[];
}

const config = loadConfig(process.env);
const dbPath = flag('db') ?? config.paths.database;
const days = Number.parseInt(flag('days') ?? '14', 10);

if (!existsSync(dbPath)) {
  process.stdout.write(
    `cost-report: no database at ${dbPath}.\n` +
      'Nothing has run yet. Run `pnpm start` in dry-run mode first, or pass --db.\n',
  );
  process.exit(0);
}

const db = openDatabase({ path: dbPath, migrate: false });
const rows = query(db, Number.isFinite(days) && days > 0 ? days : 14);
db.close();

const limits = config.deepseek;
const violations: string[] = [];

process.stdout.write(`\nDeepSeek cost report — ${dbPath}\n`);
process.stdout.write(
  `limits: ${limits.maxNormalCallsPerDay} normal/day, ${limits.maxRetriesPerDay} retry/day, ` +
    `hard ${limits.hardLimitPerDay}/day, concurrency ${limits.maxConcurrency} ` +
    `(${config.timezone})\n\n`,
);

if (rows.length === 0) {
  process.stdout.write('no model calls recorded\n\n');
  process.exit(0);
}

process.stdout.write(
  'day         normal  retry  total  off-window  blocked  accepted  tokens(p/c/t)          latency\n',
);
for (const row of rows) {
  process.stdout.write(
    `${row.day.padEnd(11)} ${String(row.normal).padStart(6)} ${String(row.retries).padStart(6)} ` +
      `${String(row.total).padStart(6)} ${String(row.offWindow).padStart(11)} ` +
      `${String(row.blocked).padStart(8)} ${String(row.accepted).padStart(9)}  ` +
      `${`${row.prompt}/${row.completion}/${row.totalTokens}`.padEnd(22)} ${row.latency}ms\n`,
  );

  if (row.total > limits.hardLimitPerDay) {
    violations.push(`${row.day}: ${row.total} calls exceeded the hard limit of ${limits.hardLimitPerDay}`);
  }
  if (row.normal > limits.maxNormalCallsPerDay) {
    violations.push(
      `${row.day}: ${row.normal} normal calls exceeded the budget of ${limits.maxNormalCallsPerDay}`,
    );
  }
  if (row.retries > limits.maxRetriesPerDay) {
    violations.push(`${row.day}: ${row.retries} retries exceeded the budget of ${limits.maxRetriesPerDay}`);
  }
  if (row.offWindow > 0) {
    violations.push(`${row.day}: ${row.offWindow} call(s) reached the model inside a blocked window`);
  }
}

const totals = rows.reduce(
  (accumulator, row) => ({
    total: accumulator.total + row.total,
    tokens: accumulator.tokens + row.totalTokens,
    accepted: accumulator.accepted + row.accepted,
  }),
  { total: 0, tokens: 0, accepted: 0 },
);

process.stdout.write(
  `\n${rows.length} day(s): ${totals.total} call(s), ${totals.tokens} token(s), ` +
    `${totals.accepted} accepted parameter set(s)\n`,
);

if (violations.length > 0) {
  process.stdout.write(`\n${violations.length} budget violation(s):\n`);
  for (const violation of violations) process.stdout.write(`  - ${violation}\n`);
  process.exitCode = 1;
} else {
  process.stdout.write('no budget violations\n');
}
process.stdout.write('\n');
