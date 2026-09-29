/**
 * The bounded dynamic room reader.
 *
 * `room_registry.test.ts` proves the *bookkeeping*: which rooms the referee says
 * are listed, and which it unlisted. This file proves the registry actually
 * feeds the reader:
 *
 *   - a room `flow.rooms` announces joins the dynamic set and is read;
 *   - an unlisted room leaves it and is not read;
 *   - `close1` and the five referee rooms are never subject to the cap;
 *   - overflowing the cap is an alert, not more sockets;
 *   - a discovered room costs one long poll per pass, never an unbounded fan-out;
 *   - the whole process still respects `MAX_INFLIGHT`.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { buildHarness, HARNESS_PACKAGE_HASH, HARNESS_ROOMS, type Harness } from './support/orchestrator.js';

let harness: Harness | undefined;

afterEach(async () => {
  if (harness) await harness.dispose();
  harness = undefined;
});

function flow(h: Harness, sweep: number, rooms: string[], unlisted: string[] = []): void {
  h.referee.post('d-close1-flow', {
    t: 'flow',
    season: 'close-1',
    n: sweep,
    mints: [],
    rooms,
    unlisted,
  });
}

describe('discovered owner rooms are actually read', () => {
  it('adds a room flow.rooms announces and reads it once in the same pass', async () => {
    harness = await buildHarness({
      agentCount: 4,
      env: { FLOP_ALLOW_REGISTRATION: 'false', MAX_DISCOVERED_ROOMS: '3' },
    });
    harness.referee.seedPost(HARNESS_PACKAGE_HASH);
    flow(harness, 100, ['d-owner-new']);

    expect(harness.runtime.reader.dynamicRooms).toEqual([]);
    await harness.runtime.reader.tick();

    expect(harness.runtime.reader.dynamicRooms).toContain('d-owner-new');
    // Read exactly once: one long poll for the room, not one per regeneration.
    expect(harness.transport.requestCount('d-owner-new')).toBe(1);
  });

  it('removes a room the referee unlisted', async () => {
    harness = await buildHarness({
      agentCount: 4,
      env: { FLOP_ALLOW_REGISTRATION: 'false', MAX_DISCOVERED_ROOMS: '3' },
    });
    harness.referee.seedPost(HARNESS_PACKAGE_HASH);
    flow(harness, 100, ['d-owner-a']);
    await harness.runtime.reader.tick();
    expect(harness.runtime.reader.dynamicRooms).toContain('d-owner-a');

    flow(harness, 112, ['close1'], ['d-owner-a']);
    await harness.runtime.reader.tick();

    expect(harness.runtime.reader.dynamicRooms).not.toContain('d-owner-a');
    expect(harness.runtime.repositories.roomRegistry.get('d-owner-a')!.listed).toBe(0);
    // The unlisted room keeps its cursor but is no longer polled.
    const before = harness.transport.requestCount('d-owner-a');
    await harness.runtime.reader.tick();
    expect(harness.transport.requestCount('d-owner-a')).toBe(before);
  });

  it('keeps close1 and the five referee rooms out of the dynamic set, always', async () => {
    harness = await buildHarness({
      agentCount: 4,
      env: { FLOP_ALLOW_REGISTRATION: 'false', MAX_DISCOVERED_ROOMS: '2' },
    });
    harness.referee.seedPost(HARNESS_PACKAGE_HASH);
    // Even a flow post that claims close1 is unlisted does not move it.
    flow(harness, 200, ['d-owner-x'], ['close1']);
    await harness.runtime.reader.tick();

    const fixed = harness.runtime.reader.fixedRoomList;
    expect([...fixed].sort()).toEqual([...HARNESS_ROOMS].sort());
    for (const room of HARNESS_ROOMS) {
      expect(harness.runtime.reader.dynamicRooms).not.toContain(room);
      expect(harness.transport.requestCount(room)).toBe(1);
    }
    expect(harness.runtime.repositories.roomRegistry.get('close1')!.listed).toBe(1);
  });
});

describe('the cap bounds discovery without touching the fixed feed', () => {
  it('reads only MAX_DISCOVERED_ROOMS and alerts about the rest', async () => {
    harness = await buildHarness({
      agentCount: 4,
      env: { FLOP_ALLOW_REGISTRATION: 'false', MAX_DISCOVERED_ROOMS: '2' },
    });
    harness.referee.seedPost(HARNESS_PACKAGE_HASH);
    flow(harness, 300, ['d-owner-1', 'd-owner-2', 'd-owner-3', 'd-owner-4']);
    await harness.runtime.reader.tick();

    expect(harness.runtime.reader.dynamicRooms).toHaveLength(2);
    // The fixed referee set is read in full, however many rooms are discovered.
    for (const room of HARNESS_ROOMS) expect(harness.transport.requestCount(room)).toBe(1);
    // The two rooms that lost the cap were not polled at all.
    const read = new Set(harness.runtime.reader.dynamicRooms);
    for (const room of ['d-owner-1', 'd-owner-2', 'd-owner-3', 'd-owner-4']) {
      expect(harness.transport.requestCount(room)).toBe(read.has(room) ? 1 : 0);
    }

    const overflow = harness.runtime.db
      .prepare("SELECT COUNT(*) AS n FROM referee_anomalies WHERE kind = 'room_overflow'")
      .get() as { n: number };
    expect(overflow.n).toBeGreaterThanOrEqual(1);
  });

  it('costs exactly one long poll per dynamic room per pass', async () => {
    harness = await buildHarness({
      agentCount: 4,
      env: { FLOP_ALLOW_REGISTRATION: 'false', MAX_DISCOVERED_ROOMS: '2' },
    });
    harness.referee.seedPost(HARNESS_PACKAGE_HASH);
    flow(harness, 400, ['d-owner-1', 'd-owner-2']);

    for (let pass = 1; pass <= 3; pass += 1) {
      await harness.runtime.reader.tick();
      for (const room of harness.runtime.reader.dynamicRooms) {
        expect(harness.transport.requestCount(room)).toBe(pass);
      }
    }
    // Six fixed rooms plus two dynamic rooms, three passes: 24 reads, not a fan-out.
    expect(harness.transport.readCount).toBe((HARNESS_ROOMS.length + 2) * 3);
  });

  it('still respects MAX_INFLIGHT across the fixed and the dynamic readers', async () => {
    harness = await buildHarness({
      agentCount: 4,
      env: {
        FLOP_ALLOW_REGISTRATION: 'false',
        MAX_DISCOVERED_ROOMS: '3',
        MAX_INFLIGHT: '2',
        READ_CONCURRENCY: '2',
        DYNAMIC_ROOM_READ_CONCURRENCY: '2',
      },
    });
    harness.referee.seedPost(HARNESS_PACKAGE_HASH);
    flow(harness, 500, ['d-owner-1', 'd-owner-2', 'd-owner-3']);
    await harness.runtime.reader.tick();

    expect(harness.runtime.reader.dynamicRooms).toHaveLength(3);
    // Nine rooms are read through one shared client whose semaphore is 2.
    expect(harness.transport.maxInFlight).toBeLessThanOrEqual(2);
  });
});
