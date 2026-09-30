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
import { Decimal } from '@flop/close-call';
import { AGENTS_PER_GROUP, DEFAULT_AGENT_COUNT, STRATEGY_GROUPS } from '@flop/identity';

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
  /**
   * Explicit gate for signing and posting trades, separate from registration.
   *
   * Live registration and live trading are different commitments: the first
   * makes the 150 owners real, the second risks collateral. Keeping them apart
   * lets an operator run `live + registration` until all 150 readbacks are in,
   * and only then arm trading.
   */
  FLOP_ALLOW_TRADING: boolish.default(false),

  // ---- close call ---------------------------------------------------------
  SEASON: z.literal('close-1').default('close-1'),
  TRADING_ROOM: z.string().default('close1'),
  CONTEST_JSON_PATH: z.string().default('reference/contest.json'),
  /** The vendored official package; the source of the package-hash pin. */
  REFERENCE_DIR: z.string().default('reference'),
  /**
   * The package hash the launch record pins, when it is known ahead of the
   * checkout. Empty means "use the vendored manifest's own sha256".
   */
  EXPECTED_PACKAGE_HASH: z.string().default(''),
  /** The referee's DID, fixed before the first message is read. */
  EXPECTED_REFEREE_DID: z.string().default(''),
  /**
   * Refuse to infer the referee from whoever posts first. On by default: the
   * permissive behaviour exists for dry-run experiments against a throwaway
   * room, not for a contest.
   */
  REQUIRE_REFEREE_PIN: boolish.default(true),
  /** The fleet the season is defined as: 150 agents, five groups of thirty. */
  EXPECTED_AGENT_COUNT: intString(150),
  REQUIRE_FULL_FLEET: boolish.default(true),

  // ---- age identity -------------------------------------------------------
  AGE_IDENTITY_FILE: z.string().default(''),
  AGE_RECIPIENT_VPS: z.string().default(''),
  AGE_RECIPIENT_ADMIN: z.string().default(''),
  /**
   * The offline admin key's public half, so the VPS can verify an inventory
   * signature without ever holding the private key. See `AdminPublicKey`.
   */
  ADMIN_PUBLIC_KEY: z.string().default(''),

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
  /**
   * How long a connected socket may go without a pong before the health report
   * calls the heartbeat stale.
   *
   * The server owns the ping interval (it is reported in the pong payload), so
   * this is a generous "the connection has gone quiet" alarm rather than a
   * precise timer: five minutes sits comfortably above the interval the SDK's own
   * configuration uses. It never forces a reconnect — a close does that.
   */
  LARK_HEARTBEAT_TIMEOUT_MS: intString(300_000),

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

  // ---- stale reference ----------------------------------------------------
  /**
   * How old `age_s` may get before the official reference counts as stale.
   *
   * The reference is never rewritten when it goes stale — the referee still
   * enforces it — so crossing this only stops us from *adding* risk.
   */
  MAX_REFERENCE_AGE_SECONDS: intString(60),
  STALE_REFERENCE_MODE: z.enum(['off', 'no_new_active_trade']).default('no_new_active_trade'),

  // ---- external offers ----------------------------------------------------
  /** The largest quantity we will ever countersign on a stranger's offer. */
  MAX_EXTERNAL_OFFER_QTY: z.string().default('15'),
  /** The largest notional (qty * px) we will ever countersign. */
  MAX_EXTERNAL_OFFER_NOTIONAL: z.string().default('4500'),
  /**
   * Margin kept on top of the *worst-case* fee on an external offer.
   *
   * The close is unknown when we countersign, so the fee we will actually pay is
   * only bounded, not known. Reserving a little more than that bound is what
   * keeps a settled trade from being voided for `funds`.
   */
  MAX_CLAWBACK_BUFFER: z.string().default('50'),

  // ---- rooms --------------------------------------------------------------
  /** Cap on dynamically discovered owner rooms; beyond this, alert and stop. */
  MAX_DISCOVERED_ROOMS: intString(10),
  /**
   * How many dynamic owner rooms are read at once.
   *
   * Deliberately separate from `READ_CONCURRENCY`, and deliberately low: the
   * fixed referee set must never queue behind a discovered room, so the dynamic
   * reader gets its own, smaller budget.
   */
  DYNAMIC_ROOM_READ_CONCURRENCY: intString(1),

  // ---- challenge sweep archive -------------------------------------------
  /** The published sweep-record archive; an audit source, never an authority. */
  CHALLENGE_ARCHIVE_BASE_URL: z.string().default('https://challenges.technocore.chat/close-1'),
  ARCHIVE_CHECK_INTERVAL_MINUTES: intString(15),
  /**
   * The archive has published well over a thousand sweeps. A check is a *bounded*
   * batch, never a full backfill: at most this many records, at most this many
   * bytes, and at most this many requests per minute.
   */
  ARCHIVE_MAX_RECORDS_PER_CHECK: intString(10),
  ARCHIVE_MAX_BYTES_PER_CHECK: intString(100_000_000),
  ARCHIVE_MAX_REQUESTS_PER_MINUTE: intString(10),
  /** Which end of the backlog a backfill pass takes next. */
  ARCHIVE_BACKFILL_MODE: z.enum(['oldest_first', 'newest_first']).default('oldest_first'),

  // ---- optional dependencies (off unless asked for) ------------------------
  /**
   * Takes other owners' open offers in discovered rooms.
   *
   * Off by default: the dynamic room reader has not completed a real staging
   * validation, so the process must not claim coverage of the registered rooms
   * nor accept offers found in them. Turning it on is an operator decision made
   * once dynamic-room staging, cursor recovery, unlisted handling and repost
   * readback have all passed.
   */
  EXTERNAL_OFFER_TAKER_ENABLED: boolish.default(false),
  /**
   * Whether the language model may review strategy parameters at all.
   *
   * Off by default: every strategy has a deterministic fallback, and the trade
   * path never waits on a model. The budget, windows and validators stay in place
   * for when it is switched on.
   */
  DEEPSEEK_ENABLED: boolish.default(false),

  // ---- staging acceptance -------------------------------------------------
  /**
   * Opt-in switch for the real-network staging smoke test.
   *
   * Defaults to false, and nothing in the runtime reads it: live trading is not
   * claimed to be safe until a real Technocore staging run has been completed by
   * a human, and this switch is how that run is requested.
   */
  STAGING_SMOKE_TEST: boolish.default(false),

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
  allowTrading: boolean;
  /** Live *and* explicitly allowed to trade. The only flag the trade path reads. */
  tradingArmed: boolean;
  season: 'close-1';
  tradingRoom: string;
  contestJsonPath: string;
  referenceDir: string;
  /** The package hash the process must be launched against, or null if unset. */
  expectedPackageHash: string | null;
  /** The referee DID fixed before the first message, or null if unset. */
  expectedRefereeDid: string | null;
  requireRefereePin: boolean;
  expectedAgentCount: number;
  requireFullFleet: boolean;
  adminPublicKey: string | null;
  ageIdentityFile: string;
  ageRecipients: string[];
  /** The VPS runtime key's recipient, when configured. */
  ageRecipientVps: string;
  /** The offline admin key's recipient, when configured. */
  ageRecipientAdmin: string;
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
    /** Whether any model call may happen. Off by default. */
    enabled: boolean;
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
  /** Risk knobs that are not part of the frozen contest rules. */
  risk: {
    maxReferenceAgeSeconds: number;
    staleReferenceMode: 'off' | 'no_new_active_trade';
    externalOffer: { maxQty: Decimal; maxNotional: Decimal; clawbackBuffer: Decimal };
  };
  roomDiscovery: { maxRooms: number; dynamicReadConcurrency: number };
  /**
   * Whether the external-offer taker may act on offers found in discovered rooms.
   *
   * While it is false the process neither claims coverage of the registered rooms
   * nor accepts offers from them; the report says `room_scope=close1_only`.
   */
  externalOfferTakerEnabled: boolean;
  archive: {
    baseUrl: string;
    checkIntervalMinutes: number;
    /** Per-check ceiling on downloaded records: a bounded batch, never a backfill. */
    maxRecordsPerCheck: number;
    /** Per-check ceiling on downloaded bytes. */
    maxBytesPerCheck: number;
    /** Ceiling on archive requests per minute, enforced between request starts. */
    maxRequestsPerMinute: number;
    /** Which end of the backlog a backfill pass takes. */
    backfillMode: 'oldest_first' | 'newest_first';
  };
  /** Opt-in flag for the real-network staging smoke test; never read at runtime. */
  stagingSmokeTest: boolean;
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

/** The only DID shape this build accepts for a pinned identity. */
export const DID_KEY_PATTERN = /^did:key:z6Mk[1-9A-HJ-NP-Za-km-z]{44}$/;
const SHA256_HEX = /^[0-9a-f]{64}$/;

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

  // A live process that cannot register is the worst of both worlds: it looks
  // armed, and every one of the 150 agents trades against a balance the referee
  // never minted. The failure would surface as 150 `funds` voids, days later.
  if (liveArmed && !raw.FLOP_ALLOW_REGISTRATION) {
    throw new ConfigError(
      'FLOP_MODE=live requires FLOP_ALLOW_REGISTRATION=true — 150 unregistered agents would trade on mintless accounts',
    );
  }
  // Trading is a second, separate commitment; it can never be armed in dry-run.
  if (raw.FLOP_ALLOW_TRADING && !liveArmed) {
    throw new ConfigError(
      'FLOP_ALLOW_TRADING=true requires FLOP_MODE=live and FLOP_LIVE_CONFIRM=close-1',
    );
  }

  const expectedRefereeDid = raw.EXPECTED_REFEREE_DID.trim();
  if (expectedRefereeDid.length > 0 && !DID_KEY_PATTERN.test(expectedRefereeDid)) {
    throw new ConfigError(`EXPECTED_REFEREE_DID is not a did:key: ${expectedRefereeDid}`);
  }
  // Without a pinned referee DID, the first signed post in a `d-` room decides
  // who the referee is — a stranger can claim it. Live therefore requires the pin.
  if (liveArmed && expectedRefereeDid.length === 0) {
    throw new ConfigError(
      'FLOP_MODE=live requires EXPECTED_REFEREE_DID — the referee must be pinned before the first message is read',
    );
  }
  if (liveArmed && !raw.REQUIRE_REFEREE_PIN) {
    throw new ConfigError('FLOP_MODE=live requires REQUIRE_REFEREE_PIN=true');
  }

  const expectedPackageHash = raw.EXPECTED_PACKAGE_HASH.trim().toLowerCase();
  if (expectedPackageHash.length > 0 && !SHA256_HEX.test(expectedPackageHash)) {
    throw new ConfigError('EXPECTED_PACKAGE_HASH must be a 64-character sha256 hex digest');
  }
  // Live must name the package it is running against. Falling back to this
  // checkout's own manifest hash would let a live process trade under whatever
  // rules happened to be on disk, which is the one thing the pin exists to stop.
  if (liveArmed && expectedPackageHash.length === 0) {
    throw new ConfigError(
      'FLOP_MODE=live requires EXPECTED_PACKAGE_HASH — the exact sha256 of the official ' +
        'reference/manifest.json this process is pinned to; the local manifest is not a substitute',
    );
  }

  if (raw.REQUIRE_FULL_FLEET && raw.EXPECTED_AGENT_COUNT !== DEFAULT_AGENT_COUNT) {
    throw new ConfigError(
      `REQUIRE_FULL_FLEET=true requires EXPECTED_AGENT_COUNT=${DEFAULT_AGENT_COUNT} — the season is ${STRATEGY_GROUPS.length} groups of ${AGENTS_PER_GROUP}`,
    );
  }

  const adminPublicKey = raw.ADMIN_PUBLIC_KEY.trim();
  if (adminPublicKey.length > 0 && !DID_KEY_PATTERN.test(adminPublicKey)) {
    throw new ConfigError(`ADMIN_PUBLIC_KEY is not a did:key: ${adminPublicKey}`);
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

  // The external-offer ceilings are numbers, not strings, by the time the trade
  // path sees them; a typo has to fail at startup rather than at the first offer.
  const decimal = (name: string, value: string): Decimal => {
    try {
      return Decimal.from(value);
    } catch {
      throw new ConfigError(`${name} is not a decimal number: ${value}`);
    }
  };
  const externalOfferMaxQty = decimal('MAX_EXTERNAL_OFFER_QTY', raw.MAX_EXTERNAL_OFFER_QTY);
  const externalOfferMaxNotional = decimal('MAX_EXTERNAL_OFFER_NOTIONAL', raw.MAX_EXTERNAL_OFFER_NOTIONAL);
  const clawbackBuffer = decimal('MAX_CLAWBACK_BUFFER', raw.MAX_CLAWBACK_BUFFER);
  if (!externalOfferMaxQty.isPositive()) {
    throw new ConfigError('MAX_EXTERNAL_OFFER_QTY must be positive');
  }
  if (!externalOfferMaxNotional.isPositive()) {
    throw new ConfigError('MAX_EXTERNAL_OFFER_NOTIONAL must be positive');
  }
  if (clawbackBuffer.isNegative()) {
    throw new ConfigError('MAX_CLAWBACK_BUFFER must not be negative');
  }
  if (raw.MAX_DISCOVERED_ROOMS < 1) {
    throw new ConfigError('MAX_DISCOVERED_ROOMS must be at least 1');
  }

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
    allowTrading: raw.FLOP_ALLOW_TRADING,
    tradingArmed: liveArmed && raw.FLOP_ALLOW_TRADING,
    season: raw.SEASON,
    tradingRoom: raw.TRADING_ROOM,
    contestJsonPath: raw.CONTEST_JSON_PATH,
    referenceDir: raw.REFERENCE_DIR,
    expectedPackageHash: expectedPackageHash.length > 0 ? expectedPackageHash : null,
    expectedRefereeDid: expectedRefereeDid.length > 0 ? expectedRefereeDid : null,
    requireRefereePin: raw.REQUIRE_REFEREE_PIN,
    expectedAgentCount: raw.EXPECTED_AGENT_COUNT,
    requireFullFleet: raw.REQUIRE_FULL_FLEET,
    adminPublicKey: adminPublicKey.length > 0 ? adminPublicKey : null,
    ageIdentityFile: raw.AGE_IDENTITY_FILE,
    ageRecipients,
    ageRecipientVps: raw.AGE_RECIPIENT_VPS.trim(),
    ageRecipientAdmin: raw.AGE_RECIPIENT_ADMIN.trim(),
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
      enabled: raw.DEEPSEEK_ENABLED,
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
    risk: {
      maxReferenceAgeSeconds: raw.MAX_REFERENCE_AGE_SECONDS,
      staleReferenceMode: raw.STALE_REFERENCE_MODE,
      externalOffer: {
        maxQty: externalOfferMaxQty,
        maxNotional: externalOfferMaxNotional,
        clawbackBuffer,
      },
    },
    roomDiscovery: {
      maxRooms: raw.MAX_DISCOVERED_ROOMS,
      dynamicReadConcurrency: Math.max(1, raw.DYNAMIC_ROOM_READ_CONCURRENCY),
    },
    externalOfferTakerEnabled: raw.EXTERNAL_OFFER_TAKER_ENABLED,
    archive: {
      baseUrl: raw.CHALLENGE_ARCHIVE_BASE_URL.replace(/\/+$/, ''),
      checkIntervalMinutes: raw.ARCHIVE_CHECK_INTERVAL_MINUTES,
      maxRecordsPerCheck: Math.max(1, raw.ARCHIVE_MAX_RECORDS_PER_CHECK),
      maxBytesPerCheck: Math.max(1, raw.ARCHIVE_MAX_BYTES_PER_CHECK),
      maxRequestsPerMinute: Math.max(1, raw.ARCHIVE_MAX_REQUESTS_PER_MINUTE),
      backfillMode: raw.ARCHIVE_BACKFILL_MODE,
    },
    stagingSmokeTest: raw.STAGING_SMOKE_TEST,
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
