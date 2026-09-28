/**
 * Upstream monitor: watch, record, report — and never apply.
 *
 * The load-bearing assertion is the last one in the drift test: the monitor may
 * write DB rows, but it must not reach any host other than GitHub, because the
 * release pipeline is a human decision.
 */
import { createHash } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createRepositories, openDatabase } from '@flop/storage';
import { loadConfig, type Config } from '../apps/orchestrator/src/config.js';
import { createLogger } from '../apps/orchestrator/src/logger.js';
import {
  RELEASE_STEPS,
  UpstreamMonitor,
  buildReleasePlan,
} from '../apps/orchestrator/src/upstream-monitor.js';

const REPO = 'flop-labs/technocore-close-call-challenge';
const BRANCH = 'main';
const API = `https://api.github.com/repos/${REPO}`;
const RAW = `https://raw.githubusercontent.com/${REPO}/${BRANCH}`;
const COMMIT_URL = `${API}/commits/${BRANCH}`;
const RELEASE_URL = `${API}/releases/latest`;

const hex = (body: string): string => createHash('sha256').update(body, 'utf8').digest('hex');

function upstreamConfig(): Config {
  return loadConfig({
    DATA_DIR: '/tmp/flop-upstream-unused',
    UPSTREAM_REPO: REPO,
    UPSTREAM_BRANCH: BRANCH,
  });
}

interface Route {
  status: number;
  body?: string;
  etag?: string;
}

function makeFetch(handler: (url: string, headers: Record<string, string>) => Route) {
  const calls: string[] = [];
  const impl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    const headers = (init?.headers ?? {}) as Record<string, string>;
    calls.push(url);
    const route = handler(url, headers);
    return new Response(route.body ?? null, {
      status: route.status,
      headers: route.etag ? { etag: route.etag } : undefined,
    });
  }) as typeof fetch;
  return { impl, calls };
}

/** A handler that serves every endpoint with healthy bodies. */
function healthy(
  bodies: { manifest?: string; contest?: string; game?: string; fold?: string } = {},
): (url: string) => Route {
  const manifest = bodies.manifest ?? 'MANIFEST';
  const contest = bodies.contest ?? 'CONTEST';
  const game = bodies.game ?? 'GAME';
  const fold = bodies.fold ?? 'FOLD';
  return (url: string): Route => {
    if (url === COMMIT_URL) {
      return {
        status: 200,
        body: JSON.stringify({
          sha: 'sha-1',
          commit: { message: 'rules update' },
          files: [{ filename: 'manifest.json' }, { filename: 'contest.json' }],
        }),
        etag: 'etag-1',
      };
    }
    if (url === RELEASE_URL) return { status: 200, body: JSON.stringify({ tag_name: 'v2.0.0' }) };
    if (url === `${RAW}/manifest.json`) return { status: 200, body: manifest };
    if (url === `${RAW}/contest.json`) return { status: 200, body: contest };
    if (url === `${RAW}/close-call-game.md`) return { status: 200, body: game };
    if (url === `${RAW}/close_call_fold.py`) return { status: 200, body: fold };
    return { status: 404 };
  };
}

function setup() {
  const db = openDatabase({ path: ':memory:' });
  const repositories = createRepositories(db);
  const logger = createLogger({ level: 'debug', repositories });
  return { db, repositories, logger };
}

const dbs: Array<ReturnType<typeof openDatabase>> = [];
afterEach(() => {
  for (const db of dbs.splice(0)) {
    try {
      db.close();
    } catch {
      /* already closed */
    }
  }
  vi.useRealTimers();
});

describe('upstream monitor: a first check', () => {
  it('stores the commit, message, changed files and all four file hashes', async () => {
    const { db, repositories, logger } = setup();
    dbs.push(db);
    const { impl } = makeFetch(healthy());
    const monitor = new UpstreamMonitor({
      config: upstreamConfig(),
      logger,
      repositories,
      fetchImpl: impl,
      now: () => new Date('2026-01-01T00:00:00.000Z'),
    });

    const { snapshot, drift } = await monitor.check();

    expect(drift).toBe(false);
    expect(snapshot.commitSha).toBe('sha-1');
    expect(snapshot.commitMessage).toBe('rules update');
    expect(snapshot.changedFiles).toEqual(['manifest.json', 'contest.json']);
    expect(snapshot.release).toBe('v2.0.0');
    expect(snapshot.manifestHash).toBe(hex('MANIFEST'));
    expect(snapshot.contestHash).toBe(hex('CONTEST'));
    expect(snapshot.gameHash).toBe(hex('GAME'));
    expect(snapshot.foldHash).toBe(hex('FOLD'));
    expect(snapshot.notModified).toBe(false);

    const row = repositories.upstream.latest();
    expect(row?.commit_sha).toBe('sha-1');
    expect(row?.manifest_hash).toBe(hex('MANIFEST'));
    expect(row?.not_modified).toBe(0);
    expect(JSON.parse(row?.changed_files ?? '[]')).toEqual(['manifest.json', 'contest.json']);
    expect(repositories.upstream.countSince('1970-01-01T00:00:00.000Z')).toBe(1);
  });

  it('pins the observed hash on the first run rather than alerting', async () => {
    const { db, repositories, logger } = setup();
    dbs.push(db);
    const { impl } = makeFetch(healthy({ manifest: 'FIRST' }));
    const monitor = new UpstreamMonitor({
      config: upstreamConfig(),
      logger,
      repositories,
      fetchImpl: impl,
      now: () => new Date('2026-01-01T00:00:00.000Z'),
    });

    const { drift } = await monitor.check();
    expect(drift).toBe(false);
    expect(repositories.upstream.getPin()?.expected_package_hash).toBe(hex('FIRST'));
  });
});

describe('upstream monitor: conditional requests', () => {
  it('records not_modified on a 304 without changing the commit sha', async () => {
    const { db, repositories, logger } = setup();
    dbs.push(db);
    const { impl } = makeFetch((url, headers) => {
      if (url === COMMIT_URL) {
        if (headers['If-None-Match'] === 'etag-1') return { status: 304 };
        return {
          status: 200,
          body: JSON.stringify({ sha: 'sha-1', commit: { message: 'm' }, files: [] }),
          etag: 'etag-1',
        };
      }
      if (url === RELEASE_URL) return { status: 200, body: JSON.stringify({ tag_name: 'v1' }) };
      if (url.startsWith(`${RAW}/`)) return { status: 200, body: url };
      return { status: 404 };
    });
    const monitor = new UpstreamMonitor({
      config: upstreamConfig(),
      logger,
      repositories,
      fetchImpl: impl,
      now: () => new Date('2026-01-01T00:00:00.000Z'),
    });

    await monitor.check();
    const second = await monitor.check();

    expect(second.snapshot.notModified).toBe(true);
    expect(second.snapshot.commitSha).toBe('sha-1');

    const row = repositories.upstream.latest();
    expect(row?.not_modified).toBe(1);
    expect(row?.commit_sha).toBe('sha-1');
    expect(repositories.upstream.countSince('1970-01-01T00:00:00.000Z')).toBe(2);
  });
});

describe('upstream monitor: partial failures', () => {
  it('records null for a failed raw file and still records the rest', async () => {
    const { db, repositories, logger } = setup();
    dbs.push(db);
    const { impl } = makeFetch((url) => {
      if (url === COMMIT_URL) {
        return { status: 200, body: JSON.stringify({ sha: 'sha-1', commit: { message: 'm' }, files: [] }) };
      }
      if (url === RELEASE_URL) return { status: 404 };
      if (url === `${RAW}/close-call-game.md`) return { status: 500 };
      if (url === `${RAW}/manifest.json`) return { status: 200, body: 'MANIFEST' };
      if (url === `${RAW}/contest.json`) return { status: 200, body: 'CONTEST' };
      if (url === `${RAW}/close_call_fold.py`) return { status: 200, body: 'FOLD' };
      return { status: 404 };
    });
    const monitor = new UpstreamMonitor({
      config: upstreamConfig(),
      logger,
      repositories,
      fetchImpl: impl,
      now: () => new Date('2026-01-01T00:00:00.000Z'),
    });

    const { snapshot } = await monitor.check();

    expect(snapshot.gameHash).toBeNull();
    expect(snapshot.manifestHash).toBe(hex('MANIFEST'));
    expect(snapshot.contestHash).toBe(hex('CONTEST'));
    expect(snapshot.foldHash).toBe(hex('FOLD'));
    expect(repositories.upstream.countSince('1970-01-01T00:00:00.000Z')).toBe(1);
  });
});

describe('upstream monitor: drift is reported, never applied', () => {
  it('flags drift, records the permanent event, and touches only GitHub + the DB', async () => {
    const { db, repositories, logger } = setup();
    dbs.push(db);
    repositories.upstream.setPin({
      season: 'close-1',
      expected_package_hash: 'f'.repeat(64),
      observed_package_hash: null,
      referee_did: null,
      pinned_at: '2026-01-01T00:00:00.000Z',
      drift: 0,
      drift_detail: null,
    });

    const { impl, calls } = makeFetch(healthy({ manifest: 'NEWMANIFEST' }));
    const monitor = new UpstreamMonitor({
      config: upstreamConfig(),
      logger,
      repositories,
      fetchImpl: impl,
      now: () => new Date('2026-01-01T00:00:00.000Z'),
    });

    const { drift, driftDetail, snapshot } = await monitor.check();

    expect(drift).toBe(true);
    expect(snapshot.manifestHash).toBe(hex('NEWMANIFEST'));
    expect(driftDetail).toContain('does not match pinned');
    expect(repositories.upstream.latest()?.drift).toBe(1);

    const eventCodes = repositories.events.recent(20).map((row) => row.code);
    expect(eventCodes).toContain('package_hash_drift');

    // The pin is a human-set expectation and must not be rewritten by the monitor.
    expect(repositories.upstream.getPin()?.expected_package_hash).toBe('f'.repeat(64));

    // Only GitHub hosts were contacted, and no git/npm/pnpm command could have
    // run: the fake fetch is the only side effect, and it only ever saw GitHub.
    expect(calls.length).toBeGreaterThan(0);
    for (const url of calls) {
      expect(['api.github.com', 'raw.githubusercontent.com']).toContain(new URL(url).host);
    }

    const eventCount = (db.prepare('SELECT COUNT(*) AS n FROM events').get() as { n: number }).n;
    expect(eventCount).toBe(1);
  });
});

describe('upstream monitor: scheduling', () => {
  it('runs on an unref', async () => {
    // The timer is created with `.unref()`; this asserts the observable contract
    // that stop() then advancing time produces no further checks.
    vi.useFakeTimers();
    const { db, repositories, logger } = setup();
    dbs.push(db);
    const { impl, calls } = makeFetch(healthy());
    const config = upstreamConfig();
    const monitor = new UpstreamMonitor({
      config,
      logger,
      repositories,
      fetchImpl: impl,
      now: () => new Date('2026-01-01T00:00:00.000Z'),
    });

    monitor.start();
    await vi.advanceTimersByTimeAsync(config.upstream.checkMinutes * 60_000 + 1);
    expect(calls.length).toBeGreaterThan(0);

    const afterFirstTicks = calls.length;
    monitor.stop();
    await vi.advanceTimersByTimeAsync(config.upstream.checkMinutes * 60_000 * 3);
    expect(calls.length).toBe(afterFirstTicks);
  });
});

describe('release procedure', () => {
  it('lists the full ordered procedure and builds the release paths', () => {
    expect(RELEASE_STEPS).toContain('pnpm install --frozen-lockfile');
    expect(RELEASE_STEPS).toContain('human confirmation');
    expect(RELEASE_STEPS).toContain('pm2 reload');
    expect(RELEASE_STEPS.indexOf('lint')).toBeGreaterThan(
      RELEASE_STEPS.indexOf('pnpm install --frozen-lockfile'),
    );
    expect(RELEASE_STEPS.indexOf('pm2 reload')).toBeGreaterThan(
      RELEASE_STEPS.indexOf('human confirmation'),
    );
    expect(RELEASE_STEPS[RELEASE_STEPS.length - 1]).toMatch(/rollback/);

    const plan = buildReleasePlan('/opt/flop-close-call/releases', '1.2.3');
    expect(plan.version).toBe('1.2.3');
    expect(plan.path).toBe('/opt/flop-close-call/releases/1.2.3');
    expect(plan.previousPath).toBe('/opt/flop-close-call/releases/current');
    expect(plan.steps).toEqual(RELEASE_STEPS);
  });
});
