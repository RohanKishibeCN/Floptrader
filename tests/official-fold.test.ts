/**
 * The official fold, ported and compared.
 *
 * Two assertions, in increasing strength:
 *
 *   1. our TypeScript fold reproduces `examples/sample-season.expected.json`
 *      exactly — every field, including the string forms the Python prints
 *      (`36.0000`, `181.44`), which is where a naive float port fails;
 *   2. when `python3` is on PATH, the vendored `reference/close_call_fold.py` is
 *      executed on the same input and its stdout is compared to our output byte
 *      for byte. This catches the case where the fixture and the script have
 *      drifted apart.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { Decimal, Fold, FOLD_DEFAULTS, amount, replay } from '@flop/close-call';

const fixtures = join(process.cwd(), 'tests', 'fixtures');
const referenceDir = join(process.cwd(), 'reference');
const seasonLines = readFileSync(join(fixtures, 'sample-season.jsonl'), 'utf8').split('\n');
const expected = JSON.parse(
  readFileSync(join(fixtures, 'sample-season.expected.json'), 'utf8'),
) as { sweeps: unknown[]; final: Record<string, unknown> };

describe('official fold: sample season', () => {
  it('reproduces examples/sample-season.expected.json exactly', () => {
    const result = replay(seasonLines, {
      mint: FOLD_DEFAULTS.mint,
      min_qty: FOLD_DEFAULTS.min_qty,
      limit_window: FOLD_DEFAULTS.limit_window,
      fee_rate: FOLD_DEFAULTS.fee_rate,
      lock_sweep: FOLD_DEFAULTS.lock_sweep,
      prize_places: FOLD_DEFAULTS.prize_places,
    });
    expect(result.sweeps).toEqual(expected.sweeps);
    expect(result.final).toEqual(expected.final);
  });

  it('prints zero_sum as the exact negation of the fees', () => {
    const result = replay(seasonLines);
    const final = result.final!;
    expect(final.fees).toBe('173.2300');
    expect(final.zero_sum).toBe('0.0000');
    expect(Decimal.from(final.zero_sum).isZero()).toBe(true);
  });

  it('marks a repeated id as settled rather than applying it twice', () => {
    const result = replay(seasonLines);
    const firstSweep = result.sweeps[0]!;
    expect(firstSweep.trades[0]).toMatchObject({ id: 't1', outcome: 'settled' });
    expect(firstSweep.trades[1]).toMatchObject({ id: 't1', outcome: 'void', reason: 'settled' });
  });

  it('applies the fold\'s checks in its documented order', () => {
    const result = replay(seasonLines);
    const reasons = result.sweeps[0]!.trades.map((trade) =>
      trade.outcome === 'void' ? trade.reason : 'settled',
    );
    expect(reasons).toEqual(['settled', 'settled', 'limits', 'funds', 'taker', 'not_owner']);
    expect(result.sweeps[1]!.trades.map((t) => (t.outcome === 'void' ? t.reason : 'settled'))).toEqual([
      'settled',
      'settled',
      'expired',
      'shape',
    ]);
  });

  it('claws back the side that got the better price, when that is more than the fee', () => {
    const result = replay(seasonLines);
    // t7: maker sells 8 at 181.50 with the sweep closing at 184.00.
    // fee = 0.01 * 8 * 181.50 = 14.5200 ; gap = (184.00 - 181.50) * 8 = 20.00
    // the seller is the one who got the worse price, so the *buyer* pays the gap.
    expect(result.sweeps[1]!.trades[0]).toMatchObject({
      id: 't7',
      maker_fee: '14.5200',
      taker_fee: '20.00',
    });
  });

  it('awards tied owners the places they span', () => {
    const fold = new Fold();
    fold.seed('100.00');
    const a = 'did:key:z6MkUf3bFjg6czAxRp6xfay1NxUV7CTMmUrNUf3bFjg6czAx';
    const b = 'did:key:z6MkrBwx3NBDGJHyHjxNPFJ1Mwrhhztn4sBbrBwx3NBDGJHy';
    fold.sweep(1, '100.00', '100.00', [a, b], []);
    const final = fold.final('100.00');
    // Both score exactly zero, so they share places 1 and 2.
    expect(final.standings.map((row) => ({ key: row.key, places: row.places, sharing: row.sharing }))).toEqual([
      { key: a, places: [1, 2], sharing: 2 },
      { key: b, places: [1, 2], sharing: 2 },
    ]);
  });

  it('has no leverage: opening a contract ties up its price', () => {
    const fold = new Fold({ mint: '1000' });
    fold.seed('100.00');
    const a = 'did:key:z6MkUf3bFjg6czAxRp6xfay1NxUV7CTMmUrNUf3bFjg6czAx';
    const b = 'did:key:z6MkrBwx3NBDGJHyHjxNPFJ1Mwrhhztn4sBbrBwx3NBDGJHy';
    fold.sweep(1, '100.00', '100.00', [a, b], []);
    // A buys 5 at 100.00 from B: A needs 5*100 + fee, B needs its own fee.
    const settled = fold.sweep(
      2,
      '100.00',
      '100.00',
      [],
      [{ id: 'x1', maker: a, side: 'buy', qty: '5', px: '100.00', taker: 'any', until: 9, countersigner: b }],
    );
    expect(settled.trades[0]).toMatchObject({ outcome: 'settled' });
    // 3,000 of collateral is unaffordable from a 1,000 mint.
    const refused = fold.sweep(
      3,
      '100.00',
      '100.00',
      [],
      [{ id: 'x2', maker: a, side: 'buy', qty: '30', px: '100.00', taker: 'any', until: 9, countersigner: b }],
    );
    expect(refused.trades[0]).toMatchObject({ outcome: 'void', reason: 'funds' });
  });

  it('rejects an amount with three decimals or using exponent notation', () => {
    expect(amount('1.005')).toBeNull();
    expect(amount('1e3')).toBeNull();
    expect(amount('0')).toBeNull();
    expect(amount('-5')).toBeNull();
    expect(amount('1.00')?.toString()).toBe('1.00');
  });

  it('refuses to apply a sweep without a seed, or with a non-increasing number', () => {
    const fold = new Fold();
    expect(() => fold.sweep(1, '100.00', '100.00', [], [])).toThrow(/needs a seed/);
    fold.seed('100.00');
    fold.sweep(5, '100.00', '100.00', [], []);
    expect(() => fold.sweep(5, '100.00', '100.00', [], [])).toThrow(/increasing sweep number/);
  });

  it('rejects a second seed and a second final price', () => {
    const fold = new Fold();
    fold.seed('100.00');
    expect(() => fold.seed('101.00')).toThrow(/one opening price/);
    fold.sweep(1, '100.00', '100.00', [], []);
    fold.final('99.00');
    expect(() => fold.final('98.00')).toThrow(/one closing price/);
  });

  it('rejects an unknown event kind', () => {
    expect(() => replay(['{"t":"nonsense"}'])).toThrow(/unknown event/);
  });
});

describe('official fold: agreement with the vendored Python', () => {
  const hasPython = (() => {
    try {
      execFileSync('python3', ['--version'], { stdio: 'ignore' });
      return true;
    } catch {
      return false;
    }
  })();

  it.skipIf(!hasPython)('our output matches close_call_fold.py byte for byte', () => {
    const stdout = execFileSync(
      'python3',
      [
        join(referenceDir, 'close_call_fold.py'),
        join(fixtures, 'sample-season.jsonl'),
        '--config',
        join(referenceDir, 'contest.json'),
      ],
      { encoding: 'utf8' },
    );
    const pythonResult = JSON.parse(stdout) as { sweeps: unknown[]; final: unknown };
    const ourResult = replay(seasonLines);
    expect(JSON.stringify(ourResult)).toBe(JSON.stringify(pythonResult));
    // Anchored to the published fixture too, so a Python version change that
    // silently altered the fold would show up as a failure rather than a match.
    expect(JSON.stringify(pythonResult)).toBe(
      JSON.stringify({ sweeps: expected.sweeps, final: expected.final }),
    );
  });
});
