/**
 * The gates that stand between a dry run and a live season.
 *
 * Every item here is a way the process could *look* armed while running under a
 * weaker contract than the contest requires:
 *
 *   - an unpinned referee, so the first signed post names the referee;
 *   - a bundle generated against no package at all;
 *   - live armed with registration off, so 150 owners trade on mintless accounts;
 *   - a short fleet, so the referee counts fewer than 150 owners;
 *   - owner registrations posted after the lock, when they cannot mint;
 *   - a restart that loses the referee's history, so the first tick trades blind;
 *   - a missing `contest.json` quietly replaced by the embedded copy.
 *
 * Each one fails closed, and each one is asserted here rather than assumed.
 */
import { createHash } from 'node:crypto';
import { copyFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  DEFAULT_AGENT_COUNT,
  IdentityError,
  assertFullFleet,
  didFromSeed,
} from '@flop/identity';
import { parseContestConfig, referenceRules, rulesFromConfig } from '@flop/close-call';
import { RefereeVerifier, computeLocalPackageManifestHash, sha256Hex } from '@flop/technocore';
import { ConfigError, loadConfig } from '../apps/orchestrator/src/config.js';
import { loadRules, resolvePackagePin } from '../apps/orchestrator/src/main.js';
import { Logger } from '../apps/orchestrator/src/logger.js';
import { FakeTransport } from './support/fake-transport.js';
import {
  HARNESS_PACKAGE_HASH,
  HARNESS_REFEREE_DID,
  buildHarness,
  REFERENCE_DIR,
  type Harness,
} from './support/orchestrator.js';
import { generateAgents, storeFrom, tempDir } from './support/harness.js';

const silent = Logger.create({ level: 'fatal' });
const REFEREE_SEED = new Uint8Array(32).fill(11);
const REFEREE_DID = didFromSeed(REFEREE_SEED);
const IMPOSTOR_SEED = new Uint8Array(32).fill(13);
const IMPOSTOR_DID = didFromSeed(IMPOSTOR_SEED);

/** The smallest environment that arms a live process. */
function liveEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  return {
    FLOP_MODE: 'live',
    FLOP_LIVE_CONFIRM: 'close-1',
    FLOP_ALLOW_REGISTRATION: 'true',
    EXPECTED_REFEREE_DID: REFEREE_DID,
    // Live must name the package it runs against; the vendored manifest's own
    // hash is the value the harness pins.
    EXPECTED_PACKAGE_HASH: HARNESS_PACKAGE_HASH,
    ...extra,
  };
}

describe('live refuses to start without the full contract', () => {
  it('arms nothing by default: the default configuration is a dry run', () => {
    const config = loadConfig({});
    expect(config.mode).toBe('dry-run');
    expect(config.liveArmed).toBe(false);
    expect(config.allowTrading).toBe(false);
    expect(config.tradingArmed).toBe(false);
    // A dry run may leave registration off; only live requires it.
    expect(() => loadConfig({ FLOP_ALLOW_REGISTRATION: 'false' })).not.toThrow();
  });

  it('refuses live with registration off', () => {
    expect(() => loadConfig(liveEnv({ FLOP_ALLOW_REGISTRATION: 'false' }))).toThrow(
      /FLOP_ALLOW_REGISTRATION=true/,
    );
  });

  it('refuses live without a pinned referee DID', () => {
    expect(() => loadConfig(liveEnv({ EXPECTED_REFEREE_DID: '' }))).toThrow(
      /EXPECTED_REFEREE_DID/,
    );
  });

  it('refuses live with the referee pin switched off', () => {
    expect(() => loadConfig(liveEnv({ REQUIRE_REFEREE_PIN: 'false' }))).toThrow(
      /REQUIRE_REFEREE_PIN/,
    );
  });

  it('refuses to arm trading outside live, whatever the other flags say', () => {
    expect(() => loadConfig({ FLOP_ALLOW_TRADING: 'true' })).toThrow(/FLOP_ALLOW_TRADING/);
  });

  it('keeps registration and trading as separate commitments', () => {
    // Live, registering, not trading: the fleet becomes real, no collateral moves.
    const registering = loadConfig(liveEnv());
    expect(registering.liveArmed).toBe(true);
    expect(registering.allowRegistration).toBe(true);
    expect(registering.tradingArmed).toBe(false);

    // Both: the only configuration in which a trade is ever posted.
    const trading = loadConfig(liveEnv({ FLOP_ALLOW_TRADING: 'true' }));
    expect(trading.tradingArmed).toBe(true);
  });

  it('refuses a referee DID that is not a did:key', () => {
    expect(() => loadConfig(liveEnv({ EXPECTED_REFEREE_DID: 'did:web:referee.example' }))).toThrow(
      /not a did:key/,
    );
  });

  it('refuses an EXPECTED_PACKAGE_HASH that is not a sha256', () => {
    expect(() => loadConfig({ EXPECTED_PACKAGE_HASH: 'not-a-hash' })).toThrow(/sha256/);
  });

  it('refuses an ADMIN_PUBLIC_KEY that is not a did:key', () => {
    expect(() => loadConfig({ ADMIN_PUBLIC_KEY: 'admin' })).toThrow(/not a did:key/);
  });

  it('ties the full-fleet rule to the season it is asserting', () => {
    expect(() => loadConfig({ EXPECTED_AGENT_COUNT: '15' })).toThrow(/EXPECTED_AGENT_COUNT=150/);
    // A small fleet is a deliberate dry-run choice, not an accident.
    const small = loadConfig({ EXPECTED_AGENT_COUNT: '15', REQUIRE_FULL_FLEET: 'false' });
    expect(small.expectedAgentCount).toBe(15);
    expect(small.requireFullFleet).toBe(false);
  });

  it('holds the fleet to exactly five groups of thirty', () => {
    const full = assertFullFleet(storeFrom(generateAgents(DEFAULT_AGENT_COUNT)));
    expect(full.size).toBe(150);
    for (const count of Object.values(full.groups)) expect(count).toBe(30);

    // A short fleet is refused, and so is a fleet whose groups are lopsided.
    expect(() => assertFullFleet(storeFrom(generateAgents(149)))).toThrow(IdentityError);
    expect(() => assertFullFleet(storeFrom(generateAgents(15)), 15)).toThrow(/strategy group/);
  });
});

describe('the package pin is the manifest, not a placeholder', () => {
  const scratch: string[] = [];
  afterEach(() => {
    for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  function copyReference(): string {
    const dir = tempDir('flop-reference-');
    scratch.push(dir);
    mkdirSync(dir, { recursive: true });
    for (const name of ['manifest.json', 'contest.json', 'close-call-game.md', 'close_call_fold.py']) {
      copyFileSync(join(REFERENCE_DIR, name), join(dir, name));
    }
    return dir;
  }

  it('hashes the manifest itself, and checks every file the manifest records', () => {
    const local = computeLocalPackageManifestHash(REFERENCE_DIR);
    expect(local.ok).toBe(true);
    expect(local.problems).toEqual([]);
    // Independent of the implementation: the sha256 of the manifest bytes.
    const expected = createHash('sha256')
      .update(readFileSync(join(REFERENCE_DIR, 'manifest.json')))
      .digest('hex');
    expect(local.manifestHash).toBe(expected);
    // The manifest does not record its own hash, so this cannot be read out of it.
    const parsed = JSON.parse(readFileSync(join(REFERENCE_DIR, 'manifest.json'), 'utf8')) as {
      files: Record<string, { sha256: string }>;
    };
    expect(parsed.files['manifest.json']).toBeUndefined();
    expect(local.manifestHash).not.toBe(parsed.files['contest.json']!.sha256);
    expect(local.verified.map((entry) => entry.path).sort()).toEqual([
      'close-call-game.md',
      'close_call_fold.py',
      'contest.json',
    ]);
    expect(HARNESS_PACKAGE_HASH).toBe(local.manifestHash);
  });

  it('fails closed when a vendored file no longer matches the manifest', () => {
    const dir = copyReference();
    writeFileSync(join(dir, 'contest.json'), '{"contest_id":"close-1"}\n');
    const local = computeLocalPackageManifestHash(dir);
    expect(local.ok).toBe(false);
    expect(local.problems.join(' ')).toContain('contest.json');
    expect(local.manifestHash).toBe(HARNESS_PACKAGE_HASH);
  });

  it('fails closed when a vendored file is missing', () => {
    const dir = copyReference();
    rmSync(join(dir, 'close_call_fold.py'));
    const local = computeLocalPackageManifestHash(dir);
    expect(local.ok).toBe(false);
    expect(local.problems.join(' ')).toContain('close_call_fold.py');
  });

  it('refuses a bundle generated against no package, or against another one', () => {
    const config = loadConfig({ REFERENCE_DIR });
    expect(() => resolvePackagePin(config, '')).toThrow(/records no package hash/);
    expect(() => resolvePackagePin(config, 'a'.repeat(64))).toThrow(/generated against package/);
    const pin = resolvePackagePin(config, HARNESS_PACKAGE_HASH);
    expect(pin.expected).toBe(HARNESS_PACKAGE_HASH);
    expect(pin.verifiedFiles).toBe(3);
  });

  it('refuses a checkout that does not hash to EXPECTED_PACKAGE_HASH', () => {
    const config = loadConfig({ REFERENCE_DIR, EXPECTED_PACKAGE_HASH: 'a'.repeat(64) });
    expect(() => resolvePackagePin(config, HARNESS_PACKAGE_HASH)).toThrow(/EXPECTED_PACKAGE_HASH/);
  });

  it('reads the pin the same way the running process does', () => {
    const rules = rulesFromConfig(parseContestConfig(readFileSync(join(REFERENCE_DIR, 'contest.json'), 'utf8')));
    expect(rules.contestId).toBe('close-1');
    expect(referenceRules().lockSweep).toBe(rules.lockSweep);
    expect(sha256Hex(readFileSync(join(REFERENCE_DIR, 'manifest.json')))).toBe(
      HARNESS_PACKAGE_HASH,
    );
  });
});

describe('live requires an explicit, matching package hash', () => {
  it('refuses live with no EXPECTED_PACKAGE_HASH', () => {
    // Live must name the package: falling back to whatever manifest happens to
    // be on disk is exactly the drift the pin exists to prevent.
    expect(() => loadConfig(liveEnv({ EXPECTED_PACKAGE_HASH: '' }))).toThrow(
      /EXPECTED_PACKAGE_HASH/,
    );
  });

  it('refuses live with a malformed hash (case-insensitive sha256 only)', () => {
    for (const bad of ['not-a-hash', 'a'.repeat(63), 'g'.repeat(64), `${'a'.repeat(62)}zz`]) {
      expect(() => loadConfig(liveEnv({ EXPECTED_PACKAGE_HASH: bad }))).toThrow(/sha256/);
    }
    // Uppercase is accepted and normalised, because the digest is the same value.
    const upper = loadConfig(liveEnv({ EXPECTED_PACKAGE_HASH: HARNESS_PACKAGE_HASH.toUpperCase() }));
    expect(upper.expectedPackageHash).toBe(HARNESS_PACKAGE_HASH);
  });

  it('refuses when the vendored manifest does not hash to the pin', () => {
    const config = loadConfig(liveEnv({ REFERENCE_DIR, EXPECTED_PACKAGE_HASH: 'a'.repeat(64) }));
    expect(() => resolvePackagePin(config, 'a'.repeat(64), silent)).toThrow(/EXPECTED_PACKAGE_HASH/);
  });

  it('refuses when the encrypted bundle was built against another package', () => {
    const config = loadConfig(liveEnv({ REFERENCE_DIR }));
    expect(() => resolvePackagePin(config, 'b'.repeat(64), silent)).toThrow(
      /generated against package/,
    );
  });

  it('lets a dry run omit the pin, but records the fallback as a warning', () => {
    const config = loadConfig({ REFERENCE_DIR });
    expect(config.expectedPackageHash).toBeNull();

    const events: Array<{ code: string; level: string }> = [];
    const logger = {
      event: (entry: { code: string; level: string }) => events.push(entry),
    } as unknown as Logger;
    const pin = resolvePackagePin(config, HARNESS_PACKAGE_HASH, logger);
    expect(pin.expected).toBe(HARNESS_PACKAGE_HASH);
    expect(events.some((entry) => entry.code === 'package_pin_implicit' && entry.level === 'warn')).toBe(
      true,
    );
  });
});

describe('the referee is pinned, not adopted', () => {
  const STATE_ROOM = 'd-close1-state';
  const PRICE_ROOM = 'd-close1-price';

  function seedText(did: string, packageHash = HARNESS_PACKAGE_HASH): string {
    return JSON.stringify({
      t: 'seed',
      season: 'close-1',
      price: '225.10',
      trade: { time: '2026-09-28T12:00:00Z', tid: 't0' },
      package: packageHash,
      rooms: [],
    });
  }

  function priceText(sweep: number, px = '225.10'): string {
    return JSON.stringify({
      t: 'price',
      season: 'close-1',
      n: sweep,
      ref: { px, time: '2026-09-28T12:00:00Z', tid: `t${sweep}` },
      limits: [(Number(px) * 0.95).toFixed(2), (Number(px) * 1.05).toFixed(2)],
    });
  }

  function last(transport: FakeTransport, room: string) {
    const messages = transport.room(room).messagesSince(0);
    return messages[messages.length - 1]!;
  }

  it('refuses the first signed post when no referee DID is pinned', () => {
    const transport = new FakeTransport();
    transport.room(STATE_ROOM).appendFrom(seedText(IMPOSTOR_DID), {
      seed: IMPOSTOR_SEED,
      did: IMPOSTOR_DID,
      nonce: 1,
    });
    const verifier = new RefereeVerifier({
      rules: referenceRules(),
      logger: silent,
      unpinnedPolicy: 'reject',
      requireSeedBeforeState: true,
    });

    const observation = verifier.observe(STATE_ROOM, last(transport, STATE_ROOM));
    expect(observation!.record.signatureValid).toBe(true);
    expect(observation!.record.accepted).toBe(false);
    expect(observation!.record.rejectedBecause).toBe('referee_unpinned');
    expect(verifier.state.refereeDid).toBeNull();
    expect(verifier.state.packageHash).toBeNull();
    expect(verifier.state.conservative).toBe(true);
  });

  it('refuses a valid signature from anyone but the pinned referee', () => {
    const transport = new FakeTransport();
    transport.room(STATE_ROOM).appendFrom(seedText(IMPOSTOR_DID), {
      seed: IMPOSTOR_SEED,
      did: IMPOSTOR_DID,
      nonce: 1,
    });
    const verifier = new RefereeVerifier({
      rules: referenceRules(),
      logger: silent,
      expectedRefereeDid: REFEREE_DID,
      unpinnedPolicy: 'reject',
      requireSeedBeforeState: true,
    });

    const observation = verifier.observe(STATE_ROOM, last(transport, STATE_ROOM));
    expect(observation!.record.signatureValid).toBe(true);
    expect(observation!.record.rejectedBecause).toBe('unexpected_referee_did');
    expect(verifier.state.packageHash).toBeNull();
    expect(verifier.state.conservativeReasons).toContain('referee_did_mismatch');
  });

  it('does not accept a price as state before the seed has arrived', () => {
    const transport = new FakeTransport();
    transport.room(PRICE_ROOM).appendFrom(priceText(42), {
      seed: REFEREE_SEED,
      did: REFEREE_DID,
      nonce: 1,
    });
    const verifier = new RefereeVerifier({
      rules: referenceRules(),
      logger: silent,
      expectedRefereeDid: REFEREE_DID,
      expectedPackageHash: HARNESS_PACKAGE_HASH,
      unpinnedPolicy: 'reject',
      requireSeedBeforeState: true,
    });

    const observation = verifier.observe(PRICE_ROOM, last(transport, PRICE_ROOM));
    expect(observation!.record.rejectedBecause).toBe('seed_required');
    expect(verifier.state.reference).toBeNull();
    expect(verifier.state.currentSweep).toBeNull();
    expect(verifier.state.conservative).toBe(true);

    // The same posts in the referee's own order are accepted.
    transport.room(STATE_ROOM).appendFrom(seedText(REFEREE_DID), {
      seed: REFEREE_SEED,
      did: REFEREE_DID,
      nonce: 2,
    });
    const seeded = verifier.observe(STATE_ROOM, last(transport, STATE_ROOM));
    expect(seeded!.record.accepted).toBe(true);
    expect(verifier.state.packageHash).toBe(HARNESS_PACKAGE_HASH);
    expect(verifier.state.seedSeen).toBe(true);
  });

  it('pins the referee and the package on the running reader', async () => {
    const harness = await buildHarness({ agentCount: 4 });
    try {
      expect(harness.runtime.reader.verifier.state.refereeDid).toBe(HARNESS_REFEREE_DID);
      expect(harness.runtime.reader.verifier.state.expectedPackageHash).toBe(HARNESS_PACKAGE_HASH);
      // An impostor seed must not be able to take over an unpinned or pinned slot.
      harness.transport.room('d-close1-state').appendFrom(seedText(IMPOSTOR_DID), {
        seed: IMPOSTOR_SEED,
        did: IMPOSTOR_DID,
        nonce: 1,
      });
      await harness.runtime.scheduler.runTick();
      expect(harness.runtime.reader.verifier.state.packageHash).toBeNull();
      expect(harness.runtime.reader.verifier.state.refereeDid).toBe(HARNESS_REFEREE_DID);
    } finally {
      await harness.dispose();
    }
  });
});

describe('the lock closes registration and trading', () => {
  it('does not post owner registrations once the sweep is past the lock', async () => {
    const harness = await buildHarness({ agentCount: 4 });
    try {
      const lockSweep = referenceRules().lockSweep;
      harness.referee.seedPost(HARNESS_PACKAGE_HASH);
      // A price one sweep past the lock, which is the referee's own signal.
      harness.referee.price(lockSweep + 1, '225.10');
      await harness.runtime.scheduler.runTick();

      const status = harness.runtime.scheduler.status();
      expect(status.locked).toBe(true);
      const outcome = await harness.runtime.scheduler.ensureParticipation();
      expect(outcome.posted).toBe(0);
      expect(outcome.pending).toBe(0);
      expect(harness.transport.postsFor('close1')).toHaveLength(0);
    } finally {
      await harness.dispose();
    }
  });

  it('writes off an attempted registration that the lock overtook', async () => {
    const harness = await buildHarness({ agentCount: 4 });
    try {
      const repositories = harness.runtime.repositories;
      const attempted = harness.runtime.keyStore.agentIds[0]!;
      const neverTried = harness.runtime.keyStore.agentIds[1]!;
      const at = '2026-09-28T12:00:00.000Z';
      repositories.participation.upsert({
        agent_id: attempted,
        did: harness.runtime.keyStore.did(attempted),
        season: 'close-1',
        registration_text: '{"t":"owner","season":"close-1","key":"x"}',
        registration_nonce: '1',
        registration_signature: '',
        room: 'close1',
        technocore_seq: null,
        technocore_ts: null,
        posted_at: at,
        readback_at: null,
        package_hash: HARNESS_PACKAGE_HASH,
        referee_did: HARNESS_REFEREE_DID,
        status: 'posted',
        attempts: 1,
        last_error: null,
        updated_at: at,
        post_request_id: null,
        message_hash: null,
        post_sweep: null,
        flow_evidence_at: null,
        state_evidence_at: null,
      });
      repositories.participation.upsert({
        agent_id: neverTried,
        did: harness.runtime.keyStore.did(neverTried),
        season: 'close-1',
        registration_text: '{"t":"owner","season":"close-1","key":"y"}',
        registration_nonce: '',
        registration_signature: '',
        room: 'close1',
        technocore_seq: null,
        technocore_ts: null,
        posted_at: null,
        readback_at: null,
        package_hash: '',
        referee_did: null,
        status: 'created',
        attempts: 0,
        last_error: null,
        updated_at: at,
        post_request_id: null,
        message_hash: null,
        post_sweep: null,
        flow_evidence_at: null,
        state_evidence_at: null,
      });

      harness.referee.seedPost(HARNESS_PACKAGE_HASH);
      harness.referee.price(referenceRules().lockSweep + 1, '225.10');
      await harness.runtime.scheduler.runTick();

      expect(repositories.participation.get(attempted)?.status).toBe('registration_closed');
      // A row that was never posted is not "closed": nothing was attempted.
      expect(repositories.participation.get(neverTried)?.status).toBe('created');

      // Terminal: the next tick cannot walk it back into "in flight".
      await harness.runtime.scheduler.runTick();
      expect(repositories.participation.get(attempted)?.status).toBe('registration_closed');
      const events = repositories.events.recent(50);
      expect(events.some((event) => event.code === 'registration_closed')).toBe(true);
    } finally {
      await harness.dispose();
    }
  });
});

describe('a restart rebuilds the referee view before the first tick', () => {
  let first: Harness | undefined;
  let second: Harness | undefined;
  const dir = tempDir('flop-hydrate-');

  afterEach(async () => {
    if (second) await second.dispose();
    second = undefined;
    try {
      first?.runtime.db.close();
    } catch {
      /* the harness may already have closed it */
    }
    first = undefined;
    rmSync(dir, { recursive: true, force: true });
  });

  it('resumes the sweep, the reference and the package without re-reading the rooms', async () => {
    const transport = new FakeTransport();
    first = await buildHarness({ agentCount: 4, dir, transport });
    first.referee.seedPost(HARNESS_PACKAGE_HASH);
    for (let sweep = 1; sweep <= 8; sweep += 1) {
      first.referee.price(sweep, sweep === 8 ? '204' : '200');
      first.referee.flow(sweep, []);
    }
    await first.runtime.scheduler.runTick();
    const before = first.runtime.scheduler.status();
    expect(before.sweep).toBe(8);
    expect(before.reference).toBe('204');

    // SIGKILL: no stop, no checkpoint, no close. The WAL is left as it was.
    second = await buildHarness({ agentCount: 4, dir, transport });

    // Nothing new has been posted, so every one of these values can only have
    // come from replaying the stored referee history at startup.
    const after = second.runtime.scheduler.status();
    expect(after.sweep).toBe(8);
    expect(after.reference).toBe('204');
    expect(after.packageHash).toBe(HARNESS_PACKAGE_HASH);
    expect(after.refereeDid).toBe(HARNESS_REFEREE_DID);
    expect(after.conservative).toBe(false);
    expect(second.runtime.reader.verifier.state.seedSeen).toBe(true);
    expect(second.runtime.repositories.referee.count()).toBeGreaterThanOrEqual(9);
  });
});

describe('live refuses an unusable contest.json', () => {
  const scratch: string[] = [];
  afterEach(() => {
    for (const path of scratch.splice(0)) rmSync(path, { force: true });
  });

  it('is fatal in live and a warning in a dry run', () => {
    const missing = join(tempDir('flop-rules-'), 'contest.json');
    scratch.push(missing);
    const live = loadConfig(liveEnv({ CONTEST_JSON_PATH: missing }));
    expect(() => loadRules(live, silent)).toThrow(ConfigError);
    const dry = loadConfig({ CONTEST_JSON_PATH: missing });
    expect(loadRules(dry, silent).contestId).toBe('close-1');
  });

  it('falls back to the embedded rules only in a dry run', () => {
    const broken = join(tempDir('flop-rules-'), 'broken.json');
    scratch.push(broken);
    mkdirSync(join(broken, '..'), { recursive: true });
    writeFileSync(broken, '{ this is not json');
    expect(loadRules(loadConfig({ CONTEST_JSON_PATH: broken }), silent).lockSweep).toBe(
      referenceRules().lockSweep,
    );
    const live = loadConfig(liveEnv({ CONTEST_JSON_PATH: broken }));
    expect(() => loadRules(live, silent)).toThrow(/refuses an unusable contest.json/);
  });
});
