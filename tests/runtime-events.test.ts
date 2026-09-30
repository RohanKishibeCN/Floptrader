/**
 * The immediate-alert trail.
 *
 * Two things an unattended box has to get right:
 *
 *   - a critical is alerted *at most once*, but a warning for a condition that
 *     simply keeps holding must not alert every sweep (an operator who mutes the
 *     channel has lost the criticals too);
 *   - the alert is queued into the *same* durable outbox the daily report uses,
 *     so a Lark outage delays it and never loses it, and a queue failure leaves
 *     the local record intact for the next flush.
 *
 * Nothing here reads the archive or calls a model: the trail is local evidence.
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
import { LarkOutbox, type LarkSendResult } from '../apps/orchestrator/src/lark.js';
import { Logger } from '../apps/orchestrator/src/logger.js';
import {
  ALERT_MAX_LENGTH,
  RuntimeEventNotifier,
  runtimeEventSummary,
} from '../apps/orchestrator/src/runtime-events.js';
import { cleanup, tempDir } from './support/harness.js';

let dir: string;
let db: SqliteDatabase;
let repositories: Repositories;
let logger: Logger;

beforeEach(() => {
  dir = tempDir('flop-runtime-events-');
  db = openDatabase({ path: join(dir, 'app.db') });
  repositories = createRepositories(db);
  logger = Logger.create({ level: 'fatal', repositories });
});

afterEach(() => {
  closeDatabase(db);
  cleanup(dir);
});

/** An outbox whose notifier records sends and can be flipped to failing. */
function makeStack(): {
  notifier: RuntimeEventNotifier;
  sent: string[];
  setFailure: (fail: boolean) => void;
} {
  const sent: string[] = [];
  let failing = false;
  const client = {
    async sendText(text: string): Promise<LarkSendResult> {
      if (failing) return { ok: false, error: 'lark down' };
      sent.push(text);
      return { ok: true, messageId: `m${sent.length}` };
    },
  };
  const outbox = new LarkOutbox({ repositories, notifier: client, logger });
  const notifier = new RuntimeEventNotifier({
    repositories,
    logger,
    outbox,
    now: () => new Date('2026-09-28T12:00:00.000Z'),
  });
  return {
    notifier,
    sent,
    setFailure: (fail: boolean) => {
      failing = fail;
    },
  };
}

describe('RuntimeEventNotifier: event ids', () => {
  it('carries the sweep for a critical and not for a warning', () => {
    expect(RuntimeEventNotifier.eventIdFor('critical', 'cursor_gap', { sweep: 7 })).toBe(
      'cursor_gap:-:7',
    );
    // A warning does not carry the sweep: the same condition must not alert again
    // just because the sweep moved on.
    expect(RuntimeEventNotifier.eventIdFor('warning', 'stale_reference', { sweep: 7 })).toBe(
      'stale_reference:-',
    );
    expect(RuntimeEventNotifier.eventIdFor('critical', 'cursor_gap', { sweep: 8 })).not.toBe(
      RuntimeEventNotifier.eventIdFor('critical', 'cursor_gap', { sweep: 7 }),
    );
  });
});

describe('RuntimeEventNotifier: recording and alerting', () => {
  it('records a critical once, queues one alert, and refuses the duplicate', async () => {
    const { notifier, sent } = makeStack();

    expect(notifier.alert('critical', 'cursor_gap', 'cursor gap in close1', { sweep: 3 })).toBe(true);
    // The same critical at the same sweep is the same fact: no second row, no
    // second message.
    expect(notifier.alert('critical', 'cursor_gap', 'cursor gap in close1', { sweep: 3 })).toBe(
      false,
    );

    expect(repositories.runtimeEvents.count()).toBe(1);
    const row = repositories.runtimeEvents.recent(1)[0]!;
    expect(row.severity).toBe('critical');
    expect(row.code).toBe('cursor_gap');
    expect(row.sweep).toBe(3);
    expect(row.lark_status).toBe('pending');

    await notifier.flush();
    expect(sent).toHaveLength(1);
    expect(sent[0]).toContain('CRITICAL');
    expect(sent[0]).toContain('cursor_gap');
    expect(repositories.runtimeEvents.recent(1)[0]!.lark_status).toBe('sent');
  });

  it('never alerts the same warning twice, but a new critical at a new sweep is new', () => {
    const { notifier } = makeStack();

    expect(notifier.alert('warning', 'mint_unknown', 'sweep 4 has no flow')).toBe(true);
    expect(notifier.alert('warning', 'mint_unknown', 'sweep 4 has no flow')).toBe(false);
    expect(notifier.alert('warning', 'mint_unknown', 'sweep 9 has no flow')).toBe(false);

    expect(repositories.runtimeEvents.countByCode('mint_unknown')).toBe(1);
  });

  it('de-duplicates a repeated gap by room, range and generation, and alerts only a new range', () => {
    const { notifier } = makeStack();

    // A gap observed by every poll is one loss, not one loss per poll. The
    // reader stamps each event with the room, the missed range and the
    // generation precisely so that this is decidable.
    const gap = { sweep: 7, dedupKey: 'close1:4-5:g1' };
    expect(notifier.alert('critical', 'cursor_gap', 'gap 4..5', gap)).toBe(true);
    expect(notifier.alert('critical', 'cursor_gap', 'gap 4..5', { ...gap })).toBe(false);
    // Not even at a later sweep: the range is the identity, not the sweep.
    expect(notifier.alert('critical', 'cursor_gap', 'gap 4..5', { sweep: 8, dedupKey: 'close1:4-5:g1' })).toBe(
      false,
    );
    // A new range is a new loss, and so is a new generation for the same range.
    expect(notifier.alert('critical', 'cursor_gap', 'gap 6..7', { sweep: 8, dedupKey: 'close1:6-7:g1' })).toBe(
      true,
    );
    expect(notifier.alert('critical', 'cursor_gap', 'gap 4..5', { sweep: 9, dedupKey: 'close1:4-5:g2' })).toBe(
      true,
    );

    expect(repositories.runtimeEvents.countByCode('cursor_gap')).toBe(3);
  });

  it('keeps the local record when the queue itself fails, and retries on the next flush', async () => {
    const { notifier, sent, setFailure } = makeStack();

    setFailure(true);
    expect(notifier.alert('critical', 'sqlite_corrupt', 'the database could not be opened')).toBe(
      true,
    );
    // The send failed, but the alert is still recorded locally and the outbox row
    // still exists: the next flush is the recovery.
    await notifier.flush();
    expect(repositories.runtimeEvents.count()).toBe(1);
    expect(repositories.runtimeEvents.recent(1)[0]!.lark_status).toBe('failed');

    setFailure(false);
    await notifier.flush();
    expect(sent).toHaveLength(1);
    expect(repositories.runtimeEvents.recent(1)[0]!.lark_status).toBe('sent');
  });

  it('observes the structured log: a catalogued code becomes an alert, an unknown one does not', async () => {
    const { notifier, sent } = makeStack();
    // The runtime wires the notifier straight into the logger's observer hook.
    const wired = Logger.create({
      level: 'fatal',
      repositories,
      onEvent: (record) => notifier.observe(record),
    });
    wired.event({ level: 'warn', source: 'reader', code: 'stale_reference', message: 'reference is old' });
    wired.event({ level: 'info', source: 'scheduler', code: 'tick_started', message: 'not in the catalogue' });

    await notifier.flush();
    expect(repositories.runtimeEvents.countByCode('stale_reference')).toBe(1);
    expect(repositories.runtimeEvents.countByCode('tick_started')).toBe(0);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toContain('WARNING');
  });
});

describe('RuntimeEventNotifier: rendering', () => {
  it('prefixes the severity, names the code and the location, and caps the length', () => {
    const long = 'x'.repeat(ALERT_MAX_LENGTH * 2);
    const text = RuntimeEventNotifier.render('critical', 'package_hash_drift', long, { sweep: 12 });
    expect(text.startsWith('🚨 CRITICAL package_hash_drift (sweep 12)')).toBe(true);
    expect(text.length).toBeLessThanOrEqual(ALERT_MAX_LENGTH);

    expect(RuntimeEventNotifier.render('warning', 'archive_unavailable', 'no archive', {})).toBe(
      '⚠ WARNING archive_unavailable\nno archive',
    );
  });
});

describe('runtimeEventSummary', () => {
  it('counts by severity and delivery state', async () => {
    const { notifier, setFailure } = makeStack();
    setFailure(true);
    notifier.alert('critical', 'cursor_gap', 'gap', { sweep: 1 });
    notifier.alert('warning', 'mint_unknown', 'no flow');
    await notifier.flush();

    const summary = runtimeEventSummary(repositories);
    expect(summary.total).toBe(2);
    expect(summary.critical).toBe(1);
    expect(summary.warning).toBe(1);
    expect(summary.failed).toBe(2);
    expect(summary.delivered).toBe(0);
    expect(summary.recentCodes).toContain('critical:cursor_gap');
  });
});
