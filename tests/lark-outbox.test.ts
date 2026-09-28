/**
 * The outbox: durable, exactly-once-ish delivery of Lark reports.
 *
 * The outbox exists so a report is never lost and never sent twice: the UNIQUE
 * report id is the duplicate guard, a failure is recorded on the row for a later
 * retry, and a crash mid-send is requeued by `recover()`.
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
  type LarkReportContent,
  type LarkSendResult,
} from '../apps/orchestrator/src/lark.js';
import { Logger } from '../apps/orchestrator/src/logger.js';
import { cleanup, tempDir } from './support/harness.js';

const config = loadConfig({ LARK_TIMEZONE: 'Asia/Shanghai', LARK_REPORT_TIMES: '08:50,18:10' });

let dir: string;
let db: SqliteDatabase;
let repositories: Repositories;
let logger: Logger;

beforeEach(() => {
  dir = tempDir('flop-lark-outbox-');
  db = openDatabase({ path: join(dir, 'app.db') });
  repositories = createRepositories(db);
  logger = Logger.create({ level: 'fatal', repositories });
});

afterEach(() => {
  closeDatabase(db);
  cleanup(dir);
});

/** An outbox whose notifier records every send and can be flipped to failing. */
function makeOutbox(): {
  outbox: LarkOutbox;
  calls: string[];
  setFailure: (fail: boolean, error?: string) => void;
} {
  const calls: string[] = [];
  let failing = false;
  let failureError = 'transport down';
  const notifier = {
    async sendText(text: string): Promise<LarkSendResult> {
      calls.push(text);
      if (failing) return { ok: false, error: failureError };
      return { ok: true, messageId: `m${calls.length}` };
    },
  };
  return {
    outbox: new LarkOutbox({ repositories, notifier, logger }),
    calls,
    setFailure: (fail: boolean, error = 'transport down') => {
      failing = fail;
      failureError = error;
    },
  };
}

const reportContent: LarkReportContent = {
  reportId: '',
  title: '日报',
  summary: 'ok',
  sections: [{ heading: 'A', lines: ['1'] }],
};

describe('LarkOutbox', () => {
  it('enqueues a report id once and rejects the duplicate', () => {
    const { outbox } = makeOutbox();

    expect(outbox.enqueue('r1', 'daily_report', 'hello')).toBe(true);
    // The UNIQUE report_id is the duplicate guard; the second insert is ignored.
    expect(outbox.enqueue('r1', 'daily_report', 'hello')).toBe(false);

    const rows = repositories.larkOutbox.pending(10);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.report_id).toBe('r1');
  });

  it('sends a pending row once, marks it sent, and never sends it again', async () => {
    const { outbox, calls } = makeOutbox();
    outbox.enqueue('r1', 'daily_report', 'body');

    const first = await outbox.flush();
    expect(first).toEqual({ sent: 1, failed: 0 });
    expect(calls).toEqual(['body']);
    expect(repositories.larkOutbox.byReportId('r1')!.status).toBe('sent');

    // A second flush must be a no-op: report duplication is zero.
    const second = await outbox.flush();
    expect(second).toEqual({ sent: 0, failed: 0 });
    expect(calls).toHaveLength(1);
  });

  it('records a failure on the row and retries it on a later flush', async () => {
    const { outbox, setFailure } = makeOutbox();
    outbox.enqueue('r2', 'daily_report', 'body');

    setFailure(true, 'lark 500');
    const first = await outbox.flush();
    expect(first).toEqual({ sent: 0, failed: 1 });

    const failedRow = repositories.larkOutbox.byReportId('r2')!;
    expect(failedRow.status).toBe('failed');
    expect(failedRow.last_error).toBe('lark 500');

    // The row is still pending work; a later flush after recovery succeeds.
    setFailure(false);
    const second = await outbox.flush();
    expect(second).toEqual({ sent: 1, failed: 0 });
    expect(repositories.larkOutbox.byReportId('r2')!.status).toBe('sent');
  });

  it('requeues a row left mid-send by a crash', () => {
    const { outbox } = makeOutbox();
    outbox.enqueue('r3', 'daily_report', 'body');
    const row = repositories.larkOutbox.byReportId('r3')!;

    // Simulate a crash after markSending but before markSent/markFailed.
    repositories.larkOutbox.markSending(row.id!);
    expect(repositories.larkOutbox.byReportId('r3')!.status).toBe('sending');

    expect(outbox.recover()).toBe(1);
    expect(repositories.larkOutbox.byReportId('r3')!.status).toBe('pending');
  });
});

describe('LarkReportScheduler end to end', () => {
  it('delivers exactly one report per scheduled time and is idempotent', async () => {
    const { outbox, calls } = makeOutbox();
    const scheduler = new LarkReportScheduler({
      config,
      logger,
      outbox,
      buildReport: async () => reportContent,
    });
    const at = new Date('2026-09-28T00:50:00Z'); // 08:50 Asia/Shanghai

    const first = await scheduler.runOnce(at);
    expect(first.delivered).toEqual(['close-1-20260928-0850']);
    expect(calls).toHaveLength(1);
    expect(repositories.larkOutbox.countByStatus().sent).toBe(1);

    // Calling again for the same minute must not deliver or enqueue anything new.
    const second = await scheduler.runOnce(at);
    expect(second.delivered).toEqual([]);
    expect(calls).toHaveLength(1);
    expect(repositories.larkOutbox.countByStatus().sent).toBe(1);
  });
});
