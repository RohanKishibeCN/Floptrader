/**
 * Per-(DID, room) monotonic nonce allocation.
 *
 * technocore.chat requires a nonce of 1..19 digits strictly greater than the last
 * nonce that key used in that room. Two rules follow, and both are enforced here:
 *
 *  1. The counter is persisted BEFORE the write is attempted, so a crash between
 *     signing and posting can never hand out the same nonce twice.
 *  2. The counter never moves backwards: a wall clock that jumps (NTP step, VM
 *     restore, container migration) raises the allocated value but never lowers
 *     it. This is the "nonce rollback = 0" acceptance criterion.
 */
import { IdentityError } from './did.js';
import { NONCE_PATTERN, assertNonce } from './signing.js';

/** Persistence port; the SQLite implementation lives in @flop/storage. */
export interface NoncePersistence {
  getLastNonce(did: string, room: string): string | null;
  setLastNonce(did: string, room: string, nonce: string, updatedAt: string): void;
}

const MAX_NONCE = 10n ** 19n - 1n;

export function maxNonce(a: string | null, b: string | null): string | null {
  if (a !== null && !NONCE_PATTERN.test(a)) {
    throw new IdentityError(`corrupt nonce value: ${JSON.stringify(a)}`);
  }
  if (b !== null && !NONCE_PATTERN.test(b)) {
    throw new IdentityError(`corrupt nonce value: ${JSON.stringify(b)}`);
  }
  if (a === null) return b;
  if (b === null) return a;
  return BigInt(a) >= BigInt(b) ? a : b;
}

export interface NonceStoreOptions {
  persistence: NoncePersistence;
  /** Injectable clock, milliseconds since epoch. */
  now?: () => number;
}

export class NonceStore {
  private readonly persistence: NoncePersistence;
  private readonly now: () => number;
  private readonly cache = new Map<string, string>();
  /** True when persistence refused a write and the in-memory value is ahead. */
  private dirty = false;

  constructor(options: NonceStoreOptions) {
    this.persistence = options.persistence;
    this.now = options.now ?? (() => Date.now());
  }

  private static cacheKey(did: string, room: string): string {
    return `${did}\u0000${room}`;
  }

  /** The highest nonce this store knows for the pair, or null. */
  last(did: string, room: string): string | null {
    const key = NonceStore.cacheKey(did, room);
    const cached = this.cache.get(key) ?? null;
    const persisted = this.persistence.getLastNonce(did, room);
    return maxNonce(cached, persisted);
  }

  /**
   * Reserve the next nonce and make it durable. Throws if persistence fails —
   * a nonce we cannot record is a nonce we must not sign with.
   */
  allocate(did: string, room: string): string {
    const previous = this.last(did, room);
    const wallClock = BigInt(Math.max(0, Math.floor(this.now())));
    const candidate = previous === null ? wallClock : BigInt(previous) + 1n;
    const next = candidate > wallClock ? candidate : wallClock;
    if (next > MAX_NONCE) {
      throw new IdentityError(`nonce space exhausted for ${did} in ${room}`);
    }
    const value = next === 0n ? '1' : next.toString();
    assertNonce(value);
    this.cache.set(NonceStore.cacheKey(did, room), value);
    this.persistence.setLastNonce(did, room, value, new Date(this.now()).toISOString());
    return value;
  }

  /**
   * Record a nonce observed from elsewhere (another operator process, or a
   * replay of our own traffic) so we never allocate below it.
   */
  observe(did: string, room: string, nonce: string): void {
    assertNonce(nonce);
    const key = NonceStore.cacheKey(did, room);
    const merged = maxNonce(this.cache.get(key) ?? null, nonce);
    if (merged !== null) this.cache.set(key, merged);
    const persisted = this.persistence.getLastNonce(did, room);
    if (maxNonce(persisted, nonce) !== persisted) {
      this.persistence.setLastNonce(did, room, nonce, new Date(this.now()).toISOString());
    }
  }

  /** Reload the in-memory view from persistence, e.g. after a writer error. */
  refresh(did: string, room: string): void {
    const persisted = this.persistence.getLastNonce(did, room);
    if (persisted !== null) {
      this.cache.set(NonceStore.cacheKey(did, room), persisted);
    }
  }

  get isDirty(): boolean {
    return this.dirty;
  }

  /** Test hook: simulate persistence failure without corrupting real state. */
  markDirty(): void {
    this.dirty = true;
  }
}

/** In-memory persistence, used by tests and by the soak harness. */
export class MemoryNoncePersistence implements NoncePersistence {
  private readonly values = new Map<string, string>();

  getLastNonce(did: string, room: string): string | null {
    return this.values.get(`${did}\u0000${room}`) ?? null;
  }

  setLastNonce(did: string, room: string, nonce: string): void {
    this.values.set(`${did}\u0000${room}`, nonce);
  }

  entries(): Array<{ did: string; room: string; nonce: string }> {
    return [...this.values.entries()].map(([key, nonce]) => {
      const [did = '', room = ''] = key.split('\u0000');
      return { did, room, nonce };
    });
  }
}
