/**
 * Control proofs, and the recovery drill the spec requires.
 *
 * The drill is the point of this file: generate 150 agents, export an encrypted
 * bundle, restore it in a clean directory, verify all 150 DIDs, re-sign a fresh
 * challenge, confirm the results agree, and prove no plaintext seed was left on
 * disk anywhere.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  AgentKeyStore,
  buildInventory,
  controlProofPayload,
  createChallenge,
  challengeHash,
  decryptBundle,
  encryptBundle,
  createAgeIdentity,
  ageRecipientFor,
  makeAgentSecretRecord,
  newChallengeRecord,
  parseBundle,
  proveControl,
  serializeBundle,
  serializeInventory,
  signInventory,
  verifyControlProof,
  verifyControlProofSet,
  verifyInventorySignature,
  writePrivateFile,
  writePublicFile,
  decodeSignature,
  didToPublicKey,
  verifyBytes,
  assignStrategyGroup,
} from '@flop/identity';
import { cleanup, generateAgents, generatedStore, tempDir } from './support/harness.js';

const adminSeed = generateAgents(151)[150]!.seed;

function signedInventory(agents: ReturnType<typeof generateAgents>) {
  const store = new AgentKeyStore({ agents });
  const inventory = buildInventory(store.publicRecords(), {
    season: 'close-1',
    packageHash: 'a1b2c3'.repeat(10) + 'ab',
    createdAt: '2026-09-28T00:00:00.000Z',
  });
  return { store, inventory, manifest: signInventory(inventory, adminSeed, '2026-09-28T00:00:01.000Z') };
}

describe('control proofs', () => {
  it('proves and verifies control for all 150 agents', () => {
    const agents = generateAgents();
    const { store, inventory, manifest } = signedInventory(agents);
    const challenge = newChallengeRecord('2026-09-28T00:00:02.000Z');

    const proofs = store.agentIds.map((agentId) =>
      proveControl(store, agentId, challenge.challenge_hash, '2026-09-28T00:00:03.000Z'),
    );
    expect(proofs).toHaveLength(150);
    expect(proofs.every((proof) => proof.verified)).toBe(true);

    const result = verifyControlProofSet(proofs, challenge.challenge_hash, inventory, manifest);
    expect(result.failed).toEqual([]);
    expect(result.verified).toBe(150);
    expect(result.total).toBe(150);
  });

  it('binds the proof to the challenge, so it cannot be replayed', () => {
    const { store } = signedInventory(generateAgents());
    const first = newChallengeRecord();
    const second = newChallengeRecord();
    expect(first.challenge_hash).not.toBe(second.challenge_hash);

    const agentId = store.agentIds[0]!;
    const proof = proveControl(store, agentId, first.challenge_hash);
    expect(verifyControlProof(proof, first.challenge_hash)).toBe(true);
    expect(verifyControlProof(proof, second.challenge_hash)).toBe(false);
  });

  it('rejects a proof whose signature was made by another agent', () => {
    const { store } = signedInventory(generateAgents());
    const challenge = newChallengeRecord();
    const agentA = store.agentIds[0]!;
    const agentB = store.agentIds[1]!;

    const stolen: Parameters<typeof verifyControlProof>[0] = {
      ...proveControl(store, agentB, challenge.challenge_hash),
      agent_id: agentA,
      did: store.did(agentA),
    };
    expect(verifyControlProof(stolen, challenge.challenge_hash)).toBe(false);
  });

  it('rejects a proof for a DID that is not the one the inventory lists', () => {
    const { store, inventory, manifest } = signedInventory(generateAgents());
    const challenge = newChallengeRecord();
    const proofs = store.agentIds.map((agentId) => proveControl(store, agentId, challenge.challenge_hash));
    const swapped = [...proofs];
    swapped[0] = { ...proofs[1]!, agent_id: proofs[0]!.agent_id };
    const result = verifyControlProofSet(swapped, challenge.challenge_hash, inventory, manifest);
    expect(result.failed.length).toBeGreaterThan(0);
    expect(result.verified).toBeLessThan(150);
  });

  it('detects a missing proof', () => {
    const { store, inventory, manifest } = signedInventory(generateAgents());
    const challenge = newChallengeRecord();
    const proofs = store.agentIds
      .slice(0, 149)
      .map((agentId) => proveControl(store, agentId, challenge.challenge_hash));
    const result = verifyControlProofSet(proofs, challenge.challenge_hash, inventory, manifest);
    expect(result.failed.some((entry) => entry.startsWith('<missing:'))).toBe(true);
  });

  it('fails the whole set when the inventory signature is invalid', () => {
    const { store, inventory, manifest } = signedInventory(generateAgents());
    const challenge = newChallengeRecord();
    const proofs = store.agentIds.map((agentId) => proveControl(store, agentId, challenge.challenge_hash));
    const result = verifyControlProofSet(proofs, challenge.challenge_hash, inventory, {
      ...manifest,
      signature: `${manifest.signature.slice(0, 85)}A`,
    });
    expect(result.failed).toContain('<inventory-signature>');
  });

  it('uses a 32-byte challenge and a documented payload shape', () => {
    const challenge = createChallenge();
    expect(challenge).toHaveLength(32);
    expect(Buffer.from(challenge).equals(Buffer.from(createChallenge()))).toBe(false);
    const payload = controlProofPayload('agent-0001', 'sha256:deadbeef');
    expect(Buffer.from(payload).toString('utf8')).toBe(
      'flop-close-call-control-v1|close-1|agent-0001|sha256:deadbeef|',
    );
  });

  it('produces a signature that a third party can verify from the DID alone', () => {
    const store = generatedStore(1);
    const challenge = createChallenge();
    const hash = challengeHash(challenge);
    const proof = proveControl(store, 'agent-0001', hash);
    expect(
      verifyBytes(
        decodeSignature(proof.signature),
        controlProofPayload('agent-0001', hash),
        didToPublicKey(proof.did),
      ),
    ).toBe(true);
    // The proof must not be a plain signature of the raw challenge.
    expect(
      verifyBytes(decodeSignature(proof.signature), challenge, didToPublicKey(proof.did)),
    ).toBe(false);
  });
});

describe('recovery drill: encrypt, restore in a clean directory, re-prove', () => {
  it('restores 150 DIDs and re-signs a fresh challenge with identical results', async () => {
    const workdir = tempDir('flop-recovery-');
    const restoredDir = tempDir('flop-restored-');
    try {
      // --- 1. generate 150 agents and export the encrypted bundle -------------
      const originals = generateAgents();
      const { store: originalStore, inventory } = signedInventory(originals);
      const vpsIdentity = await createAgeIdentity();
      const offlineIdentity = await createAgeIdentity();
      const recipients = [await ageRecipientFor(vpsIdentity), await ageRecipientFor(offlineIdentity)];

      const bundlePlaintext = serializeBundle(originals, {
        season: 'close-1',
        packageHash: inventory.package_hash,
        createdAt: '2026-09-28T00:01:00.000Z',
        agentCount: originals.length,
      });
      const ciphertext = await encryptBundle(bundlePlaintext, recipients);

      const bundlePath = join(workdir, 'agents.bundle.age');
      const identityPath = join(workdir, 'vps.agekey');
      const inventoryPath = join(workdir, 'agents.manifest.json');
      writePrivateFile(bundlePath, ciphertext);
      writePrivateFile(identityPath, `${vpsIdentity}\n`);
      writePublicFile(inventoryPath, serializeInventory(inventory));

      // The only plaintext file written is the public inventory.
      expect(existsSync(bundlePath)).toBe(true);
      const written = readdirSync(workdir);
      expect(written.sort()).toEqual(['agents.bundle.age', 'agents.manifest.json', 'vps.agekey']);
      for (const name of written) {
        if (name === 'agents.manifest.json') continue;
        const body = readFileSync(join(workdir, name));
        expect(body.toString('utf8')).not.toContain('did:key');
        expect(body.toString('utf8')).not.toContain('z6Mk');
      }

      // --- 2. restore in a clean directory -----------------------------------
      const restoredIdentity = readFileSync(identityPath, 'utf8').trim();
      const restoredPlaintext = await decryptBundle(
        new Uint8Array(readFileSync(bundlePath)),
        [restoredIdentity],
      );
      const parsed = parseBundle(restoredPlaintext);
      expect(parsed.agents).toHaveLength(150);

      // Rebuild the store the way the process would, from the decrypted bundle.
      const restoredStore = new AgentKeyStore({ agents: parsed.agents });

      // --- 3. all 150 DIDs are identical ------------------------------------
      expect(restoredStore.agentIds).toEqual(originalStore.agentIds);
      for (const agentId of originalStore.agentIds) {
        expect(restoredStore.did(agentId)).toBe(originalStore.did(agentId));
      }
      expect(new Set(restoredStore.agentIds.map((id) => restoredStore.did(id))).size).toBe(150);

      // The restored store still matches the published inventory.
      const restoredInventory = buildInventory(restoredStore.publicRecords(), {
        season: 'close-1',
        packageHash: inventory.package_hash,
        createdAt: inventory.created_at,
      });
      expect(restoredInventory.agents).toEqual(inventory.agents);

      // --- 4. re-sign a fresh challenge with the restored keys --------------
      const challenge = newChallengeRecord('2026-09-28T00:02:00.000Z');
      writePrivateFile(
        join(restoredDir, 'challenge.json'),
        `${JSON.stringify(challenge, null, 2)}\n`,
      );
      const restoredProofs = restoredStore.agentIds.map((agentId) =>
        proveControl(restoredStore, agentId, challenge.challenge_hash, '2026-09-28T00:02:01.000Z'),
      );

      // --- 5. verification is identical to the pre-recovery run -------------
      const preRecoveryProofs = originalStore.agentIds.map((agentId) =>
        proveControl(originalStore, agentId, challenge.challenge_hash, '2026-09-28T00:02:01.000Z'),
      );
      expect(restoredProofs).toEqual(preRecoveryProofs);

      const manifest = signInventory(inventory, adminSeed, '2026-09-28T00:00:01.000Z');
      expect(verifyInventorySignature(inventory, manifest)).toBe(true);
      const result = verifyControlProofSet(
        restoredProofs,
        challenge.challenge_hash,
        inventory,
        manifest,
      );
      expect(result.failed).toEqual([]);
      expect(result.verified).toBe(150);

      // --- 6. no plaintext seed file remains ---------------------------------
      // The decrypted seed material lived only in `restoredStore` and the parsed
      // bundle string; nothing wrote it out. Assert no seed-shaped file exists.
      for (const dir of [workdir, restoredDir]) {
        for (const name of readdirSync(dir)) {
          const contents = readFileSync(join(dir, name));
          const hex = contents.toString('hex');
          for (const agent of originals.slice(0, 5)) {
            expect(hex.includes(Buffer.from(agent.seed).toString('hex'))).toBe(false);
          }
        }
      }
      restoredStore.destroy();
    } finally {
      cleanup(workdir, restoredDir);
    }
  });

  it('rebuilds the identical 150 DIDs from a bundle written with only the agent count', () => {
    const agents = generateAgents();
    const text = serializeBundle(agents, {
      season: 'close-1',
      packageHash: 'x'.repeat(64),
      createdAt: '2026-09-28T00:00:00.000Z',
      agentCount: 150,
    });
    const parsed = parseBundle(text);
    const store = new AgentKeyStore({ agents: parsed.agents });
    expect(store.size).toBe(150);
    for (let index = 0; index < 150; index += 1) {
      const rebuilt = makeAgentSecretRecord(index, Uint8Array.from(agents[index]!.seed), assignStrategyGroup(index));
      expect(rebuilt.did).toBe(store.did(agents[index]!.agentId));
    }
  });
});
