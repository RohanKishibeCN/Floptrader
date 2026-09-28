/**
 * Lark integration: one inbound WebSocket, the Open API for outbound reports, a
 * durable outbox, and the daily report scheduler.
 *
 * The two transports are deliberately separate. The WebSocket long connection is
 * for *receiving* events from Lark (at most one connection, with our own backoff).
 * Posting a report goes through the Open API, because the long connection is
 * inbound only. The outbox is the durability boundary: a report is written to
 * SQLite before any network call, so a crash mid-send requeues instead of losing
 * the report, and the UNIQUE `report_id` is the duplicate guard.
 *
 * Secrets never reach the log: the app secret is only ever handed to the SDK and
 * is never included in an event payload.
 */
import * as LarkSdk from '@larksuiteoapi/node-sdk';
import type { Repositories } from '@flop/storage';
import type { Config } from './config.js';
import type { Logger } from './logger.js';

// ---------------------------------------------------------------------------
// shared helpers
// ---------------------------------------------------------------------------

function toMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === 'string') return error;
  return String(error);
}

/** A WebSocket transport the client drives; either the SDK or a test fake. */
export interface WsLike {
  start(): Promise<void>;
  stop(): Promise<void>;
}

/** Callbacks a transport uses to report connection lifecycle back to the client. */
export interface LarkTransportHooks {
  onReady(): void;
  onError(error: unknown): void;
  onHeartbeat(): void;
}

/** What a transport factory receives; the fake in tests reads the hooks. */
export interface WsTransportOptions {
  appId: string;
  appSecret: string;
  botId: string;
  onReady(): void;
  onError(error: unknown): void;
  onHeartbeat(): void;
}

export type WsFactory = (options: WsTransportOptions) => WsLike;

/** Nominal (pre-jitter) exponential backoff for a 0-based attempt index. */
export function nominalBackoffMs(attemptIndex: number, minMs: number, maxMs: number): number {
  const exponent = Math.max(0, attemptIndex);
  return Math.min(minMs * 2 ** exponent, maxMs);
}

/**
 * Nominal backoff plus ±20% jitter. The jitter only spreads out reconnects from a
 * fleet; the nominal value is what is capped at `maxMs`.
 */
export function backoffDelayMs(
  attemptIndex: number,
  minMs: number,
  maxMs: number,
  random: () => number = Math.random,
): number {
  const nominal = nominalBackoffMs(attemptIndex, minMs, maxMs);
  const jitter = 1 + (random() * 2 - 1) * 0.2;
  return Math.max(0, nominal * jitter);
}

// ---------------------------------------------------------------------------
// LarkWebSocketClient
// ---------------------------------------------------------------------------

export type LarkConnectionState = 'stopped' | 'connecting' | 'connected' | 'reconnecting' | 'failed';

export interface LarkWebSocketStatus {
  connected: boolean;
  state: LarkConnectionState;
  attempts: number;
  lastConnectedAt: string | null;
  lastErrorAt: string | null;
  lastError: string | null;
  sinceLastHeartbeatMs: number | null;
  /** True once no heartbeat has arrived for longer than `heartbeatTimeoutMs`. */
  heartbeatStale: boolean;
  /** Always 0 or 1; the client refuses to hold more than one connection. */
  connections: number;
}

export interface LarkWebSocketClientOptions {
  appId: string;
  appSecret: string;
  botId: string;
  reconnectMinMs: number;
  reconnectMaxMs: number;
  heartbeatTimeoutMs: number;
  logger: Logger;
  eventHandlers?: Record<string, (data: unknown) => void | Promise<void>>;
  /** Test seam: when absent the SDK's `WSClient` is used. */
  wsFactory?: WsFactory;
}

export class LarkWebSocketClient {
  private readonly options: LarkWebSocketClientOptions;
  private readonly logger: Logger;
  private readonly random: () => number;

  private transport: WsLike | null = null;
  private state: LarkConnectionState = 'stopped';
  private stopped = true;
  private attemptCount = 0;
  private consecutiveFailures = 0;
  private openConnections = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;

  private lastConnectedAt: string | null = null;
  private lastErrorAt: string | null = null;
  private lastError: string | null = null;
  private lastHeartbeatAtMs: number | null = null;

  constructor(options: LarkWebSocketClientOptions) {
    this.options = options;
    this.logger = options.logger;
    this.random = Math.random;
  }

  async start(): Promise<void> {
    this.stopped = false;
    if (
      this.transport !== null ||
      this.reconnectTimer !== null ||
      this.state === 'connecting' ||
      this.state === 'connected'
    ) {
      // A start while a connection already exists must not open a second one.
      return;
    }
    await this.openConnection();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    const transport = this.transport;
    this.transport = null;
    this.openConnections = 0;
    this.state = 'stopped';
    if (transport) {
      try {
        await transport.stop();
      } catch (error) {
        this.logger.event({
          level: 'warn',
          source: 'lark',
          code: 'lark_ws_stop_failed',
          message: 'Lark WebSocket transport stop failed',
          data: { error: toMessage(error) },
        });
      }
    }
  }

  get status(): LarkWebSocketStatus {
    const sinceLastHeartbeatMs =
      this.lastHeartbeatAtMs === null ? null : Math.max(0, Date.now() - this.lastHeartbeatAtMs);
    return {
      connected: this.state === 'connected',
      state: this.state,
      attempts: this.attemptCount,
      lastConnectedAt: this.lastConnectedAt,
      lastErrorAt: this.lastErrorAt,
      lastError: this.lastError,
      sinceLastHeartbeatMs,
      heartbeatStale:
        sinceLastHeartbeatMs !== null && sinceLastHeartbeatMs > this.options.heartbeatTimeoutMs,
      connections: this.openConnections,
    };
  }

  private async openConnection(): Promise<void> {
    if (this.stopped) return;
    if (this.transport !== null) return;
    // Hard invariant: a single long connection, never two.
    if (this.openConnections >= 1) {
      throw new Error('lark websocket already holds an open connection');
    }
    this.state = this.attemptCount === 0 ? 'connecting' : 'reconnecting';
    this.attemptCount += 1;
    this.openConnections = 1;

    const hooks: LarkTransportHooks = {
      onReady: () => this.handleReady(),
      onError: (error) => this.handleTransportError(error),
      onHeartbeat: () => {
        this.lastHeartbeatAtMs = Date.now();
      },
    };

    let transport: WsLike;
    try {
      transport = this.options.wsFactory
        ? this.options.wsFactory(this.transportOptions(hooks))
        : this.buildSdkTransport(hooks);
    } catch (error) {
      this.openConnections = 0;
      this.handleTransportError(error);
      return;
    }
    this.transport = transport;

    try {
      await transport.start();
      if (this.stopped) {
        this.transport = null;
        this.openConnections = 0;
        await this.safeStop(transport);
        return;
      }
      // A transport that resolves without signalling readiness is still usable.
      if (this.state === 'connecting' || this.state === 'reconnecting') {
        this.handleReady();
      }
    } catch (error) {
      this.handleTransportError(error);
    }
  }

  private transportOptions(hooks: LarkTransportHooks): WsTransportOptions {
    return {
      appId: this.options.appId,
      appSecret: this.options.appSecret,
      botId: this.options.botId,
      ...hooks,
    };
  }

  private handleReady(): void {
    this.openConnections = 1;
    this.state = 'connected';
    this.consecutiveFailures = 0;
    this.lastConnectedAt = new Date().toISOString();
    this.logger.event({
      level: 'info',
      source: 'lark',
      code: 'lark_ws_connected',
      message: 'Lark WebSocket connected',
      data: { attempts: this.attemptCount },
    });
  }

  private handleTransportError(error: unknown): void {
    this.lastError = toMessage(error);
    this.lastErrorAt = new Date().toISOString();
    this.consecutiveFailures += 1;
    this.openConnections = 0;
    this.transport = null;
    this.logger.event({
      level: 'warn',
      source: 'lark',
      code: 'lark_ws_error',
      message: 'Lark WebSocket error',
      data: { attempts: this.attemptCount, error: this.lastError },
    });
    if (this.stopped) {
      this.state = 'stopped';
      return;
    }
    this.scheduleReconnect();
  }

  private scheduleReconnect(): void {
    if (this.stopped || this.reconnectTimer !== null) return;
    const delayMs = backoffDelayMs(
      this.consecutiveFailures - 1,
      this.options.reconnectMinMs,
      this.options.reconnectMaxMs,
      this.random,
    );
    this.state = 'reconnecting';
    this.logger.event({
      level: 'warn',
      source: 'lark',
      code: 'lark_ws_reconnect_scheduled',
      message: 'scheduled a Lark WebSocket reconnect',
      data: { delayMs: Math.round(delayMs), failures: this.consecutiveFailures },
    });
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (this.stopped) return;
      void this.openConnection();
    }, delayMs);
  }

  private async safeStop(transport: WsLike): Promise<void> {
    try {
      await transport.stop();
    } catch {
      /* stopping is best-effort */
    }
  }

  private buildSdkTransport(hooks: LarkTransportHooks): WsLike {
    const sdk = LarkSdk as unknown as SdkModule;
    if (typeof sdk.WSClient !== 'function') {
      throw new Error('@larksuiteoapi/node-sdk does not export WSClient');
    }
    if (typeof sdk.EventDispatcher !== 'function') {
      throw new Error('@larksuiteoapi/node-sdk does not export EventDispatcher');
    }
    const dispatcher = new sdk.EventDispatcher({ loggerLevel: sdk.LoggerLevel?.info });
    if (this.options.eventHandlers) {
      dispatcher.register(this.options.eventHandlers as Record<string, unknown>);
    }
    const wsClient = new sdk.WSClient({
      appId: this.options.appId,
      appSecret: this.options.appSecret,
      autoReconnect: false, // the client owns the backoff and reconnect policy
    });
    return {
      start: async () => {
        await wsClient.start({ eventDispatcher: dispatcher });
        hooks.onReady();
      },
      stop: async () => {
        // 1.48.0 exposes no public close(); terminate the socket best-effort.
        const internal = wsClient as unknown as {
          pingInterval?: ReturnType<typeof setTimeout>;
          wsConfig?: { getWSInstance?: () => { terminate?: () => void } | null };
        };
        if (internal.pingInterval !== undefined) clearTimeout(internal.pingInterval);
        internal.wsConfig?.getWSInstance?.()?.terminate?.();
      },
    };
  }
}

// ---------------------------------------------------------------------------
// LarkOpenApiNotifier
// ---------------------------------------------------------------------------

export interface LarkSendResult {
  ok: boolean;
  messageId?: string;
  error?: string;
}

export interface LarkSendClient {
  send(chatId: string, text: string): Promise<LarkSendResult>;
}

export interface LarkOpenApiNotifierOptions {
  appId: string;
  appSecret: string;
  chatId: string;
  logger: Logger;
  /** Test seam: when absent the SDK's `Client` is used. */
  clientFactory?: (options: { appId: string; appSecret: string; logger: Logger }) => LarkSendClient;
}

export class LarkOpenApiNotifier {
  private readonly options: LarkOpenApiNotifierOptions;
  private readonly logger: Logger;
  private client: LarkSendClient | null = null;

  constructor(options: LarkOpenApiNotifierOptions) {
    this.options = options;
    this.logger = options.logger;
  }

  /**
   * Send a plain-text report through the Open API.
   *
   * This is deliberately NOT the WebSocket: the long connection is inbound only
   * (it receives events), while sending a report is an outbound HTTP call. The
   * notifier retries nothing itself — the outbox owns retries — and it only
   * throws on programmer error, returning `{ok:false,error}` on transport failure.
   */
  async sendText(text: string): Promise<LarkSendResult> {
    try {
      const client = this.resolveClient();
      const result = await client.send(this.options.chatId, text);
      if (result.ok) {
        this.logger.event({
          level: 'info',
          source: 'lark',
          code: 'lark_report_sent',
          message: 'report sent to Lark',
          data: { messageId: result.messageId ?? null },
        });
      } else {
        this.logger.event({
          level: 'warn',
          source: 'lark',
          code: 'lark_report_send_failed',
          message: 'report send failed',
          data: { error: result.error ?? 'unknown error' },
        });
      }
      return result;
    } catch (error) {
      const message = toMessage(error);
      this.logger.event({
        level: 'error',
        source: 'lark',
        code: 'lark_report_send_error',
        message: 'report send threw',
        data: { error: message },
      });
      return { ok: false, error: message };
    }
  }

  private resolveClient(): LarkSendClient {
    if (this.client) return this.client;
    const factory =
      this.options.clientFactory ??
      ((options: { appId: string; appSecret: string; logger: Logger }) =>
        defaultSendClient(options));
    this.client = factory({
      appId: this.options.appId,
      appSecret: this.options.appSecret,
      logger: this.logger,
    });
    return this.client;
  }
}

function defaultSendClient(options: {
  appId: string;
  appSecret: string;
  logger: Logger;
}): LarkSendClient {
  const sdk = LarkSdk as unknown as SdkModule;
  if (typeof sdk.Client !== 'function') {
    throw new Error('@larksuiteoapi/node-sdk does not export Client');
  }
  const client = new sdk.Client({ appId: options.appId, appSecret: options.appSecret });
  return {
    async send(chatId: string, text: string): Promise<LarkSendResult> {
      const response = await client.im.v1.message.create({
        data: {
          receive_id: chatId,
          msg_type: 'text',
          content: JSON.stringify({ text }),
        },
        params: { receive_id_type: 'chat_id' },
      });
      if (response.code !== undefined && response.code !== 0) {
        return { ok: false, error: response.msg ?? `lark error code ${response.code}` };
      }
      return response.data?.message_id !== undefined
        ? { ok: true, messageId: response.data.message_id }
        : { ok: true };
    },
  };
}

// ---------------------------------------------------------------------------
// LarkOutbox
// ---------------------------------------------------------------------------

export interface LarkTextSender {
  sendText(text: string): Promise<LarkSendResult>;
}

export interface LarkOutboxOptions {
  repositories: Repositories;
  notifier: LarkTextSender;
  logger: Logger;
  maxAttempts?: number;
}

export class LarkOutbox {
  private readonly repositories: Repositories;
  private readonly notifier: LarkTextSender;
  private readonly logger: Logger;
  private readonly maxAttempts: number;

  constructor(options: LarkOutboxOptions) {
    this.repositories = options.repositories;
    this.notifier = options.notifier;
    this.logger = options.logger;
    this.maxAttempts = options.maxAttempts ?? 12;
  }

  /** Returns false when `reportId` was already enqueued (the UNIQUE guard). */
  enqueue(reportId: string, kind: string, text: string): boolean {
    return this.repositories.larkOutbox.enqueue({ report_id: reportId, kind, payload: text });
  }

  /**
   * Deliver up to `limit` pending rows. Never throws: a failure is recorded on the
   * row and the loop continues, so one bad report cannot stall the others.
   */
  async flush(limit = 10): Promise<{ sent: number; failed: number }> {
    let sent = 0;
    let failed = 0;
    let rows;
    try {
      rows = this.repositories.larkOutbox.pending(limit);
    } catch (error) {
      this.logger.event({
        level: 'error',
        source: 'lark',
        code: 'lark_outbox_read_failed',
        message: 'could not read pending Lark reports',
        data: { error: toMessage(error) },
      });
      return { sent, failed };
    }

    for (const row of rows) {
      const id = row.id;
      if (id === undefined) continue;
      // A row already sent must never be sent again.
      if (row.status === 'sent') continue;
      // markSending only claims pending/failed rows; another flush may have taken it.
      if (!this.repositories.larkOutbox.markSending(id)) continue;
      try {
        const result = await this.notifier.sendText(row.payload);
        if (result.ok) {
          this.repositories.larkOutbox.markSent(id);
          sent += 1;
        } else {
          this.repositories.larkOutbox.markFailed(id, result.error ?? 'unknown error');
          failed += 1;
        }
      } catch (error) {
        this.repositories.larkOutbox.markFailed(id, toMessage(error));
        failed += 1;
      }
    }
    return { sent, failed };
  }

  /** Requeue rows left mid-flight by a crash. Returns the number requeued. */
  recover(): number {
    return this.repositories.larkOutbox.requeueStale(this.maxAttempts);
  }

  counts(): Record<string, number> {
    return this.repositories.larkOutbox.countByStatus();
  }
}

// ---------------------------------------------------------------------------
// LarkReportScheduler
// ---------------------------------------------------------------------------

export interface LarkReportSection {
  heading: string;
  lines: string[];
}

export interface LarkReportContent {
  reportId: string;
  title: string;
  summary: string;
  sections: LarkReportSection[];
  critical?: string[];
}

export interface LarkReportSchedulerOptions {
  config: Config;
  logger: Logger;
  outbox: LarkOutbox;
  buildReport: () => Promise<LarkReportContent>;
  now?: () => Date;
  /** How long after a configured time it is still considered due. Default 10. */
  windowMinutes?: number;
}

/** Appended verbatim when a report had to be shortened for a Lark text message. */
export const REPORT_TRUNCATION_NOTE = '⚠ 内容过长，已截断最长章节的中间部分';

const REPORT_MAX_LENGTH = 4000;
const DID_PATTERN = /did:key:z6Mk[1-9A-HJ-NP-Za-km-z]{44}/g;

/** A line holding a raw wall of DIDs is useless in a report; collapse it. */
function summarizeDids(line: string): string {
  const matches = line.match(DID_PATTERN);
  if (!matches || matches.length <= 3) return line;
  let seen = 0;
  return line
    .replace(DID_PATTERN, () => (seen++ === 0 ? `<did×${matches.length}>` : ''))
    .replace(/[ \t]{2,}/g, ' ')
    .trimEnd();
}

function parseHHMM(time: string): number | null {
  const match = /^([01][0-9]|2[0-3]):([0-5][0-9])$/.exec(time);
  if (!match) return null;
  return Number.parseInt(match[1]!, 10) * 60 + Number.parseInt(match[2]!, 10);
}

export class LarkReportScheduler {
  private readonly config: Config;
  private readonly logger: Logger;
  private readonly outbox: LarkOutbox;
  private readonly buildReport: () => Promise<LarkReportContent>;
  private readonly clock: () => Date;
  private readonly windowMinutes: number;
  /** Local date (YYYYMMDD) -> report times already handled today. */
  private readonly delivered = new Map<string, Set<string>>();

  constructor(options: LarkReportSchedulerOptions) {
    this.config = options.config;
    this.logger = options.logger;
    this.outbox = options.outbox;
    this.buildReport = options.buildReport;
    this.clock = options.now ?? (() => new Date());
    this.windowMinutes = options.windowMinutes ?? 10;
  }

  /**
   * The daily report is generated purely from local SQLite and system metrics; it
   * never calls DeepSeek. Rendering is a plain-text Lark message.
   */
  render(content: LarkReportContent): string {
    const header = [summarizeDids(content.title), summarizeDids(content.summary)];
    const blocks = content.sections.map((section) => this.renderSection(section));
    const critical = content.critical ?? [];
    const criticalBlock =
      critical.length > 0 ? ['⚠ 严重', ...critical.map((item) => `- ${summarizeDids(item)}`)] : [];
    const assemble = (sectionBlocks: string[]): string =>
      [...header, ...sectionBlocks, ...criticalBlock].join('\n');

    const text = assemble(blocks);
    if (text.length < REPORT_MAX_LENGTH) return text;

    // Truncate the middle of the longest section and note it at the very end.
    const target = REPORT_MAX_LENGTH - 1;
    if (blocks.length === 0) {
      return `${text.slice(0, target - REPORT_TRUNCATION_NOTE.length - 2)}…\n${REPORT_TRUNCATION_NOTE}`;
    }
    let longestIndex = 0;
    for (let index = 1; index < blocks.length; index += 1) {
      if (blocks[index]!.length > blocks[longestIndex]!.length) longestIndex = index;
    }
    const longest = blocks[longestIndex]!;
    const othersLength = text.length - longest.length;
    const keep = Math.max(0, target - othersLength - REPORT_TRUNCATION_NOTE.length - 2);
    const headLength = Math.min(longest.length, Math.ceil(keep / 2));
    const tailLength = Math.max(0, keep - headLength);
    const truncated = `${longest.slice(0, headLength)}…${longest.slice(longest.length - tailLength)}`;
    const rebuilt = assemble(blocks.map((block, index) => (index === longestIndex ? truncated : block)));
    let result = `${rebuilt}\n${REPORT_TRUNCATION_NOTE}`;
    if (result.length >= REPORT_MAX_LENGTH) {
      result = `${result.slice(0, target - REPORT_TRUNCATION_NOTE.length - 2)}…\n${REPORT_TRUNCATION_NOTE}`;
    }
    return result;
  }

  /**
   * Which configured report times are due at `at`. A time is due when the local
   * HH:MM matches it, or when it is within `windowMinutes` after it, and it has
   * not already been delivered today. Local wall-clock values come from
   * `Intl.DateTimeFormat` so the process timezone is irrelevant.
   */
  dueReports(at: Date): string[] {
    const { date, minutes } = this.localParts(at);
    const deliveredToday = this.delivered.get(date) ?? new Set<string>();
    const due: string[] = [];
    for (const time of this.config.lark.reportTimes) {
      if (deliveredToday.has(time)) continue;
      const target = parseHHMM(time);
      if (target === null) continue;
      const inWindow = minutes === target || (minutes > target && minutes <= target + this.windowMinutes);
      if (inWindow) due.push(time);
    }
    return due;
  }

  /**
   * Deliver every report due at `at`. Idempotent: a report id is `close-1-<local
   * date>-<HHMM>`, so calling twice for the same minute enqueues exactly once.
   */
  async runOnce(at: Date = this.clock()): Promise<{ delivered: string[]; skipped: string[] }> {
    const { date } = this.localParts(at);
    const due = this.dueReports(at);
    const delivered: string[] = [];
    const skipped: string[] = [];

    for (const time of due) {
      const reportId = `close-1-${date}-${time.replace(':', '')}`;
      let enqueued: boolean;
      try {
        const built = await this.buildReport();
        const content: LarkReportContent = { ...built, reportId };
        enqueued = this.outbox.enqueue(content.reportId, 'daily_report', this.render(content));
      } catch (error) {
        // Leave the time unmarked so the next window retries it.
        this.logger.event({
          level: 'error',
          source: 'lark',
          code: 'lark_report_build_failed',
          message: 'could not build the Lark report',
          data: { reportId, error: toMessage(error) },
        });
        continue;
      }
      this.markDelivered(date, time);
      if (enqueued) delivered.push(reportId);
      else skipped.push(reportId);
    }

    if (due.length > 0) {
      try {
        await this.outbox.flush();
      } catch (error) {
        this.logger.event({
          level: 'error',
          source: 'lark',
          code: 'lark_outbox_flush_failed',
          message: 'could not flush the Lark outbox',
          data: { error: toMessage(error) },
        });
      }
    }
    return { delivered, skipped };
  }

  private renderSection(section: LarkReportSection): string {
    const lines = [`【${section.heading}】`, ...section.lines.map((line) => `- ${summarizeDids(line)}`)];
    return lines.join('\n');
  }

  private markDelivered(date: string, time: string): void {
    const set = this.delivered.get(date) ?? new Set<string>();
    set.add(time);
    this.delivered.set(date, set);
  }

  private localParts(at: Date): { date: string; minutes: number } {
    const formatter = new Intl.DateTimeFormat('en-US', {
      timeZone: this.config.lark.timezone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    });
    const parts = formatter.formatToParts(at);
    const value = (type: string): string =>
      parts.find((part) => part.type === type)?.value ?? '00';
    const hourRaw = value('hour');
    const hour = hourRaw === '24' ? '00' : hourRaw;
    const date = `${value('year')}${value('month')}${value('day')}`;
    const minutes = Number.parseInt(hour, 10) * 60 + Number.parseInt(value('minute'), 10);
    return { date, minutes };
  }
}

// ---------------------------------------------------------------------------
// createLarkStack
// ---------------------------------------------------------------------------

export interface CreateLarkStackOptions {
  config: Config;
  logger: Logger;
  repositories: Repositories;
  buildReport: () => Promise<LarkReportContent>;
  /** Test seam for a fake WebSocket transport. */
  transport?: WsFactory;
  /** Test seam for a fake Open API message sender. */
  notifierClientFactory?: LarkOpenApiNotifierOptions['clientFactory'];
}

export interface LarkStack {
  websocket: LarkWebSocketClient;
  notifier: LarkOpenApiNotifier;
  outbox: LarkOutbox;
  scheduler: LarkReportScheduler;
  start(): Promise<void>;
  stop(): Promise<void>;
}

export function createLarkStack(options: CreateLarkStackOptions): LarkStack {
  const { config, logger, repositories, buildReport, transport, notifierClientFactory } = options;

  const websocket = new LarkWebSocketClient({
    appId: config.lark.appId,
    appSecret: config.lark.appSecret,
    botId: config.lark.botId,
    reconnectMinMs: config.lark.reconnectMinMs,
    reconnectMaxMs: config.lark.reconnectMaxMs,
    heartbeatTimeoutMs: config.lark.heartbeatTimeoutMs,
    logger,
    ...(transport ? { wsFactory: transport } : {}),
  });
  const notifier = new LarkOpenApiNotifier({
    appId: config.lark.appId,
    appSecret: config.lark.appSecret,
    chatId: config.lark.chatId,
    logger,
    ...(notifierClientFactory ? { clientFactory: notifierClientFactory } : {}),
  });
  const outbox = new LarkOutbox({ repositories, notifier, logger });
  const scheduler = new LarkReportScheduler({ config, logger, outbox, buildReport });

  return {
    websocket,
    notifier,
    outbox,
    scheduler,
    async start(): Promise<void> {
      if (config.lark.mode === 'off' || !config.lark.configured) {
        // No credentials: do not open a socket, but the scheduler still builds
        // and enqueues reports, so nothing is lost while Lark is unconfigured.
        logger.event({
          level: 'info',
          source: 'lark',
          code: 'lark_not_configured',
          message: 'Lark WebSocket not started; reports are still generated and queued',
          data: { mode: config.lark.mode, configured: config.lark.configured },
        });
        return;
      }
      await websocket.start();
    },
    async stop(): Promise<void> {
      await websocket.stop();
    },
  };
}

// ---------------------------------------------------------------------------
// SDK shape (checked defensively because the package is CommonJS)
// ---------------------------------------------------------------------------

interface SdkMessagePayload {
  data: { receive_id: string; msg_type: string; content: string };
  params: { receive_id_type: 'chat_id' };
}

interface SdkMessageResponse {
  code?: number;
  msg?: string;
  data?: { message_id?: string };
}

interface SdkOpenApiClient {
  im: {
    v1: {
      message: {
        create(payload: SdkMessagePayload): Promise<SdkMessageResponse>;
      };
    };
  };
}

interface SdkEventDispatcher {
  register(handlers: Record<string, unknown>): unknown;
}

interface SdkWebSocketClient {
  start(params: { eventDispatcher: unknown }): Promise<void>;
}

interface SdkModule {
  WSClient?: new (params: Record<string, unknown>) => SdkWebSocketClient;
  EventDispatcher?: new (params: Record<string, unknown>) => SdkEventDispatcher;
  Client?: new (params: Record<string, unknown>) => SdkOpenApiClient;
  LoggerLevel?: Record<string, number>;
}
