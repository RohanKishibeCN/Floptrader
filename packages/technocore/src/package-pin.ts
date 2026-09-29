/**
 * The package pin: the manifest hash that fixes the rules for this season.
 *
 * FLOP Labs pins the package manifest hash and the referee DID in the launch
 * record and in the referee's seed message. "The rules and fold stay frozen during
 * the contest." So this module does one job, and does it conservatively:
 *
 *   - record the expected hash (from the launch record, `reference/manifest.json`,
 *     or a pinned value in `package_pins`);
 *   - compare it against the hash the referee's seed message quotes;
 *   - on a mismatch, stop active trading and say so loudly. **Never** switch to the
 *     new package, never reload, never follow GitHub `main`.
 *
 * The last point is the whole reason this is a separate module with a boring
 * implementation: the tempting behaviour is exactly the dangerous one.
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

export interface PackageComparison {
  drift: boolean;
  expected: string | null;
  observed: string | null;
  detail: string | null;
}

/** Normalise a hex digest, accepting an optional `sha256:` prefix. */
export function normalizeHash(value: string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  const trimmed = value.trim().toLowerCase();
  if (trimmed.length === 0) return null;
  return trimmed.startsWith('sha256:') ? trimmed.slice('sha256:'.length) : trimmed;
}

/**
 * Compare the pinned hash against an observed one.
 *
 * Both missing is not drift (nothing is claimed). Exactly one missing is drift:
 * a contest whose rules hash is unknown on one side is not a contest we should be
 * trading in.
 */
export function comparePackageHash(
  expected: string | null | undefined,
  observed: string | null | undefined,
): PackageComparison {
  const left = normalizeHash(expected);
  const right = normalizeHash(observed);
  if (left === null && right === null) {
    return { drift: false, expected: null, observed: null, detail: null };
  }
  if (left === null) {
    return {
      drift: true,
      expected: null,
      observed: right,
      detail: 'no expected package hash is pinned',
    };
  }
  if (right === null) {
    return {
      drift: true,
      expected: left,
      observed: null,
      detail: 'the referee has not quoted a package hash',
    };
  }
  if (left === right) return { drift: false, expected: left, observed: right, detail: null };
  return {
    drift: true,
    expected: left,
    observed: right,
    detail: `package hash changed: pinned ${left}, referee says ${right}`,
  };
}

export function sha256Hex(body: string | Uint8Array): string {
  return createHash('sha256').update(body).digest('hex');
}

/**
 * The vendored reference files, hashed. `reference/manifest.json` records these
 * hashes for the whole package, which is how the pin is bootstrapped from a
 * checkout rather than from the network.
 */
export interface PinnedPackage {
  manifestHash: string;
  contestHash: string;
  gameHash: string;
  foldHash: string;
  refereeDid: string | null;
}

export function pinnedFromManifest(manifest: {
  files?: Record<string, { sha256?: string }>;
}): Partial<PinnedPackage> {
  const files = manifest.files ?? {};
  const hash = (path: string): string | undefined => normalizeHash(files[path]?.sha256) ?? undefined;
  const manifestHash = hash('manifest.json');
  return {
    ...(manifestHash === undefined ? {} : { manifestHash }),
    ...(hash('contest.json') === undefined ? {} : { contestHash: hash('contest.json')! }),
    ...(hash('close-call-game.md') === undefined ? {} : { gameHash: hash('close-call-game.md')! }),
    ...(hash('close_call_fold.py') === undefined ? {} : { foldHash: hash('close_call_fold.py')! }),
  };
}

export const PINNED_PATHS = [
  'manifest.json',
  'contest.json',
  'close-call-game.md',
  'close_call_fold.py',
] as const;

export type PinnedPath = (typeof PINNED_PATHS)[number];

/**
 * The paths this repository actually vendors out of the official package.
 *
 * `manifest.json` lists thirteen files; we ship four of them, and the manifest
 * cannot record a hash for itself. So the check below covers the three vendored
 * files the manifest *does* hash, and the pin is the manifest's own sha256 —
 * computed from its bytes, never read out of its `files` map.
 */
export const VENDORED_PACKAGE_PATHS = [
  'contest.json',
  'close-call-game.md',
  'close_call_fold.py',
] as const;

export interface LocalPackageManifest {
  /**
   * sha256 of `reference/manifest.json` — the value a referee seed quotes as
   * `package`. Empty only when the manifest could not be read at all.
   */
  manifestHash: string;
  /** The vendored files whose bytes matched the manifest's record. */
  verified: Array<{ path: string; sha256: string }>;
  problems: string[];
  ok: boolean;
}

/**
 * Compute the local package pin from the vendored reference directory.
 *
 * This is the only source of the expected package hash. An empty string is never
 * an acceptable result: a bundle generated against "no package" would leave the
 * seed's `package` field unbound, which is exactly the hole this closes. Every
 * failure — a missing manifest, unparseable JSON, a vendored file whose bytes
 * disagree with the manifest — is collected and returned with `ok: false` so the
 * caller can fail closed.
 */
export function computeLocalPackageManifestHash(referenceDir: string): LocalPackageManifest {
  const dir = referenceDir.replace(/\/+$/, '');
  const verified: Array<{ path: string; sha256: string }> = [];
  const problems: string[] = [];

  const manifestPath = `${dir}/manifest.json`;
  let raw: Buffer;
  try {
    raw = readFileSync(manifestPath);
  } catch (error) {
    return {
      manifestHash: '',
      verified,
      problems: [`cannot read ${manifestPath}: ${message(error)}`],
      ok: false,
    };
  }

  const manifestHash = sha256Hex(new Uint8Array(raw));

  let parsed: { files?: Record<string, { sha256?: string }> };
  try {
    parsed = JSON.parse(raw.toString('utf8')) as typeof parsed;
  } catch (error) {
    return {
      manifestHash,
      verified,
      problems: [`${manifestPath} is not valid JSON: ${message(error)}`],
      ok: false,
    };
  }

  const files = parsed.files ?? {};
  for (const relative of VENDORED_PACKAGE_PATHS) {
    const expected = normalizeHash(files[relative]?.sha256);
    if (expected === null) {
      problems.push(`manifest.json records no sha256 for ${relative}`);
      continue;
    }
    let bytes: Buffer;
    try {
      bytes = readFileSync(`${dir}/${relative}`);
    } catch {
      problems.push(`vendored file is missing: ${relative}`);
      continue;
    }
    const actual = sha256Hex(new Uint8Array(bytes));
    if (actual !== expected) {
      problems.push(`${relative} hashes to ${actual}, but the manifest says ${expected}`);
      continue;
    }
    verified.push({ path: relative, sha256: actual });
  }

  return { manifestHash, verified, problems, ok: problems.length === 0 };
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * The decision a pin change implies. Modelled explicitly so no caller can
 * accidentally treat "hash changed" as "keep going".
 */
export interface DriftDecision {
  action: 'continue' | 'pause_active_trading' | 'pause_trading_and_alert';
  reason: string;
  /** Always false. A comment would be easier to delete than this constant. */
  switchPackageAutomatically: false;
}

export function decideOnDrift(comparison: PackageComparison, role: 'seed' | 'upstream'): DriftDecision {
  if (!comparison.drift) {
    return { action: 'continue', reason: 'package hash matches the pin', switchPackageAutomatically: false };
  }
  if (role === 'seed') {
    // The referee is the authority on contest state; a disagreeing seed hash means
    // we may be about to trade under rules we did not agree to.
    return {
      action: 'pause_trading_and_alert',
      reason: comparison.detail ?? 'referee package hash differs from the pin',
      switchPackageAutomatically: false,
    };
  }
  // An upstream change is informational: GitHub main moves, the contest does not.
  return {
    action: 'pause_active_trading',
    reason: comparison.detail ?? 'upstream package hash differs from the pin',
    switchPackageAutomatically: false,
  };
}
