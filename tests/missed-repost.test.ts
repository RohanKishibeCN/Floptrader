/**
 * `missed` means the referee never read the message, so it does not count.
 *
 * This is the audit trail for the one remedy the rules leave open: re-publishing
 * the *same business content* under a **new outer nonce and signature**, before
 * the lock. The tests here are mostly about restraint:
 *
 *   - only a message that is genuinely ours, matched on room + seq + DID (or the
 *     trade id) is queued at all;
 *   - an unmatched `missed` entry is recorded and alerted about, never re-posted;
 *   - nothing is re-posted past the lock, and nothing into a room the referee
 *     unlisted;
 *   - an `omitted` entry never enters the queue: it is a truncated list, not a
 *     missing message;
 *   - the unique key survives a restart, so a message is queued once.
 */
import { rmSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import { buildTerms, signTrade, type TradeTerms } from '@flop/close-call';
import { ownerRegistrationText } from '../apps/orchestrator/src/writer.js';
import {
  HARNESS_PACKAGE_HASH,
  buildHarness,
  type Harness,
} from './support/orchestrator.js';
import { tempDir } from './support/harness.js';
import type { RepostRow } from '@flop/storage';

let harness: Harness | undefined;
let second: Harness | undefined;

afterEach(async () => {
  if (harness) await harness.dispose();
  harness = undefined;
  if (second) await second.dispose();
  second = undefined;
});

function missed(h: Harness, sweep: number, entries: unknown[]): void {
  h.referee.post('d-close1-flow', {
    t: 'flow',
    season: 'close-1',
    n: sweep,
    mints: [],
    rooms: [],
    missed: entries,
  });
}

function rows(h: Harness): RepostRow[] {
  return h.runtime.repositories.reposts.all();
}

describe('a missed local message is queued once and re-posted with a new nonce', () => {
  it('identifies a missed owner registration and re-posts the same text', async () => {
    harness = await buildHarness({ agentCount: 3, env: { MAX_DISCOVERED_ROOMS: '2' } });
    const h = harness;

    // The registrations are posted, then read back on the next pass so the local
    // `messages` table holds our own bytes.
    await h.runtime.scheduler.runTick();
    await h.runtime.reader.tick();

    const original = h.runtime.db
      .prepare(
        "SELECT room, seq, sender_did, nonce, text FROM messages WHERE kind = 'owner' AND room = 'close1' ORDER BY seq LIMIT 1",
      )
      .get() as { room: string; seq: number; sender_did: string; nonce: string; text: string };
    expect(original.sender_did).toBeTruthy();

    // The verifier refuses a flow post before the seed, exactly as live does.
    h.referee.seedPost(HARNESS_PACKAGE_HASH);
    missed(h, 500, [{ room: 'close1', seq: original.seq, did: original.sender_did }]);
    await h.runtime.reader.tick();

    const result = await h.runtime.scheduler.reconcileReposts();

    expect(result.queued).toBe(1);
    expect(result.posted).toBe(1);
    const queued = rows(h);
    expect(queued).toHaveLength(1);
    const row = queued[0]!;
    expect(row.message_kind).toBe('owner');
    expect(row.original_room).toBe('close1');
    expect(row.original_seq).toBe(original.seq);
    expect(row.original_text).toBe(original.text);
    expect(row.status).toBe('posted');
    expect(row.new_room).toBe('close1');
    // The outer envelope is regenerated: a fresh nonce, and a seq the room gave back.
    expect(row.new_nonce).not.toBe('');
    expect(row.new_nonce).not.toBe(original.nonce);
    expect(row.new_seq).toBeGreaterThan(0);

    // At most one re-post per original message: a second pass writes nothing.
    const postsBefore = h.transport.postsFor('close1').filter((post) => post.body.text === original.text).length;
    const again = await h.runtime.scheduler.reconcileReposts();
    expect(again.posted).toBe(0);
    expect(rows(h)).toHaveLength(1);
    expect(
      h.transport.postsFor('close1').filter((post) => post.body.text === original.text).length,
    ).toBe(postsBefore);
  });

  it('identifies a missed trade and keeps its terms and signatures byte-for-byte', async () => {
    // Live + trading armed is the only configuration in which a trade re-post is
    // a real write. The fleet is full because live refuses a short one.
    harness = await buildHarness({
      agentCount: 150,
      env: {
        FLOP_MODE: 'live',
        FLOP_LIVE_CONFIRM: 'close-1',
        FLOP_ALLOW_REGISTRATION: 'true',
        FLOP_ALLOW_TRADING: 'true',
        MAX_DISCOVERED_ROOMS: '1',
      },
    });
    const h = harness;
    const agentId = h.runtime.keyStore.agentIds[0]!;
    const did = h.runtime.keyStore.did(agentId);
    const room = 'd-owner-trades';

    // A real, fully signed trade message from one of our own DIDs.
    let tradeText = '';
    let tradeId = '';
    let tradeSeq = 0;
    h.runtime.keyStore.withSeed(agentId, (seed) => {
      const terms: TradeTerms = buildTerms({
        id: 'repost-trade-1',
        maker: did,
        side: 'buy',
        qty: '1',
        px: '225.10',
        until: 900,
      });
      // `signTrade` builds the canonical room text; it is the exact bytes the
      // re-post must preserve.
      const signed = signTrade({ terms, taker: did, makerSeed: seed });
      tradeText = signed.text;
      tradeId = terms.id;
      tradeSeq = h.transport.room(room).appendFrom(tradeText, { seed, did, nonce: 7 }).seq;
      return null;
    });
    expect(tradeText).toContain('"t":"trade"');

    h.referee.seedPost(HARNESS_PACKAGE_HASH);
    // Register the room so the dynamic reader actually reads and stores the trade.
    h.referee.post('d-close1-flow', {
      t: 'flow',
      season: 'close-1',
      n: 10,
      mints: [],
      rooms: [room],
    });
    await h.runtime.reader.tick();
    const stored = h.runtime.repositories.messages.get(room, tradeSeq);
    expect(stored?.kind).toBe('trade');

    missed(h, 11, [{ room, seq: tradeSeq, tid: tradeId }]);
    await h.runtime.reader.tick();

    const result = await h.runtime.scheduler.reconcileReposts();
    expect(result.posted).toBe(1);

    const row = rows(h)[0]!;
    expect(row.message_kind).toBe('trade');
    expect(row.trade_id).toBe(tradeId);
    // The business content is untouched; only the outer envelope was regenerated.
    expect(row.original_text).toBe(tradeText);
    expect(row.new_room).toBe(room);
    expect(row.new_nonce).not.toBe('7');
    expect(row.new_seq).toBeGreaterThan(0);
  });
});

describe('what must never be re-posted', () => {
  it('re-posts into close1 when the original room was unlisted', async () => {
    harness = await buildHarness({
      agentCount: 3,
      env: { FLOP_ALLOW_REGISTRATION: 'true', MAX_DISCOVERED_ROOMS: '2' },
    });
    const h = harness;
    const agentId = h.runtime.keyStore.agentIds[0]!;
    const did = h.runtime.keyStore.did(agentId);
    const room = 'd-owner-gone';

    let seq = 0;
    h.runtime.keyStore.withSeed(agentId, (seed) => {
      seq = h.transport
        .room(room)
        .appendFrom(ownerRegistrationText(did), { seed, did, nonce: 3 })
        .seq;
      return null;
    });

    h.referee.seedPost(HARNESS_PACKAGE_HASH);
    h.referee.post('d-close1-flow', {
      t: 'flow',
      season: 'close-1',
      n: 20,
      mints: [],
      rooms: [room],
    });
    await h.runtime.reader.tick();
    expect(h.runtime.repositories.messages.get(room, seq)).toBeDefined();

    // The same post unlists the room and reports the message as missed.
    h.referee.post('d-close1-flow', {
      t: 'flow',
      season: 'close-1',
      n: 32,
      mints: [],
      rooms: ['close1'],
      unlisted: [room],
      missed: [{ room, seq, did }],
    });
    await h.runtime.reader.tick();
    expect(h.runtime.repositories.roomRegistry.get(room)!.listed).toBe(0);

    const result = await h.runtime.scheduler.reconcileReposts();
    expect(result.posted).toBe(1);

    const row = rows(h)[0]!;
    expect(row.status).toBe('posted');
    // Never back into a room the referee stopped reading.
    expect(row.new_room).toBe('close1');
    expect(h.transport.postsFor(room)).toHaveLength(0);
    expect(h.transport.postsFor('close1')).toHaveLength(1);
  });

  it('does not re-post past the lock, and says so', async () => {
    harness = await buildHarness({
      agentCount: 3,
      env: { FLOP_ALLOW_REGISTRATION: 'true', MAX_DISCOVERED_ROOMS: '2' },
    });
    const h = harness;
    const agentId = h.runtime.keyStore.agentIds[0]!;
    const did = h.runtime.keyStore.did(agentId);

    h.runtime.repositories.reposts.enqueue({
      original_room: 'close1',
      original_seq: 41,
      agent_id: agentId,
      did,
      message_kind: 'owner',
      trade_id: null,
      original_text: ownerRegistrationText(did),
      reason: 'referee_missed',
      status: 'pending',
    });
    expect(rows(h)).toHaveLength(1);

    // A sweep past the lock, which is the referee's own signal.
    h.referee.seedPost(HARNESS_PACKAGE_HASH);
    h.referee.price(h.runtime.rules.lockSweep + 1, '225.10');
    await h.runtime.reader.tick();

    const postsBefore = h.transport.postsFor('close1').length;
    const result = await h.runtime.scheduler.reconcileReposts();

    expect(result.posted).toBe(0);
    expect(result.skipped).toBe(1);
    expect(h.transport.postsFor('close1')).toHaveLength(postsBefore);
    const row = rows(h)[0]!;
    expect(row.status).toBe('skipped');
    expect(row.reason).toBe('lock_passed');
  });

  it('records an unmatched missed entry without re-posting anything', async () => {
    harness = await buildHarness({
      agentCount: 3,
      env: { FLOP_ALLOW_REGISTRATION: 'true', MAX_DISCOVERED_ROOMS: '2' },
    });
    const h = harness;
    h.referee.seedPost(HARNESS_PACKAGE_HASH);
    // Nothing in `messages` at that seq: a message we never read, so we cannot
    // know it was ours.
    missed(h, 600, [{ room: 'close1', seq: 4242, did: 'did:key:z6Mk'.padEnd(52, 'A') }]);
    await h.runtime.reader.tick();

    const postsBefore = h.transport.postsFor('close1').length;
    const result = await h.runtime.scheduler.reconcileReposts();

    expect(result.posted).toBe(0);
    expect(h.transport.postsFor('close1')).toHaveLength(postsBefore);
    const row = rows(h)[0]!;
    expect(row.status).toBe('skipped');
    expect(row.reason).toBe('unmatched_local_message');
  });

  it('never queues an omitted entry', async () => {
    harness = await buildHarness({
      agentCount: 3,
      env: { FLOP_ALLOW_REGISTRATION: 'true', MAX_DISCOVERED_ROOMS: '2' },
    });
    const h = harness;
    h.referee.seedPost(HARNESS_PACKAGE_HASH);
    h.referee.post('d-close1-flow', {
      t: 'flow',
      season: 'close-1',
      n: 700,
      mints: [],
      rooms: [],
      omitted: 9,
    });
    await h.runtime.reader.tick();

    await h.runtime.scheduler.reconcileReposts();

    // `omitted` is a truncated list, not a missing message.
    expect(h.runtime.repositories.reposts.count()).toBe(0);
    expect(
      h.runtime.repositories.refereeAnomalies.byKind('referee_omitted'),
    ).toHaveLength(1);
  });
});

describe('the queue survives a restart without re-posting', () => {
  const dir = tempDir('flop-repost-');

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('keeps the same single row and does not post twice', async () => {
    harness = await buildHarness({ agentCount: 3, dir, env: { MAX_DISCOVERED_ROOMS: '2' } });
    await harness.runtime.scheduler.runTick();
    await harness.runtime.reader.tick();

    const original = harness.runtime.db
      .prepare(
        "SELECT seq, sender_did, nonce, text FROM messages WHERE kind = 'owner' AND room = 'close1' ORDER BY seq LIMIT 1",
      )
      .get() as { seq: number; sender_did: string; nonce: string; text: string };
    harness.referee.seedPost(HARNESS_PACKAGE_HASH);
    missed(harness, 800, [{ room: 'close1', seq: original.seq, did: original.sender_did }]);
    await harness.runtime.reader.tick();
    await harness.runtime.scheduler.reconcileReposts();
    expect(rows(harness)).toHaveLength(1);

    const transport = harness.transport;
    const postsBefore = transport.postsFor('close1').length;
    // SIGKILL: no stop, no close. The WAL is left exactly as it was.
    try {
      harness.runtime.db.close();
    } catch {
      /* the harness may already have closed it */
    }

    second = await buildHarness({
      agentCount: 3,
      dir,
      transport,
      env: { MAX_DISCOVERED_ROOMS: '2' },
    });

    const result = await second.runtime.scheduler.reconcileReposts();

    expect(result.queued).toBe(0);
    expect(result.posted).toBe(0);
    expect(rows(second)).toHaveLength(1);
    expect(second.runtime.repositories.reposts.count()).toBe(1);
    expect(transport.postsFor('close1')).toHaveLength(postsBefore);
  });
});
