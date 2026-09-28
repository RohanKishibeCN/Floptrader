/**
 * Structured logging, and the durable event trail.
 *
 * Two destinations on purpose:
 *   - pino to stdout, for the operator and PM2's log files;
 *   - the `events` table for anything an auditor will want after a restart, which
 *     is also what the Lark report and `verify-all` read back.
 *
 * Secrets never reach either. The redaction list is applied by pino, and
 * `logEvent` refuses to write a payload that looks like key material.
 */
import { pino, type Logger as PinoLogger } from 'pino';
import type { Repositories } from '@flop/storage';

export type LogLevel = 'trace' | 'debug' | 'info' | 'warn' | 'error' | 'fatal';

const REDACT_PATHS = [
  'seed',
  '*.seed',
  'seeds',
  'privateKey',
  '*.privateKey',
  'apiKey',
  '*.apiKey',
  'appSecret',
  '*.appSecret',
  'AGE_IDENTITY_FILE',
  'DEEPSEEK_API_KEY',
  'LARK_APP_SECRET',
  'authorization',
  'req.headers.authorization',
];

/** Anything matching these is refused by `logEvent`. */
const SECRET_PATTERNS = [
  /AGE-SECRET-KEY-/,
  /"seed"\s*:\s*"[A-Za-z0-9+/=]{40,}"/,
  /DEEPSEEK_API_KEY\s*[:=]\s*\S+/,
  /LARK_APP_SECRET\s*[:=]\s*\S+/,
];

export interface LoggerOptions {
  level: LogLevel;
  name?: string;
  /** When set, structured events are also persisted for audit. */
  repositories?: Repositories;
  /** Test hook: capture lines instead of writing them. */
  destination?: NodeJS.WritableStream;
}

export interface EventRecord {
  level: LogLevel;
  source: string;
  code: string;
  message: string;
  data?: Record<string, unknown>;
}

export class Logger {
  private readonly pino: PinoLogger;
  private readonly repositories?: Repositories;

  private constructor(pinoInstance: PinoLogger, repositories?: Repositories) {
    this.pino = pinoInstance;
    this.repositories = repositories;
  }

  static create(options: LoggerOptions): Logger {
    const instance = pino(
      {
        level: options.level,
        name: options.name ?? 'flop-close-call',
        redact: { paths: REDACT_PATHS, censor: '[redacted]' },
        base: undefined,
        timestamp: pino.stdTimeFunctions.isoTime,
      },
      options.destination,
    );
    return new Logger(instance, options.repositories);
  }

  /** A logger carrying extra bindings, sharing the same destinations. */
  child(bindings: Record<string, unknown>): Logger {
    return new Logger(this.pino.child(bindings), this.repositories);
  }

  trace(data: Record<string, unknown>, message: string): void {
    this.pino.trace(data, message);
  }

  debug(data: Record<string, unknown>, message: string): void {
    this.pino.debug(data, message);
  }

  info(data: Record<string, unknown>, message: string): void {
    this.pino.info(data, message);
  }

  warn(data: Record<string, unknown>, message: string): void {
    this.pino.warn(data, message);
  }

  error(data: Record<string, unknown>, message: string): void {
    this.pino.error(data, message);
  }

  fatal(data: Record<string, unknown>, message: string): void {
    this.pino.fatal(data, message);
  }

  /**
   * Log and persist an event. `code` is the stable identifier dashboards and the
   * retention policy key off; the message is for humans.
   */
  event(record: EventRecord): void {
    const payload = record.data ?? {};
    if (record.level === 'error' || record.level === 'fatal') {
      this.pino.error(payload, `[${record.code}] ${record.message}`);
    } else if (record.level === 'warn') {
      this.pino.warn(payload, `[${record.code}] ${record.message}`);
    } else if (record.level === 'debug') {
      this.pino.debug(payload, `[${record.code}] ${record.message}`);
    } else {
      this.pino.info(payload, `[${record.code}] ${record.message}`);
    }
    this.persist(record);
  }

  /** Persist without logging, for events already surfaced elsewhere. */
  persist(record: EventRecord): void {
    if (!this.repositories) return;
    const serialized = JSON.stringify(record.data ?? {});
    for (const pattern of SECRET_PATTERNS) {
      if (pattern.test(serialized)) {
        this.pino.error(
          { code: record.code, pattern: String(pattern) },
          'refusing to persist an event whose payload matches a secret pattern',
        );
        return;
      }
    }
    this.repositories.events.insert({
      at: new Date().toISOString(),
      level: record.level,
      source: record.source,
      code: record.code,
      message: record.message,
      data: serialized === '{}' ? null : serialized,
    });
  }
}

export function createLogger(options: LoggerOptions): Logger {
  return Logger.create(options);
}

/** A logger that discards everything, for tests that do not care. */
export function silentLogger(): Logger {
  return Logger.create({ level: 'fatal' });
}
