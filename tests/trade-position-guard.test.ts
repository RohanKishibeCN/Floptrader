/**
 * The guard on a repeating write path: "may another trade be opened on top of
 * what this agent still holds".
 *
 * Production got this wrong in a way no existing test could see. The guard asked
 * `hasEffectiveTradeForDid` — "has this agent ever traded at all" — and the
 * one-shot participation fallback covers all 150 owners as a maker or a taker
 * before it stops. So every later proposal was refused with
 * `bootstrap_trade_already_recorded`: 46,080 refusals over 25 hours and zero
 * trades, while `/status` kept reporting the strategy armed and ready.
 *
 * The rule a position actually needs is a deadline, not a history:
 *
 *   - coverage ("is this owner on the book") and position ("can this still
 *     settle") are different questions, and the first must never veto the second;
 *   - `until_sweep` is the last sweep the trade may settle in, and the official
 *     fold expires it only *after* that sweep (`n > until`), so
 *     `until_sweep >= sweep` is exactly "still in effect";
 *   - a `void` never happened, so it is neither a position nor a block.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { createRepositories, openDatabase, type Repositories, type SqliteDatabase } from '@flop/storage';
import { cleanup, generateAgents, tempDir } from './support/harness.js';

const agents = generateAgents(4, true);
const [maker, taker, other, fourth] = agents;

let ctx: { dir: string; db: SqliteDatabase; repositories: Repositories } | null = null;

afterEach(() => {
  if (ctx) {
    ctx.db.close();
    cleanup(ctx.dir);
  }
  ctx = null;
});

function build(): { repositories: Repositories } {
  const dir = tempDir('flop-position-guard-');
  const db = openDatabase({ path: `${dir}/app.db` });
  const repositories = createRepositories(db);
  ctx = { dir, db, repositories };
  return { repositories };
}

/** A row shaped like the ones the write paths actually insert. */
function trade(overrides: {
  id: string;
  makerDid: string;
  takerDid?: string | null;
  untilSweep: number;
  status: string;
  agentId: string;
  source: 'strategy' | 'participation' | 'bootstrap';
}) {
  return {
    id: overrides.id,
    season: 'close-1' as const,
    maker_did: overrides.makerDid,
    taker_did: overrides.takerDid ?? null,
    side: 'buy',
    qty: '0.1',
    px: '229.80',
    until_sweep: overrides.untilSweep,
    maker_sig: 'sig',
    taker_sig: null,
    status: overrides.status,
    room: 'close1',
    seq: 1,
    agent_id: overrides.agentId,
    counter_agent_id: null,
    posted_sweep: overrides.untilSweep - 1,
    trade_source: overrides.source,
  };
}

describe('the position guard is a deadline, not a history', () => {
  it('does not let an expired participation trade veto the next one', () => {
    const { repositories } = build();
    // The production shape: the fallback covered this owner at sweep 1902, and
    // the contest has moved on. The trade can no longer settle.
    repositories.trades.insert(
      trade({
        id: 'pl-old',
        makerDid: maker!.did,
        takerDid: taker!.did,
        untilSweep: 1902,
        status: 'pending',
        agentId: maker!.agentId,
        source: 'participation',
      }),
    );

    // Coverage still answers yes — the owner is on the book and always will be.
    expect(repositories.trades.hasEffectiveTradeForDid(maker!.did)).toBe(true);
    // The position question answers no, which is what unblocks the strategy.
    expect(repositories.trades.hasUnsettledTradeForAgent(maker!.agentId, maker!.did, 2353)).toBe(false);
    expect(repositories.trades.hasUnsettledTradeForAgent(maker!.agentId, maker!.did, 1903)).toBe(false);
    // The boundary is the fold's: `until_sweep` itself is still in effect.
    expect(repositories.trades.hasUnsettledTradeForAgent(maker!.agentId, maker!.did, 1902)).toBe(true);
  });

  it('blocks a second trade while one can still settle, and only for its own agent', () => {
    const { repositories } = build();
    repositories.trades.insert(
      trade({
        id: 'b-live',
        makerDid: maker!.did,
        untilSweep: 1760,
        status: 'pending',
        agentId: maker!.agentId,
        source: 'bootstrap',
      }),
    );

    expect(repositories.trades.hasUnsettledTradeForAgent(maker!.agentId, maker!.did, 1759)).toBe(true);
    expect(repositories.trades.hasUnsettledTradeForAgent(maker!.agentId, maker!.did, 1760)).toBe(true);
    // One sweep past the deadline is a release, not a refusal.
    expect(repositories.trades.hasUnsettledTradeForAgent(maker!.agentId, maker!.did, 1761)).toBe(false);
    // Another agent is never held by this one's position.
    expect(repositories.trades.hasUnsettledTradeForAgent(other!.agentId, other!.did, 1759)).toBe(false);
  });

  it('never lets a void stand in for a position', () => {
    const { repositories } = build();
    // The referee saw it and ruled it out: no position was ever created, so a
    // later trade is not "on top of" anything.
    repositories.trades.insert(
      trade({
        id: 'b-void',
        makerDid: maker!.did,
        untilSweep: 1902,
        status: 'void',
        agentId: maker!.agentId,
        source: 'bootstrap',
      }),
    );
    expect(repositories.trades.hasUnsettledTradeForAgent(maker!.agentId, maker!.did, 1900)).toBe(false);
    // `void` is still coverage: it did reach the book.
    expect(repositories.trades.hasEffectiveTradeForDid(maker!.did)).toBe(true);
  });

  it('counts a settled position while it is still in effect', () => {
    const { repositories } = build();
    // A `pending` row the referee went on to settle, which is the normal life of
    // a row the reader did see. It is a real position until its deadline passes.
    repositories.trades.insert(
      trade({
        id: 'b-settled',
        makerDid: maker!.did,
        untilSweep: 1760,
        status: 'settled',
        agentId: maker!.agentId,
        source: 'bootstrap',
      }),
    );
    expect(repositories.trades.hasUnsettledTradeForAgent(maker!.agentId, maker!.did, 1760)).toBe(true);
    expect(repositories.trades.hasUnsettledTradeForAgent(maker!.agentId, maker!.did, 1761)).toBe(false);
  });

  it('holds the counterparty too, because a trade is a position for both sides', () => {
    const { repositories } = build();
    // A participation row carries the *maker's* `agent_id` and the taker's DID in
    // `taker_did`. An `agent_id`-only question therefore leaves every taker-side
    // owner unguarded, which is exactly how an owner ends up holding a
    // participation trade and a bootstrap trade settleable in the same sweep.
    repositories.trades.insert(
      trade({
        id: 'p-pair',
        makerDid: maker!.did,
        takerDid: taker!.did,
        untilSweep: 1902,
        status: 'pending',
        agentId: maker!.agentId,
        source: 'participation',
      }),
    );
    expect(repositories.trades.hasUnsettledTradeForAgent(maker!.agentId, maker!.did, 1902)).toBe(true);
    expect(repositories.trades.hasUnsettledTradeForAgent(taker!.agentId, taker!.did, 1902)).toBe(true);
    // One deadline releases both sides; an unrelated owner is untouched.
    expect(repositories.trades.hasUnsettledTradeForAgent(maker!.agentId, maker!.did, 1903)).toBe(false);
    expect(repositories.trades.hasUnsettledTradeForAgent(taker!.agentId, taker!.did, 1903)).toBe(false);
    expect(repositories.trades.hasUnsettledTradeForAgent(fourth!.agentId, fourth!.did, 1902)).toBe(false);
  });
});
