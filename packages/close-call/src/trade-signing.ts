/**
 * Both halves of a Close Call trade signature.
 *
 *   maker: close-1|terms|<terms>
 *   taker: close-1|accept|<terms>|<taker did:key>
 *
 * Both signatures are base64url, unpadded, 86 characters. A trade "counts only as
 * terms signed by both keys", so neither side can be inferred: the maker's key
 * must equal `terms.maker`, and the countersigner must be the key that signed the
 * accept payload — which is checked against the outer envelope's DID too.
 */
import {
  decodeSignature,
  didToPublicKey,
  encodeSignature,
  signBytes,
  verifyBytes,
} from '@flop/identity';
import { canonicalJson } from '@flop/identity';
import { TradeTerms, TradeMessage, TradeMessageSchema } from './models.js';
import {
  checkTermsShape,
  makerSignaturePayload,
  takerSignaturePayload,
  termsPayload,
} from './terms.js';
import { SEASON } from './rules.js';

export function signTermsAsMaker(terms: TradeTerms, makerSeed: Uint8Array): string {
  return encodeSignature(signBytes(makerSeed, makerSignaturePayload(terms)));
}

export function signTermsAsTaker(terms: TradeTerms, takerDid: string, takerSeed: Uint8Array): string {
  return encodeSignature(signBytes(takerSeed, takerSignaturePayload(terms, takerDid)));
}

export function verifyMakerSignature(terms: TradeTerms, signature: string): boolean {
  try {
    return verifyBytes(
      decodeSignature(signature),
      makerSignaturePayload(terms),
      didToPublicKey(terms.maker),
    );
  } catch {
    return false;
  }
}

export function verifyTakerSignature(terms: TradeTerms, takerDid: string, signature: string): boolean {
  try {
    return verifyBytes(
      decodeSignature(signature),
      takerSignaturePayload(terms, takerDid),
      didToPublicKey(takerDid),
    );
  } catch {
    return false;
  }
}

/**
 * The exact room text for a trade. Canonical JSON so the bytes are reproducible
 * from the parts and the outer room signature is deterministic.
 */
export function buildTradeMessage(params: {
  terms: TradeTerms;
  taker: string;
  makerSig: string;
  takerSig: string;
}): string {
  const message = {
    t: 'trade',
    season: SEASON,
    terms: params.terms,
    taker: params.taker,
    maker_sig: params.makerSig,
    taker_sig: params.takerSig,
  };
  return canonicalJson(message as unknown as Record<string, unknown>);
}

export function parseTradeMessage(text: string): TradeMessage | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  const result = TradeMessageSchema.safeParse(parsed);
  if (!result.success) return null;
  const check = checkTermsShape((parsed as { terms: unknown }).terms);
  if (!check.ok) return null;
  return { ...result.data, terms: check.terms } as TradeMessage;
}

export interface SignedTrade {
  terms: TradeTerms;
  taker: string;
  maker_sig: string;
  taker_sig: string;
  text: string;
}

/** Sign both sides in one step — used when we are the maker accepting a taker. */
export function signTrade(params: {
  terms: TradeTerms;
  taker: string;
  makerSeed: Uint8Array;
  takerSeed?: Uint8Array;
}): SignedTrade {
  const makerSig = signTermsAsMaker(params.terms, params.makerSeed);
  const takerSig = params.takerSeed
    ? signTermsAsTaker(params.terms, params.taker, params.takerSeed)
    : '';
  return {
    terms: params.terms,
    taker: params.taker,
    maker_sig: makerSig,
    taker_sig: takerSig,
    text: buildTradeMessage({
      terms: params.terms,
      taker: params.taker,
      makerSig,
      takerSig,
    }),
  };
}

/** Countersign an external maker's open offer. */
export function countersignOffer(params: {
  terms: TradeTerms;
  takerDid: string;
  takerSeed: Uint8Array;
  makerSig: string;
}): SignedTrade {
  const takerSig = signTermsAsTaker(params.terms, params.takerDid, params.takerSeed);
  return {
    terms: params.terms,
    taker: params.takerDid,
    maker_sig: params.makerSig,
    taker_sig: takerSig,
    text: buildTradeMessage({
      terms: params.terms,
      taker: params.takerDid,
      makerSig: params.makerSig,
      takerSig,
    }),
  };
}

export { termsPayload };
