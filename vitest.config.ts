import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

const r = (p: string) => fileURLToPath(new URL(p, import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      '@flop/identity': r('./packages/identity/src/index.ts'),
      '@flop/storage': r('./packages/storage/src/index.ts'),
      '@flop/technocore': r('./packages/technocore/src/index.ts'),
      '@flop/close-call': r('./packages/close-call/src/index.ts'),
      '@flop/strategy': r('./packages/strategy/src/index.ts'),
      '@orchestrator': r('./apps/orchestrator/src'),
    },
  },
  test: {
    include: ['tests/**/*.test.ts'],
    environment: 'node',
    testTimeout: 60_000,
    hookTimeout: 60_000,
    // One short-lived process per test file, run sequentially. Test files open real
    // SQLite databases; a worker that outlives the file it opened them in can run a
    // native finalizer after the environment is gone, which aborts the worker. A
    // fresh process per file, plus the explicit GC in support/teardown.ts, keeps the
    // suite deterministic and bounds memory.
    pool: 'forks',
    poolOptions: {
      forks: {
        singleFork: false,
        isolate: true,
        // Needed by tests/support/teardown.ts to drain native finalizers safely.
        execArgv: ['--expose-gc'],
      },
    },
    fileParallelism: false,
    setupFiles: ['tests/support/teardown.ts'],
    reporters: ['default'],
  },
});
