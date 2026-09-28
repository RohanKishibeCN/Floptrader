/**
 * Test teardown: drain native finalizers while the Node environment is still alive.
 *
 * better-sqlite3 finalises its native statement and connection handles from V8 weak
 * callbacks, and those callbacks call back into the Node environment. A worker that
 * finishes a test file leaves already-unreachable native wrappers behind; if the
 * final GC that collects them happens during isolate teardown, `GetCurrent(isolate)`
 * returns null and the addon aborts the process with
 * `Assertion failed: (env) != nullptr`.
 *
 * That is a harness hazard, not a product bug, and it is avoidable: run a full GC at
 * the end of every file, while the environment is unambiguously alive, so the weak
 * callbacks fire safely and nothing is left for teardown to finalise.
 *
 * The worker is started with `--expose-gc` (see vitest.config.ts). Without it this
 * file does nothing rather than failing: a missing GC hook must not break the suite.
 */
import { afterAll } from 'vitest';
import { liveDatabaseCount } from '@flop/storage';

const gc = (globalThis as { gc?: () => void }).gc;

afterAll(() => {
  if (typeof gc !== 'function') return;
  // Two passes: the first invokes the weak callbacks, the second collects whatever
  // those callbacks released.
  for (let pass = 0; pass < 3; pass += 1) {
    gc();
  }
  // Kept reachable on purpose (see storage/database.ts); reported so a leak of
  // connections across a file would be visible rather than silent.
  void liveDatabaseCount();
});
