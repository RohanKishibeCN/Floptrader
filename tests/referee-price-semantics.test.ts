/**
 * The five numbers in a referee `price` post, and the four rules that keep them
 * apart.
 *
 * Per `docs/close-1-referee.md`:
 *
 *   applied  the reference *this* sweep's trades were checked against
 *   ref.px   this sweep's closing price — prices fees/clawback, sets next limits
 *   limits   the band the referee will enforce on the next sweep
 *   for      the sweep `limits` apply to, `n + 1`
 *   age_s    seconds from `ref.time` to this sweep's close
 *
 * The old code read `ref.px` as "this sweep's reference". That is the bug this
 * file pins shut: `ref.px` is the *close*, and a trade that is about to settle
 * is bounded by the *published* band, never by a locally rebuilt ±5%.
 */
import { describe, expect, it } from 'vitest';
import { signRoomMessage } from '@flop/identity';
import { RefereeVerifier, type RoomMessage } from '@flop/technocore';
import { referenceRules, type RefereePrice, type RefereeSeed } from '@flop/close-call';
import { generateAgents } from './support/harness.js';

const referee = generateAgents(1)[0]!;
const PRICE_ROOM = 'd-close1-price';

/** Records every event, so a `stale_reference` warning is observable. */
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

interface VerifierOptions {
  maxReferenceAgeSeconds?: number;
  staleReferenceMode?: 'off' | 'no_new_active_trade';
}

function makeVerifier(options: VerifierOptions = {}): { engine: RefereeVerifier; logger: RecordingLogger } {
  const logger = new RecordingLogger();
  const engine = new RefereeVerifier({
    rules: referenceRules(),
    logger,
    expectedRefereeDid: referee.did,
    expectedPackageHash: 'a'.repeat(64),
    ...options,
  });
  engine.observe(PRICE_ROOM, post(PRICE_ROOM, seedPayload('a'.repeat(64)), 1));
  return { engine, logger };
}

describe('the price post carries four different numbers', () => {
  it('keeps applied, close, limits and for apart', () => {
    const { engine } = makeVerifier();
    engine.observe(PRICE_ROOM, post(PRICE_ROOM, pricePayload(), 2));

    const state = engine.state;
    // `applied` is the reference this sweep's trades used.
    expect(state.appliedReference?.toString()).toBe('223.13');
    // `ref.px` is the close: it prices fees and sets the next band.
    expect(state.close?.toString()).toBe('223.01');
    // `limits` is the band for the next sweep, kept exactly as posted.
    expect(state.limits?.low.toString()).toBe('211.86');
    expect(state.limits?.high.toString()).toBe('234.16');
    expect(state.limitsForSweep).toBe(825);
    // The close is never promoted into the historical reference.
    expect(state.appliedReference!.eq(state.close!)).toBe(false);
  });

  it('publishes the same split on the snapshot, with close as the pricing baseline', () => {
    const { engine } = makeVerifier();
    engine.observe(PRICE_ROOM, post(PRICE_ROOM, pricePayload(), 2));

    const snapshot = engine.snapshot(new Date('2026-09-28T08:40:02Z'));
    expect(snapshot.appliedReference?.toString()).toBe('223.13');
    expect(snapshot.close?.toString()).toBe('223.01');
    expect(snapshot.nextLimits?.low.toString()).toBe('211.86');
    expect(snapshot.nextLimits?.high.toString()).toBe('234.16');
    expect(snapshot.limitsForSweep).toBe(825);
    // `reference`/`limits` are the pricing aliases: a new offer settles next
    // sweep, so it sits around the close and inside the published band.
    expect(snapshot.reference?.toString()).toBe('223.01');
    expect(snapshot.limits?.low.toString()).toBe('211.86');
    // History is a list of closes, not of applied references.
    expect(snapshot.history.map(String)).toEqual(['223.01']);
  });

  it('falls back to the previous close when a post omits applied', () => {
    const { engine } = makeVerifier();
    engine.observe(PRICE_ROOM, post(PRICE_ROOM, pricePayload(), 2));
    engine.observe(
      PRICE_ROOM,
      post(PRICE_ROOM, pricePayload({ n: 825, applied: undefined, for: 826 }), 3),
    );
    // Sweep 825's trades were checked against sweep 824's close.
    expect(engine.state.appliedReference?.toString()).toBe('223.01');
  });
});

describe('the limits the referee publishes are authoritative', () => {
  it('enters conservative mode when `for` names a sweep other than n + 1', () => {
    const { engine } = makeVerifier();
    engine.observe(PRICE_ROOM, post(PRICE_ROOM, pricePayload({ n: 824, for: 830 }), 2));

    expect(engine.state.conservative).toBe(true);
    expect(engine.state.conservativeReasons).toContain('limits_for_mismatch');
    // The band is still recorded verbatim — we just refuse to trade on it.
    expect(engine.state.limitsForSweep).toBe(830);
  });

  it('accepts the band again once a correct post arrives', () => {
    const { engine } = makeVerifier();
    engine.observe(PRICE_ROOM, post(PRICE_ROOM, pricePayload({ n: 824, for: 830 }), 2));
    expect(engine.state.conservative).toBe(true);

    engine.observe(PRICE_ROOM, post(PRICE_ROOM, pricePayload({ n: 825, for: 826 }), 3));
    expect(engine.state.conservativeReasons).not.toContain('limits_for_mismatch');
    expect(engine.state.conservative).toBe(false);
  });

  it('does not rebuild the band from the close, and keeps the posted precision', () => {
    const { engine } = makeVerifier();
    // A band deliberately narrower than close ± 5%, with a different scale from
    // the close: the referee's numbers are kept verbatim, down to the scale.
    engine.observe(
      PRICE_ROOM,
      post(PRICE_ROOM, pricePayload({ ref: { px: '200.00', tid: 1, time: 'x' }, limits: ['199.00', '201.00'] }), 2),
    );
    expect(engine.state.close?.toString()).toBe('200.00');
    expect(engine.state.limits?.low.toString()).toBe('199.00');
    expect(engine.state.limits?.high.toString()).toBe('201.00');
  });
});

describe('a stale reference stops new risk without rewriting the price', () => {
  it('marks the snapshot stale when age_s exceeds the limit', () => {
    const { engine, logger } = makeVerifier({ maxReferenceAgeSeconds: 60 });
    engine.observe(PRICE_ROOM, post(PRICE_ROOM, pricePayload({ age_s: 61 }), 2));

    const snapshot = engine.snapshot(new Date('2026-09-28T08:40:02Z'));
    expect(snapshot.staleReference).toBe(true);
    // The official reference stands: staleness is a signal, not a correction.
    expect(snapshot.close?.toString()).toBe('223.01');
    expect(snapshot.appliedReference?.toString()).toBe('223.13');
    expect(logger.events.some((event) => event.code === 'stale_reference')).toBe(true);
  });

  it('clears once a fresh post arrives', () => {
    const { engine } = makeVerifier({ maxReferenceAgeSeconds: 60 });
    engine.observe(PRICE_ROOM, post(PRICE_ROOM, pricePayload({ age_s: 120 }), 2));
    expect(engine.snapshot().staleReference).toBe(true);

    engine.observe(
      PRICE_ROOM,
      post(PRICE_ROOM, pricePayload({ n: 825, for: 826, age_s: 3 }), 3),
    );
    expect(engine.snapshot().staleReference).toBe(false);
  });

  it('can be turned off, and never uses the local clock as the age', () => {
    const { engine } = makeVerifier({ staleReferenceMode: 'off' });
    engine.observe(PRICE_ROOM, post(PRICE_ROOM, pricePayload({ age_s: 10_000 }), 2));
    expect(engine.snapshot(new Date('2026-09-28T08:40:02Z')).staleReference).toBe(false);

    const { engine: normal } = makeVerifier({ maxReferenceAgeSeconds: 60 });
    // A post with no `age_s` at all is not "stale": the referee did not say so,
    // and a replay read days later is not a stale feed.
    normal.observe(PRICE_ROOM, post(PRICE_ROOM, pricePayload({ age_s: undefined }), 2));
    expect(normal.snapshot(new Date('2026-10-05T00:00:00Z')).staleReference).toBe(false);
  });
});

describe('a replay rebuilds the same price view', () => {
  it('restores appliedReference, close, limits and for from stored rows', () => {
    const engine = new RefereeVerifier({
      rules: referenceRules(),
      logger: new RecordingLogger(),
      expectedRefereeDid: referee.did,
      expectedPackageHash: 'a'.repeat(64),
    });
    engine.replay({
      room: PRICE_ROOM,
      seq: 1,
      ts: ts(1),
      kind: 'seed',
      senderDid: referee.did,
      payload: seedPayload('a'.repeat(64)),
    });
    engine.replay({
      room: PRICE_ROOM,
      seq: 2,
      ts: ts(2),
      kind: 'price',
      senderDid: referee.did,
      payload: pricePayload(),
    });

    expect(engine.state.appliedReference?.toString()).toBe('223.13');
    expect(engine.state.close?.toString()).toBe('223.01');
    expect(engine.state.limitsForSweep).toBe(825);
    expect(engine.state.limits?.low.toString()).toBe('211.86');
    // The next-sweep band is what a restart needs before it can trade again.
    expect(engine.snapshot().nextLimits?.high.toString()).toBe('234.16');
    expect(engine.state.conservative).toBe(false);
  });
});
