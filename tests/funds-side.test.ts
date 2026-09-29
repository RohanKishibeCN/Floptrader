/**
 * `reason: funds` names a reason, never a side.
 *
 * The referee says a trade was voided for funds; it does not say *which* side was
 * short. So:
 *
 *   - `referee_funds_side` is always `unknown` when the referee ruled, and
 *     `funds_side_confidence` is `official`;
 *   - our own inference lives in `local_funds_side`, labelled `local_inference`,
 *     and is never promoted to a referee conclusion;
 *   - both survive a restart, because they are columns on `trades`;
 *   - the Lark report prints them as two separate facts.
 */
import { rmSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import { HARNESS_PACKAGE_HASH, buildHarness, type Harness } from './support/orchestrator.js';
import { tempDir } from './support/harness.js';

let harness: Harness | undefined;
let second: Harness | undefined;

afterEach(async () => {
  if (harness) await harness.dispose();
  harness = undefined;
  if (second) await second.dispose();
  second = undefined;
});

/** A market that makes the contrarian group want to trade, so a trade is built. */
async function market(h: Harness): Promise<void> {
  const dids = [...h.runtime.keyStore.agentIds].map((id) => h.runtime.keyStore.did(id));
  h.referee.seedPost(HARNESS_PACKAGE_HASH);
  for (let sweep = 1; sweep <= 8; sweep += 1) {
    h.referee.price(sweep, sweep === 8 ? '204' : '200');
    h.referee.flow(sweep, dids);
  }
  await h.runtime.scheduler.runTick();
}

describe('the referee verdict and the local inference are different facts', () => {
  it('records a referee funds verdict as official, with side unknown', async () => {
    harness = await buildHarness({
      agentCount: 3,
      env: { FLOP_ALLOW_REGISTRATION: 'false', MAX_DISCOVERED_ROOMS: '2' },
    });
    const h = harness;
    const agentId = h.runtime.keyStore.agentIds[0]!;
    const did = h.runtime.keyStore.did(agentId);

    h.runtime.repositories.trades.insert({
      id: 'T-funds-1',
      season: 'close-1',
      maker_did: did,
      taker_did: 'did:key:z6Mk'.padEnd(52, 'B'),
      side: 'buy',
      qty: '1',
      px: '225.10',
      until_sweep: 500,
      maker_sig: 'sig',
      taker_sig: 'sig2',
      status: 'pending',
      agent_id: agentId,
      local_funds_side: 'maker',
      funds_side_confidence: 'local_inference',
    });

    h.referee.seedPost(HARNESS_PACKAGE_HASH);
    h.referee.post('d-close1-flow', {
      t: 'flow',
      season: 'close-1',
      n: 120,
      mints: [],
      rooms: [],
      void: [{ id: 'T-funds-1', reason: 'funds' }],
    });
    await h.runtime.reader.tick();

    const outcome = h.runtime.scheduler.reconcileRefereeSettlements();
    expect(outcome.funds).toBe(1);

    const row = h.runtime.repositories.trades.get('T-funds-1')!;
    expect(row.referee_reason).toBe('funds');
    // The referee never names a side, so the official side is unknown.
    expect(row.referee_funds_side).toBe('unknown');
    expect(row.funds_side_confidence).toBe('official');
    expect(row.status).toBe('void');
    expect(row.reason).toBe('funds');
    // Our own inference is still there, beside the official fields.
    expect(row.local_funds_side).toBe('maker');

    // A later local pass cannot overwrite the official `unknown`.
    h.runtime.repositories.trades.setLocalFundsSide('T-funds-1', 'taker');
    const after = h.runtime.repositories.trades.get('T-funds-1')!;
    expect(after.referee_funds_side).toBe('unknown');
    expect(after.funds_side_confidence).toBe('official');
    expect(after.local_funds_side).toBe('maker');

    // A status update must not clear a verdict either.
    h.runtime.repositories.trades.updateStatus('T-funds-1', 'void', 'funds');
    const cleared = h.runtime.repositories.trades.get('T-funds-1')!;
    expect(cleared.referee_reason).toBe('funds');
    expect(cleared.referee_funds_side).toBe('unknown');
    expect(cleared.funds_side_confidence).toBe('official');
  });

  it('writes a local inference alongside every trade it builds', async () => {
    harness = await buildHarness({
      agentCount: 15,
      env: { FLOP_ALLOW_REGISTRATION: 'false', MAX_DISCOVERED_ROOMS: '2' },
    });
    const h = harness;
    await market(h);

    const rows = h.runtime.repositories.trades.fundsVerdicts();
    expect(rows).toHaveLength(0);

    const written = h.runtime.db
      .prepare(
        `SELECT COUNT(*) AS n FROM trades WHERE local_funds_side IS NOT NULL
          AND funds_side_confidence = 'local_inference'`,
      )
      .get() as { n: number };
    expect(written.n).toBeGreaterThan(0);
    // Nothing was promoted: no trade carries an official verdict yet.
    const official = h.runtime.db
      .prepare("SELECT COUNT(*) AS n FROM trades WHERE funds_side_confidence = 'official'")
      .get() as { n: number };
    expect(official.n).toBe(0);

    // The report separates the two, and never presents the inference as a finding.
    const report = await h.runtime.scheduler.buildReport();
    const funds = report.sections.find((section) => section.heading.includes('funds'));
    expect(funds).toBeDefined();
    const text = funds!.lines.join('\n');
    expect(text).toContain('official side: unknown');
    expect(text).toContain('confidence: local_inference');
    expect(text).toContain('local inferred side:');
  });
});

describe('the funds columns survive a restart', () => {
  const dir = tempDir('flop-funds-');

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('keeps the official verdict and the local inference on disk', async () => {
    harness = await buildHarness({
      agentCount: 15,
      dir,
      env: { FLOP_ALLOW_REGISTRATION: 'false', MAX_DISCOVERED_ROOMS: '2' },
    });
    await market(harness);
    const sample = harness.runtime.db
      .prepare("SELECT id, local_funds_side, funds_side_confidence FROM trades WHERE status = 'dry_run' LIMIT 1")
      .get() as { id: string; local_funds_side: string; funds_side_confidence: string };
    expect(sample.local_funds_side).not.toBeNull();
    expect(sample.funds_side_confidence).toBe('local_inference');

    // A referee funds verdict for that very trade, then a restart.
    harness.referee.post('d-close1-flow', {
      t: 'flow',
      season: 'close-1',
      n: 200,
      mints: [],
      rooms: [],
      void: { [sample.id]: 'funds' },
    });
    await harness.runtime.reader.tick();
    harness.runtime.scheduler.reconcileRefereeSettlements();

    const transport = harness.transport;
    try {
      harness.runtime.db.close();
    } catch {
      /* the harness may already have closed it */
    }

    second = await buildHarness({
      agentCount: 15,
      dir,
      transport,
      env: { FLOP_ALLOW_REGISTRATION: 'false', MAX_DISCOVERED_ROOMS: '2' },
    });

    const after = second.runtime.repositories.trades.get(sample.id)!;
    expect(after.referee_reason).toBe('funds');
    expect(after.referee_funds_side).toBe('unknown');
    expect(after.funds_side_confidence).toBe('official');
    expect(after.local_funds_side).toBe(sample.local_funds_side);
  });
});
