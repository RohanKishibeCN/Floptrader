/**
 * Phase 1 acceptance: the 150 identities.
 *
 *   - 150 DIDs, all unique, all matching the official fold's DID pattern
 *   - a restart (re-deriving from the same seeds) does not change any DID
 *   - corrupt key material fails closed instead of starting degraded
 *   - exactly 5 strategy groups of exactly 30
 *   - the public inventory carries no secret
 */
import { describe, expect, it } from 'vitest';
import {
  AGENTS_PER_GROUP,
  AgentKeyStore,
  DID_PATTERN,
  DEFAULT_AGENT_COUNT,
  STRATEGY_GROUPS,
  assignStrategyGroup,
  buildInventory,
  didToPublicKey,
  fingerprintOf,
  fingerprintOfDid,
  makeAgentSecretRecord,
  publicKeyToMultibase,
  serializeInventory,
  assertNoSecrets,
  parseInventory,
  signInventory,
  verifyInventorySignature,
  serializeBundle,
  parseBundle,
  encryptBundle,
  decryptBundle,
  createAgeIdentity,
  ageRecipientFor,
} from '@flop/identity';
import { generateAgents, generatedStore, groupCounts, storeFrom } from './support/harness.js';

describe('150 did:key Ed25519 identities', () => {
  it('generates exactly 150 agents with unique DIDs', () => {
    const agents = generateAgents();
    expect(agents).toHaveLength(DEFAULT_AGENT_COUNT);
    expect(DEFAULT_AGENT_COUNT).toBe(150);

    const dids = new Set(agents.map((agent) => agent.did));
    expect(dids.size).toBe(150);

    const fingerprints = new Set(agents.map((agent) => agent.fingerprint));
    expect(fingerprints.size).toBe(150);

    const seeds = new Set(agents.map((agent) => Buffer.from(agent.seed).toString('hex')));
    expect(seeds.size).toBe(150);
  });

  it('produces DIDs the official fold regex accepts', () => {
    for (const agent of generateAgents()) {
      expect(agent.did).toMatch(DID_PATTERN);
      expect(agent.did.startsWith('did:key:z6Mk')).toBe(true);
      // "did:key:" (8) + multibase "z" (1) + "6Mk" (3) + 44 base58 chars
      expect(agent.did).toHaveLength(56);
      // The multibase public key on its own is 48 characters.
      expect(agent.publicKeyMultibase).toHaveLength(48);
    }
  });

  it('round-trips a DID back to the same public key and fingerprint', () => {
    const agents = generateAgents();
    for (const agent of agents.slice(0, 10)) {
      const publicKey = didToPublicKey(agent.did);
      expect(publicKeyToMultibase(publicKey)).toBe(agent.publicKeyMultibase);
      expect(fingerprintOf(publicKey)).toBe(agent.fingerprint);
      expect(fingerprintOfDid(agent.did)).toBe(agent.fingerprint);
      expect(agent.fingerprint).toMatch(/^sha256:[0-9a-f]{64}$/);
    }
  });

  it('keeps every DID stable across a restart', () => {
    const first = generatedStore();
    const firstDids = first.agentIds.map((id) => first.did(id));

    // "Restart": the same seeds, decoded into a brand new store.
    const second = storeFrom(generateAgents());
    const secondDids = second.agentIds.map((id) => second.did(id));

    expect(secondDids).toEqual(firstDids);
    expect(new Set(secondDids)).toEqual(new Set(firstDids));
  });

  it('accepts a store built from a re-serialised bundle without changing DIDs', () => {
    const agents = generateAgents();
    const rebuilt = agents.map((agent, index) =>
      makeAgentSecretRecord(index, Uint8Array.from(agent.seed), assignStrategyGroup(index)),
    );
    const original = storeFrom(agents);
    const restored = storeFrom(rebuilt);
    expect(restored.agentIds.map((id) => restored.did(id))).toEqual(
      original.agentIds.map((id) => original.did(id)),
    );
  });
});

describe('fail-closed key handling', () => {
  it('refuses a seed of the wrong length', () => {
    const agents = generateAgents(2);
    const broken = { ...agents[0]!, seed: new Uint8Array(31) };
    expect(() => new AgentKeyStore({ agents: [broken, agents[1]!] })).toThrow(/corrupt seed/);
  });

  it('refuses a seed that does not derive its recorded DID', () => {
    const agents = generateAgents(2);
    const broken = { ...agents[0]!, did: agents[1]!.did };
    expect(() => new AgentKeyStore({ agents: [broken] })).toThrow(/does not match recorded DID/);
  });

  it('refuses a wrong public key multibase', () => {
    const agents = generateAgents(2);
    const broken = { ...agents[0]!, publicKeyMultibase: agents[1]!.publicKeyMultibase };
    expect(() => new AgentKeyStore({ agents: [broken] })).toThrow(/multibase mismatch/);
  });

  it('refuses a duplicate DID across two agent ids', () => {
    const agents = generateAgents(2);
    const duplicate = { ...agents[1]!, did: agents[0]!.did, seed: agents[0]!.seed };
    expect(() => new AgentKeyStore({ agents: [agents[0]!, duplicate] })).toThrow(
      /does not match recorded DID|multibase mismatch|duplicate/,
    );
  });

  it('throws for an unknown agent rather than returning undefined', () => {
    const store = generatedStore();
    expect(() => store.did('agent-9999')).toThrow(/unknown agent id/);
  });

  it('zeroes seed material on destroy', () => {
    const agents = generateAgents(3);
    const store = new AgentKeyStore({ agents });
    const before = Buffer.from(agents[0]!.seed);
    store.destroy();
    expect(Buffer.from(agents[0]!.seed).equals(before)).toBe(false);
    expect(agents[0]!.seed.every((byte) => byte === 0)).toBe(true);
  });
});

describe('strategy groups', () => {
  it('is exactly 5 groups of exactly 30 agents', () => {
    const counts = groupCounts(generateAgents());
    expect(Object.keys(counts).sort()).toEqual([...STRATEGY_GROUPS].sort());
    for (const group of STRATEGY_GROUPS) {
      expect(counts[group]).toBe(AGENTS_PER_GROUP);
      expect(AGENTS_PER_GROUP).toBe(30);
    }
    expect(Object.values(counts).reduce((a, b) => a + b, 0)).toBe(150);
  });

  it('assigns groups deterministically', () => {
    const first = generateAgents().map((agent) => agent.strategyGroup);
    const second = generateAgents().map((agent) => agent.strategyGroup);
    expect(second).toEqual(first);
  });

  it('exposes a DID set for the local-trade refusal', () => {
    const store = generatedStore();
    const dids = store.didSet();
    expect(dids.size).toBe(150);
    const firstId = store.agentIds[0]!;
    expect(dids.has(store.did(firstId))).toBe(true);
    expect(store.agentIdForDid(store.did(firstId))).toBe(firstId);
    expect(store.agentIdForDid('did:key:z6MkfN3kGrbLpJcS8TrTNVEo37tN9XWmFCmNC9CLQsdFNvGb')).toBeNull();
  });
});

describe('public inventory', () => {
  it('publishes 150 agents without any secret material', () => {
    const store = generatedStore();
    const inventory = buildInventory(store.publicRecords(), {
      season: 'close-1',
      packageHash: 'a'.repeat(64),
      createdAt: '2026-09-28T00:00:00.000Z',
    });
    expect(inventory.schema).toBe('flop-close-call-agent-inventory-v1');
    expect(inventory.season).toBe('close-1');
    expect(inventory.agents).toHaveLength(150);
    expect(inventory.agent_count).toBe(150);

    const serialized = serializeInventory(inventory);
    expect(() => assertNoSecrets(serialized)).not.toThrow();
    expect(serialized).not.toMatch(/seed|private|AGE-SECRET|DEEPSEEK|LARK_APP_SECRET/i);

    for (const entry of inventory.agents) {
      expect(Object.keys(entry).sort()).toEqual([
        'agent_id',
        'did',
        'fingerprint',
        'public_key_multibase',
        'strategy_group',
      ]);
    }
  });

  it('catches a leaked seed if one is ever added to the export', () => {
    const leaked = JSON.stringify({ agents: [{ seed: 'AAAA' }] });
    expect(() => assertNoSecrets(leaked)).toThrow(/forbidden seed/);
    expect(() => assertNoSecrets('AGE-SECRET-KEY-1ABCDEF')).toThrow(/forbidden age identity/);
    expect(() => assertNoSecrets('{"DEEPSEEK_API_KEY":"x"}')).toThrow(/forbidden deepseek key/);
  });

  it('signs and verifies the manifest with an offline admin key', () => {
    const store = generatedStore();
    const inventory = buildInventory(store.publicRecords(), {
      season: 'close-1',
      packageHash: 'b'.repeat(64),
      createdAt: '2026-09-28T00:00:00.000Z',
    });
    const adminSeed = generateAgents(151)[150]!.seed;
    const manifest = signInventory(inventory, adminSeed, '2026-09-28T00:00:01.000Z');
    expect(manifest.schema).toBe('flop-close-call-manifest-signature-v1');
    expect(manifest.agent_count).toBe(150);
    expect(verifyInventorySignature(inventory, manifest)).toBe(true);

    // Any tampering invalidates it: a swapped DID, a flipped signature bit, a
    // digest that does not match, or a re-sign by a different admin key.
    const tampered = structuredClone(inventory);
    tampered.agents[0]!.did = tampered.agents[1]!.did;
    expect(verifyInventorySignature(tampered, manifest)).toBe(false);
    const flipped = `${manifest.signature.slice(0, 85)}${manifest.signature.endsWith('A') ? 'Q' : 'A'}`;
    expect(verifyInventorySignature(inventory, { ...manifest, signature: flipped })).toBe(false);
    expect(verifyInventorySignature(inventory, { ...manifest, inventory_digest: 'sha256:00' })).toBe(
      false,
    );
    const otherAdmin = generateAgents(152)[151]!.seed;
    const foreignManifest = signInventory(inventory, otherAdmin, 'x');
    // Internally consistent, but not signed by the pinned admin key.
    expect(verifyInventorySignature(inventory, foreignManifest)).toBe(true);
    expect(verifyInventorySignature(inventory, foreignManifest, manifest.admin_did)).toBe(false);
    expect(verifyInventorySignature(inventory, manifest, manifest.admin_did)).toBe(true);
  });

  it('round-trips the inventory through serialisation', () => {
    const store = generatedStore();
    const inventory = buildInventory(store.publicRecords(), {
      season: 'close-1',
      packageHash: 'c'.repeat(64),
      createdAt: '2026-09-28T00:00:00.000Z',
    });
    const restored = parseInventory(serializeInventory(inventory));
    expect(restored).toEqual(inventory);
    const broken = structuredClone(inventory);
    broken.agents[0]!.public_key_multibase = broken.agents[1]!.public_key_multibase;
    expect(() => parseInventory(JSON.stringify(broken))).toThrow(/multibase does not match DID/);
  });
});

describe('encrypted key bundle', () => {
  it('encrypts to two recipients and decrypts with either identity', async () => {
    const agents = generateAgents();
    const plaintext = serializeBundle(agents, {
      season: 'close-1',
      packageHash: 'd'.repeat(64),
      createdAt: '2026-09-28T00:00:00.000Z',
      agentCount: agents.length,
    });
    const vpsIdentity = await createAgeIdentity();
    const adminIdentity = await createAgeIdentity();
    const ciphertext = await encryptBundle(plaintext, [
      await ageRecipientFor(vpsIdentity),
      await ageRecipientFor(adminIdentity),
    ]);

    // Ciphertext must not leak key material in the clear.
    expect(Buffer.from(ciphertext).toString('utf8')).not.toContain('did:key');
    expect(Buffer.from(ciphertext).toString('utf8')).not.toContain('z6Mk');

    for (const identity of [vpsIdentity, adminIdentity]) {
      const decrypted = await decryptBundle(ciphertext, [identity]);
      const parsed = parseBundle(decrypted);
      expect(parsed.agents).toHaveLength(150);
      expect(parsed.meta.season).toBe('close-1');
      expect(parsed.agents.map((agent) => agent.did)).toEqual(agents.map((agent) => agent.did));
    }
  });

  it('refuses to decrypt with an unrelated identity', async () => {
    const agents = generateAgents(5);
    const plaintext = serializeBundle(agents, {
      season: 'close-1',
      packageHash: 'e'.repeat(64),
      createdAt: '2026-09-28T00:00:00.000Z',
      agentCount: 5,
    });
    const owner = await createAgeIdentity();
    const stranger = await createAgeIdentity();
    const ciphertext = await encryptBundle(plaintext, [await ageRecipientFor(owner)]);
    await expect(decryptBundle(ciphertext, [stranger])).rejects.toThrow(/could not decrypt/);
  });

  it('fails closed on a bundle whose agent_count disagrees', () => {
    const agents = generateAgents(3);
    const text = serializeBundle(agents, {
      season: 'close-1',
      packageHash: 'f'.repeat(64),
      createdAt: '2026-09-28T00:00:00.000Z',
      agentCount: 3,
    });
    const broken = JSON.parse(text) as { agent_count: number };
    broken.agent_count = 4;
    expect(() => parseBundle(JSON.stringify(broken))).toThrow(/disagrees/);
  });

  it('fails closed on a bundle with a truncated seed', () => {
    const agents = generateAgents(2);
    const text = serializeBundle(agents, {
      season: 'close-1',
      packageHash: 'g'.repeat(64),
      createdAt: '2026-09-28T00:00:00.000Z',
      agentCount: 2,
    });
    const broken = JSON.parse(text) as { agents: Array<{ seed: string }> };
    broken.agents[0]!.seed = Buffer.from(new Uint8Array(16)).toString('base64');
    expect(() => parseBundle(JSON.stringify(broken))).toThrow(/seed must be exactly 32 bytes/);
  });
});
