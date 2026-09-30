/**
 * The four numbers in a referee `price` post, at the live boundary.
 *
 * `referee-price-semantics.test.ts` pins the *meaning* of `applied`, `ref.px`,
 * `limits` and `for` in a permissive reader. This file pins what changes when the
 * process is actually armed:
 *
 *   - a live post with no `applied` is an anomaly: conservative mode, no new
 *     active risk, the previous close kept only as a stand-in;
 *   - a live post with no `for` makes the published band read-only, so nothing can
 *     be priced from it;
 *   - a `for` that names the wrong sweep is conservative mode and a critical alert;
 *   - a dry run keeps the permissive fallback, because it never posts a trade;
 *   - a stale `age_s` still only stops new risk — the official numbers stand;
 *   - a replay rebuilds the same four values, and never swaps them.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { signRoomMessage } from '@flop/identity';
import { RefereeVerifier, type RoomMessage } from '@flop/technocore';
import { referenceRules, type RefereePrice, type RefereeSeed } from '@flop/close-call';
import { generateAgents } from './support/harness.js';
import { HARNESS_PACKAGE_HASH, buildHarness, type Harness } from './support/orchestrator.js';

const referee = generateAgents(1)[0]!;
const PRICE_ROOM = 'd-close1-price';
const STATE_ROOM = 'd-close1-state';

class RecordingLogger {
  readonly events: Array<{ level: string; code: string; data?: Record<string, unknown> }> = [];
  debug(): void {}
  info(): void {}
  warn(): void {}
  error(): void {}
  event(record: { level: string; code: string; data?: Record<string, unknown> }): void {
    this.events.push({ level: record.level, code: record.code, data: record.data });
  }
}

function ts(seq: number): string {
  return `2026-09-28T08:40:${String(seq).padStart(2, '0')}.000Z`;
}

function post(room: string, payload: object, seq: number): RoomMessage {
  const text = JSON.stringify(payload);
  const nonce = String(seq);
  const signed = signRoomMessage(referee.did, referee.seed, room, nonce, text);
  return { seq, ts: ts(seq), from: signed.did, text: signed.text, nonce, sig: signed.sig };
}

function seedPayload(packageHash: string): RefereeSeed {
  return {
    t: 'seed',
    season: 'close-1',
    price: '223.01',
    trade: { time: '2026-09-25T12:05:00Z', tid: 1 },
    package: packageHash,
    rooms: [],
  };
}

function pricePayload(patch: Partial<RefereePrice> = {}): RefereePrice {
  return {
    t: 'price',
    n: 824,
    ref: { px: '223.01', tid: 444195233496965, time: '2026-09-28T08:40:00Z' },
    limits: ['211.86', '234.16'],
    global: '221.22',
    age_s: 0,
    applied: '223.13',
    for: 825,
    ...patch,
  };
}

function makeVerifier(live: boolean, options: { maxReferenceAgeSeconds?: number } = {}) {
  const logger = new RecordingLogger();
  const engine = new RefereeVerifier({
    rules: referenceRules(),
    logger,
    expectedRefereeDid: referee.did,
    expectedPackageHash: 'a'.repeat(64),
    live,
    ...options,
  });
  engine.observe(STATE_ROOM, post(STATE_ROOM, seedPayload('a'.repeat(64)), 1));
  return { engine, logger };
}

describe('live: a missing applied is an anomaly, not a fallback', () => {
  it('enters conservative mode and refuses to add risk', () => {
    const { engine, logger } = makeVerifier(true);
    const observation = engine.observe(
      PRICE_ROOM,
      post(PRICE_ROOM, pricePayload({ applied: undefined }), 2),
    );

    expect(observation?.appliedMissing).toBe(true);
    expect(engine.state.appliedMissing).toBe(true);
    expect(engine.state.conservative).toBe(true);
    expect(engine.state.conservativeReasons).toContain('applied_missing');
    expect(logger.events.some((event) => event.code === 'conservative_mode')).toBe(true);
    // The previous close is kept only as a stand-in; it is never promoted.
    expect(engine.state.reference?.toString()).toBe('223.01');
  });

  it('is tolerated in a dry run, which never posts a trade', () => {
    const { engine } = makeVerifier(false);
    const observation = engine.observe(
      PRICE_ROOM,
      post(PRICE_ROOM, pricePayload({ applied: undefined }), 2),
    );

    expect(observation?.appliedMissing).toBeFalsy();
    expect(engine.state.appliedMissing).toBe(false);
    expect(engine.state.conservative).toBe(false);
  });
});

describe('live: a missing or wrong `for` makes the band unusable', () => {
  it('marks the band read-only when a live post omits `for`', () => {
    const { engine } = makeVerifier(true);
    const observation = engine.observe(
      PRICE_ROOM,
      post(PRICE_ROOM, pricePayload({ for: undefined }), 2),
    );

    expect(observation?.limitsForMissing).toBe(true);
    expect(engine.state.limitsForMissing).toBe(true);
    expect(engine.state.limitsUsable).toBe(false);
    expect(engine.state.conservativeReasons).toContain('limits_for_missing');
    // The numbers the referee published are still stored verbatim.
    expect(engine.state.limits?.low.toString()).toBe('211.86');
    expect(engine.state.limits?.high.toString()).toBe('234.16');
    expect(engine.state.limitsForSweep).toBeNull();
  });

  it('keeps the permissive fallback in a dry run', () => {
    const { engine } = makeVerifier(false);
    engine.observe(PRICE_ROOM, post(PRICE_ROOM, pricePayload({ for: undefined }), 2));

    expect(engine.state.limitsUsable).toBe(true);
    expect(engine.state.limitsForMissing).toBe(false);
    expect(engine.state.conservativeReasons).not.toContain('limits_for_missing');
  });

  it('is conservative, and stays unusable, when `for` names the wrong sweep', () => {
    const { engine } = makeVerifier(true);
    engine.observe(PRICE_ROOM, post(PRICE_ROOM, pricePayload({ for: 830 }), 2));

    expect(engine.state.conservative).toBe(true);
    expect(engine.state.conservativeReasons).toContain('limits_for_mismatch');
    expect(engine.state.limitsUsable).toBe(false);

    // A correct post clears it again.
    engine.observe(PRICE_ROOM, post(PRICE_ROOM, pricePayload({ n: 825, for: 826 }), 3));
    expect(engine.state.limitsUsable).toBe(true);
    expect(engine.state.conservativeReasons).not.toContain('limits_for_mismatch');
  });
});

describe('a stale price still only stops new risk', () => {
  it('sets staleReference without rewriting the official numbers', () => {
    const { engine } = makeVerifier(false, { maxReferenceAgeSeconds: 60 });
    engine.observe(PRICE_ROOM, post(PRICE_ROOM, pricePayload({ age_s: 61 }), 2));

    const snapshot = engine.snapshot(new Date('2026-09-28T08:40:02Z'));
    expect(snapshot.staleReference).toBe(true);
    expect(snapshot.close?.toString()).toBe('223.01');
    expect(snapshot.appliedReference?.toString()).toBe('223.13');
    expect(snapshot.nextLimits?.low.toString()).toBe('211.86');
  });
});

describe('a replay rebuilds the four values without swapping them', () => {
  it('restores applied, close, limits and for from stored rows', () => {
    const engine = new RefereeVerifier({
      rules: referenceRules(),
      logger: new RecordingLogger(),
      expectedRefereeDid: referee.did,
      expectedPackageHash: 'a'.repeat(64),
      live: true,
    });
    engine.replay({
      seq: 1,
      ts: ts(1),
      kind: 'seed',
      senderDid: referee.did,
      payload: seedPayload('a'.repeat(64)),
    });
    engine.replay({
      seq: 2,
      ts: ts(2),
      kind: 'price',
      senderDid: referee.did,
      payload: pricePayload(),
    });

    expect(engine.state.appliedReference?.toString()).toBe('223.13');
    expect(engine.state.close?.toString()).toBe('223.01');
    expect(engine.state.limitsForSweep).toBe(825);
    expect(engine.state.limitsUsable).toBe(true);
    expect(engine.snapshot().nextLimits?.high.toString()).toBe('234.16');
    // `ref.px` is the close, never the reference the settled trades used.
    expect(engine.state.appliedReference!.eq(engine.state.close!)).toBe(false);
    expect(engine.state.conservative).toBe(false);
  });
});

describe('the running reader records the live anomalies', () => {
  let harness: Harness | undefined;
  afterEach(async () => {
    if (harness) await harness.dispose();
    harness = undefined;
  });

  it('records applied_missing and limits_for_missing, and blocks pricing from the band', async () => {
    // Live mode is the only one in which these are holes; the fleet must be full.
    harness = await buildHarness({
      agentCount: 150,
      env: {
        FLOP_MODE: 'live',
        FLOP_LIVE_CONFIRM: 'close-1',
        FLOP_ALLOW_REGISTRATION: 'true',
        EXPECTED_PACKAGE_HASH: HARNESS_PACKAGE_HASH,
        MAX_DISCOVERED_ROOMS: '1',
      },
    });
    const h = harness;
    h.referee.seedPost(HARNESS_PACKAGE_HASH);
    // Neither `applied` nor `for`: the two live holes at once.
    h.referee.post('d-close1-price', {
      t: 'price',
      season: 'close-1',
      n: 300,
      ref: { px: '225.10', time: '2026-09-28T12:00:00Z', tid: 't300' },
      limits: ['213.85', '236.36'],
    });

    await h.runtime.reader.tick();

    const status = h.runtime.scheduler.status();
    expect(status.conservative).toBe(true);
    expect(status.conservativeReasons).toContain('applied_missing');
    expect(status.conservativeReasons).toContain('limits_for_missing');
    expect(h.runtime.reader.snapshot().limitsUsable).toBe(false);
    // The referee's band is still recorded verbatim — it just cannot price a trade.
    expect(status.limits).toEqual({ low: '213.85', high: '236.36' });

    expect(
      h.runtime.repositories.refereeAnomalies.byKind('applied_missing'),
    ).toHaveLength(1);
    expect(
      h.runtime.repositories.refereeAnomalies.byKind('limits_for_missing'),
    ).toHaveLength(1);

    const report = await h.runtime.scheduler.buildReport();
    expect(report.critical.join(' ')).toContain('no new live trade can be priced');
  });
});
