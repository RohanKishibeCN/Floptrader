/**
 * The package pin, and the two things it must never do.
 *
 * "The rules and fold stay frozen during the contest." The referee's seed quotes
 * a package hash, and the process pinned one at launch. When those disagree, or
 * when GitHub `main` moves, the only correct behaviour is to stop active trading,
 * keep reading, and wait for a human. It must never switch to the new package,
 * never reload, never follow upstream automatically.
 *
 * The file has three layers, matching the three places the guarantee can break:
 *
 *   1. the pure comparison and decision helpers in `@flop/technocore`;
 *   2. the vendored reference files actually hashing to the manifest's record —
 *      without this the pin is a number with nothing behind it;
 *   3. the running scheduler, where a drifted pin has to turn a real candidate
 *      trade into a refusal rather than a post.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  PINNED_PATHS,
  RefereeVerifier,
  comparePackageHash,
  decideOnDrift,
  normalizeHash,
  pinnedFromManifest,
  sha256Hex,
} from '@flop/technocore';
import {
  Decimal,
  RiskAccount,
  buildTerms,
  referenceRules,
  signTrade,
  validateTrade,
} from '@flop/close-call';
import { didFromSeed } from '@flop/identity';
import { buildReleasePlan, RELEASE_STEPS, ReleaseManager } from '../apps/orchestrator/src/upstream-monitor.js';
import { Logger } from '../apps/orchestrator/src/logger.js';
import { buildHarness, type Harness } from './support/orchestrator.js';
import { FakeTransport } from './support/fake-transport.js';

const REFERENCE_DIR = join(process.cwd(), 'reference');
const silent = Logger.create({ level: 'fatal' });
const PIN = 'a'.repeat(64);
const DRIFTED = 'c'.repeat(64);

/** The hash the harness bundle pins, so the seed has to agree with it. */
const HARNESS_PACKAGE_HASH = 'b'.repeat(64);

function referenceFile(name: string): string {
  return readFileSync(join(REFERENCE_DIR, name), 'utf8');
}

describe('the hash comparison', () => {
  it('normalises an optional sha256: prefix and case', () => {
    expect(normalizeHash(`sha256:${PIN}`)).toBe(PIN);
    expect(normalizeHash(`  SHA256:${PIN.toUpperCase()}  `)).toBe(PIN);
    expect(normalizeHash('')).toBeNull();
    expect(normalizeHash(null)).toBeNull();
  });

  it('treats two absences as no claim and one absence as drift', () => {
    expect(comparePackageHash(null, null).drift).toBe(false);
    expect(comparePackageHash(PIN, PIN).drift).toBe(false);
    expect(comparePackageHash(`sha256:${PIN}`, PIN).drift).toBe(false);
    expect(comparePackageHash(null, DRIFTED)).toMatchObject({ drift: true, expected: null });
    expect(comparePackageHash(PIN, null)).toMatchObject({ drift: true, observed: null });
  });

  it('names the disagreement precisely', () => {
    const comparison = comparePackageHash(PIN, DRIFTED);
    expect(comparison.drift).toBe(true);
    expect(comparison.detail).toContain(PIN);
    expect(comparison.detail).toContain(DRIFTED);
  });
});

describe('the drift decision', () => {
  it('continues when the hashes agree', () => {
    expect(decideOnDrift(comparePackageHash(PIN, PIN), 'seed')).toMatchObject({ action: 'continue' });
  });

  it('pauses trading and alerts on a seed disagreement', () => {
    const decision = decideOnDrift(comparePackageHash(PIN, DRIFTED), 'seed');
    expect(decision.action).toBe('pause_trading_and_alert');
    expect(decision.reason).toContain(PIN);
  });

  it('pauses active trading on an upstream change, which is informational', () => {
    expect(decideOnDrift(comparePackageHash(PIN, DRIFTED), 'upstream').action).toBe('pause_active_trading');
  });

  it('never switches the package automatically, in any branch', () => {
    for (const role of ['seed', 'upstream'] as const) {
      for (const comparison of [comparePackageHash(PIN, PIN), comparePackageHash(PIN, DRIFTED)]) {
        expect(decideOnDrift(comparison, role).switchPackageAutomatically).toBe(false);
      }
    }
  });
});

describe('the vendored reference files', () => {
  it('hashes each pinned file to the manifest record', () => {
    const manifest = JSON.parse(referenceFile('manifest.json')) as {
      files: Record<string, { sha256: string }>;
    };
    for (const path of ['contest.json', 'close-call-game.md', 'close_call_fold.py'] as const) {
      const observed = sha256Hex(referenceFile(path));
      expect(observed, `${path} differs from the manifest record`).toBe(manifest.files[path]!.sha256);
    }
  });

  it('agrees with the published contest.json hash', () => {
    expect(sha256Hex(referenceFile('contest.json'))).toBe(
      'f2c08c1388fe7f29b13be01cf4655dcf2f2178aa2df92edac5841d5a021da831',
    );
  });

  it('reads the pin out of the manifest, and knows which paths it covers', () => {
    const pinned = pinnedFromManifest(JSON.parse(referenceFile('manifest.json')));
    expect(pinned.contestHash).toBe('f2c08c1388fe7f29b13be01cf4655dcf2f2178aa2df92edac5841d5a021da831');
    expect(pinned.gameHash).toBeDefined();
    expect(pinned.foldHash).toBeDefined();
    // The manifest does not record its own hash, so it is omitted rather than faked.
    expect(pinned.manifestHash).toBeUndefined();
    expect([...PINNED_PATHS]).toEqual([
      'manifest.json',
      'contest.json',
      'close-call-game.md',
      'close_call_fold.py',
    ]);
  });

  it('tolerates a manifest with no files block', () => {
    expect(pinnedFromManifest({})).toEqual({});
  });
});

describe('the release procedure is a human decision', () => {
  it('lists every gate the spec requires, confirmation included', () => {
    for (const step of [
      'pnpm install --frozen-lockfile',
      'lint',
      'typecheck',
      'test',
      'build',
      'verify-all',
      'official fold',
      'dry-run',
      'human confirmation',
      'pm2 reload',
      'health check',
      'rollback to the previous release on failure',
    ]) {
      expect(RELEASE_STEPS).toContain(step);
    }
  });

  it('plans a candidate beside the previous release, so rollback is a pointer move', () => {
    const plan = buildReleasePlan('/opt/flop-close-call/releases/', '0.2.0');
    expect(plan.path).toBe('/opt/flop-close-call/releases/0.2.0');
    expect(plan.previousPath).toBe('/opt/flop-close-call/releases/current');
  });

  it('throws rather than applying a release automatically', () => {
    const manager = new ReleaseManager('/opt/flop-close-call/releases');
    expect(() => manager.assertNoAutomaticApply()).toThrow(/human decision/);
    expect(manager.steps()).toBe(RELEASE_STEPS);
  });
});

describe('a seed that disagrees with the pin', () => {
  /**
   * The seam between the pin and the trade gate, in one place: a genuine,
   * correctly signed seed whose package hash differs from the pin puts the
   * verifier into conservative mode, and the same verifier's snapshot is what
   * the validator consults — so the drift reaches `validateTrade` as
   * `conservative`, which no strategy can talk its way past.
   */
  function verifierAfterSeed(packageHash: string, expectedPackageHash: string) {
    const transport = new FakeTransport();
    const seed = new Uint8Array(32).fill(11);
    const did = didFromSeed(seed);
    transport.room('d-close1-state').appendFrom(
      JSON.stringify({
        t: 'seed',
        season: 'close-1',
        price: '200',
        trade: { time: '2026-09-28T12:00:00Z', tid: 't0' },
        package: packageHash,
        rooms: [],
      }),
      { seed, did, nonce: 1 },
    );
    const verifier = new RefereeVerifier({
      rules: referenceRules(),
      logger: silent,
      expectedPackageHash,
      expectedRefereeDid: did,
    });
    const observation = verifier.observe('d-close1-state', transport.room('d-close1-state').messagesSince(0)[0]!);
    return { verifier, observation };
  }

  it('degrades the verifier and leaves the pin untouched', () => {
    const { verifier, observation } = verifierAfterSeed(DRIFTED, PIN);
    expect(observation!.packageDrift).toBe(true);
    expect(observation!.record.signatureValid).toBe(true);
    expect(verifier.state.conservativeReasons).toContain('package_hash_drift');
    // The pin still holds the launch expectation; the seed's hash was recorded
    // as what the referee said, never promoted to the new expectation.
    expect(verifier.state.expectedPackageHash).toBe(PIN);
    expect(verifier.state.packageHash).toBe(DRIFTED);
  });

  it('stays clear when the seed agrees, so the refusal really is about drift', () => {
    const { verifier, observation } = verifierAfterSeed(PIN, PIN);
    expect(observation!.packageDrift).toBe(false);
    expect(verifier.state.conservative).toBe(false);
  });

  it('turns a fully signed trade into a refusal once the reader is degraded', () => {
    const rules = referenceRules();
    const makerSeed = new Uint8Array(32).fill(21);
    const takerSeed = new Uint8Array(32).fill(22);
    const makerDid = didFromSeed(makerSeed);
    const takerDid = didFromSeed(takerSeed);
    const terms = buildTerms({ id: 'drift-trade', maker: makerDid, side: 'buy', qty: '1', px: '200', until: 500 });
    const signed = signTrade({ terms, taker: takerDid, makerSeed, takerSeed });

    const context = {
      rules,
      sweep: 10,
      reference: Decimal.from('200'),
      close: Decimal.from('200'),
      localDids: new Set([makerDid, takerDid]),
      settledIds: new Set<string>(),
      accounts: new Map([
        [makerDid, RiskAccount.withMint(makerDid, rules.mint)],
        [takerDid, RiskAccount.withMint(takerDid, rules.mint)],
      ]),
      refuseLocalPairing: false,
    };

    // Undrifted: the trade is valid, so the schema of this fixture is right.
    expect(validateTrade({ terms, taker: takerDid, maker_sig: signed.maker_sig, taker_sig: signed.taker_sig }, { ...context, conservative: false }).ok).toBe(true);

    const degraded = verifierAfterSeed(DRIFTED, PIN).verifier.snapshot(new Date());
    expect(degraded.degraded).toBe(true);
    const verdict = validateTrade(
      { terms, taker: takerDid, maker_sig: signed.maker_sig, taker_sig: signed.taker_sig },
      { ...context, conservative: degraded.degraded },
    );
    expect(verdict.reason).toBe('conservative');
  });
});

describe('a drifted seed in the running scheduler', () => {
  let harness: Harness | undefined;

  afterEach(async () => {
    if (harness) await harness.dispose();
    harness = undefined;
  });

  /**
   * A market that makes the contrarian group want to trade: seven flat sweeps at
   * 200 and then a 2% spike. The move clears `moveThreshold` (1.5%) without the
   * least-squares trend clearing `trendCutoff` (0.4%), which is exactly the
   * "one sweep overreacted" setup the profile exists for.
   *
   * Every sweep gets a flow, so the reader has no omitted-flow reason to degrade
   * over. The only variable between the two runs is the hash in the seed.
   */
  async function marketWithACandidate(options: { drift: boolean }) {
    const built = await buildHarness({ agentCount: 15, env: { FLOP_ALLOW_REGISTRATION: 'false' } });
    harness = built;
    const dids = [...built.runtime.keyStore.agentIds].map((id) => built.runtime.keyStore.did(id));

    // The seed is the referee's own claim about which package is in force.
    built.referee.seedPost(options.drift ? DRIFTED : HARNESS_PACKAGE_HASH);
    for (let sweep = 1; sweep <= 8; sweep += 1) {
      built.referee.price(sweep, sweep === 8 ? '204' : '200');
      built.referee.flow(sweep, dids);
    }

    const report = await built.runtime.scheduler.runTick();
    return { harness: built, report };
  }

  it('runs the full path and only records a dry-run when the seed agrees', async () => {
    const { harness: h, report } = await marketWithACandidate({ drift: false });

    expect(report.conservative).toBe(false);
    expect(report.upstream.drift).toBe(false);
    // dry-run is the default: the trade is fully built and recorded, not posted.
    expect(h.transport.postsFor('close1')).toHaveLength(0);
    expect(report.trades.dryRun).toBeGreaterThan(0);
    const dry = h.runtime.db
      .prepare("SELECT COUNT(*) AS n FROM trades WHERE status = 'dry_run'")
      .get() as { n: number };
    expect(dry.n).toBe(report.trades.dryRun);
  });

  it('pauses active trading on a drifted seed: nothing built, nothing posted', async () => {
    const { harness: h, report } = await marketWithACandidate({ drift: true });

    expect(report.conservative).toBe(true);
    expect(report.upstream.drift).toBe(true);
    expect(report.trades.dryRun).toBe(0);
    expect(report.trades.posted).toBe(0);
    expect(h.transport.postsFor('close1')).toHaveLength(0);
    // No trade was even built: the deterministic gate refuses a degraded market
    // before anything reaches the signing path.
    expect(h.runtime.repositories.trades.count()).toBe(0);

    // The pin records both sides of the disagreement and keeps the launch
    // expectation. Nothing promoted the referee's hash to the new pin.
    const pin = h.runtime.repositories.upstream.getPin();
    expect(pin?.expected_package_hash).toBe(HARNESS_PACKAGE_HASH);
    expect(pin?.observed_package_hash).toBe(DRIFTED);
    expect(Number(pin?.drift)).toBe(1);
  });

  it('surfaces the drift on the status the health endpoint serves', async () => {
    const { harness: h } = await marketWithACandidate({ drift: true });
    const status = h.runtime.scheduler.status();
    expect(status.packageDrift).toBe(true);
    expect(status.upstream.drift).toBe(true);
    expect(status.expectedPackageHash).toBe(HARNESS_PACKAGE_HASH);
    expect(status.packageHash).toBe(DRIFTED);
    expect(status.conservativeReasons).toContain('package_hash_drift');
    // Reading is what tells us the problem is over; it never stops.
    expect(status.sweep).toBe(8);
    expect(status.reference).toBe('204');
  });
});
