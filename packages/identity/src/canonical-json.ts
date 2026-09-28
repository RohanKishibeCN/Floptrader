/**
 * Canonical JSON, byte-identical to Python's
 * `json.dumps(value, sort_keys=True, separators=(",", ":"))`.
 *
 * Close Call trade terms are hashed and signed over this exact serialisation, so
 * key order must be sorted, separators must be bare, and non-ASCII must be
 * escaped as lowercase `\uXXXX` (Python's `ensure_ascii=True` default).
 */
export type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { [key: string]: JsonValue };

export function canonicalJson(value: unknown): string {
  return write(value);
}

function write(value: unknown): string {
  if (value === null || value === undefined) return 'null';
  switch (typeof value) {
    case 'boolean':
      return value ? 'true' : 'false';
    case 'number':
      return writeNumber(value);
    case 'string':
      return writeString(value);
    case 'bigint':
      return value.toString();
    case 'object':
      break;
    default:
      throw new TypeError(`canonicalJson: unsupported type ${typeof value}`);
  }
  if (Array.isArray(value)) {
    let out = '[';
    for (let i = 0; i < value.length; i += 1) {
      if (i > 0) out += ',';
      out += write(value[i]);
    }
    return `${out}]`;
  }
  if (value instanceof Date) return writeString(value.toISOString());
  if (value instanceof Uint8Array) return writeString(Buffer.from(value).toString('base64'));
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  let out = '{';
  for (let i = 0; i < entries.length; i += 1) {
    const [key, v] = entries[i]!;
    if (i > 0) out += ',';
    out += `${writeString(key)}:${write(v)}`;
  }
  return `${out}}`;
}

function writeNumber(value: number): string {
  if (!Number.isFinite(value)) throw new TypeError('canonicalJson: non-finite number');
  if (Number.isInteger(value)) return value.toString();
  // Python repr(2.5) === "2.5"; JavaScript gives the same shortest round-trip
  // form for every value Close Call ever serialises (decimals are strings).
  return JSON.stringify(value);
}

/** Python's ensure_ascii=True escaping, plus the control escapes JS shares. */
function writeString(value: string): string {
  let out = '"';
  for (const ch of value) {
    const code = ch.codePointAt(0)!;
    switch (ch) {
      case '"':
        out += '\\"';
        continue;
      case '\\':
        out += '\\\\';
        continue;
      case '\n':
        out += '\\n';
        continue;
      case '\r':
        out += '\\r';
        continue;
      case '\t':
        out += '\\t';
        continue;
      case '\b':
        out += '\\b';
        continue;
      case '\f':
        out += '\\f';
        continue;
      default:
        break;
    }
    if (code < 0x20 || code > 0x7e) {
      if (code > 0xffff) {
        // Python escapes astral code points as a surrogate pair.
        const offset = code - 0x10000;
        const high = 0xd800 + (offset >> 10);
        const low = 0xdc00 + (offset & 0x3ff);
        out += `\\u${high.toString(16).padStart(4, '0')}\\u${low.toString(16).padStart(4, '0')}`;
      } else {
        out += `\\u${code.toString(16).padStart(4, '0')}`;
      }
      continue;
    }
    out += ch;
  }
  return `${out}"`;
}
