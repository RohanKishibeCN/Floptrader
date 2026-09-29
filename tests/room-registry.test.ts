/**
 * The live referee's room listing, and the three lists it uses to report holes.
 *
 * Rule 5 says a room is listed from the sweep that registers it until
 * technocore.chat deletes it. `docs/close-1-referee.md` says what the referee
 * actually does: it takes quiet rooms off the list 12 sweeps after the last
 * activity, and it reports three kinds of gap — `unlisted` (rooms it stopped
 * reading), `missed` (messages it never read) and `omitted` (entries cut for
 * length).
 *
 * The point of these tests is that none of the three is treated as a failure.
 * A gap is recorded as a gap, `close1` is never dropped, and an omitted entry is
 * not an absent one.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildHarness, HARNESS_PACKAGE_HASH, HARNESS_ROOMS, type Harness } from './support/orchestrator.js';

let harness: Harness;

beforeEach(async () => {
  // Registration off and a small fleet: this is about the room bookkeeping, so
  // the cheapest possible harness keeps the test honest and fast.
  harness = await buildHarness({
    agentCount: 5,
    env: { FLOP_ALLOW_REGISTRATION: 'false', MAX_DISCOVERED_ROOMS: '3' },
  });
});

afterEach(async () => {
  await harness.dispose();
});

function anomalyKinds(code: string): Array<{ kind: string; affected_count: number }> {
  return harness.runtime.db
    .prepare('SELECT kind, affected_count, room, raw_payload FROM referee_anomalies WHERE kind = ? ORDER BY id')
    .all(code) as Array<{ kind: string; affected_count: number }>;
}

describe('the room registry', () => {
  it('seeds every room we read unconditionally, with close1 never unlisted', () => {
    const rows = harness.runtime.repositories.roomRegistry.listListed();
    const rooms = rows.map((row) => row.room).sort();
    expect(rooms).toEqual([...HARNESS_ROOMS].sort());

    const close1 = harness.runtime.repositories.roomRegistry.get('close1')!;
    expect(close1.listed).toBe(1);
    expect(close1.source).toBe('close1');
    expect(close1.unlisted_at).toBeNull();
  });

  it('unlists a quiet owner room the flow post names under unlisted', async () => {
    harness.referee.seedPost(HARNESS_PACKAGE_HASH);
    harness.referee.post('d-close1-flow', {
      t: 'flow',
      season: 'close-1',
      n: 100,
      mints: [],
      rooms: ['close1'],
      unlisted: ['d-owner-quiet'],
    });

    await harness.runtime.reader.tick();

    const row = harness.runtime.repositories.roomRegistry.get('d-owner-quiet')!;
    expect(row.listed).toBe(0);
    expect(row.unlisted_at).not.toBeNull();

    const anomalies = anomalyKinds('room_unlisted');
    expect(anomalies).toHaveLength(1);
  });

  it('keeps close1 listed even when a flow post claims otherwise', async () => {
    harness.referee.seedPost(HARNESS_PACKAGE_HASH);
    harness.referee.post('d-close1-flow', {
      t: 'flow',
      season: 'close-1',
      n: 100,
      mints: [],
      rooms: [],
      unlisted: ['close1'],
    });

    await harness.runtime.reader.tick();

    // The claim is recorded, but acting on it would drop the registrations that
    // live in close1, so close1 stays listed.
    expect(harness.runtime.repositories.roomRegistry.get('close1')!.listed).toBe(1);
    expect(anomalyKinds('room_unlisted')).toHaveLength(1);
  });

  it('counts a room registration as activity', async () => {
    harness.referee.seedPost(HARNESS_PACKAGE_HASH);
    harness.referee.post('d-close1-flow', {
      t: 'flow',
      season: 'close-1',
      n: 101,
      mints: [],
      rooms: ['d-owner-active'],
    });

    await harness.runtime.reader.tick();

    const row = harness.runtime.repositories.roomRegistry.get('d-owner-active')!;
    expect(row.listed).toBe(1);
    expect(row.last_activity_sweep).toBe(101);
  });
});

describe('omitted, missed and overflow are recorded, never treated as failures', () => {
  it('records omitted as a gap, never as mint_unknown', async () => {
    harness.referee.seedPost(HARNESS_PACKAGE_HASH);
    harness.referee.post('d-close1-flow', {
      t: 'flow',
      season: 'close-1',
      n: 200,
      mints: [],
      rooms: [],
      omitted: 7,
    });

    await harness.runtime.reader.tick();

    const anomalies = anomalyKinds('referee_omitted');
    expect(anomalies).toHaveLength(1);
    expect(anomalies[0]!.affected_count).toBe(7);
    // The existence of the anomaly is not a mint verdict.
    expect(harness.runtime.db.prepare('SELECT COUNT(*) AS n FROM referee_anomalies WHERE kind = ?').get('mint_unknown')).toEqual({ n: 0 });
  });

  it('preserves a missed payload so the message can be re-posted', async () => {
    const missed = { room: 'close1', seq: 42, tid: 987, did: 'did:key:z6Mk'.padEnd(52, 'A') };
    harness.referee.seedPost(HARNESS_PACKAGE_HASH);
    harness.referee.post('d-close1-flow', {
      t: 'flow',
      season: 'close-1',
      n: 201,
      mints: [],
      rooms: [],
      missed: [missed],
    });

    await harness.runtime.reader.tick();

    const rows = harness.runtime.db
      .prepare("SELECT raw_payload, room FROM referee_anomalies WHERE kind = 'referee_missed'")
      .all() as Array<{ raw_payload: string; room: string | null }>;
    expect(rows).toHaveLength(1);
    // The original message is kept verbatim: a re-post needs a fresh nonce, but
    // it must carry the same business content.
    expect(JSON.parse(rows[0]!.raw_payload)).toEqual(missed);
    expect(rows[0]!.room).toBe('close1');
  });

  it('alerts when the listed rooms exceed the cap', async () => {
    harness.referee.seedPost(HARNESS_PACKAGE_HASH);
    harness.referee.post('d-close1-flow', {
      t: 'flow',
      season: 'close-1',
      n: 202,
      mints: [],
      rooms: ['d-owner-1', 'd-owner-2', 'd-owner-3', 'd-owner-4'],
    });

    await harness.runtime.reader.tick();

    // Six fixed rooms plus four discovered ones is well above the cap of three.
    expect(anomalyKinds('room_overflow')).toHaveLength(1);
    // And the fixed referee set is untouched: the reader still reads its own rooms.
    expect(harness.runtime.repositories.roomRegistry.get('close1')!.listed).toBe(1);
  });
});
