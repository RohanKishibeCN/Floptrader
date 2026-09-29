/**
 * The trade-path guards that are not the fold's: the published band, the
 * external-offer ceilings, the stale-reference stop, and the funds-side honesty
 * rule.
 *
 * Each of these exists because the *safe* answer is not the obvious one:
 *
 *   - the referee's posted band is authoritative, so a price is checked against
 *     it rather than against a locally rebuilt `reference ± 5%`;
 *   - an external offer gets its own ceilings, because it is the one path where a
 *     number we did not choose becomes our position;
 *   - a stale reference is never rewritten, it only stops new risk;
 *   - the referee's `funds` void names a reason and never a side, so any claim
 *     about the side has to be labelled as our own inference.
 */
import { describe, expect, it } from 'vitest';
import {
  Decimal,
  RiskAccount,
  assessFundsSide,
  buildTerms,
  referenceRules,
  signTermsAsMaker,
  signTrade,
  validateExternalOffer,
  validateTrade,
  withinLimits,
  withinPublishedLimits,
  type TradeTerms,
  type TradeValidationContext,
} from '@flop/close-call';
import { didFromSeed } from '@flop/identity';
import { generateAgents } from './support/harness.js';

const rules = referenceRules();
const agents = generateAgents(150, true);
const maker = agents[0]!;
const taker = agents[1]!;
const localDids = new Set(agents.map((agent) => agent.did));

/** A counterparty that is not one of ours, with a real seed to sign with. */
const externalSeed = new Uint8Array(32).fill(0x5a);
const externalDid = didFromSeed(externalSeed);

const MINT = rules.mint;

function account(cash: string): RiskAccount {
  return new RiskAccount('x', Decimal.from(cash));
}

function accountsFor(...keys: string[]): Map<string, RiskAccount> {
  const map = new Map<string, RiskAccount>();
  for (const key of keys) map.set(key, RiskAccount.withMint(key, MINT));
  return map;
}

function context(overrides: Partial<TradeValidationContext> = {}): TradeValidationContext {
  return {
    rules,
    sweep: 100,
    reference: Decimal.from('200'),
    close: null,
    localDids,
    settledIds: new Set<string>(),
    accounts: accountsFor(maker.did, taker.did, externalDid),
    conservative: false,
    // These tests exercise the band and stale guards, not the local-pairing
    // refusal, so both sides may be ours here.
    refuseLocalPairing: false,
    ...overrides,
  };
}

function terms(overrides: Partial<TradeTerms> = {}): TradeTerms {
  return buildTerms({
    id: 'guard-1',
    maker: maker.did,
    side: 'buy',
    qty: '2',
    px: '200',
    until: 540,
    ...overrides,
  });
}

/** An offer from a stranger, properly signed, which is what the caps are for. */
function externalOffer(overrides: Partial<TradeTerms> = {}): TradeTerms {
  return terms({ maker: externalDid, taker: 'any', ...overrides });
}

function offerContext(
  overrides: Partial<TradeValidationContext & { takerDid: string }> = {},
): TradeValidationContext & { takerDid: string } {
  return {
    ...context({ tolerateUnknownAccounts: true }),
    takerDid: taker.did,
    ...overrides,
  };
}

describe('the published band is the authority', () => {
  it('refuses a price the posted band excludes even when ±5% would allow it', () => {
    const signed = signTrade({
      terms: terms({ px: '205' }),
      taker: taker.did,
      makerSeed: maker.seed,
      takerSeed: taker.seed,
    });
    // With no band from the referee, the local ±5% window (190..210) lets it pass.
    expect(withinLimits(rules, Decimal.from('205'), Decimal.from('200'))).toBe(true);
    expect(validateTrade(signed, context({ nextLimits: null })).reason).not.toBe('limits');

    // The referee posted 195..199 for the settlement sweep: now it is refused.
    const posted = context({ nextLimits: { low: Decimal.from('195'), high: Decimal.from('199') } });
    const verdict = validateTrade(signed, posted);
    expect(verdict.ok).toBe(false);
    expect(verdict.reason).toBe('limits');
  });

  it('accepts a price the posted band includes even when ±5% would exclude it', () => {
    // 211 is outside 200 ± 5% (190..210) but inside the referee's posted band.
    const signed = signTrade({
      terms: terms({ px: '211' }),
      taker: taker.did,
      makerSeed: maker.seed,
      takerSeed: taker.seed,
    });
    expect(withinLimits(rules, Decimal.from('211'), Decimal.from('200'))).toBe(false);
    const verdict = validateTrade(
      signed,
      context({ nextLimits: { low: Decimal.from('205'), high: Decimal.from('215') } }),
    );
    expect(verdict.reason).not.toBe('limits');
  });

  it('treats the band as a closed interval', () => {
    const band = { low: Decimal.from('190'), high: Decimal.from('210') };
    expect(withinPublishedLimits(Decimal.from('190'), band)).toBe(true);
    expect(withinPublishedLimits(Decimal.from('210'), band)).toBe(true);
    expect(withinPublishedLimits(Decimal.from('189.99'), band)).toBe(false);
    expect(withinPublishedLimits(Decimal.from('210.01'), band)).toBe(false);
  });
});

describe('external offers have their own ceilings', () => {
  it('refuses an offer above the quantity cap', () => {
    const offer = externalOffer({ qty: '20' });
    const verdict = validateExternalOffer(
      { terms: offer, maker_sig: signTermsAsMaker(offer, externalSeed) },
      offerContext({
        externalOfferLimits: {
          maxQty: Decimal.from('15'),
          maxNotional: Decimal.from('999999'),
          clawbackBuffer: Decimal.zero(),
        },
      }),
    );
    expect(verdict.reason).toBe('external_cap');
  });

  it('refuses an offer above the notional cap', () => {
    const offer = externalOffer({ qty: '10', px: '200' });
    const verdict = validateExternalOffer(
      { terms: offer, maker_sig: signTermsAsMaker(offer, externalSeed) },
      offerContext({
        externalOfferLimits: {
          maxQty: Decimal.from('50'),
          maxNotional: Decimal.from('1000'),
          clawbackBuffer: Decimal.zero(),
        },
      }),
    );
    expect(verdict.reason).toBe('external_cap');
  });

  it('keeps a buffer on top of the worst-case fee, and refuses without it', () => {
    // Our account holds exactly the notional (400) plus the worst-case fee (100).
    const margin = new Map<string, RiskAccount>([[taker.did, account('500')]]);
    const offer = externalOffer({ qty: '2', px: '200' });
    const signedOffer = { terms: offer, maker_sig: signTermsAsMaker(offer, externalSeed) };

    const withoutBuffer = validateExternalOffer(signedOffer, offerContext({ accounts: margin }));
    expect(withoutBuffer.ok).toBe(true);

    const withBuffer = validateExternalOffer(
      signedOffer,
      offerContext({
        accounts: margin,
        externalOfferLimits: {
          maxQty: Decimal.from('50'),
          maxNotional: Decimal.from('100000'),
          clawbackBuffer: Decimal.from('1'),
        },
      }),
    );
    expect(withBuffer.ok).toBe(false);
    expect(withBuffer.reason).toBe('funds');
  });
});

describe('a stale reference stops new risk', () => {
  it('refuses a maker trade', () => {
    const signed = signTrade({
      terms: terms(),
      taker: taker.did,
      makerSeed: maker.seed,
      takerSeed: taker.seed,
    });
    const verdict = validateTrade(signed, context({ staleReference: true }));
    expect(verdict.reason).toBe('stale_reference');
  });

  it('refuses an external offer too', () => {
    const offer = externalOffer();
    const verdict = validateExternalOffer(
      { terms: offer, maker_sig: signTermsAsMaker(offer, externalSeed) },
      offerContext({ staleReference: true }),
    );
    expect(verdict.reason).toBe('stale_reference');
  });
});

describe('the referee never says which side was short', () => {
  const fees = { makerFee: Decimal.from('4'), takerFee: Decimal.from('4') };

  it('always reports the referee side as unknown, whatever we infer', () => {
    const assessment = assessFundsSide({
      maker: account('1'),
      taker: RiskAccount.withMint(taker.did, MINT),
      side: 'buy',
      qty: Decimal.from('2'),
      px: Decimal.from('200'),
      ...fees,
    });
    expect(assessment.refereeReason).toBe('funds');
    expect(assessment.refereeFundsSide).toBe('unknown');
    expect(assessment.localFundsSide).toBe('maker');
    expect(assessment.fundsSideConfidence).toBe('high');
  });

  it('distinguishes maker, taker and both locally', () => {
    const rich = RiskAccount.withMint('rich', MINT);
    const poor = account('1');
    const both = assessFundsSide({
      maker: poor,
      taker: account('1'),
      side: 'buy',
      qty: Decimal.from('2'),
      px: Decimal.from('200'),
      ...fees,
    });
    expect(both.localFundsSide).toBe('both');

    const onlyTaker = assessFundsSide({
      maker: rich,
      taker: poor,
      side: 'buy',
      qty: Decimal.from('2'),
      px: Decimal.from('200'),
      ...fees,
    });
    expect(onlyTaker.localFundsSide).toBe('taker');
  });

  it('says so when it cannot tell', () => {
    const missing = assessFundsSide({
      maker: undefined,
      taker: RiskAccount.withMint(taker.did, MINT),
      side: 'buy',
      qty: Decimal.from('2'),
      px: Decimal.from('200'),
      ...fees,
    });
    expect(missing.localFundsSide).toBe('unknown');
    expect(missing.fundsSideConfidence).toBe('unknown');

    // Neither side short locally but the referee voided it: our mirror is behind,
    // so the reconstruction is possible but not trustworthy.
    const disagreement = assessFundsSide({
      maker: RiskAccount.withMint('m', MINT),
      taker: RiskAccount.withMint('t', MINT),
      side: 'buy',
      qty: Decimal.from('2'),
      px: Decimal.from('200'),
      ...fees,
    });
    expect(disagreement.localFundsSide).toBe('unknown');
    expect(disagreement.fundsSideConfidence).toBe('medium');
  });
});
