/**
 * The seed's room, and what to do when the seed is no longer in it.
 *
 * The official layout puts the seed, the reference, the limits, the global price
 * and the final price in `d-close1-price`; `-flow`, `-positions`, `-pnl` and
 * `-state` carry flow, positions, pnl and the state root. The seed is a
 * *one-time* post, and a room's retained ring only reaches back so far: by the
 * time a process starts late, the seed has been rotated out and re-reading the
 * room can never produce it.
 *
 * Three things therefore have to hold, and this file pins all three:
 *
 *   1. only `d-close1-price` may carry a seed, and a seed-shaped message
 *      anywhere else is refused rather than adopted;
 *   2. when the seed is gone from the ring, the official signed envelope the
 *      launch record published can stand in — verified by the same verifier, so
 *      nothing weaker than a live seed is accepted;
 *   3. a seed that arrives *after* other referee posts makes those stored posts
 *      readable again, without waiting for the next sweep.
 */
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { referenceRules } from '@flop/close-call';
import { didFromSeed, signRoomMessage } from '@flop/identity';
import { roomsFor } from '../apps/orchestrator/src/reader.js';
import {
  HARNESS_PACKAGE_HASH,
  HARNESS_REFEREE_DID,
  HARNESS_REFEREE_SEED,
  buildHarness,
} from './support/orchestrator.js';
import { cleanup, tempDir } from './support/harness.js';

const SEED_ROOM = 'd-close1-price';
const STATE_ROOM = 'd-close1-state';
const IMPOSTOR_SEED = new Uint8Array(32).fill(13);
const IMPOSTOR_DID = didFromSeed(IMPOSTOR_SEED);

/** The seed body, exactly as the referee posts it. */
function seedText(packageHash = HARNESS_PACKAGE_HASH): string {
  return JSON.stringify({
    t: 'seed',
    season: 'close-1',
    price: '225.10',
    trade: { time: '2026-09-25T12:00:00Z', tid: 't0' },
    package: packageHash,
    rooms: [],
  });
}

/** A signed envelope, shaped the way the official launch record publishes one. */
function envelope(options: {
  room?: string;
  text?: string;
  seed?: Uint8Array;
  did?: string;
  nonce?: string;
  seq?: number;
}): Record<string, unknown> {
  const room = options.room ?? SEED_ROOM;
  const text = options.text ?? seedText();
  const seed = options.seed ?? HARNESS_REFEREE_SEED;
  const did = options.did ?? HARNESS_REFEREE_DID;
  const signed = signRoomMessage(did, seed, room, options.nonce ?? '1', text);
  return {
    room,
    message: {
      seq: options.seq ?? 1,
      ts: '2026-09-25T12:00:00.000Z',
      from: signed.did,
      nonce: signed.nonce,
      text: signed.text,
      sig: signed.sig,
    },
  };
}

/** A file holding one JSON value, in a directory the caller cleans up. */
function envelopeFile(dir: string, name: string, value: unknown): string {
  const path = join(dir, name);
  writeFileSync(path, JSON.stringify(value), 'utf8');
  return path;
}

describe('only the price room may carry a seed', () => {
  it('is read first in every scheduler-driven pass', () => {
    // The order is a hint, not the guarantee — the continuous loops issue their
    // requests concurrently — but the seed room still leads the list, because it
    // is the one post that has to be seen before anything else can be applied.
    const rooms = roomsFor(referenceRules());
    expect(rooms[0]).toBe(SEED_ROOM);
    expect(rooms).toContain(STATE_ROOM);
    expect(rooms[rooms.length - 1]).toBe('close1');

    // Even when the rules list the rooms in another order.
    const rules = { ...referenceRules(), refereeRooms: [STATE_ROOM, SEED_ROOM] };
    expect(roomsFor(rules)[0]).toBe(SEED_ROOM);
  });

  it('accepts the seed in d-close1-price and fixes the package from it', async () => {
    const harness = await buildHarness({ agentCount: 4 });
    try {
      harness.referee.seedPost(HARNESS_PACKAGE_HASH);
      await harness.runtime.scheduler.runTick();

      const reader = harness.runtime.reader;
      expect(reader.verifier.state.seedSeen).toBe(true);
      expect(reader.verifier.state.packageHash).toBe(HARNESS_PACKAGE_HASH);
      expect(reader.seedVerified).toBe(true);
      expect(reader.seedSource).toBe('referee_room');
      expect(reader.verifier.state.conservativeReasons).not.toContain('seed_required');
    } finally {
      await harness.dispose();
    }
  });

  it('refuses a correctly signed seed that arrives in the state room', async () => {
    const harness = await buildHarness({ agentCount: 4 });
    try {
      // Signed *for* the state room, so the signature verifies: the refusal is
      // about the room, not about the signature.
      harness.referee.post(STATE_ROOM, {
        t: 'seed',
        season: 'close-1',
        price: '225.10',
        trade: { time: '2026-09-25T12:00:00Z', tid: 't0' },
        package: HARNESS_PACKAGE_HASH,
        rooms: [],
      });
      await harness.runtime.scheduler.runTick();

      const state = harness.runtime.reader.verifier.state;
      expect(state.seedSeen).toBe(false);
      expect(state.packageHash).toBeNull();
      expect(state.conservativeReasons).toContain('seed_wrong_room');
      // The gate stays shut: no seed, so no feed.
      const status = harness.runtime.scheduler.status();
      expect(status.readiness.refereeFeedReady).toBe(false);
      expect(status.readiness.registrationReady).toBe(false);
    } finally {
      await harness.dispose();
    }
  });
});

describe('a late start is given the official signed seed envelope', () => {
  it('accepts the envelope, records where it came from, and rehydrates the feed', async () => {
    const dir = tempDir('flop-seed-bootstrap-');
    const path = envelopeFile(dir, 'seed.json', envelope({}));
    const harness = await buildHarness({
      agentCount: 4,
      env: { REFEREE_SEED_BOOTSTRAP_PATH: path },
    });
    try {
      const reader = harness.runtime.reader;
      expect(reader.verifier.state.seedSeen).toBe(true);
      expect(reader.seedVerified).toBe(true);
      expect(reader.seedSource).toBe('official_signed_bootstrap');
      expect(reader.verifier.state.refereeDid).toBe(HARNESS_REFEREE_DID);
      expect(reader.verifier.state.packageHash).toBe(HARNESS_PACKAGE_HASH);

      const status = harness.runtime.scheduler.status();
      expect(status.seedVerified).toBe(true);
      expect(status.seedSource).toBe('official_signed_bootstrap');
      expect(status.packageHash).toBe(HARNESS_PACKAGE_HASH);
      // The envelope is kept as evidence, with its own hash and seq — never the
      // text, and never anything private.
      const evidence = reader.seedEvidence;
      expect(evidence?.seq).toBe(1);
      expect(evidence?.messageHash).toMatch(/^sha256:[0-9a-f]{64}$/);
      expect(harness.runtime.repositories.referee.count()).toBe(1);
    } finally {
      await harness.dispose();
      cleanup(dir);
    }
  });

  it('accepts the simplified envelope, whose room defaults to the seed room', async () => {
    const dir = tempDir('flop-seed-simple-');
    const signed = envelope({});
    const message = (signed as { message: Record<string, unknown> }).message;
    const path = envelopeFile(dir, 'seed.json', message);
    const harness = await buildHarness({
      agentCount: 4,
      env: { REFEREE_SEED_BOOTSTRAP_PATH: path },
    });
    try {
      expect(harness.runtime.reader.seedSource).toBe('official_signed_bootstrap');
      expect(harness.runtime.reader.verifier.state.seedSeen).toBe(true);
    } finally {
      await harness.dispose();
      cleanup(dir);
    }
  });

  it('refuses an envelope with no signature', async () => {
    const dir = tempDir('flop-seed-unsigned-');
    const signed = envelope({});
    const message = (signed as { message: Record<string, unknown> }).message;
    const path = envelopeFile(dir, 'seed.json', { ...message, sig: '' });
    const harness = await buildHarness({ agentCount: 4 });
    try {
      expect(harness.runtime.reader.applySeedBootstrap(path).reason).toBe('bootstrap_malformed');
      expect(harness.runtime.reader.verifier.state.seedSeen).toBe(false);
      // An invalid bootstrap never widens a gate.
      expect(harness.runtime.scheduler.status().readiness.refereeFeedReady).toBe(false);
    } finally {
      await harness.dispose();
      cleanup(dir);
    }
  });

  it('refuses a bare seed payload with no envelope around it', async () => {
    const dir = tempDir('flop-seed-bare-');
    const path = envelopeFile(dir, 'seed.json', {
      t: 'seed',
      season: 'close-1',
      price: '225.10',
      package: HARNESS_PACKAGE_HASH,
      rooms: [],
    });
    const harness = await buildHarness({ agentCount: 4 });
    try {
      expect(harness.runtime.reader.applySeedBootstrap(path).reason).toBe('bootstrap_malformed');
      expect(harness.runtime.reader.seedVerified).toBe(false);
    } finally {
      await harness.dispose();
      cleanup(dir);
    }
  });

  it('refuses a seed envelope whose room is not the seed room', async () => {
    const dir = tempDir('flop-seed-wrongroom-');
    const path = envelopeFile(dir, 'seed.json', envelope({ room: STATE_ROOM }));
    const harness = await buildHarness({ agentCount: 4 });
    try {
      expect(harness.runtime.reader.applySeedBootstrap(path).reason).toBe('seed_wrong_room');
      expect(harness.runtime.reader.seedVerified).toBe(false);
    } finally {
      await harness.dispose();
      cleanup(dir);
    }
  });

  it('refuses a seed envelope signed by a DID that is not the pinned referee', async () => {
    const dir = tempDir('flop-seed-wrongdid-');
    const path = envelopeFile(
      dir,
      'seed.json',
      envelope({ seed: IMPOSTOR_SEED, did: IMPOSTOR_DID }),
    );
    const harness = await buildHarness({ agentCount: 4 });
    try {
      expect(harness.runtime.reader.applySeedBootstrap(path).reason).toBe(
        'unexpected_referee_did',
      );
      expect(harness.runtime.reader.verifier.state.packageHash).toBeNull();
    } finally {
      await harness.dispose();
      cleanup(dir);
    }
  });

  it('refuses a seed envelope whose package hash disagrees with the pin', async () => {
    const dir = tempDir('flop-seed-drift-');
    const path = envelopeFile(dir, 'seed.json', envelope({ text: seedText('b'.repeat(64)) }));
    const harness = await buildHarness({ agentCount: 4 });
    try {
      expect(harness.runtime.reader.applySeedBootstrap(path).reason).toBe('package_hash_drift');
      // No provenance is recorded for a seed the bootstrap would not stand behind.
      expect(harness.runtime.reader.seedSource).toBeNull();
      expect(harness.runtime.scheduler.status().readiness.refereeFeedReady).toBe(false);
    } finally {
      await harness.dispose();
      cleanup(dir);
    }
  });

  it('refuses a malformed envelope', async () => {
    const dir = tempDir('flop-seed-malformed-');
    const path = envelopeFile(dir, 'seed.json', { room: SEED_ROOM, message: { seq: 1 } });
    const harness = await buildHarness({ agentCount: 4 });
    try {
      expect(harness.runtime.reader.applySeedBootstrap(path).reason).toBe('bootstrap_malformed');
      expect(harness.runtime.reader.seedVerified).toBe(false);
    } finally {
      await harness.dispose();
      cleanup(dir);
    }
  });

  it('records a missing bootstrap file as a warning, not as a seed', async () => {
    const harness = await buildHarness({ agentCount: 4 });
    try {
      const result = harness.runtime.reader.applySeedBootstrap('/nonexistent/seed.json');
      expect(result.ok).toBe(false);
      expect(result.reason).toBe('bootstrap_missing');
      expect(harness.runtime.reader.seedVerified).toBe(false);
    } finally {
      await harness.dispose();
    }
  });
});

describe('a seed that arrives after other referee posts revives them', () => {
  it('applies the stored price and flow the moment the seed lands', async () => {
    const harness = await buildHarness({ agentCount: 4 });
    try {
      // The referee posted a sweep before we ever heard from its price room —
      // exactly the order a concurrent reader produces.
      harness.referee.price(10, '225.10', ['213.85', '236.36']);
      harness.referee.flow(10, []);
      await harness.runtime.scheduler.runTick();

      expect(harness.runtime.reader.verifier.state.seedSeen).toBe(false);
      // The signed evidence is kept even though nothing could be applied.
      expect(harness.runtime.repositories.referee.count()).toBe(2);
      expect(harness.runtime.reader.snapshot().sweep).toBe(0);

      harness.referee.seedPost(HARNESS_PACKAGE_HASH);
      await harness.runtime.scheduler.runTick();

      const snapshot = harness.runtime.reader.snapshot();
      expect(harness.runtime.reader.verifier.state.seedSeen).toBe(true);
      // No waiting for the next sweep: the stored posts are replayed at once.
      expect(snapshot.sweep).toBe(10);
      expect(snapshot.reference?.toString()).toBe('225.10');
      expect(snapshot.nextLimits?.low.toString()).toBe('213.85');
      expect(snapshot.history.map(String)).toEqual(['225.10']);
    } finally {
      await harness.dispose();
    }
  });

  it('does not apply the same stored post twice when it replays again', async () => {
    const harness = await buildHarness({ agentCount: 4 });
    try {
      harness.referee.price(10, '225.10');
      harness.referee.flow(10, []);
      await harness.runtime.scheduler.runTick();
      harness.referee.seedPost(HARNESS_PACKAGE_HASH);
      await harness.runtime.scheduler.runTick();

      // A second hydrate re-reads the same rows. The history must not double.
      harness.runtime.reader.hydrateFromSnapshots();
      expect(harness.runtime.reader.snapshot().history.map(String)).toEqual(['225.10']);
    } finally {
      await harness.dispose();
    }
  });
});

describe('a restart replays the stored history with the seed first', () => {
  it('rebuilds the sweep even when the seed was stored after the price', async () => {
    const dir = tempDir('flop-seed-order-');
    const first = await buildHarness({ agentCount: 4, dir });
    try {
      // Insertion order is price, then seed. Replay order is kind, not insertion:
      // a replay that took the rows in insertion order would refuse the price.
      first.referee.price(10, '225.10', ['213.85', '236.36']);
      first.referee.flow(10, []);
      await first.runtime.scheduler.runTick();
      first.referee.seedPost(HARNESS_PACKAGE_HASH);
      await first.runtime.scheduler.runTick();
      expect(first.runtime.reader.snapshot().sweep).toBe(10);
    } finally {
      await first.runtime.db.close();
    }

    const restarted = await buildHarness({ agentCount: 4, dir });
    try {
      // No read at all: everything below came out of `hydrateFromSnapshots()`.
      expect(restarted.transport.requestCount(SEED_ROOM)).toBe(0);
      const snapshot = restarted.runtime.reader.snapshot();
      expect(snapshot.sweep).toBe(10);
      expect(snapshot.reference?.toString()).toBe('225.10');
      expect(snapshot.history.map(String)).toEqual(['225.10']);
      expect(restarted.runtime.reader.verifier.state.seedSeen).toBe(true);
    } finally {
      await restarted.dispose();
      cleanup(dir);
    }
  });
});
