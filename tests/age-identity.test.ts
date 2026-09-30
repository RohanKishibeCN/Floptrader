/**
 * Reading the age identity file.
 *
 * One file, one key. `age-keygen` writes a commented short format; the library's
 * own generator writes just the key line. Both must work, and anything else must
 * fail loudly *without* echoing the key: a startup refusal that prints the secret
 * key into a terminal or a journal has turned a configuration problem into a
 * disclosure.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  IdentityError,
  ageRecipientFor,
  createAgeIdentity,
  decryptBundle,
  encryptBundle,
  parseAgeIdentity,
  readAgeIdentityFile,
} from '@flop/identity';

// Shaped like a real key (bech32 data characters) but not a real one: the parser
// is a string function and never derives a key from these.
const BARE_KEY = `AGE-SECRET-KEY-1${'qpzry9x8gf2tvdw0s3jn54khce6mua7l'.repeat(2).slice(0, 58)}`;
const OTHER_KEY = `AGE-SECRET-KEY-1${'l7aum6echk45nj3s0wdvt2fg8x9yrzpq'.repeat(2).slice(0, 58)}`;

/** Exactly what `age-keygen` writes: two comment lines, then the key. */
function standardAgeKeygenFile(key: string, publicKey = 'age1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqq'): string {
  return `# created: 2026-09-30T02:00:00Z\n# public key: ${publicKey}\n${key}\n`;
}

describe('parseAgeIdentity', () => {
  it('reads the standard commented age-keygen file', () => {
    expect(parseAgeIdentity(standardAgeKeygenFile(BARE_KEY), 'runtime.key')).toBe(BARE_KEY);
  });

  it('reads a bare single-line key file', () => {
    expect(parseAgeIdentity(`${BARE_KEY}\n`, 'runtime.key')).toBe(BARE_KEY);
    expect(parseAgeIdentity(BARE_KEY, 'runtime.key')).toBe(BARE_KEY);
  });

  it('refuses an empty file', () => {
    expect(() => parseAgeIdentity('', 'runtime.key')).toThrow(IdentityError);
    expect(() => parseAgeIdentity('\n\n   \n', 'runtime.key')).toThrow(/exactly one/);
  });

  it('refuses a file with no AGE-SECRET-KEY line', () => {
    const publicOnly = `# created: 2026-09-30T02:00:00Z\n# public key: age1qqqq\n`;
    expect(() => parseAgeIdentity(publicOnly, 'runtime.key')).toThrow(/no AGE-SECRET-KEY-1 line/);
  });

  it('refuses two AGE-SECRET-KEY lines', () => {
    const two = `${standardAgeKeygenFile(BARE_KEY)}${OTHER_KEY}\n`;
    expect(() => parseAgeIdentity(two, 'runtime.key')).toThrow(/2 AGE-SECRET-KEY-1 lines/);
  });

  it('never puts the key material in the error', () => {
    const cases: Array<() => unknown> = [
      () => parseAgeIdentity('', 'runtime.key'),
      () => parseAgeIdentity('# public key: age1qqqq\n', 'runtime.key'),
      () => parseAgeIdentity(`${BARE_KEY}\n${OTHER_KEY}\n`, 'runtime.key'),
    ];
    for (const run of cases) {
      let message = '';
      try {
        run();
      } catch (error) {
        message = error instanceof Error ? error.message : String(error);
      }
      expect(message.length).toBeGreaterThan(0);
      expect(message).not.toContain(BARE_KEY);
      expect(message).not.toContain(OTHER_KEY);
      // The file name is what an operator needs, and it is safe to print.
      expect(message).toContain('runtime.key');
    }
  });
});

describe('readAgeIdentityFile', () => {
  it('reads from disk and reports a missing file without a key', () => {
    const dir = mkdtempSync(join(tmpdir(), 'flop-age-'));
    try {
      const path = join(dir, 'runtime.key');
      writeFileSync(path, standardAgeKeygenFile(BARE_KEY), { mode: 0o600 });
      expect(readAgeIdentityFile(path)).toBe(BARE_KEY);

      const missing = join(dir, 'nope.key');
      let message = '';
      try {
        readAgeIdentityFile(missing);
      } catch (error) {
        message = error instanceof Error ? error.message : String(error);
      }
      expect(message).toContain(missing);
      expect(message).not.toContain('AGE-SECRET-KEY');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('encrypts to, and decrypts with, a standard age-keygen file', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'flop-age-'));
    try {
      // A real key, written in the real tool's format: the header comment names
      // the recipient, exactly as `age-keygen` does.
      const bare = await createAgeIdentity();
      const recipient = await ageRecipientFor(bare);
      const path = join(dir, 'runtime.key');
      writeFileSync(path, standardAgeKeygenFile(bare, recipient), { mode: 0o600 });

      // The generate path: the identity file yields the recipient the bundle is
      // encrypted to.
      const parsed = readAgeIdentityFile(path);
      expect(parsed).toBe(bare);
      const fromFile = await ageRecipientFor(parsed);
      expect(fromFile).toBe(recipient);

      // The decrypt path: the same file opens the bundle it was encrypted to.
      const ciphertext = await encryptBundle('{"schema":"x"}', [fromFile]);
      expect(await decryptBundle(ciphertext, [parsed])).toBe('{"schema":"x"}');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
