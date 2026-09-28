/**
 * The fake technocore transport itself.
 *
 * These tests pin the double's contract, because every other offline test trusts
 * it: if the fake read the wrong window, or accepted an unsigned POST, the reader
 * and writer suites would be testing the wrong thing. Each assertion here exists
 * to make a specific downstream claim trustworthy.
 */
import { describe, expect, it } from 'vitest';
import { signRoomMessage } from '@flop/identity';
import { TechnocoreClient } from '@flop/technocore';
import { generateAgents } from './support/harness.js';
import { FakeTransport } from './support/fake-transport.js';

const BASE = 'http://technocore.test';
const agent = generateAgents(1)[0]!;

function clientFor(transport: FakeTransport): TechnocoreClient {
  return new TechnocoreClient({ baseUrl: BASE, fetchImpl: transport.fetchImpl });
}

describe('fake transport: room reads', () => {
  it('returns exactly the messages after since, oldest first, with ring metadata', async () => {
    const transport = new FakeTransport();
    for (let seq = 1; seq <= 5; seq += 1) {
      transport.enqueue('close1', { seq, text: `m${seq}` });
    }

    const read = (await clientFor(transport).readRoom('close1', { since: 2 })).read;
    // `since` is exclusive: m3, m4, m5 only, in ascending seq order.
    expect(read.messages.map((message) => message.seq)).toEqual([3, 4, 5]);
    expect(read.count).toBe(3);
    // first_seq/last_seq describe the retained ring, not the returned slice.
    expect(read.first_seq).toBe(1);
    expect(read.last_seq).toBe(5);
    // A steady room announces no generation; the client falls back to the stored
    // one, which is why the protocol marks the field optional.
    expect(read.generation).toBeUndefined();
  });

  it('reports the new generation once the room is recreated', async () => {
    const transport = new FakeTransport();
    transport.enqueue('close1', { seq: 1, text: 'm1' });
    transport.room('close1').generation = 2;

    const read = (await clientFor(transport).readRoom('close1', { since: 0 })).read;
    // A generation change is the one signal that every known seq is now
    // meaningless, so it must survive the wire trip.
    expect(read.generation).toBe(2);
  });

  it('caps the returned window at limit and never holds a long poll', async () => {
    const transport = new FakeTransport();
    for (let seq = 1; seq <= 5; seq += 1) transport.enqueue('close1', { seq, text: `m${seq}` });

    const read = (await clientFor(transport).readRoom('close1', { limit: 2, since: 0, waitSeconds: 10 })).read;
    expect(read.messages.map((message) => message.seq)).toEqual([1, 2]);
    // The fake must return promptly even with `wait=10`; a real hold would make a
    // test hang instead of fail.
    expect(read.wait_held).toBeUndefined();
  });
});

describe('fake transport: signed posts', () => {
  it('accepts and records a valid signed envelope', async () => {
    const transport = new FakeTransport();
    const envelope = signRoomMessage(agent.did, agent.seed, 'close1', '1', 'hello');
    const result = await clientFor(transport).postSigned('close1', envelope);

    expect(result.ok).toBe(true);
    expect(result.status).toBe(200);
    const posted = transport.postsFor('close1');
    expect(posted).toHaveLength(1);
    expect(posted[0]!.body).toEqual({
      did: envelope.did,
      sig: envelope.sig,
      nonce: envelope.nonce,
      text: envelope.text,
    });
  });

  it('refuses a POST whose first invalid field is named in the response', async () => {
    const transport = new FakeTransport();
    // `text` is missing, so the refusal's first line must name "text" — the
    // writer surfaces exactly this line as the failure reason.
    const response = await transport.fetchImpl(`${BASE}/r/close1`, {
      method: 'POST',
      body: JSON.stringify({ did: agent.did, sig: 'x', nonce: '1' }),
    });
    expect(response.status).toBe(400);
    const body = await response.text();
    expect(body.split('\n')[0]).toContain('text');
    // A refused envelope is never recorded as accepted.
    expect(transport.posts).toHaveLength(0);
  });
});

describe('fake transport: duplicate-text floor', () => {
  it('refuses the sixth identical copy but accepts a reworded one', async () => {
    const transport = new FakeTransport();
    transport.setDupeFilter('close1', 16, 5, 60);
    const client = clientFor(transport);
    const text = 'this text is comfortably long enough';

    const statuses: number[] = [];
    for (let copy = 1; copy <= 6; copy += 1) {
      const envelope = signRoomMessage(agent.did, agent.seed, 'close1', String(copy), text);
      statuses.push((await client.postSigned('close1', envelope)).status);
    }
    expect(statuses).toEqual([200, 200, 200, 200, 200, 422]);

    const reworded = signRoomMessage(agent.did, agent.seed, 'close1', '7', `${text}!`);
    const accepted = await client.postSigned('close1', reworded);
    // A different body is a different message; the floor only catches repeats.
    expect(accepted.ok).toBe(true);
  });

  it('exempts texts below the floor length', async () => {
    const transport = new FakeTransport();
    transport.setDupeFilter('close1', 16, 2, 60);
    const client = clientFor(transport);

    for (let copy = 1; copy <= 10; copy += 1) {
      const envelope = signRoomMessage(agent.did, agent.seed, 'close1', String(copy), 'hi');
      const result = await client.postSigned('close1', envelope);
      // Short chatter cannot be a duplicate by the service's own rule.
      expect(result.ok).toBe(true);
    }
    expect(transport.postsFor('close1')).toHaveLength(10);
  });
});

describe('fake transport: failure injection and request log', () => {
  it('rejects the next request on a simulated socket error, then succeeds', async () => {
    const transport = new FakeTransport();
    transport.enqueue('close1', { seq: 1, text: 'm1' });
    const client = clientFor(transport);

    transport.networkFailNext(1);
    await expect(client.readRoom('close1')).rejects.toThrow();
    // The injected failure is spent; the following request must go through so a
    // retry can be observed as a real success.
    const recovered = await client.readRoom('close1');
    expect(recovered.status).toBe(200);
  });

  it('lists every served request so "one socket for six rooms" is expressible', async () => {
    const transport = new FakeTransport();
    const rooms = ['d-close1-price', 'd-close1-flow', 'd-close1-state', 'd-close1-positions', 'd-close1-pnl', 'close1'];
    const client = clientFor(transport);
    for (const room of rooms) await client.readRoom(room);

    expect(transport.requests).toHaveLength(6);
    expect(transport.readCount).toBe(6);
    // Exactly one read per room, and nothing extra had to be opened to do it.
    for (const room of rooms) expect(transport.requestCount(room)).toBe(1);
    expect(transport.requests.every((request) => request.method === 'GET')).toBe(true);
  });
});
