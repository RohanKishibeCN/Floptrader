/**
 * canonical JSON must be byte-identical to Python's
 * json.dumps(value, sort_keys=True, separators=(",", ":")) — the official fold's
 * serialisation for trade terms. The expected strings below were produced by
 * running exactly that expression under CPython 3.
 */
import { describe, expect, it } from 'vitest';
import { canonicalJson } from '@flop/identity';

describe('canonicalJson', () => {
  it('matches Python for trade terms', () => {
    const terms = {
      id: 'a7f3',
      maker: 'did:key:z6MkA',
      px: '181.20',
      qty: '2',
      side: 'sell',
      taker: 'any',
      until: 1236,
    };
    expect(canonicalJson(terms)).toBe(
      '{"id":"a7f3","maker":"did:key:z6MkA","px":"181.20","qty":"2","side":"sell","taker":"any","until":1236}',
    );
  });

  it('sorts keys regardless of insertion order', () => {
    expect(canonicalJson({ b: 1, a: 2 })).toBe(canonicalJson({ a: 2, b: 1 }));
    expect(canonicalJson({ b: 1, a: 2 })).toBe('{"a":2,"b":1}');
  });

  it('escapes non-ASCII exactly as Python ensure_ascii=True does', () => {
    expect(canonicalJson({ a: 'é', b: '日本語', c: 'emoji 😀' })).toBe(
      '{"a":"\\u00e9","b":"\\u65e5\\u672c\\u8a9e","c":"emoji \\ud83d\\ude00"}',
    );
  });

  it('escapes DEL, matching Python (the printable window is 0x20..0x7e)', () => {
    expect(canonicalJson({ ctrl: '\u0001\u001f\u007f' })).toBe('{"ctrl":"\\u0001\\u001f\\u007f"}');
  });

  it('handles nesting, booleans, nulls and empty containers', () => {
    expect(canonicalJson({ z: [1, 2, { y: null, x: true }], a: { n: false, m: [] } })).toBe(
      '{"a":{"m":[],"n":false},"z":[1,2,{"x":true,"y":null}]}',
    );
    expect(canonicalJson({})).toBe('{}');
    expect(canonicalJson([])).toBe('[]');
  });

  it('keeps the standard JSON string escapes', () => {
    expect(canonicalJson({ f: 2.5, i: -17, s: 'a"b\\c\nd\te' })).toBe(
      '{"f":2.5,"i":-17,"s":"a\\"b\\\\c\\nd\\te"}',
    );
  });

  it('does not trim or normalise strings', () => {
    expect(canonicalJson({ leading: '  spaced  ' })).toBe('{"leading":"  spaced  "}');
  });

  it('sorts the owner registration message the way the referee will read it', () => {
    expect(canonicalJson({ t: 'owner', season: 'close-1', key: 'did:key:z6Mk...' })).toBe(
      '{"key":"did:key:z6Mk...","season":"close-1","t":"owner"}',
    );
  });

  it('omits undefined members rather than emitting null', () => {
    expect(canonicalJson({ a: 1, b: undefined })).toBe('{"a":1}');
  });

  it('rejects non-finite numbers', () => {
    expect(() => canonicalJson({ a: Number.NaN })).toThrow(/non-finite/);
    expect(() => canonicalJson({ a: Number.POSITIVE_INFINITY })).toThrow(/non-finite/);
  });
});
