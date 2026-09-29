/**
 * The Close Call trade protocol, end to end and offline.
 *
 * Three layers have to line up before a trade is real, and each is tested here
 * on its own terms:
 *
 *   1. the outer room envelope — `<room>|<nonce>|<text>` signed by the sender;
 *   2. the two terms signatures — `close-1|terms|<terms>` by the maker and
 *      `close-1|accept|<terms>|<taker>` by the countersigner;
 *   3. the validator — the fold's void reasons, plus the local refusals the fold
 *      cannot express: internal pairings, self-trades, reused ids.
 *
 * The fee section pins the clawback arithmetic against the values the official
 * fold prints, because the string form (scale and all) is part of its output.
 */
import { describe, expect, it } from 'vitest';
import {
  Decimal,
  LocalRiskBook,
  MAX_REFERENCE_MOVE,
  RiskAccount,
  buildTerms,
  buildTradeMessage,
  checkTermsShape,
  countersignOffer,
  formatAmount,
  isLocked,
  limitBand,
  makerSignaturePayload,
  parseTradeMessage,
  referenceRules,
  sideFees,
  signTermsAsMaker,
  signTermsAsTaker,
  signTrade,
  takerSignaturePayload,
  termsPayload,
  validateExternalOffer,
  validateTrade,
  verifyMakerSignature,
  verifyTakerSignature,
  withinLimits,
  worstCaseSideFee,
  type TradeTerms,
  type TradeValidationContext,
} from '@flop/close-call';
import { canonicalJson, didFromSeed, signRoomMessage, verifyRoomSignatureForRoom } from '@flop/identity';
import { generateAgents } from './support/harness.js';

const rules = referenceRules();
const ROOM = rules.tradingRoom;

/** 150 real keys, exactly as the process holds them. */
const agents = generateAgents(150, true);
const maker = agents[0]!;
const taker = agents[1]!;
const stranger = agents[2]!;
const untrustedThird = agents[3]!;
const localDids = new Set(agents.map((agent) => agent.did));

/** A counterparty that is not one of ours. */
const externalSeed = new Uint8Array(32).fill(0x5a);
const externalDid = didFromSeed(externalSeed);

const MINT = rules.mint;

function accountsFor(...keys: string[]): Map<string, RiskAccount> {
  const map = new Map<string, RiskAccount>();
  for (const key of keys) map.set(key, RiskAccount.withMint(key, MINT));
  return map;
}

function baseContext(overrides: Partial<TradeValidationContext> = {}): TradeValidationContext {
  return {
    rules,
    sweep: 100,
    reference: Decimal.from('200'),
    close: Decimal.from('200'),
    localDids,
    settledIds: new Set<string>(),
    accounts: accountsFor(maker.did, taker.did, stranger.did, externalDid),
    conservative: false,
    ...overrides,
  };
}

/** Terms an external maker signs and offers to `any` taker. */
function openOffer(overrides: Partial<TradeTerms> = {}): TradeTerms {
  return buildTerms({
    id: `offer-${Math.random().toString(36).slice(2, 10)}`,
    maker: maker.did,
    side: 'buy',
    qty: '2',
    px: '200',
    until: 540,
    ...overrides,
  });
}

describe('terms and their canonical bytes', () => {
  it('serialises with sorted keys, no spaces, and exactly the seven fields', () => {
    const terms = buildTerms({
      id: 'a7f3',
      maker: maker.did,
      side: 'sell',
      qty: '2',
      px: '181.20',
      until: 1236,
    });
    expect(Object.keys(terms).sort()).toEqual(['id', 'maker', 'px', 'qty', 'side', 'taker', 'until']);
    const text = new TextDecoder().decode(termsPayload(terms));
    expect(text).toBe(
      `{"id":"a7f3","maker":"${maker.did}","px":"181.2","qty":"2","side":"sell","taker":"any","until":1236}`,
    );
    // No whitespace anywhere: the bytes are the signature payload.
    expect(text).not.toMatch(/[ \n\t]/);
  });

  it('names the maker and taker payloads exactly as the game document does', () => {
    const terms = buildTerms({ id: 't1', maker: maker.did, side: 'buy', qty: '1', px: '200', until: 100 });
    const canonical = canonicalJson(terms as unknown as Record<string, unknown>);
    expect(new TextDecoder().decode(makerSignaturePayload(terms))).toBe(`close-1|terms|${canonical}`);
    expect(new TextDecoder().decode(takerSignaturePayload(terms, taker.did))).toBe(
      `close-1|accept|${canonical}|${taker.did}`,
    );
  });

  it('keeps amounts as decimal strings with at most two places', () => {
    expect(formatAmount('225.10')).toBe('225.1');
    expect(formatAmount(Decimal.from('0.10'))).toBe('0.1');
    expect(checkTermsShape({ ...openOffer(), px: '225.123' }).ok).toBe(false);
    expect(checkTermsShape({ ...openOffer(), px: 225.1 }).ok).toBe(false);
    expect(checkTermsShape({ ...openOffer(), qty: '0' }).ok).toBe(false);
    expect(checkTermsShape({ ...openOffer(), until: 540.5 }).ok).toBe(false);
    expect(checkTermsShape({ ...openOffer(), side: 'BUY' }).ok).toBe(false);
    expect(checkTermsShape({ ...openOffer(), taker: 'anyone' }).ok).toBe(false);
  });

  it('refuses to build terms below the 0.1 minimum quantity', () => {
    expect(() =>
      buildTerms({ maker: maker.did, side: 'buy', qty: '0.09', px: '200', until: 100 }),
    ).toThrow(/0\.1 minimum/);
  });

  it('mints a fresh, valid id every time', () => {
    const ids = new Set<string>();
    for (let index = 0; index < 200; index += 1) {
      const terms = buildTerms({ maker: maker.did, side: 'buy', qty: '1', px: '200', until: 100 });
      expect(ids.has(terms.id)).toBe(false);
      ids.add(terms.id);
      expect(terms.id.length).toBeLessThanOrEqual(64);
    }
  });
});

describe('the outer room envelope', () => {
  const nonce = '1';

  it('covers <room>|<nonce>|<text> and round-trips', () => {
    const text = buildTradeMessage({
      terms: openOffer({ id: 'env-1' }),
      taker: taker.did,
      makerSig: 'x',
      takerSig: 'y',
    });
    const envelope = signRoomMessage(maker.did, maker.seed, ROOM, nonce, text);

    expect(verifyRoomSignatureForRoom(envelope.did, envelope.nonce, envelope.text, envelope.sig, ROOM)).toBe(true);
    // The same bytes in another room are a different message.
    expect(verifyRoomSignatureForRoom(envelope.did, envelope.nonce, envelope.text, envelope.sig, 'close2')).toBe(false);
    // And one flipped character invalidates it.
    expect(
      verifyRoomSignatureForRoom(envelope.did, envelope.nonce, `${envelope.text} `, envelope.sig, ROOM),
    ).toBe(false);
  });

  it('rejects an envelope signed by a different key', () => {
    const envelope = signRoomMessage(maker.did, maker.seed, ROOM, '7', '{"t":"owner"}');
    expect(
      verifyRoomSignatureForRoom(taker.did, envelope.nonce, envelope.text, envelope.sig, ROOM),
    ).toBe(false);
  });
});

describe('the two terms signatures', () => {
  it('verifies a maker signature only against the key named in terms.maker', () => {
    const terms = openOffer({ id: 'sig-maker' });
    const signature = signTermsAsMaker(terms, maker.seed);
    expect(verifyMakerSignature(terms, signature)).toBe(true);
    expect(verifyMakerSignature({ ...terms, qty: '3' }, signature)).toBe(false);
    expect(verifyMakerSignature({ ...terms, maker: stranger.did }, signature)).toBe(false);
  });

  it('verifies a taker signature only against the did it was made for', () => {
    const terms = openOffer({ id: 'sig-taker' });
    const signature = signTermsAsTaker(terms, taker.did, taker.seed);
    expect(verifyTakerSignature(terms, taker.did, signature)).toBe(true);
    expect(verifyTakerSignature(terms, stranger.did, signature)).toBe(false);
    expect(verifyTakerSignature({ ...terms, px: '201' }, taker.did, signature)).toBe(false);
  });

  it('round-trips a fully signed trade through canonical JSON', () => {
    const terms = openOffer({ id: 'round-trip' });
    const signed = signTrade({ terms, taker: taker.did, makerSeed: maker.seed, takerSeed: taker.seed });
    const parsed = parseTradeMessage(signed.text);
    expect(parsed).not.toBeNull();
    expect(parsed!.terms).toEqual(terms);
    expect(verifyMakerSignature(parsed!.terms, parsed!.maker_sig)).toBe(true);
    expect(verifyTakerSignature(parsed!.terms, parsed!.taker, parsed!.taker_sig)).toBe(true);
  });
});

describe('the validator', () => {
  function signedOffer(overrides: Partial<TradeTerms> = {}) {
    const terms = openOffer(overrides);
    const signed = signTrade({ terms, taker: taker.did, makerSeed: maker.seed, takerSeed: taker.seed });
    return { terms, taker: taker.did, maker_sig: signed.maker_sig, taker_sig: signed.taker_sig };
  }

  it('accepts a well-formed trade between an owner and an external counterparty', () => {
    const terms = openOffer({ id: 'ok-1', maker: externalDid, taker: 'any' });
    const signed = signTrade({ terms, taker: maker.did, makerSeed: externalSeed, takerSeed: maker.seed });
    const verdict = validateTrade(
      { terms, taker: maker.did, maker_sig: signed.maker_sig, taker_sig: signed.taker_sig },
      baseContext(),
    );
    expect(verdict).toEqual({ ok: true, reason: null, detail: 'ok' });
  });

  it('refuses an internal pairing: two of our own DIDs', () => {
    const verdict = validateTrade(signedOffer({ id: 'local-1' }), baseContext());
    expect(verdict.reason).toBe('local_did');
    // The fold-comparison lane turns the refusal off; nothing else does.
    const foldLane = validateTrade(
      signedOffer({ id: 'local-2' }),
      baseContext({ refuseLocalPairing: false }),
    );
    expect(foldLane.ok).toBe(true);
  });

  it('refuses a self-trade', () => {
    const terms = buildTerms({ id: 'self-1', maker: maker.did, side: 'buy', qty: '1', px: '200', until: 200 });
    const signed = signTrade({ terms, taker: maker.did, makerSeed: maker.seed, takerSeed: maker.seed });
    const verdict = validateTrade(
      { terms, taker: maker.did, maker_sig: signed.maker_sig, taker_sig: signed.taker_sig },
      baseContext(),
    );
    expect(verdict.reason).toBe('self_trade');
  });

  it('refuses a reused trade id', () => {
    const candidate = signedOffer({ id: 'dup-1' });
    const verdict = validateTrade(
      candidate,
      baseContext({ settledIds: new Set(['dup-1']), refuseLocalPairing: false }),
    );
    expect(verdict.reason).toBe('settled');
  });

  it('refuses a missing taker signature: an open offer is not yet a trade', () => {
    const offer = openOffer({ id: 'sigless-1' });
    const verdict = validateTrade(
      { terms: offer, taker: taker.did, maker_sig: signTermsAsMaker(offer, maker.seed), taker_sig: '' },
      baseContext(),
    );
    expect(verdict.reason).toBe('signature');
  });

  it('refuses a maker signature that does not verify', () => {
    const candidate = signedOffer({ id: 'badsig-1' });
    const verdict = validateTrade(
      { ...candidate, maker_sig: signTermsAsMaker(candidate.terms, stranger.seed) },
      baseContext(),
    );
    expect(verdict.reason).toBe('signature');
  });

  it('refuses a countersigner that terms did not name', () => {
    const terms = buildTerms({
      id: 'named-1',
      maker: externalDid,
      side: 'buy',
      qty: '1',
      px: '200',
      until: 300,
      taker: stranger.did,
    });
    const makersig = signTermsAsMaker(terms, externalSeed);
    const wrongSig = signTermsAsTaker(terms, untrustedThird.did, untrustedThird.seed);
    const verdict = validateTrade(
      { terms, taker: untrustedThird.did, maker_sig: makersig, taker_sig: wrongSig },
      baseContext(),
    );
    expect(verdict.reason).toBe('taker');
  });

  it('refuses a quantity below the minimum', () => {
    const terms = openOffer({ id: 'tiny-1' });
    const tampered = { ...terms, qty: '0.05' };
    const signed = signTrade({ terms: tampered, taker: taker.did, makerSeed: maker.seed, takerSeed: taker.seed });
    const verdict = validateTrade(
      { terms: tampered, taker: taker.did, maker_sig: signed.maker_sig, taker_sig: signed.taker_sig },
      baseContext(),
    );
    expect(verdict.reason).toBe('shape');
  });

  it('refuses a price outside the ±5% window around the reference', () => {
    expect(withinLimits(rules, Decimal.from('210'), Decimal.from('200'))).toBe(true);
    expect(withinLimits(rules, Decimal.from('190'), Decimal.from('200'))).toBe(true);
    expect(withinLimits(rules, Decimal.from('210.01'), Decimal.from('200'))).toBe(false);

    const terms = openOffer({ id: 'wide-1', px: '215' });
    const signed = signTrade({ terms, taker: taker.did, makerSeed: maker.seed, takerSeed: taker.seed });
    const verdict = validateTrade(
      { terms, taker: taker.did, maker_sig: signed.maker_sig, taker_sig: signed.taker_sig },
      baseContext({ refuseLocalPairing: false }),
    );
    expect(verdict.reason).toBe('limits');
  });

  it('refuses with no reference at all rather than guessing the window', () => {
    const verdict = validateTrade(
      signedOffer({ id: 'noref-1' }),
      baseContext({ reference: null, refuseLocalPairing: false }),
    );
    expect(verdict.reason).toBe('limits');
  });

  it('refuses an expired offer and one past the lock', () => {
    const expired = signedOffer({ id: 'exp-1', until: 50 });
    expect(validateTrade(expired, baseContext({ sweep: 100, refuseLocalPairing: false })).reason).toBe('expired');

    const locked = signedOffer({ id: 'lock-1', until: 999999 });
    expect(validateTrade(locked, baseContext({ sweep: 999999, refuseLocalPairing: false })).reason).toBe('locked');
    expect(isLocked(rules, rules.lockSweep)).toBe(false);
    expect(isLocked(rules, rules.lockSweep + 1)).toBe(true);
  });

  it('refuses when a side cannot cover what it opens plus its fee', () => {
    const poor = new Map<string, RiskAccount>([
      [maker.did, RiskAccount.withMint(maker.did, Decimal.from('100'))],
      [taker.did, RiskAccount.withMint(taker.did, MINT)],
    ]);
    const verdict = validateTrade(
      signedOffer({ id: 'poor-1', qty: '2', px: '200' }),
      baseContext({ accounts: poor, refuseLocalPairing: false }),
    );
    expect(verdict.reason).toBe('funds');
  });

  it('refuses a side that is not a registered owner we can see', () => {
    const verdict = validateTrade(
      signedOffer({ id: 'unknown-1' }),
      baseContext({ accounts: accountsFor(taker.did), refuseLocalPairing: false }),
    );
    expect(verdict.reason).toBe('not_owner');
  });

  it('never widens risk while the reader is degraded', () => {
    const verdict = validateTrade(
      signedOffer({ id: 'cons-1' }),
      baseContext({ conservative: true, refuseLocalPairing: false }),
    );
    expect(verdict.reason).toBe('conservative');
  });
});

describe('the external offer taker', () => {
  const takerContext = () => ({ ...baseContext(), takerDid: taker.did });

  function takeOffer(
    terms: TradeTerms,
    makerSig: string,
    overrides: Partial<TradeValidationContext> = {},
  ) {
    return validateExternalOffer({ terms, maker_sig: makerSig }, { ...takerContext(), ...overrides });
  }

  it('accepts a signed, priced, unfunded-by-us offer from a stranger', () => {
    const terms = openOffer({ id: 'ext-ok', maker: externalDid, taker: 'any' });
    const makerSig = signTermsAsMaker(terms, externalSeed);
    expect(takeOffer(terms, makerSig).ok).toBe(true);
  });

  it('refuses an offer made by one of our own DIDs', () => {
    const terms = openOffer({ id: 'ext-local', maker: maker.did, taker: 'any' });
    const makerSig = signTermsAsMaker(terms, maker.seed);
    const verdict = takeOffer(terms, makerSig);
    expect(verdict.reason).toBe('not_ours');
    // Even when the same terms are valid by every other measure.
    expect(validateTrade(
      { terms, taker: taker.did, maker_sig: makerSig, taker_sig: signTermsAsTaker(terms, taker.did, taker.seed) },
      baseContext({ refuseLocalPairing: false }),
    ).ok).toBe(true);
  });

  it('refuses an offer whose maker signature does not verify', () => {
    const terms = openOffer({ id: 'ext-badsig', maker: externalDid, taker: 'any' });
    expect(takeOffer(terms, signTermsAsMaker(terms, stranger.seed)).reason).toBe('signature');
  });

  it('refuses an offer that is not open', () => {
    const terms = openOffer({ id: 'ext-closed', maker: externalDid, taker: stranger.did });
    const makerSig = signTermsAsMaker(terms, externalSeed);
    expect(takeOffer(terms, makerSig).reason).toBe('taker');
  });

  it('refuses an offer priced outside the limits, already settled, or expired', () => {
    const wide = openOffer({ id: 'ext-wide', maker: externalDid, px: '215' });
    expect(takeOffer(wide, signTermsAsMaker(wide, externalSeed)).reason).toBe('limits');

    const used = openOffer({ id: 'ext-used', maker: externalDid });
    expect(
      takeOffer(used, signTermsAsMaker(used, externalSeed), { settledIds: new Set(['ext-used']) }).reason,
    ).toBe('settled');

    const stale = openOffer({ id: 'ext-stale', maker: externalDid, until: 10 });
    expect(takeOffer(stale, signTermsAsMaker(stale, externalSeed)).reason).toBe('expired');
  });

  it('countersigns an accepted offer so the pair verifies', () => {
    const terms = openOffer({ id: 'ext-countersign', maker: externalDid, taker: 'any' });
    const makerSig = signTermsAsMaker(terms, externalSeed);
    const signed = countersignOffer({ terms, takerDid: taker.did, takerSeed: taker.seed, makerSig });

    expect(verifyMakerSignature(terms, signed.maker_sig)).toBe(true);
    expect(verifyTakerSignature(terms, taker.did, signed.taker_sig)).toBe(true);
    expect(validateTrade(
      { terms, taker: taker.did, maker_sig: signed.maker_sig, taker_sig: signed.taker_sig },
      baseContext(),
    ).ok).toBe(true);
  });

  /**
   * The clawback is priced by the sweep's *close*, which the referee publishes
   * when the sweep ends — after an offer has to be answered. Pricing it at the
   * reference assumes the market does not move, and that is wrong precisely when
   * the move is against us; the referee then voids the trade for funds, which is
   * worse than a refusal we can see coming.
   */
  it('refuses an offer it could only afford if the close did not move', () => {
    // A 450 account covers a 400 position plus the plain 1% fee, and nothing more.
    const tight = new Map<string, RiskAccount>([
      [taker.did, RiskAccount.withMint(taker.did, Decimal.from('450'))],
    ]);
    const terms = openOffer({ id: 'ext-tight', maker: externalDid, taker: 'any', side: 'sell', qty: '2', px: '200' });
    const makerSig = signTermsAsMaker(terms, externalSeed);

    // Priced at the reference the trade looks affordable, which is the assumption
    // the referee's own close can break.
    expect(takeOffer(terms, makerSig, { accounts: tight }).ok).toBe(true);
    // With the close unknown the fee is bounded at the worst case: the close can
    // land 25% high, so 400 + (250 - 200) * 2 = 500, which this account cannot cover.
    expect(takeOffer(terms, makerSig, { accounts: tight, close: null }).reason).toBe('funds');
  });
});

describe('the clawback fee', () => {
  it('charges each side its own worst case, at the fold’s scale', () => {
    // fee = 0.01 * 20 * 180.00 = 36.0000 ; gap = (190 - 180.00) * 20 = 200.00
    const fees = sideFees('buy', Decimal.from('20'), Decimal.from('180.00'), Decimal.from('190'), Decimal.from('0.01'));
    expect(fees.maker.toString()).toBe('200.00');
    expect(fees.taker.toString()).toBe('36.0000');
    expect(fees.maker.eq(Decimal.from('200'))).toBe(true);
    expect(fees.taker.eq(Decimal.from('36'))).toBe(true);
  });

  it('falls back to the plain 1% when nobody got a better price', () => {
    const fees = sideFees('buy', Decimal.from('2'), Decimal.from('200'), Decimal.from('200'), Decimal.from('0.01'));
    expect(fees.maker.eq(Decimal.from('4'))).toBe(true);
    expect(fees.taker.eq(Decimal.from('4'))).toBe(true);
  });

  it('mirrors the fee onto the seller when the maker is selling', () => {
    const buying = sideFees('buy', Decimal.from('20'), Decimal.from('180.00'), Decimal.from('190'), Decimal.from('0.01'));
    const selling = sideFees('sell', Decimal.from('20'), Decimal.from('180.00'), Decimal.from('190'), Decimal.from('0.01'));
    expect(selling.maker.eq(buying.taker)).toBe(true);
    expect(selling.taker.eq(buying.maker)).toBe(true);
  });

  it('takes the fee out of cash and records it, so fees never stay in play', () => {
    const key = stranger.did;
    const account = RiskAccount.withMint(key, MINT);
    account.apply(1, Decimal.from('2'), Decimal.from('200'), Decimal.from('4'));
    // Opening a long ties up its full price as collateral, on top of the fee.
    expect(account.cash.eq(Decimal.from('9596'))).toBe(true);
    expect(account.fees.eq(Decimal.from('4'))).toBe(true);
    expect(account.position.eq(Decimal.from('2'))).toBe(true);
    // Marked to the entry price, the account is down exactly the fee.
    expect(account.valueAt(Decimal.from('200')).eq(MINT.sub(Decimal.from('4')))).toBe(true);
  });

  it('reconstructs the fee band from the reference, conservatively', () => {
    const band = limitBand(rules, Decimal.from('200'));
    expect(band.low.lte(Decimal.from('190'))).toBe(true);
    expect(band.high.gte(Decimal.from('200'))).toBe(true);
  });

  it('bounds an unknown close at the far edge of the reference guard', () => {
    const reference = Decimal.from('200');
    const priced = sideFees('sell', Decimal.from('2'), Decimal.from('200'), reference, rules.feeRate).taker;
    const buy = worstCaseSideFee('buy', Decimal.from('2'), Decimal.from('200'), reference, rules.feeRate);
    const sell = worstCaseSideFee('sell', Decimal.from('2'), Decimal.from('200'), reference, rules.feeRate);

    // The buyer pays most when the close lands high, the seller when it lands low:
    // 1.25 * 200 - 200 = 50, times 2 = 100, which beats the plain 1% fee of 4.
    expect(buy.eq(Decimal.from('100'))).toBe(true);
    expect(sell.eq(Decimal.from('100'))).toBe(true);
    expect(buy.gte(priced)).toBe(true);
    expect(sell.gte(priced)).toBe(true);
    // The bound is exactly the guard the verifier uses, so the two cannot drift.
    expect(MAX_REFERENCE_MOVE.eq(Decimal.from('0.25'))).toBe(true);
  });
});

describe('the local risk mirror', () => {
  it('only mints accounts for DIDs we control', () => {
    const book = new LocalRiskBook({
      mint: MINT,
      feeRate: rules.feeRate,
      didToAgent: new Map(agents.map((agent) => [agent.did, agent.agentId])),
    });
    expect(book.observeMint(externalDid)).toBe(false);
    expect(book.observeMint(maker.did)).toBe(true);
    // Mints are once per key.
    expect(book.observeMint(maker.did)).toBe(false);
    expect(book.size).toBe(1);
    expect(book.account(maker.did)?.cash.eq(MINT)).toBe(true);
  });

  it('applies a settled trade to both sides exactly as the fold does', () => {
    const didToAgent = new Map(agents.map((agent) => [agent.did, agent.agentId]));
    const book = new LocalRiskBook({ mint: MINT, feeRate: rules.feeRate, didToAgent });
    book.observeMint(maker.did);
    book.observeMint(taker.did);

    const fees = sideFees('buy', Decimal.from('2'), Decimal.from('200'), Decimal.from('200'), rules.feeRate);
    book.applySettled({
      maker: maker.did,
      taker: taker.did,
      side: 'buy',
      qty: Decimal.from('2'),
      px: Decimal.from('200'),
      close: Decimal.from('200'),
      makerFee: fees.maker,
      takerFee: fees.taker,
    });

    expect(book.account(maker.did)?.position.eq(Decimal.from('2'))).toBe(true);
    expect(book.account(taker.did)?.position.eq(Decimal.from('-2'))).toBe(true);
    expect(book.openNotional(maker.did).eq(Decimal.from('400'))).toBe(true);
    // Value is conserved: no value was created out of nothing.
    const total = book
      .account(maker.did)!
      .valueAt(Decimal.from('200'))
      .add(book.account(taker.did)!.valueAt(Decimal.from('200')));
    expect(total.eq(MINT.mul(2).sub(fees.maker).sub(fees.taker))).toBe(true);
  });
});
