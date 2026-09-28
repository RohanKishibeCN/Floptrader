/**
 * Archive maintenance / retention.
 *
 * The whole point of the retention policy is the negative: key contest evidence
 * is never deleted, however old it is and however many times maintenance runs.
 * The archive path is deliberately "checksum first, then delete", and an
 * archive is only removed after an external backup has been checksummed too.
 */
import { existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  createRepositories,
  fileBytes,
  openDatabase,
  sha256File,
  snapshotPermanentCounts,
  type Repositories,
  type SqliteDatabase,
} from '@flop/storage';
import { loadConfig, type Config } from '../apps/orchestrator/src/config.js';
import { createLogger } from '../apps/orchestrator/src/logger.js';
import { LoadGuard } from '../apps/orchestrator/src/load-guard.js';
import { ArchiveMaintenance } from '../apps/orchestrator/src/archive-maintenance.js';
import { cleanup, tempDir } from './support/harness.js';

const LOCAL_DID = 'did:key:local';
const NOW = '2026-06-01T00:00:00.000Z';

interface Ctx {
  dir: string;
  config: Config;
  db: SqliteDatabase;
  repositories: Repositories;
  maintenance: ArchiveMaintenance;
}

const contexts: Ctx[] = [];
afterEach(() => {
  for (const ctx of contexts.splice(0)) {
    cleanup(ctx.dir);
  }
});

function makeCtx(localDids: string[] = [LOCAL_DID]): Ctx {
  const dir = tempDir();
  const config = loadConfig({ DATA_DIR: dir });
  mkdirSync(config.paths.archive, { recursive: true });
  const db = openDatabase({ path: ':memory:' });
  const repositories = createRepositories(db);
  const now = new Date(NOW);
  const loadGuard = new LoadGuard({
    config,
    logger: createLogger({ level: 'fatal' }),
    readProcessMemory: () => ({ rssBytes: 100, heapUsedBytes: 10 }),
    readDiskUsage: () => 5,
    now: () => now,
  });
  const maintenance = new ArchiveMaintenance({
    config,
    logger: createLogger({ level: 'fatal', repositories }),
    repositories,
    db,
    loadGuard,
    localDids: () => localDids,
    now: () => now,
  });
  const ctx: Ctx = { dir, config, db, repositories, maintenance };
  contexts.push(ctx);
  return ctx;
}

function insertMessage(
  repositories: Repositories,
  room: string,
  seq: number,
  ts: string,
  kind: string,
  senderDid: string | null,
  text = 'x',
): void {
  repositories.messages.insert({
    room,
    seq,
    ts,
    sender_did: senderDid,
    nonce: null,
    sig: null,
    text,
    kind,
    signature_valid: 1,
    ingested_at: ts,
  });
}

/** One agent's full evidence set: registration, control, a trade and referee data. */
function seedEvidence(ctx: Ctx): void {
  const { repositories } = ctx;
  repositories.identities.upsert({
    agent_id: 'agent-1',
    did: LOCAL_DID,
    public_key_multibase: 'z6Mk',
    fingerprint: 'sha256:0',
    strategy_group: 'g1',
    season: 'close-1',
    risk_tier: 'low',
    random_seed: 1,
    max_qty: '1.00',
    max_open_notional: '1.00',
    cooldown_sweeps: 0,
    confidence_threshold: '0.50',
    strategy_version: 'v1',
    last_run_at: null,
    last_run_week: null,
    enabled: 1,
  });
  repositories.participation.upsert({
    agent_id: 'agent-1',
    did: LOCAL_DID,
    season: 'close-1',
    registration_text: 'reg',
    registration_nonce: 'n1',
    registration_signature: 'sig',
    room: 'close1',
    technocore_seq: 1,
    technocore_ts: NOW,
    posted_at: NOW,
    readback_at: NOW,
    package_hash: 'p'.repeat(64),
    referee_did: null,
    status: 'readback_confirmed',
    attempts: 1,
    last_error: null,
    updated_at: NOW,
  });
  repositories.controlProofs.upsert({
    agent_id: 'agent-1',
    did: LOCAL_DID,
    challenge_hash: 'h',
    signature: 's',
    created_at: NOW,
    verified: 1,
    verified_at: NOW,
  });
  repositories.trades.insert({
    id: 't-1',
    season: 'close-1',
    maker_did: LOCAL_DID,
    taker_did: null,
    side: 'buy',
    qty: '1.00',
    px: '100.00',
    until_sweep: 5,
    maker_sig: 'sig',
    taker_sig: null,
    status: 'pending',
  });
  repositories.referee.insertSnapshot({
    room: 'close1',
    seq: 1,
    sweep: 1,
    kind: 'price',
    payload: '{}',
    ref_px: '100.00',
    limits_low: '90.00',
    limits_high: '110.00',
    package_hash: 'p'.repeat(64),
    referee_did: 'did:key:ref',
    signature_valid: 1,
    created_at: NOW,
  });
  insertMessage(repositories, 'close1', 10, NOW, 'owner', LOCAL_DID, 'registration');
  insertMessage(repositories, 'close1', 11, NOW, 'trade', LOCAL_DID, 'trade');
  insertMessage(repositories, 'close1', 12, NOW, 'chat', LOCAL_DID, 'our own chatter');
}

describe('archive maintenance: gating', () => {
  it('prunes nothing when the daily report did not go out, and says why', async () => {
    const ctx = makeCtx();
    insertMessage(ctx.repositories, 'close1', 1, '2026-01-01T00:00:00.000Z', 'chat', null, 'old');
    insertMessage(ctx.repositories, 'close1', 1000, NOW, 'room', 'did:key:other', 'recent');
    const before = ctx.repositories.messages.count();

    const report = await ctx.maintenance.run(false);

    expect(report.chatterDeleted).toBe(0);
    expect(report.notes.join(' ')).toMatch(/report/);
    expect(ctx.repositories.messages.count()).toBe(before);
    expect(readdirSync(ctx.config.paths.archive)).toHaveLength(0);
  });
});

describe('archive maintenance: normal run', () => {
  it('archives third-party chatter to a verifiable .jsonl.gz before deleting it', async () => {
    const ctx = makeCtx();
    // The chatter is old, third-party, and far enough behind the newest seq to
    // fall outside the keep-recent window.
    insertMessage(ctx.repositories, 'close1', 1, '2026-01-01T00:00:00.000Z', 'chat', null, 'old');
    insertMessage(ctx.repositories, 'close1', 1000, NOW, 'room', 'did:key:other', 'recent');

    const report = await ctx.maintenance.run(true);

    expect(report.chatterArchived).toBe(1);
    expect(report.chatterDeleted).toBe(1);
    expect(ctx.repositories.messages.count()).toBe(1);

    const files = readdirSync(ctx.config.paths.archive).filter((name) => name.endsWith('.jsonl.gz'));
    expect(files).toHaveLength(1);
    const archivePath = join(ctx.config.paths.archive, files[0]!);
    const manifest = ctx.repositories.archiveManifests.get(archivePath);
    expect(manifest).toBeTruthy();
    expect(String(manifest?.sha256)).toBe(sha256File(archivePath));
    expect(Number(manifest?.verified)).toBe(1);
  });
});

describe('archive maintenance: evidence is permanent', () => {
  it('keeps every piece of key evidence across two maintenance runs', async () => {
    const ctx = makeCtx();
    seedEvidence(ctx);
    const before = snapshotPermanentCounts(ctx.db);

    await ctx.maintenance.run(true);
    await ctx.maintenance.run(true);

    const after = snapshotPermanentCounts(ctx.db);
    // messages and events are the prunable tables and are not in the snapshot,
    // so every permanent count — including archive_manifests — must be unchanged.
    expect(after).toEqual(before);

    expect(ctx.repositories.identities.get('agent-1')).toBeTruthy();
    expect(ctx.repositories.participation.get('agent-1')).toBeTruthy();
    expect(ctx.repositories.controlProofs.all()).toHaveLength(1);
    expect(ctx.repositories.trades.get('t-1')).toBeTruthy();
    expect(ctx.repositories.referee.count()).toBe(1);

    const kinds = ctx.repositories.messages
      .recent('close1', 100)
      .map((row) => row.kind)
      .sort();
    expect(kinds).toEqual(['chat', 'owner', 'trade']);
  });
});

describe('archive maintenance: debug events', () => {
  it('drops old debug events but keeps a permanent code however old it is', async () => {
    const ctx = makeCtx();
    ctx.repositories.events.insert({
      at: '2026-01-01T00:00:00.000Z',
      level: 'debug',
      source: 'reader',
      code: 'noise',
      message: 'old debug',
      data: null,
    });
    ctx.repositories.events.insert({
      at: '2026-01-01T00:00:00.000Z',
      level: 'error',
      source: 'upstream-monitor',
      code: 'package_hash_drift',
      message: 'old but permanent',
      data: null,
    });

    await ctx.maintenance.run(true);

    const codes = ctx.repositories.events.recent(50).map((row) => row.code);
    expect(codes).not.toContain('noise');
    expect(codes).toContain('package_hash_drift');
  });
});

describe('archive maintenance: deletion gating', () => {
  it('refuses to delete without a verified manifest or a matching external backup', () => {
    const ctx = makeCtx();
    const file = join(ctx.config.paths.archive, 'manual.jsonl.gz');
    writeFileSync(file, 'ARCHIVE-DATA');
    ctx.repositories.archiveManifests.record({
      path: file,
      sha256: sha256File(file),
      bytes: fileBytes(file),
      files: 1,
      kind: 'messages',
    });

    const missing = join(ctx.config.paths.archive, 'missing.bak');
    // Unverified manifest.
    expect(() => ctx.maintenance.deleteArchive(file, missing)).toThrow();

    ctx.repositories.archiveManifests.markVerified(file, true, null);
    // Verified, but the external backup does not exist.
    expect(() => ctx.maintenance.deleteArchive(file, missing)).toThrow(/does not exist|external/);

    const wrong = join(ctx.config.paths.archive, 'wrong.bak');
    writeFileSync(wrong, 'WRONG-DATA');
    expect(() => ctx.maintenance.deleteArchive(file, wrong)).toThrow(/checksum/);

    const good = join(ctx.config.paths.archive, 'good.bak');
    writeFileSync(good, 'ARCHIVE-DATA');
    ctx.maintenance.deleteArchive(file, good);

    expect(existsSync(file)).toBe(false);
    expect(ctx.repositories.archiveManifests.get(file)?.deleted_at).toBeTruthy();
  });

  it('flags a tampered archive as failed and leaves an intact one verified', () => {
    const ctx = makeCtx();
    const tampered = join(ctx.config.paths.archive, 'tampered.jsonl.gz');
    writeFileSync(tampered, 'GOOD');
    ctx.repositories.archiveManifests.record({
      path: tampered,
      sha256: sha256File(tampered),
      bytes: fileBytes(tampered),
      files: 1,
      kind: 'messages',
    });
    writeFileSync(tampered, 'TAMPERED');

    const intact = join(ctx.config.paths.archive, 'intact.jsonl.gz');
    writeFileSync(intact, 'INTACT');
    ctx.repositories.archiveManifests.record({
      path: intact,
      sha256: sha256File(intact),
      bytes: fileBytes(intact),
      files: 1,
      kind: 'messages',
    });

    const result = ctx.maintenance.verifyArchives();

    expect(result.failed).toContain(tampered);
    expect(result.verified).toContain(intact);
    expect(Number(ctx.repositories.archiveManifests.get(tampered)?.verified)).toBe(0);
    expect(Number(ctx.repositories.archiveManifests.get(intact)?.verified)).toBe(1);
  });
});
