/**
 * soak-test: the accelerated contest rehearsal.
 *
 * A real 24-hour run is 288 sweeps at five minutes each. This drives the same
 * number of ticks through the *real* orchestrator — the real reader, writer,
 * scheduler, risk book and Lark stack — with only the two network edges replaced
 * by doubles (the technocore HTTP transport and the Lark transports). Nothing is
 * simulated in the sense of being stubbed out; the code path is the production
 * one, and the clock is the only thing that moves faster.
 *
 * The scripted events are the ones the acceptance criteria name:
 *
 *   - a disk crossing the critical threshold and receding, so the degradation
 *     ladder runs rather than being asserted about;
 *   - a Lark WebSocket drop, so the reconnect ladder runs;
 *   - a referee seed quoting a different package hash, so drift pauses active
 *     trading while the reader keeps reading;
 *   - a hard kill mid-run, then a restart over the same database *and the same
 *     rooms*, so the recovered cursors and nonces are exercised under load.
 *
 * It prints the acceptance numbers and exits non-zero if any invariant broke.
 *
 * Usage:
 *   pnpm soak-test                    # 150 agents, 288 sweeps
 *   pnpm soak-test --quick            #  30 agents,  36 sweeps
 *   pnpm soak-test --agents 150 --ticks 288 --out soak-report.json
 */
import { writeFileSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import { join } from 'node:path';
import {
  buildHarness,
  HARNESS_PACKAGE_HASH,
  REFERENCE_CONTEST_PATH,
  type Harness,
} from '../tests/support/orchestrator.js';
import { FakeTransport } from '../tests/support/fake-transport.js';
import { cleanup, tempDir } from '../tests/support/harness.js';
import type { WsFactory, WsTransportOptions } from '../apps/orchestrator/src/lark.js';

// ---------------------------------------------------------------------------
// arguments
// ---------------------------------------------------------------------------

function flag(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  if (index === -1) return undefined;
  const next = process.argv[index + 1];
  return next === undefined || next.startsWith('--') ? 'true' : next;
}

const quick = process.argv.includes('--quick');
const AGENTS = Number.parseInt(flag('agents') ?? (quick ? '30' : '150'), 10);
const TICKS = Number.parseInt(flag('ticks') ?? (quick ? '36' : '288'), 10);
const SWEEP_SECONDS = 300;
const OUT = flag('out');

/**
 * The seed this run agrees with, and the one it later drifts to.
 *
 * `PACKAGE_HASH` has to be the hash the harness actually pinned — the real
 * sha256 of the vendored manifest — or the very first seed reads as drift and the
 * whole run becomes a test of conservative mode rather than of the trade path.
 * `DRIFTED_HASH` is deliberately a hash nothing pins, so the drift event is real.
 */
const PACKAGE_HASH = HARNESS_PACKAGE_HASH;
const DRIFTED_HASH = 'c'.repeat(64);

/** Scripted events, as tick indices. */
const DISK_EVENT_AT = Math.max(2, Math.floor(TICKS * 0.2));
const DISK_RECOVERS_AT = DISK_EVENT_AT + 3;
const LARK_DROP_AT = Math.max(3, Math.floor(TICKS * 0.45));
const DRIFT_AT = Math.max(4, Math.floor(TICKS * 0.75));
const KILL_AT = Math.max(5, Math.floor(TICKS * 0.6));

// ---------------------------------------------------------------------------
// a Lark WebSocket that can be dropped on command
// ---------------------------------------------------------------------------

class ScriptableWs {
  private hooks: WsTransportOptions | null = null;
  opens = 0;
  drops = 0;

  factory: WsFactory = (options) => {
    this.hooks = options;
    this.opens += 1;
    return {
      start: async () => {
        // Signal readiness on a later turn, as a real handshake would.
        await Promise.resolve();
        options.onReady();
        options.onHeartbeat();
      },
      stop: async () => {},
    };
  };

  /** Fail the live connection: the client's reconnect ladder must take over. */
  drop(): void {
    this.drops += 1;
    this.hooks?.onError(new Error('soak: simulated socket drop'));
  }
}

// ---------------------------------------------------------------------------
// run
// ---------------------------------------------------------------------------

interface Sample {
  rssBytes: number;
  cpuPercent: number;
  lagMs: number;
  tier: string;
  sweep: number;
  conservative: boolean;
  drift: boolean;
}

const samples: Sample[] = [];
const notes: string[] = [];
const invariantFailures: string[] = [];

function invariant(ok: boolean, message: string): void {
  if (!ok) invariantFailures.push(message);
}

function human(bytes: number): string {
  return `${(bytes / 1024 / 1024).toFixed(1)} MiB`;
}

async function eventLoopLag(): Promise<number> {
  const start = performance.now();
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
  return performance.now() - start;
}

const dir = tempDir('flop-soak-');
const transport = new FakeTransport();
const ws = new ScriptableWs();

const ENV: Record<string, string> = {
  NODE_ENV: 'test',
  TIMEZONE: 'Asia/Shanghai',
  LOG_LEVEL: 'error',
  DATA_DIR: join(dir, 'data'),
  SECRETS_DIR: join(dir, 'secrets'),
  CONTEST_JSON_PATH: REFERENCE_CONTEST_PATH,
  FLOP_MODE: 'dry-run',
  FLOP_ALLOW_REGISTRATION: 'true',
  TICK_SECONDS: String(SWEEP_SECONDS),
  LARK_MODE: 'websocket',
  LARK_APP_ID: 'soak-app',
  LARK_APP_SECRET: 'soak-secret',
  LARK_CHAT_ID: 'soak-chat',
  LARK_REPORT_TIMES: '08:50,18:10',
  LARK_RECONNECT_MIN_MS: '1',
  LARK_RECONNECT_MAX_MS: '5',
  HEALTH_PORT: '0',
  // The model edge is the same fake transport, which answers 404 — a call that
  // fails is exactly the case the budget must absorb.
  DEEPSEEK_API_KEY: 'soak-fake-key',
  DEEPSEEK_MIN_INTERVAL_MS: '0',
};

process.stdout.write(
  `\nsoak-test  ${AGENTS} agents, ${TICKS} sweeps of ${SWEEP_SECONDS}s ` +
    `(${((TICKS * SWEEP_SECONDS) / 3600).toFixed(1)} simulated hours)\n` +
    `  events: disk @${DISK_EVENT_AT}, lark drop @${LARK_DROP_AT}, ` +
    `kill -9 @${KILL_AT}, package drift @${DRIFT_AT}\n\n`,
);

let harness: Harness = await buildHarness({
  agentCount: AGENTS,
  dir,
  transport,
  wsFactory: ws.factory,
  env: ENV,
});

const startedAt = Date.now();
const cpuAtStart = process.cpuUsage();
let peakRss = 0;
let restarts = 0;
let driftObserved = false;
let postedAfterDrift = 0;
let dryRunBeforeDrift = 0;
let runsDuringReadonly = 0;
let reportsDelivered = 0;

const cpuPercentSince = (since: NodeJS.CpuUsage, sinceMs: number): number => {
  const usage = process.cpuUsage(since);
  return Number((((usage.user + usage.system) / 1000 / (Date.now() - sinceMs)) * 100).toFixed(1));
};

/**
 * The referee's reference series: a slow drift with a periodic spike.
 *
 * The spike matters. Every group's entry rule needs a reason to act, and the
 * contrarian profile in particular needs a single sweep to have overreacted by
 * more than its `moveThreshold`. A smooth series exercises the reader and the
 * guards but never the trade path, which would quietly make half of this run
 * vacuous.
 */
function referenceFor(sweep: number): string {
  const base = 200 + (sweep % 7) * 0.3;
  return (sweep % 11 === 0 ? base * 1.025 : base).toFixed(2);
}

/**
 * Which DIDs this sweep's flow announces.
 *
 * A `did:key` is 56 characters, so a single room message caps out at about 69 of
 * them — 150 mints simply do not fit in one flow, and `signRoomMessage` refuses
 * the message outright. The referee therefore announces mints in batches, and
 * this rotates through the whole set 60 at a time. That is realistic, and it is
 * also a useful exercise: most sweeps leave part of the roster unminted, so the
 * `mint_unknown` path is exercised rather than assumed.
 */
const FLOW_CHUNK = 60;
const allDids = harness.runtime.keyStore.agentIds.map((id) => harness.runtime.keyStore.did(id));

function mintsFor(sweep: number): string[] {
  const take = Math.min(FLOW_CHUNK, allDids.length);
  const start = ((sweep - 1) * take) % allDids.length;
  return Array.from({ length: take }, (_, offset) => allDids[(start + offset) % allDids.length]!);
}

await harness.runtime.lark.start();

for (let tick = 0; tick < TICKS; tick += 1) {
  const sweep = tick + 1;
  harness.advance(SWEEP_SECONDS * 1000);

  // The referee's own posts for this sweep: one price, one flow.
  if (tick === 0) harness.referee.seedPost(PACKAGE_HASH);
  harness.referee.price(sweep, referenceFor(sweep));
  harness.referee.flow(sweep, mintsFor(sweep));

  if (tick === DISK_EVENT_AT) {
    harness.setDiskUsedPercent(93);
    notes.push(`tick ${tick}: disk at 93% — critical`);
  }
  if (tick === DISK_RECOVERS_AT) {
    harness.setDiskUsedPercent(12);
    notes.push(`tick ${tick}: disk at 12% — recovered`);
  }
  if (tick === LARK_DROP_AT) {
    ws.drop();
    // And one send failure, so the outbox requeue path is exercised too.
    harness.lark.failNext = 1;
    notes.push(`tick ${tick}: Lark socket dropped and one send forced to fail`);
  }
  if (tick === DRIFT_AT) {
    harness.referee.seedPost(DRIFTED_HASH);
    notes.push(`tick ${tick}: referee seed quotes a different package hash — drift`);
  }

  const lag = await eventLoopLag();
  const report = await harness.runtime.scheduler.runTick();

  if (report.tier === 'readonly') runsDuringReadonly += 1;
  if (!driftObserved) {
    dryRunBeforeDrift += report.trades.dryRun;
  } else {
    postedAfterDrift += report.trades.posted;
  }
  if (report.upstream.drift) driftObserved = true;
  reportsDelivered = harness.lark.sent.length;

  const memory = process.memoryUsage();
  peakRss = Math.max(peakRss, memory.rss);
  samples.push({
    rssBytes: memory.rss,
    cpuPercent: cpuPercentSince(cpuAtStart, startedAt),
    lagMs: Number(lag.toFixed(2)),
    tier: report.tier,
    sweep,
    conservative: report.conservative,
    drift: report.upstream.drift,
  });

  // ---- hard kill, then a restart over the same database and the same rooms ----
  if (tick === KILL_AT) {
    await harness.runtime.lark.stop();
    try {
      // No checkpoint, no graceful stop: as close to SIGKILL as a test can get.
      harness.runtime.db.close();
    } catch {
      /* the second process opens it regardless */
    }
    harness = await buildHarness({
      agentCount: AGENTS,
      dir,
      transport,
      wsFactory: ws.factory,
      env: ENV,
      now: () => new Date(Date.parse('2026-09-28T12:00:00.000Z') + (tick + 1) * SWEEP_SECONDS * 1000),
    });
    await harness.runtime.lark.start();
    restarts += 1;
    notes.push(`tick ${tick}: killed and restarted from the same directory`);
  }
}

const elapsedMs = Date.now() - startedAt;
const averageRss = samples.reduce((total, sample) => total + sample.rssBytes, 0) / samples.length;
const maxLag = Math.max(...samples.map((sample) => sample.lagMs));
const wallPeakCpu = Math.max(...samples.map((sample) => sample.cpuPercent));

const cpuUsage = process.cpuUsage(cpuAtStart);
const cpuSeconds = (cpuUsage.user + cpuUsage.system) / 1e6;
const simulatedSeconds = TICKS * SWEEP_SECONDS;
/**
 * The number a 2 vCPU VPS is actually billed for.
 *
 * The accelerated run never idles, so its wall-clock CPU share is ~100% by
 * construction and means nothing. What does mean something is CPU time consumed
 * divided by the wall-clock time the same number of sweeps occupies in the real
 * contest — that is the duty cycle, and it is the figure to compare with the 35%
 * budget.
 */
const impliedCpuPercent = Number(((cpuSeconds / simulatedSeconds) * 100).toFixed(3));
const cpuMsPerSweep = Number(((cpuSeconds * 1000) / TICKS).toFixed(2));

// ---------------------------------------------------------------------------
// invariants
// ---------------------------------------------------------------------------

const runtime = harness.runtime;
const db = runtime.db;
const repositories = runtime.repositories;

const participation = repositories.participation.count();
const readback = repositories.participation.countWithReadback();
const statuses = repositories.participation.countByStatus();

const duplicateTrades = (
  db.prepare('SELECT COUNT(*) AS n FROM (SELECT id FROM trades GROUP BY id HAVING COUNT(*) > 1)').get() as {
    n: number;
  }
).n;
const duplicateReports = (
  db
    .prepare('SELECT COUNT(*) AS n FROM (SELECT report_id FROM lark_outbox GROUP BY report_id HAVING COUNT(*) > 1)')
    .get() as { n: number }
).n;

const cursorGaps = repositories.roomCursors.totalGaps();
const stale = runtime.scheduler.status().agents.staleCount;
const cursorRows = repositories.roomCursors.all();

const llm = (
  db
    .prepare(
      `SELECT SUM(CASE WHEN status IN ('ok','failed','timeout','invalid') THEN 1 ELSE 0 END) AS attempted,
              SUM(CASE WHEN status IN ('ok','failed','timeout','invalid') AND window_ok = 0 THEN 1 ELSE 0 END) AS offWindow,
              SUM(CASE WHEN status IN ('ok','failed','timeout','invalid') AND retry_of IS NULL THEN 1 ELSE 0 END) AS normal,
              SUM(CASE WHEN retry_of IS NOT NULL THEN 1 ELSE 0 END) AS retries,
              SUM(total_tokens) AS tokens
         FROM llm_calls`,
    )
    .get() as { attempted: number; offWindow: number; normal: number; retries: number; tokens: number }
) ?? { attempted: 0, offWindow: 0, normal: 0, retries: 0, tokens: 0 };

const perDay = db
  .prepare(
    `SELECT day,
            SUM(CASE WHEN status IN ('ok','failed','timeout','invalid') THEN 1 ELSE 0 END) AS total,
            SUM(CASE WHEN status IN ('ok','failed','timeout','invalid') AND retry_of IS NULL THEN 1 ELSE 0 END) AS normal
       FROM llm_calls GROUP BY day`,
  )
  .all() as Array<{ day: string; total: number; normal: number }>;

const integrity = db.pragma('integrity_check', { simple: true }) as string;
const journalMode = db.pragma('journal_mode', { simple: true }) as string;

invariant(participation === AGENTS, `participation records: ${participation}, expected ${AGENTS}`);
invariant(readback === AGENTS, `readback evidence: ${readback}, expected ${AGENTS}`);
invariant((statuses.failed ?? 0) === 0, `${statuses.failed ?? 0} participation rows are failed`);
invariant(duplicateTrades === 0, `${duplicateTrades} duplicate trade id(s)`);
invariant(duplicateReports === 0, `${duplicateReports} duplicate Lark report id(s)`);
invariant(cursorGaps === 0, `${cursorGaps} lost cursor sequence(s)`);
invariant(stale === 0, `${stale} agent(s) fell outside the rolling window`);
invariant(llm.offWindow === 0, `${llm.offWindow} model call(s) inside a blocked window`);
invariant(integrity === 'ok', `sqlite integrity_check returned ${integrity}`);
invariant(journalMode === 'wal', `journal_mode is ${journalMode}`);
invariant(postedAfterDrift === 0, `${postedAfterDrift} trade(s) posted after the package drift`);
invariant(
  dryRunBeforeDrift > 0,
  'no trade was ever built: the run never exercised the strategy -> gate -> signing path',
);
for (const row of perDay) {
  invariant(row.total <= 3, `${row.day}: ${row.total} model calls exceeded the hard limit`);
  invariant(row.normal <= 2, `${row.day}: ${row.normal} normal model calls exceeded the budget`);
}

// The run spans a report window, so the reports it should have produced are
// exactly the ones at 08:50 and 18:10 Shanghai that the clock passed.
const simulatedHours = simulatedSeconds / 3600;
const expectedReports = simulatedHours >= 22.2 ? 2 : simulatedHours >= 12.9 ? 1 : 0;
invariant(
  reportsDelivered >= expectedReports,
  `${reportsDelivered} Lark report(s) delivered; ${expectedReports} window(s) were crossed`,
);

const evidence = repositories.participation.all().filter((row) => row.readback_at === null).length;
invariant(evidence === 0, `${evidence} participation row(s) have no readback timestamp`);

// ---------------------------------------------------------------------------
// report
// ---------------------------------------------------------------------------

const larkStatus = runtime.lark.websocket.status;
const wsStatus = { state: larkStatus.state, attempts: larkStatus.attempts, connections: larkStatus.connections };

const lines: string[] = [];
lines.push('');
lines.push(`soak-test result — ${((TICKS * SWEEP_SECONDS) / 3600).toFixed(1)} simulated hours in ${(elapsedMs / 1000).toFixed(1)}s`);
lines.push('');
lines.push(`  agents                 ${AGENTS}`);
lines.push(`  sweeps                 ${TICKS}`);
lines.push(`  restarts (kill -9)     ${restarts}`);
lines.push(`  lark ws opens/drops    ${ws.opens}/${ws.drops} (state ${wsStatus.state}, attempts ${wsStatus.attempts}, connections ${wsStatus.connections})`);
lines.push(`  lark reports delivered ${reportsDelivered}`);
lines.push(`  trades (dry-run)       ${repositories.trades.countByStatus().dry_run ?? 0} dry-run before drift, ${postedAfterDrift} posted after`);
lines.push(`  participation          ${participation} rows, ${readback} with readback, statuses ${JSON.stringify(statuses)}`);
lines.push(`  room cursors           ${cursorRows.length} rooms, ${cursorGaps} lost sequences`);
lines.push(`  model calls            ${llm.attempted} attempted (${llm.normal} normal, ${llm.retries} retry, ${llm.offWindow} off-window), ${llm.tokens} tokens`);
lines.push('');
lines.push(`  rss average            ${human(averageRss)}  (target < 600 MiB)`);
lines.push(`  rss peak               ${human(peakRss)}  (target < 1.2 GiB)`);
lines.push(
  `  cpu duty cycle         ${impliedCpuPercent}%  of one core at the real 5-minute cadence ` +
    `(target < 35%; ${cpuMsPerSweep} ms of CPU per sweep)`,
);
lines.push(`  cpu wall share (accel) ${wallPeakCpu.toFixed(1)}%  — meaningless: this run never idles`);
lines.push(`  event loop lag max     ${maxLag.toFixed(1)}ms  (target < 100ms)`);
lines.push(`  sqlite                 ${integrity}, ${journalMode}`);
lines.push('');
lines.push(`  readonly ticks         ${runsDuringReadonly}`);
lines.push(`  drift observed         ${driftObserved}`);
lines.push('');
lines.push('  events');
for (const note of notes) lines.push(`    ${note}`);

lines.push('');
if (invariantFailures.length === 0) {
  lines.push('  PASS: every invariant held');
} else {
  lines.push(`  FAIL: ${invariantFailures.length} invariant(s) broke`);
  for (const failure of invariantFailures) lines.push(`    - ${failure}`);
}
lines.push('');

process.stdout.write(lines.join('\n'));

if (OUT !== undefined && OUT !== 'true') {
  writeFileSync(
    OUT,
    `${JSON.stringify(
      {
        agents: AGENTS,
        ticks: TICKS,
        sweepSeconds: SWEEP_SECONDS,
        elapsedMs,
        restarts,
        reportsDelivered,
        wsOpens: ws.opens,
        wsDrops: ws.drops,
        larkWebsocket: wsStatus,
        participation: { total: participation, readback, statuses },
        cursors: { rooms: cursorRows.length, gaps: cursorGaps },
        model: llm,
        perDay,
        rss: { averageBytes: Math.round(averageRss), peakBytes: peakRss },
        cpu: {
          dutyCyclePercent: impliedCpuPercent,
          msPerSweep: cpuMsPerSweep,
          acceleratedWallSharePercent: wallPeakCpu,
        },
        eventLoopLagMs: { max: maxLag },
        dryRunBeforeDrift,
        expectedReports,
        driftObserved,
        postedAfterDrift,
        readonlyTicks: runsDuringReadonly,
        invariantFailures,
        notes,
      },
      null,
      2,
    )}\n`,
  );
  process.stdout.write(`  wrote ${OUT}\n\n`);
}

await harness.dispose();
cleanup(dir);

if (invariantFailures.length > 0) process.exitCode = 1;
