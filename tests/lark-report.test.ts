/**
 * Report rendering and the daily schedule.
 *
 * The report goes to a Lark *text* message, so rendering is the contract: a raw
 * wall of 150 DIDs must be collapsed, and anything long must be cut under 4000
 * characters with a note. Scheduling is wall-clock in the configured timezone and
 * must never double-deliver a time on the same local day.
 */
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  closeDatabase,
  createRepositories,
  openDatabase,
  type Repositories,
  type SqliteDatabase,
} from '@flop/storage';
import { loadConfig } from '../apps/orchestrator/src/config.js';
import {
  LarkOutbox,
  LarkReportScheduler,
  REPORT_TRUNCATION_NOTE,
  type LarkReportContent,
} from '../apps/orchestrator/src/lark.js';
import { Logger } from '../apps/orchestrator/src/logger.js';
import { cleanup, tempDir } from './support/harness.js';

// Asia/Shanghai is UTC+8 with no DST, so local 08:50 == 00:50Z and 18:10 == 10:10Z.
const config = loadConfig({ LARK_TIMEZONE: 'Asia/Shanghai', LARK_REPORT_TIMES: '08:50,18:10' });

let dir: string;
let db: SqliteDatabase;
let repositories: Repositories;
let logger: Logger;

beforeEach(() => {
  dir = tempDir('flop-lark-report-');
  db = openDatabase({ path: join(dir, 'app.db') });
  repositories = createRepositories(db);
  logger = Logger.create({ level: 'fatal', repositories });
});

afterEach(() => {
  closeDatabase(db);
  cleanup(dir);
});

/** A scheduler wired to an outbox whose notifier records what it was asked to send. */
function makeScheduler(build: () => LarkReportContent): {
  scheduler: LarkReportScheduler;
  sent: string[];
} {
  const sent: string[] = [];
  const notifier = {
    async sendText(text: string) {
      sent.push(text);
      return { ok: true, messageId: `m${sent.length}` };
    },
  };
  const outbox = new LarkOutbox({ repositories, notifier, logger });
  const scheduler = new LarkReportScheduler({ config, logger, outbox, buildReport: async () => build() });
  return { scheduler, sent };
}

function content(overrides: Partial<LarkReportContent> = {}): LarkReportContent {
  return {
    reportId: 'unused',
    title: 'Close Call 日报',
    summary: '系统正常',
    sections: [
      { heading: '交易', lines: ['成交 3 笔', '盈亏 +1.20'] },
      { heading: '风控', lines: ['无越界'] },
    ],
    ...overrides,
  };
}

describe('LarkReportScheduler.render', () => {
  it('includes the title, summary, every section heading and every line', () => {
    const { scheduler } = makeScheduler(() => content());
    const text = scheduler.render(content());

    expect(text).toContain('Close Call 日报');
    expect(text).toContain('系统正常');
    expect(text).toContain('【交易】');
    expect(text).toContain('- 成交 3 笔');
    expect(text).toContain('- 盈亏 +1.20');
    expect(text).toContain('【风控】');
    expect(text).toContain('- 无越界');
  });

  it('renders a ⚠ 严重 block only when there are critical items', () => {
    const { scheduler } = makeScheduler(() => content());
    expect(scheduler.render(content())).not.toContain('⚠ 严重');

    const withCritical = scheduler.render(
      content({ critical: ['writer 队列积压', '磁盘 92%'] }),
    );
    expect(withCritical).toContain('⚠ 严重');
    expect(withCritical).toContain('- writer 队列积压');
    expect(withCritical).toContain('- 磁盘 92%');
  });

  it('collapses a wall of 150 DIDs to a single placeholder', () => {
    const { scheduler } = makeScheduler(() => content());
    const did = `did:key:z6Mk${'A'.repeat(44)}`;
    const line = Array.from({ length: 150 }, () => did).join(' ');
    const text = scheduler.render(
      content({ sections: [{ heading: '账号', lines: [line] }] }),
    );

    expect(text).toContain('<did×150>');
    // Not one raw DID may survive: the text message must stay readable.
    expect(text).not.toContain('did:key:z6Mk');
  });

  it('truncates content over 4000 characters and still ends with the note', () => {
    const { scheduler } = makeScheduler(() => content());
    const filler = 'x'.repeat(300);
    const lines = Array.from({ length: 40 }, (_, index) => `条目 ${index} ${filler}`);
    const text = scheduler.render(
      content({ sections: [{ heading: '大章节', lines }] }),
    );

    expect(text.length).toBeLessThan(4000);
    expect(text.endsWith(REPORT_TRUNCATION_NOTE)).toBe(true);
    expect(text.startsWith('Close Call 日报')).toBe(true);
  });
});

describe('LarkReportScheduler.dueReports', () => {
  it('returns 08:50 at exactly 08:50 Asia/Shanghai', () => {
    const { scheduler } = makeScheduler(() => content());
    expect(scheduler.dueReports(new Date('2026-09-28T00:50:00Z'))).toEqual(['08:50']);
  });

  it('returns 18:10 at exactly 18:10 Asia/Shanghai', () => {
    const { scheduler } = makeScheduler(() => content());
    expect(scheduler.dueReports(new Date('2026-09-28T10:10:00Z'))).toEqual(['18:10']);
  });

  it('still considers a time due within the window after it', () => {
    const { scheduler } = makeScheduler(() => content());
    // 08:53 local is three minutes past 08:50, inside the default ten-minute window.
    expect(scheduler.dueReports(new Date('2026-09-28T00:53:00Z'))).toEqual(['08:50']);
  });

  it('does not report a time already delivered earlier the same day', async () => {
    const { scheduler } = makeScheduler(() => content());
    const at = new Date('2026-09-28T00:50:00Z');

    const first = await scheduler.runOnce(at);
    expect(first.delivered).toEqual(['close-1-20260928-0850']);

    // Same minute, and later within the window: the report was already handled.
    expect(scheduler.dueReports(at)).toEqual([]);
    expect(scheduler.dueReports(new Date('2026-09-28T00:53:00Z'))).toEqual([]);
  });

  it('derives a stable close-1-YYYYMMDD-HHMM report id from the local date', async () => {
    const { scheduler } = makeScheduler(() => content());
    await scheduler.runOnce(new Date('2026-09-28T00:50:00Z'));

    const row = repositories.larkOutbox.byReportId('close-1-20260928-0850');
    expect(row).toBeDefined();
    expect(row!.report_id).toBe('close-1-20260928-0850');
  });
});
