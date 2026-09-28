/**
 * Configuration: every knob comes from the environment, is validated once at
 * startup, and is then frozen.
 *
 * Two rules the whole program depends on:
 *   - the default is dry-run. Live trading requires BOTH `FLOP_MODE=live` and
 *     `FLOP_LIVE_CONFIRM=close-1`; a single env var cannot arm it by accident.
 *   - nothing that throttles the process has an unbounded default. This runs on a
 *     2 vCPU / 4 GB VPS shared with other tenants.
 */
import { z } from 'zod';

const boolish = z
  .union([z.boolean(), z.string()])
  .transform((value) => {
    if (typeof value === 'boolean') return value;
    return ['1', 'true', 'yes', 'on'].includes(value.trim().toLowerCase());
  });

const intString = (fallback: number) =>
  z
    .union([z.number(), z.string()])
    .default(fallback)
    .transform((value, ctx) => {
      const parsed = typeof value === 'number' ? value : Number.parseInt(value, 10);
      if (!Number.isFinite(parsed)) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: `not an integer: ${String(value)}` });
        return fallback;
      }
      return parsed;
    });

export const EnvSchema = z.object({
  // ---- process -------------------------------------------------------------
  NODE_ENV: z.string().default('production'),
  TIMEZONE: z.string().default('Asia/Shanghai'),
  LOG_LEVEL: z.enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal']).default('info'),
  DATA_DIR: z.string().default('data'),
  SECRETS_DIR: z.string().default('secrets'),
  RELEASES_DIR: z.string().default('releases'),

  // ---- mode ---------------------------------------------------------------
  /** dry-run by default. "live" is the only value that trades for real. */
  FLOP_MODE: z.enum(['dry-run', 'live']).default('dry-run'),
  /** Must equal the contest id for live trading to arm. */
  FLOP_LIVE_CONFIRM: z.string().default(''),
  /** Explicit gate for posting owner registrations to technocore. */
  FLOP_ALLOW_REGISTRATION: boolish.default(false),

  // ---- close call ---------------------------------------------------------
  SEASON: z.literal('close-1').default('close-1'),
  TRADING_ROOM: z.string().default('close1'),
  CONTEST_JSON_PATH: z.string().default('reference/contest.json'),

  // ---- age identity -------------------------------------------------------
  AGE_IDENTITY_FILE: z.string().default(''),
  AGE_RECIPIENT_VPS: z.string().default(''),
  AGE_RECIPIENT_ADMIN: z.string().default(''),

  // ---- technocore ---------------------------------------------------------
  TECHNO_CORE_BASE_URL: z.string().default('https://technocore.chat'),
  READ_CONCURRENCY: intString(2),
  READ_WAIT_SECONDS: intString(10),
  WRITE_RATE_PER_MINUTE: intString(180),
  WRITER_CONCURRENCY: intString(1),
  REQUEST_TIMEOUT_MS: intString(15_000),
  READ_MAX_RETRIES: intString(3),
  WRITE_MAX_RETRIES: intString(4),
  /** Hard cap on requests in flight; the reader must not spawn a poll per room. */
  MAX_INFLIGHT: intString(6),

  // ---- deepseek -----------------------------------------------------------
  DEEPSEEK_BASE_URL: z.string().default('https://api.deepseek.com'),
  DEEPSEEK_API_KEY: z.string().default(''),
  DEEPSEEK_MODEL: z.string().default('deepseek-chat'),
  DEEPSEEK_MAX_NORMAL_CALLS_PER_DAY: intString(2),
  DEEPSEEK_MAX_RETRIES_PER_DAY: intString(1),
  DEEPSEEK_HARD_LIMIT_PER_DAY: intString(3),
  DEEPSEEK_MAX_CONCURRENCY: intString(1),
  DEEPSEEK_MIN_INTERVAL_MS: intString(1500),
  DEEPSEEK_TIMEOUT_MS: intString(20_000),
  DEEPSEEK_MAX_INPUT_TOKENS: intString(900),
  DEEPSEEK_MAX_OUTPUT_TOKENS: intString(160),

  // ---- lark ---------------------------------------------------------------
  LARK_MODE: z.enum(['websocket', 'off']).default('websocket'),
  LARK_TIMEZONE: z.string().default('Asia/Shanghai'),
  LARK_APP_ID: z.string().default(''),
  LARK_APP_SECRET: z.string().default(''),
  LARK_BOT_ID: z.string().default(''),
  LARK_CHAT_ID: z.string().default(''),
  LARK_REPORT_TIMES: z.string().default('08:50,18:10'),
  LARK_RECONNECT_MIN_MS: intString(1_000),
  LARK_RECONNECT_MAX_MS: intString(60_000),
  LARK_HEARTBEAT_TIMEOUT_MS: intString(30_000),

  // ---- concurrency --------------------------------------------------------
  LLM_CONCURRENCY: intString(1),
  LARK_WS_CONNECTIONS: intString(1),
  ARCHIVE_WORKERS: intString(1),

  // ---- scheduling ---------------------------------------------------------
  /** How often the scheduler evaluates a group of agents. */
  TICK_SECONDS: intString(60),
  /** Agents evaluated per tick, per group; keeps a tick bounded on 2 vCPU. */
  AGENTS_PER_TICK: intString(10),
  /** Rolling run window: 7 * 24 h. */
  RUN_WINDOW_HOURS: intString(168),
  WEEKLY_WATCHDOG_CRON_HOURS: intString(6),

  // ---- upstream monitor --------------------------------------------------
  UPSTREAM_CHECK_MINUTES: intString(12),
  UPSTREAM_REPO: z.string().default('flop-labs/technocore-close-call-challenge'),
  UPSTREAM_BRANCH: z.string().default('main'),
  UPSTREAM_GITHUB_TOKEN: z.string().default(''),

  // ---- health -------------------------------------------------------------
  HEALTH_PORT: intString(8_780),
  HEALTH_HOST: z.string().default('127.0.0.1'),

  // ---- load guard ---------------------------------------------------------
  RSS_PAUSE_PERCENT: intString(70),
  RSS_SHED_PERCENT: intString(85),
  EVENT_LOOP_LAG_MS: intString(250),
  EVENT_LOOP_LAG_SECONDS: intString(60),
  DISK_COMPRESS_PERCENT: intString(75),
  DISK_SHED_PERCENT: intString(85),
  DISK_CRITICAL_PERCENT: intString(90),
  DISK_READONLY_PERCENT: intString(95),
  WRITER_QUEUE_SHED: intString(100),
  LLM_QUEUE_SHED: intString(5),
});

export type RawEnv = z.infer<typeof EnvSchema>;

export interface Config {
  nodeEnv: string;
  timezone: string;
  logLevel: RawEnv['LOG_LEVEL'];
  dataDir: string;
  secretsDir: string;
  releasesDir: string;
  mode: 'dry-run' | 'live';
  liveArmed: boolean;
  allowRegistration: boolean;
  season: 'close-1';
  tradingRoom: string;
  contestJsonPath: string;
  ageIdentityFile: string;
  ageRecipients: string[];
  technoCore: {
    baseUrl: string;
    readConcurrency: number;
    readWaitSeconds: number;
    writeRatePerMinute: number;
    writerConcurrency: number;
    requestTimeoutMs: number;
    readMaxRetries: number;
    writeMaxRetries: number;
    maxInflight: number;
  };
  deepseek: {
    baseUrl: string;
    apiKey: string;
    model: string;
    maxNormalCallsPerDay: number;
    maxRetriesPerDay: number;
    hardLimitPerDay: number;
    maxConcurrency: number;
    minIntervalMs: number;
    timeoutMs: number;
    maxInputTokens: number;
    maxOutputTokens: number;
  };
  lark: {
    mode: 'websocket' | 'off';
    timezone: string;
    appId: string;
    appSecret: string;
    botId: string;
    chatId: string;
    reportTimes: string[];
    reconnectMinMs: number;
    reconnectMaxMs: number;
    heartbeatTimeoutMs: number;
    configured: boolean;
  };
  concurrency: { llm: number; larkWs: number; archiveWorkers: number };
  scheduling: {
    tickSeconds: number;
    agentsPerTick: number;
    runWindowHours: number;
    weeklyWatchdogHours: number;
  };
  upstream: {
    checkMinutes: number;
    repo: string;
    branch: string;
    githubToken: string;
  };
  health: { port: number; host: string };
  loadGuard: {
    rssPausePercent: number;
    rssShedPercent: number;
    eventLoopLagMs: number;
    eventLoopLagSeconds: number;
    diskCompressPercent: number;
    diskShedPercent: number;
    diskCriticalPercent: number;
    diskReadonlyPercent: number;
    writerQueueShed: number;
    llmQueueShed: number;
  };
  /** Absolute paths the orchestrator owns. */
  paths: {
    data: string;
    identities: string;
    public: string;
    participation: string;
    backups: string;
    archive: string;
    database: string;
    secrets: string;
    bundle: string;
  };
}

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigError';
  }
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = EnvSchema.safeParse(env);
  if (!parsed.success) {
    const detail = parsed.error.issues
      .map((issue) => `${issue.path.join('.') || '<root>'}: ${issue.message}`)
      .join('; ');
    throw new ConfigError(`invalid environment configuration: ${detail}`);
  }
  const raw = parsed.data;

  const liveArmed = raw.FLOP_MODE === 'live' && raw.FLOP_LIVE_CONFIRM === raw.SEASON;
  if (raw.FLOP_MODE === 'live' && !liveArmed) {
    throw new ConfigError(
      `FLOP_MODE=live requires FLOP_LIVE_CONFIRM=${raw.SEASON} — refusing to start armed-looking but unconfirmed`,
    );
  }
  if (raw.DEEPSEEK_MAX_NORMAL_CALLS_PER_DAY > raw.DEEPSEEK_HARD_LIMIT_PER_DAY) {
    throw new ConfigError('DEEPSEEK_MAX_NORMAL_CALLS_PER_DAY cannot exceed the hard limit');
  }
  if (raw.RSS_PAUSE_PERCENT >= raw.RSS_SHED_PERCENT) {
    throw new ConfigError('RSS_PAUSE_PERCENT must be below RSS_SHED_PERCENT');
  }
  if (
    raw.DISK_COMPRESS_PERCENT >= raw.DISK_SHED_PERCENT ||
    raw.DISK_SHED_PERCENT >= raw.DISK_CRITICAL_PERCENT ||
    raw.DISK_CRITICAL_PERCENT >= raw.DISK_READONLY_PERCENT
  ) {
    throw new ConfigError('disk thresholds must increase: compress < shed < critical < readonly');
  }

  const reportTimes = raw.LARK_REPORT_TIMES.split(',')
    .map((value) => value.trim())
    .filter((value) => value.length > 0);
  for (const time of reportTimes) {
    if (!/^([01][0-9]|2[0-3]):[0-5][0-9]$/.test(time)) {
      throw new ConfigError(`LARK_REPORT_TIMES entry is not HH:MM: ${time}`);
    }
  }
  if (reportTimes.length !== 2) {
    throw new ConfigError('LARK_REPORT_TIMES must list exactly two times, e.g. 08:50,18:10');
  }

  const ageRecipients = [raw.AGE_RECIPIENT_VPS, raw.AGE_RECIPIENT_ADMIN].filter(
    (value) => value.trim().length > 0,
  );

  const dataDir = raw.DATA_DIR.replace(/\/+$/, '');
  return {
    nodeEnv: raw.NODE_ENV,
    timezone: raw.TIMEZONE,
    logLevel: raw.LOG_LEVEL,
    dataDir,
    secretsDir: raw.SECRETS_DIR,
    releasesDir: raw.RELEASES_DIR,
    mode: raw.FLOP_MODE,
    liveArmed,
    allowRegistration: raw.FLOP_ALLOW_REGISTRATION,
    season: raw.SEASON,
    tradingRoom: raw.TRADING_ROOM,
    contestJsonPath: raw.CONTEST_JSON_PATH,
    ageIdentityFile: raw.AGE_IDENTITY_FILE,
    ageRecipients,
    technoCore: {
      baseUrl: raw.TECHNO_CORE_BASE_URL.replace(/\/+$/, ''),
      readConcurrency: raw.READ_CONCURRENCY,
      readWaitSeconds: Math.min(10, Math.max(0, raw.READ_WAIT_SECONDS)),
      writeRatePerMinute: raw.WRITE_RATE_PER_MINUTE,
      writerConcurrency: raw.WRITER_CONCURRENCY,
      requestTimeoutMs: raw.REQUEST_TIMEOUT_MS,
      readMaxRetries: raw.READ_MAX_RETRIES,
      writeMaxRetries: raw.WRITE_MAX_RETRIES,
      maxInflight: Math.max(1, raw.MAX_INFLIGHT),
    },
    deepseek: {
      baseUrl: raw.DEEPSEEK_BASE_URL.replace(/\/+$/, ''),
      apiKey: raw.DEEPSEEK_API_KEY,
      model: raw.DEEPSEEK_MODEL,
      maxNormalCallsPerDay: raw.DEEPSEEK_MAX_NORMAL_CALLS_PER_DAY,
      maxRetriesPerDay: raw.DEEPSEEK_MAX_RETRIES_PER_DAY,
      hardLimitPerDay: raw.DEEPSEEK_HARD_LIMIT_PER_DAY,
      maxConcurrency: raw.DEEPSEEK_MAX_CONCURRENCY,
      minIntervalMs: raw.DEEPSEEK_MIN_INTERVAL_MS,
      timeoutMs: raw.DEEPSEEK_TIMEOUT_MS,
      maxInputTokens: raw.DEEPSEEK_MAX_INPUT_TOKENS,
      maxOutputTokens: raw.DEEPSEEK_MAX_OUTPUT_TOKENS,
    },
    lark: {
      mode: raw.LARK_MODE,
      timezone: raw.LARK_TIMEZONE,
      appId: raw.LARK_APP_ID,
      appSecret: raw.LARK_APP_SECRET,
      botId: raw.LARK_BOT_ID,
      chatId: raw.LARK_CHAT_ID,
      reportTimes,
      reconnectMinMs: raw.LARK_RECONNECT_MIN_MS,
      reconnectMaxMs: raw.LARK_RECONNECT_MAX_MS,
      heartbeatTimeoutMs: raw.LARK_HEARTBEAT_TIMEOUT_MS,
      configured: raw.LARK_APP_ID.length > 0 && raw.LARK_APP_SECRET.length > 0 && raw.LARK_CHAT_ID.length > 0,
    },
    concurrency: {
      llm: raw.LLM_CONCURRENCY,
      larkWs: raw.LARK_WS_CONNECTIONS,
      archiveWorkers: raw.ARCHIVE_WORKERS,
    },
    scheduling: {
      tickSeconds: raw.TICK_SECONDS,
      agentsPerTick: raw.AGENTS_PER_TICK,
      runWindowHours: raw.RUN_WINDOW_HOURS,
      weeklyWatchdogHours: raw.WEEKLY_WATCHDOG_CRON_HOURS,
    },
    upstream: {
      checkMinutes: raw.UPSTREAM_CHECK_MINUTES,
      repo: raw.UPSTREAM_REPO,
      branch: raw.UPSTREAM_BRANCH,
      githubToken: raw.UPSTREAM_GITHUB_TOKEN,
    },
    health: { port: raw.HEALTH_PORT, host: raw.HEALTH_HOST },
    loadGuard: {
      rssPausePercent: raw.RSS_PAUSE_PERCENT,
      rssShedPercent: raw.RSS_SHED_PERCENT,
      eventLoopLagMs: raw.EVENT_LOOP_LAG_MS,
      eventLoopLagSeconds: raw.EVENT_LOOP_LAG_SECONDS,
      diskCompressPercent: raw.DISK_COMPRESS_PERCENT,
      diskShedPercent: raw.DISK_SHED_PERCENT,
      diskCriticalPercent: raw.DISK_CRITICAL_PERCENT,
      diskReadonlyPercent: raw.DISK_READONLY_PERCENT,
      writerQueueShed: raw.WRITER_QUEUE_SHED,
      llmQueueShed: raw.LLM_QUEUE_SHED,
    },
    paths: {
      data: dataDir,
      identities: `${dataDir}/identities`,
      public: `${dataDir}/public`,
      participation: `${dataDir}/participation`,
      backups: `${dataDir}/backups`,
      archive: `${dataDir}/archive`,
      database: `${dataDir}/app.db`,
      secrets: raw.SECRETS_DIR,
      bundle: `${raw.SECRETS_DIR}/agents.bundle.age`,
    },
  };
}

/** The allow/deny windows for model calls, in the configured timezone. */
export const DEEPSEEK_BLOCKED_WINDOWS: Array<{ from: string; to: string }> = [
  { from: '09:00', to: '12:00' },
  { from: '14:00', to: '18:00' },
];
export const DEEPSEEK_ALLOWED_WINDOWS: Array<{ from: string; to: string }> = [
  { from: '00:00', to: '09:00' },
  { from: '12:00', to: '14:00' },
  { from: '18:00', to: '24:00' },
];
export const DEEPSEEK_DEFAULT_CALL_TIMES = ['06:30', '20:30'];
