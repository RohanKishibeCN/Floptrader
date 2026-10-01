/**
 * Participation evidence: the minimum record this project has to produce.
 *
 * Every one of the 150 agents must
 *
 *   1. post a signed `{"t":"owner","season":"close-1","key":"<did>"}` to `close1`;
 *   2. have that exact message echoed back by the room, with a seq and a
 *      timestamp, which is what makes it evidence rather than an intention;
 *   3. keep the whole thing — text, nonce, signature, room, seq, timestamp,
 *      readback time, referee DID, package hash — for the life of the contest.
 *
 * The status ladder has one rule that is easy to get wrong and expensive to get
 * wrong: `mint_unknown` is not `failed`. A sweep the referee posted a price for
 * but no flow for leaves that sweep's mints unknown, and the correct response is
 * to say so, keep reading, and never to record the agent as having failed.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { signRoomMessage, verifyRoomSignatureForRoom } from '@flop/identity';
import { ownerRegistrationText } from '../apps/orchestrator/src/writer.js';
import { buildHarness, HARNESS_PACKAGE_HASH, HARNESS_ROOMS, type Harness } from './support/orchestrator.js';

describe('owner registration and readback', () => {
  let harness: Harness;

  beforeEach(async () => {
    harness = await buildHarness();
  }, 120_000);

  afterEach(async () => {
    await harness.dispose();
  });

  it('posts one signed registration per agent and nothing else', async () => {
    const outcome = await harness.runtime.scheduler.ensureParticipation();

    expect(outcome.posted).toBe(150);
    expect(outcome.failed).toBe(0);
    expect(harness.runtime.repositories.participation.count()).toBe(150);

    const posts = harness.transport.postsFor('close1');
    expect(posts).toHaveLength(150);
    // The canonical text, for every agent, with that agent's own DID as the key.
    for (const post of posts) {
      expect(JSON.parse(post.body.text!)).toEqual({
        t: 'owner',
        season: 'close-1',
        key: post.body.did,
      });
      expect(post.body.text).toBe(ownerRegistrationText(post.body.did!));
    }
    // No other room was written to: no per-agent rooms, no heartbeat topic.
    expect([...new Set(harness.transport.posts.map((post) => post.room))]).toEqual(['close1']);
  }, 120_000);

  it('records readback evidence with seq, timestamp, nonce and a verifiable signature', async () => {
    await harness.runtime.scheduler.ensureParticipation();
    // The reader's next pass is what turns a post into evidence: the room has to
    // hand the bytes back before they count.
    await harness.runtime.scheduler.runTick();

    const rows = harness.runtime.repositories.participation.all();
    expect(rows).toHaveLength(150);
    for (const row of rows) {
      expect(row.readback_at).not.toBeNull();
      expect(row.technocore_seq).not.toBeNull();
      expect(row.technocore_ts).not.toBeNull();
      expect(row.registration_nonce).toMatch(/^[0-9]{1,19}$/);
      expect(row.registration_signature.length).toBeGreaterThan(0);
      expect(row.room).toBe('close1');
      expect(row.season).toBe('close-1');
      // The signature is over `<room>|<nonce>|<text>` and must actually verify.
      expect(
        verifyRoomSignatureForRoom(
          row.did,
          row.registration_nonce,
          row.registration_text,
          row.registration_signature,
          'close1',
        ),
      ).toBe(true);
    }
    const statuses = harness.runtime.repositories.participation.countByStatus();
    expect(statuses.before_lock_confirmed).toBe(150);
    expect(statuses.failed ?? 0).toBe(0);
    // Readback is durable, not just a column: the registration record itself is
    // retained forever.
    expect(harness.runtime.repositories.participation.ownerRegistrationCount()).toBe(150);
  }, 120_000);

  it('is idempotent: a second pass posts nothing and re-confirms nothing', async () => {
    await harness.runtime.scheduler.ensureParticipation();
    await harness.runtime.scheduler.runTick();
    const postsAfterFirst = harness.transport.postsFor('close1').length;

    const second = await harness.runtime.scheduler.ensureParticipation();

    expect(second.posted).toBe(0);
    expect(harness.transport.postsFor('close1').length).toBe(postsAfterFirst);
    expect(harness.runtime.repositories.participation.ownerRegistrationCount()).toBe(150);
  }, 120_000);

  it('never writes a plaintext seed, and keeps the evidence readable only by the owner', async () => {
    await harness.runtime.scheduler.ensureParticipation();
    await harness.runtime.scheduler.runTick();

    // The private directory holds the encrypted bundle and the age key only.
    const secrets = harness.config.secretsDir;
    for (const name of ['agents.bundle.age', 'admin.key.age', 'runtime.key']) {
      expect(existsSync(join(secrets, name))).toBe(true);
    }
    const bundle = readFileSync(join(secrets, 'agents.bundle.age'));
    // age's default output is binary, so the file must not be readable JSON and
    // must not contain any of the plaintext it was built from.
    expect(bundle.byteLength).toBeGreaterThan(0);
    const asText = bundle.toString('utf8');
    expect(asText.startsWith('{')).toBe(false);
    expect(asText).not.toContain('"seed"');
    for (const agentId of harness.runtime.keyStore.agentIds.slice(0, 5)) {
      expect(asText).not.toContain(harness.runtime.keyStore.did(agentId));
    }
    // The public inventory must not carry any secret marker.
    const manifest = readFileSync(
      join(harness.config.paths.public, 'agents.manifest.json'),
      'utf8',
    );
    for (const forbidden of ['seed', 'AGE-SECRET-KEY', 'private', 'appSecret', 'apiKey']) {
      expect(manifest.toLowerCase()).not.toContain(forbidden.toLowerCase());
    }
    // 150 DIDs, and the manifest is the only place they are published.
    expect(JSON.parse(manifest).agent_count).toBe(150);
  }, 120_000);
});

describe('mint reconciliation', () => {
  let harness: Harness;

  beforeEach(async () => {
    harness = await buildHarness({ agentCount: 8 });
    // The referee rooms exist from the start; a real service always has them.
    for (const room of HARNESS_ROOMS) harness.transport.room(room);
    // The seed comes first: past the pin, the verifier refuses price and flow
    // posts that arrive before it, which is exactly what production does.
    harness.referee.seedPost(HARNESS_PACKAGE_HASH);
  }, 120_000);

  afterEach(async () => {
    await harness.dispose();
  });

  it('marks mint_observed when a flow post names our DIDs', async () => {
    await harness.runtime.scheduler.ensureParticipation();
    await harness.runtime.scheduler.runTick();

    const dids = harness.runtime.keyStore.agentIds.map((agentId) =>
      harness.runtime.keyStore.did(agentId),
    );
    harness.referee.price(100, '225.10');
    harness.referee.flow(100, dids.slice(0, 3));
    // The tick's own report carries the reconciliation result; the separate
    // `reconcileMints` call has nothing left to do by the time it returns.
    const report = await harness.runtime.scheduler.runTick();

    expect(report.participation.minted).toBeGreaterThanOrEqual(3);
    const rows = harness.runtime.repositories.participation.all();
    const minted = rows.filter((row) => row.status === 'mint_observed');
    expect(minted.length).toBeGreaterThanOrEqual(3);
    // The referee's own flow evidence is recorded in its own column, separately
    // from the room's echo: "the referee listed us" and "the room returned our
    // bytes" are different facts and one is never inferred from the other.
    const flowEvidence = rows.filter((row) => row.flow_evidence_at !== null);
    expect(flowEvidence.length).toBeGreaterThanOrEqual(3);
    // The observer's own local risk mirror only ever holds minted DIDs.
    expect(harness.runtime.scheduler.mintedDids().size).toBeGreaterThanOrEqual(3);
  }, 120_000);

  it('records state-listing evidence from the referee state room', async () => {
    await harness.runtime.scheduler.ensureParticipation();
    await harness.runtime.scheduler.runTick();

    const dids = harness.runtime.keyStore.agentIds.map((agentId) =>
      harness.runtime.keyStore.did(agentId),
    );
    // The `owners` shape is not pinned by the published schema, so the state post
    // is read defensively; what must hold is that a DID it does list is recorded
    // as *state* evidence and not as flow evidence.
    harness.referee.post('d-close1-state', { t: 'state', n: 1, owners: [dids[0]!, dids[1]!] });
    await harness.runtime.scheduler.runTick();

    const rows = harness.runtime.repositories.participation.all();
    const stateEvidence = rows.filter((row) => row.state_evidence_at !== null);
    expect(stateEvidence.map((row) => row.did).sort()).toEqual([dids[0]!, dids[1]!].sort());
    expect(rows.every((row) => row.flow_evidence_at === null)).toBe(true);
  }, 120_000);

  it('records mint_unknown, never failed, when a sweep posted a price but no flow', async () => {
    await harness.runtime.scheduler.ensureParticipation();
    await harness.runtime.scheduler.runTick();

    // A price for sweep 200, and then a later sweep, with no flow for 200 at all.
    harness.referee.price(200, '225.10');
    harness.referee.price(202, '225.10');
    await harness.runtime.scheduler.runTick();
    await harness.runtime.scheduler.runTick();

    const missing = harness.runtime.scheduler.sweepsWithMissingFlow();
    expect(missing).toContain(200);

    harness.runtime.scheduler.reconcileMints();
    const statuses = harness.runtime.repositories.participation.countByStatus();
    expect(statuses.mint_unknown ?? 0).toBeGreaterThan(0);
    // The load-bearing assertion: an unknown mint is never a failure.
    expect(statuses.failed ?? 0).toBe(0);

    // And it survives as unknown rather than decaying into anything else.
    const rows = harness.runtime.repositories.participation.all();
    expect(rows.every((row) => row.status !== 'failed')).toBe(true);
  }, 120_000);

  it('prefers mint_observed over mint_unknown once the flow arrives', async () => {
    await harness.runtime.scheduler.ensureParticipation();
    await harness.runtime.scheduler.runTick();
    harness.referee.price(200, '225.10');
    harness.referee.price(202, '225.10');
    await harness.runtime.scheduler.runTick();
    await harness.runtime.scheduler.runTick();
    harness.runtime.scheduler.reconcileMints();

    const afterUnknown = harness.runtime.repositories.participation.all();
    expect(afterUnknown.some((row) => row.status === 'mint_unknown')).toBe(true);

    const first = harness.runtime.keyStore.did(harness.runtime.keyStore.agentIds[0]!);
    harness.referee.flow(200, [first]);
    await harness.runtime.scheduler.runTick();
    harness.runtime.scheduler.reconcileMints();

    const row = harness.runtime.repositories.participation.get(
      harness.runtime.keyStore.agentIds[0]!,
    );
    expect(row?.status).toBe('mint_observed');
  }, 120_000);
});

describe('registration gating', () => {
  it('posts nothing when FLOP_ALLOW_REGISTRATION is off, and says so', async () => {
    const harness = await buildHarness({
      agentCount: 4,
      env: { FLOP_ALLOW_REGISTRATION: 'false' },
    });
    try {
      const outcome = await harness.runtime.scheduler.ensureParticipation();
      expect(outcome.posted).toBe(0);
      expect(harness.transport.postsFor('close1')).toHaveLength(0);
      const events = harness.runtime.repositories.events.recent(20);
      expect(events.some((event) => event.code === 'registration_disabled')).toBe(true);
    } finally {
      await harness.dispose();
    }
  }, 120_000);
});

/**
 * A signature that does not verify must never be accepted as our readback.
 *
 * Registration is switched off for this test so the only owner post in the room
 * is the forged one; otherwise a genuine registration from the same agent would
 * legitimately supply the readback and the assertion would prove nothing.
 */
describe('readback rejects a forged registration', () => {
  let harness: Harness;

  beforeEach(async () => {
    harness = await buildHarness({ agentCount: 2, env: { FLOP_ALLOW_REGISTRATION: 'false' } });
  }, 120_000);

  afterEach(async () => {
    await harness.dispose();
  });

  it('does not confirm a readback whose signature does not verify', async () => {
    const agentId = harness.runtime.keyStore.agentIds[0]!;
    const did = harness.runtime.keyStore.did(agentId);

    // A message from our DID, carrying a signature over unrelated bytes. This is
    // exactly what a replayed or fabricated registration record looks like.
    const forged = signRoomMessage(did, new Uint8Array(32).fill(9), 'close1', '1', 'something else');
    harness.transport.enqueue('close1', {
      from: did,
      text: ownerRegistrationText(did),
      nonce: 1,
      sig: forged.sig,
    });

    await harness.runtime.scheduler.runTick();
    harness.runtime.scheduler.reconcileMints();

    const row = harness.runtime.repositories.participation.get(agentId);
    expect(row?.readback_at ?? null).toBeNull();
    expect(harness.runtime.repositories.participation.ownerRegistrationCount()).toBe(0);
    // The message is still stored — as an unverifiable record, not as evidence.
    const stored = harness.runtime.repositories.messages.byKind('close1', 'owner');
    expect(stored).toHaveLength(1);
    expect(stored[0]!.signature_valid).toBe(0);
  }, 120_000);
});
