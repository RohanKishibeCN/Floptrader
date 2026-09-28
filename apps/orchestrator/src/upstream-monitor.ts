/**
 * Upstream monitor: watch the official GitHub repo for rule changes and NEVER
 * apply them automatically.
 *
 * This is deliberately a read-only, report-only component. The release pipeline
 * is a human decision: the monitor records what it observed, flags a drift from
 * the pinned package hash, and stops there. It never runs git, npm, pnpm, pm2 or
 * anything that could reload the running process — `ReleaseManager` documents the
 * manual procedure and `assertNoAutomaticApply()` exists so a future patch cannot
 * quietly wire automation in.
 */
import { createHash } from 'node:crypto';
import type { Config } from './config.js';
import type { Logger } from './logger.js';
import type { Repositories, UpstreamEventRow } from '@flop/storage';

const REQUEST_TIMEOUT_MS = 15_000;
const GITHUB_API = 'https://api.github.com';
const RAW_HOST = 'https://raw.githubusercontent.com';

/**
 * Local stand-in for the (not-yet-existing) `@flop/technocore` package-pin
 * helper. `packages/technocore/src/package-pin.ts` does not exist in this tree,
 * so the interface is consumed here instead of imported. Keep the shape the same
 * if/when it lands: `{ drift, expected, observed }`.
 */
function comparePackageHash(
  expected: string | null,
  observed: string | null,
): { drift: boolean; expected: string | null; observed: string | null } {
  if (expected === null || expected === '') return { drift: false, expected: null, observed };
  return { drift: observed !== expected, expected, observed };
}

export interface UpstreamSnapshot {
  commitSha: string | null;
  commitMessage: string | null;
  changedFiles: string[];
  release: string | null;
  manifestHash: string | null;
  contestHash: string | null;
  gameHash: string | null;
  foldHash: string | null;
  etag: string | null;
  notModified: boolean;
  checkedAt: string;
}

export interface UpstreamCheckResult {
  snapshot: UpstreamSnapshot;
  drift: boolean;
  driftDetail: string | null;
}

export interface UpstreamMonitorOptions {
  config: Config;
  logger: Logger;
  repositories: Repositories;
  fetchImpl?: typeof fetch;
  now?: () => Date;
}

interface Fetched {
  ok: boolean;
  status: number;
  etag: string | null;
  body: string;
}

/** Plain hex sha256 — the GitHub manifest records raw hex, no `sha256:` prefix. */
function sha256Hex(body: string): string {
  return createHash('sha256').update(body, 'utf8').digest('hex');
}

function rawHashesFrom(files: unknown): string[] {
  if (!Array.isArray(files)) return [];
  const names: string[] = [];
  for (const entry of files) {
    if (entry && typeof entry === 'object' && typeof (entry as { filename?: unknown }).filename === 'string') {
      names.push((entry as { filename: string }).filename);
    }
  }
  return names;
}

export class UpstreamMonitor {
  private readonly config: Config;
  private readonly logger: Logger;
  private readonly repositories: Repositories;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => Date;
  private timer: ReturnType<typeof setInterval> | undefined;
  private lastCheck: string | null = null;
  private failureCount = 0;

  constructor(options: UpstreamMonitorOptions) {
    this.config = options.config;
    this.logger = options.logger;
    this.repositories = options.repositories;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.now = options.now ?? (() => new Date());
  }

  get lastCheckAt(): string | null {
    return this.lastCheck;
  }

  get consecutiveFailures(): number {
    return this.failureCount;
  }

  async check(): Promise<UpstreamCheckResult> {
    const checkedAt = this.now().toISOString();
    const previous = this.repositories.upstream.latest();
    const repo = this.config.upstream.repo;
    const branch = this.config.upstream.branch;

    const baseHeaders: Record<string, string> = {
      Accept: 'application/vnd.github+json',
      'User-Agent': 'flop-close-call-orchestrator',
    };
    // The token is sent, never logged and never placed in an event payload.
    if (this.config.upstream.githubToken.length > 0) {
      baseHeaders.Authorization = `Bearer ${this.config.upstream.githubToken}`;
    }

    // Conditional request: ETag first, then the last checked-at as a fallback.
    const conditionalHeaders: Record<string, string> = { ...baseHeaders };
    if (previous?.etag) conditionalHeaders['If-None-Match'] = previous.etag;
    else if (previous?.checked_at) conditionalHeaders['If-Modified-Since'] = previous.checked_at;

    const commitUrl = `${GITHUB_API}/repos/${repo}/commits/${encodeURIComponent(branch)}`;
    const commit = await this.safeFetch(commitUrl, conditionalHeaders);

    if (commit && commit.status === 304 && previous) {
      // Nothing changed upstream: reuse the previous snapshot verbatim.
      const snapshot = this.snapshotFromRow(previous, checkedAt, true);
      this.repositories.upstream.insert({
        checked_at: checkedAt,
        commit_sha: previous.commit_sha,
        commit_message: previous.commit_message,
        changed_files: previous.changed_files,
        release: previous.release,
        manifest_hash: previous.manifest_hash,
        contest_hash: previous.contest_hash,
        game_hash: previous.game_hash,
        fold_hash: previous.fold_hash,
        etag: previous.etag,
        not_modified: 1,
        drift: previous.drift,
        drift_detail: previous.drift_detail,
      });
      this.lastCheck = checkedAt;
      this.failureCount = 0;
      return { snapshot, drift: previous.drift === 1, driftDetail: previous.drift_detail };
    }

    let commitSha: string | null = null;
    let commitMessage: string | null = null;
    let changedFiles: string[] = [];
    let etag = previous?.etag ?? null;

    if (commit && commit.ok) {
      this.failureCount = 0;
      try {
        const parsed = JSON.parse(commit.body) as {
          sha?: unknown;
          commit?: { message?: unknown };
          files?: unknown;
        };
        commitSha = typeof parsed.sha === 'string' ? parsed.sha : null;
        commitMessage =
          parsed.commit && typeof parsed.commit.message === 'string' ? parsed.commit.message : null;
        changedFiles = rawHashesFrom(parsed.files);
      } catch {
        // A malformed body is recorded as "no commit" rather than aborting the check.
      }
      if (commit.etag) etag = commit.etag;
    } else {
      this.failureCount += 1;
    }

    // Release is best effort; a 404 (no releases yet) is tolerated as null.
    const releaseRes = await this.safeFetch(`${GITHUB_API}/repos/${repo}/releases/latest`, baseHeaders);
    let release: string | null = null;
    if (releaseRes && releaseRes.ok) {
      try {
        const parsed = JSON.parse(releaseRes.body) as { tag_name?: unknown };
        release = typeof parsed.tag_name === 'string' ? parsed.tag_name : null;
      } catch {
        release = null;
      }
    }

    // Raw files are fetched independently: one failure records null and the rest
    // still proceed.
    const rawBase = `${RAW_HOST}/${repo}/${branch}`;
    const [manifestHash, contestHash, gameHash, foldHash] = await Promise.all([
      this.hashRaw(`${rawBase}/manifest.json`, baseHeaders),
      this.hashRaw(`${rawBase}/contest.json`, baseHeaders),
      this.hashRaw(`${rawBase}/close-call-game.md`, baseHeaders),
      this.hashRaw(`${rawBase}/close_call_fold.py`, baseHeaders),
    ]);

    const previousPin = this.repositories.upstream.getPin();
    let drift = false;
    let driftDetail: string | null = null;
    if (previousPin?.expected_package_hash) {
      const comparison = comparePackageHash(previousPin.expected_package_hash, manifestHash);
      drift = comparison.drift;
      if (drift) {
        driftDetail =
          `manifest.json hash ${comparison.observed ?? 'null'} does not match ` +
          `pinned ${comparison.expected}`;
      }
    } else if (manifestHash) {
      // First observation (or a pin without an expectation): pin rather than alert.
      this.repositories.upstream.setPin({
        season: this.config.season,
        expected_package_hash: manifestHash,
        observed_package_hash: manifestHash,
        referee_did: null,
        pinned_at: checkedAt,
        drift: 0,
        drift_detail: null,
      });
    }

    this.repositories.upstream.insert({
      checked_at: checkedAt,
      commit_sha: commitSha,
      commit_message: commitMessage,
      changed_files: changedFiles.length > 0 ? JSON.stringify(changedFiles) : null,
      release,
      manifest_hash: manifestHash,
      contest_hash: contestHash,
      game_hash: gameHash,
      fold_hash: foldHash,
      etag,
      not_modified: 0,
      drift: drift ? 1 : 0,
      drift_detail: driftDetail,
    });

    if (drift) {
      // Report only. The release pipeline is a human decision; this monitor must
      // never git pull, npm/pnpm install, or reload the process on drift.
      this.logger.event({
        level: 'error',
        source: 'upstream-monitor',
        code: 'package_hash_drift',
        message: 'official package hash drifted from the pin; manual release required',
        data: { expected: previousPin?.expected_package_hash ?? null, observed: manifestHash },
      });
    }

    this.lastCheck = checkedAt;
    const snapshot: UpstreamSnapshot = {
      commitSha,
      commitMessage,
      changedFiles,
      release,
      manifestHash,
      contestHash,
      gameHash,
      foldHash,
      etag,
      notModified: false,
      checkedAt,
    };
    return { snapshot, drift, driftDetail };
  }

  /** Repeating check, `unref`d so it can never hold the process open. */
  start(): void {
    if (this.timer) return;
    const intervalMs = Math.max(1, this.config.upstream.checkMinutes) * 60_000;
    this.timer = setInterval(() => {
      void this.check().catch(() => {
        /* a failed scheduled check is retried next tick */
      });
    }, intervalMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (!this.timer) return;
    clearInterval(this.timer);
    this.timer = undefined;
  }

  private async safeFetch(url: string, headers: Record<string, string>): Promise<Fetched | null> {
    try {
      const response = await this.fetchImpl(url, {
        headers,
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      return {
        ok: response.ok,
        status: response.status,
        etag: response.headers.get('etag'),
        body: await response.text(),
      };
    } catch {
      return null;
    }
  }

  private async hashRaw(url: string, headers: Record<string, string>): Promise<string | null> {
    const response = await this.safeFetch(url, headers);
    if (!response || !response.ok) return null;
    return sha256Hex(response.body);
  }

  private snapshotFromRow(row: UpstreamEventRow, checkedAt: string, notModified: boolean): UpstreamSnapshot {
    let changedFiles: string[] = [];
    if (row.changed_files) {
      try {
        const parsed = JSON.parse(row.changed_files) as unknown;
        if (Array.isArray(parsed)) changedFiles = parsed.filter((f): f is string => typeof f === 'string');
      } catch {
        changedFiles = [];
      }
    }
    return {
      commitSha: row.commit_sha,
      commitMessage: row.commit_message,
      changedFiles,
      release: row.release,
      manifestHash: row.manifest_hash,
      contestHash: row.contest_hash,
      gameHash: row.game_hash,
      foldHash: row.fold_hash,
      etag: row.etag,
      notModified,
      checkedAt,
    };
  }
}

/**
 * The documented release procedure, expressed as data so the CLI can print it and
 * a test can assert it stays complete. Nothing here is executed by the monitor.
 */
export const RELEASE_STEPS: readonly string[] = [
  'fetch the candidate release from upstream',
  'create the candidate release directory',
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
];

export interface ReleasePlan {
  version: string;
  path: string;
  previousPath: string | null;
  steps: readonly string[];
}

/** `<releasesDir>/<version>` for the candidate, `<releasesDir>/current` for rollback. */
export function buildReleasePlan(releasesDir: string, version: string): ReleasePlan {
  const base = releasesDir.replace(/\/+$/, '');
  return {
    version,
    path: `${base}/${version}`,
    previousPath: `${base}/current`,
    steps: RELEASE_STEPS,
  };
}

export class ReleaseManager {
  constructor(private readonly releasesDir: string) {}

  plan(version: string): ReleasePlan {
    return buildReleasePlan(this.releasesDir, version);
  }

  steps(): readonly string[] {
    return RELEASE_STEPS;
  }

  /**
   * Exists so a future patch cannot quietly wire automation in. Called nowhere.
   */
  assertNoAutomaticApply(): never {
    throw new Error('release application is a human decision; this monitor only reports');
  }
}
