/**
 * The `/status` contract, over HTTP.
 *
 * A metric that exists in the source and not in the served payload is
 * indistinguishable, from a VPS, from a reader that does not have it — which is
 * exactly how a deployed process came to report a fraction of the fields the
 * code was computing. Two claims are pinned here, and neither can be satisfied
 * by the source alone:
 *
 *   - **Every field the runbook names is present in the served `/status`.** The
 *     route is the only thing an operator has, so the assertion runs through
 *     `health.app.inject` rather than through `scheduler.status()` directly.
 *   - **The payload says which contract it is.** `statusSchemaVersion` and
 *     `readerMetricsVersion` travel with every response, so a stale bundle is
 *     recognised from the outside instead of inferred.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { READER_METRICS_VERSION, STATUS_SCHEMA_VERSION } from '@flop/technocore';
import { createHealthServer } from '../apps/orchestrator/src/health.js';
import { buildHarness, type Harness } from './support/orchestrator.js';

/**
 * Every field `/status.reader` must carry.
 *
 * Lifted verbatim from the runbook. A field is added here when it is promised,
 * and the test fails until the payload actually emits it — which is the point:
 * the list is the contract, not a description of the code.
 */
const REQUIRED_READER_FIELDS = [
  'continuousMode',
  'running',
  'fixedRoomCount',
  'activeRequests',
  'completedReads',
  'failedReads',
  'returnedMessages',
  'persistedMessages',
  'duplicateMessages',
  'rejectedMessages',
  'signedMessages',
  'invalidSignatureMessages',
  'messagesPerMinute',
  'persistedMessagesPerMinute',
  'cursorAdvancePerMinute',
  'cursorSequenceAdvancePerMinute',
  'gapMessagesPerMinute',
  'producerRate',
  'consumerRate',
  'netBacklogRate',
  'netBacklogIncreasing',
  'catchupState',
  'fullyCaughtUp',
  'unresolvedGap',
  'unresolvedGapRooms',
  'modeByRoom',
  'lastReturnedCountByRoom',
  'lastReturnedFirstSeqByRoom',
  'lastReturnedLastSeqByRoom',
  'lastCursorByRoom',
  'lastRingFirstSeqByRoom',
  'lastRingLastSeqByRoom',
  'cursorLagByRoom',
  'pageSaturated',
  'consecutiveShortPages',
  'contiguousResumeCount',
  'gapRecoveryCount',
  'exportRecovery',
  'throttledReads',
  'timeoutReads',
  'waitNotHeld',
  'silentRooms',
  'lastError',
  'lastErrorAt',
  'statusSchemaVersion',
  'readerMetricsVersion',
] as const;

/** Fields of `exportRecovery` an operator reads to explain a silent gap. */
const REQUIRED_EXPORT_FIELDS = [
  'enabled',
  'skippedReason',
  'attempts',
  'succeeded',
  'failed',
  'generationMismatch',
  'lastAttemptAt',
  'lastError',
  'lastSuccessAt',
  'recoveredMessages',
  'malformedRecords',
  'lastTruncated',
  'lastGeneration',
  'lastLines',
  'cooldownMs',
] as const;

describe('the served /status contract', () => {
  let harness: Harness | null = null;

  afterEach(async () => {
    if (harness) await harness.dispose();
    harness = null;
  });

  async function servedStatus(h: Harness): Promise<Record<string, unknown>> {
    // The route is built exactly as production builds it, and `inject` exercises
    // the real serialization without binding a port.
    const health = createHealthServer({
      config: h.runtime.config,
      logger: h.runtime.logger,
      scheduler: h.runtime.scheduler,
    });
    const response = await health.app.inject({ method: 'GET', url: '/status' });
    expect(response.statusCode).toBe(200);
    return response.json() as Record<string, unknown>;
  }

  it('serves every promised reader field, not just the ones the source happens to compute', async () => {
    harness = await buildHarness({ agentCount: 4 });
    const h = harness;
    const status = await servedStatus(h);
    const reader = status.reader as Record<string, unknown>;
    expect(reader).toBeTruthy();

    const missing = REQUIRED_READER_FIELDS.filter((field) => !(field in reader));
    expect(missing).toEqual([]);

    const exportRecovery = reader.exportRecovery as Record<string, unknown>;
    const missingExport = REQUIRED_EXPORT_FIELDS.filter((field) => !(field in exportRecovery));
    expect(missingExport).toEqual([]);

    // The consumer figure is the persisted rate. It is never the cursor-advance
    // rate: a cursor steps over a gap nobody stored, so using it as consumption
    // is what lets a losing reader report itself as keeping up.
    expect(reader.consumerRate).toBe(reader.persistedMessagesPerMinute as number);
    expect(reader.netBacklogRate).toBe(
      Math.round(((reader.producerRate as number) - (reader.consumerRate as number)) * 100) / 100,
    );
    // `messagesPerMinute` is what the service returned, not what was stored.
    expect(reader.messagesPerMinute).toBe(reader.returnedPerMinute as number);
  });

  it('carries the schema versions, so a stale bundle is visible from outside', async () => {
    harness = await buildHarness({ agentCount: 4 });
    const h = harness;
    const status = await servedStatus(h);

    expect(status.statusSchemaVersion).toBe(STATUS_SCHEMA_VERSION);
    expect(status.readerMetricsVersion).toBe(READER_METRICS_VERSION);
    // The same two versions inside the reader block, so a reader-level consumer
    // does not have to reach up a level for them.
    const reader = status.reader as Record<string, unknown>;
    expect(reader.statusSchemaVersion).toBe(STATUS_SCHEMA_VERSION);
    expect(reader.readerMetricsVersion).toBe(READER_METRICS_VERSION);
    // The commit is whatever the supervisor exported; absent means null, never a
    // fabricated hash.
    expect(status).toHaveProperty('commit');
  });

  it('reports the effective configuration and the per-room view, with no secrets', async () => {
    harness = await buildHarness({
      agentCount: 4,
      env: { LARK_APP_SECRET: 'lark-secret-sentinel', DEEPSEEK_API_KEY: 'deepseek-key-sentinel' },
    });
    const h = harness;

    const health = createHealthServer({
      config: h.runtime.config,
      logger: h.runtime.logger,
      scheduler: h.runtime.scheduler,
    });
    const response = await health.app.inject({ method: 'GET', url: '/reader-report' });
    expect(response.statusCode).toBe(200);
    const raw = response.body;
    const report = JSON.parse(raw) as Record<string, unknown>;

    // The acceptance block's shape.
    expect(report.statusSchemaVersion).toBe(STATUS_SCHEMA_VERSION);
    expect(report).toHaveProperty('commit');
    expect(report).toHaveProperty('mode');
    expect(report).toHaveProperty('catchupState');
    expect(report).toHaveProperty('unresolvedGapRooms');

    // The three gates travel together and are named separately: an operator has
    // to be able to tell "the referee is not provable" from "our own write lane
    // is not", because the two need different repairs.
    const readiness = report.readiness as Record<string, unknown>;
    for (const field of ['refereeFeedReady', 'registrationReady', 'tradingReady']) {
      expect(readiness).toHaveProperty(field);
    }
    for (const field of ['refereeFeedReasons', 'registrationReasons', 'tradingReasons']) {
      expect(readiness).toHaveProperty(field);
    }

    // The `close1` policy surface: the coverage classification, both operator
    // switches, our own seqs in the band and the readback progress.
    expect(report).toHaveProperty('operatingMode');
    expect(report).toHaveProperty('close1Coverage');
    expect(report).toHaveProperty('localMessagesInGap');
    expect(report).toHaveProperty('registrationPending');
    expect(report).toHaveProperty('registrationReadback');
    expect(report).toHaveProperty('tradeBlockedReason');
    const registrationPolicy = report.registrationPolicy as Record<string, unknown>;
    expect(registrationPolicy).toHaveProperty('allowWithClose1Gap');
    const tradingPolicy = report.tradingPolicy as Record<string, unknown>;
    expect(tradingPolicy).toHaveProperty('allowWithClose1Gap');
    expect(tradingPolicy).toHaveProperty('override');
    const readback = report.registrationReadback as Record<string, unknown>;
    for (const field of ['completed', 'pending', 'total']) expect(readback).toHaveProperty(field);

    const config = report.effectiveConfig as Record<string, unknown>;
    expect(config.serverLimit).toBeGreaterThan(0);
    expect(config.close1GapPolicy).toBe('block');
    expect(config.exportRecoveryEnabled).toBe(false);
    // Each room is described by its own mode and its own three rates.
    const rooms = report.rooms as Array<Record<string, unknown>>;
    expect(rooms.length).toBeGreaterThan(0);
    for (const row of rooms) {
      expect(row).toHaveProperty('producerRate');
      expect(row).toHaveProperty('persistedConsumerRate');
      expect(row).toHaveProperty('cursorAdvanceRate');
      expect(row).toHaveProperty('waitSeconds');
    }
    const totals = report.totals as Record<string, unknown>;
    // The accounting identity the two-window rule is written with, at the reader
    // level: net backlog is producer minus *persisted consumer*, and it is never
    // derived from the cursor.
    expect(totals.netBacklogRate).toBeCloseTo(
      (totals.producerRate as number) - (totals.persistedConsumerRate as number),
      2,
    );

    // Nothing secret may survive into either payload.
    for (const sentinel of ['lark-secret-sentinel', 'deepseek-key-sentinel']) {
      expect(raw).not.toContain(sentinel);
    }
    expect(raw).not.toMatch(/AGE-SECRET-KEY|BEGIN [A-Z ]*PRIVATE KEY/);
  });
});
