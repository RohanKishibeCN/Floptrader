#!/usr/bin/env node
/**
 * Bundle the orchestrator and the CLI into `dist/`.
 *
 * Two things about this build are deliberate:
 *
 *   1. **Only the workspace packages are bundled.** Every npm dependency is
 *      externalised, because the VPS installs them with `pnpm install
 *      --frozen-lockfile` — bundling `better-sqlite3` would mean shipping a
 *      native addon twice and picking the wrong ABI once. `@flop/*` are source
 *      TypeScript with no build step of their own, so they are compiled in.
 *
 *   2. **The output is ESM with `--experimental-*`-free Node 22 semantics.**
 *      `better-sqlite3` is CommonJS and is imported through Node's interop, which
 *      is why it stays external rather than being rewritten by the bundler.
 *
 * Usage:
 *   node scripts/build.mjs                # dist/main.mjs + dist/cli.mjs
 *   node scripts/build.mjs --outdir dist
 */
import { build } from 'esbuild';
import { mkdirSync, rmSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

function flag(name, fallback) {
  const index = process.argv.indexOf(`--${name}`);
  if (index === -1) return fallback;
  const next = process.argv[index + 1];
  return next === undefined || next.startsWith('--') ? 'true' : next;
}

const outdir = join(root, flag('outdir', 'dist'));

/**
 * Resolved by Node at runtime from `node_modules`, not by the bundler. A bare
 * specifier here also externalises its subpaths, which is what the `@noble/*`
 * deep imports need.
 */
const external = [
  'better-sqlite3',
  'fastify',
  'pino',
  'undici',
  'zod',
  'age-encryption',
  '@noble/curves',
  '@noble/hashes',
  '@scure/base',
  '@larksuiteoapi/node-sdk',
];

rmSync(outdir, { recursive: true, force: true });
mkdirSync(outdir, { recursive: true });

await build({
  entryPoints: {
    main: join(root, 'apps/orchestrator/src/main.ts'),
    cli: join(root, 'apps/orchestrator/src/cli.ts'),
  },
  outdir,
  outExtension: { '.js': '.mjs' },
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  sourcemap: true,
  legalComments: 'none',
  logLevel: 'info',
  tsconfig: join(root, 'tsconfig.json'),
  external,
  banner: {
    js: "import { createRequire as __createRequire } from 'node:module';\nconst require = __createRequire(import.meta.url);",
  },
});

const bytes = (path) => statSync(path).size.toLocaleString('en-US');
process.stdout.write(
  [
    '',
    `built into ${relative(root, outdir)}:`,
    `  main.mjs  ${bytes(join(outdir, 'main.mjs'))} bytes`,
    `  cli.mjs   ${bytes(join(outdir, 'cli.mjs'))} bytes`,
    `  external: ${external.join(', ')}`,
    '',
  ].join('\n'),
);
