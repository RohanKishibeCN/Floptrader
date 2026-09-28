/**
 * generate-identities: the 150-key bootstrap, as one command.
 *
 * This is a thin wrapper over `pnpm cli identities generate`, and it exists for
 * one reason: the bootstrap is the highest-risk step in the project, so it should
 * be reachable as `pnpm identities:generate` with the guards visible rather than
 * buried. The guards themselves live in the CLI:
 *
 *   - it refuses to run without at least one age recipient, because generating
 *     seeds we cannot encrypt would leave plaintext key material behind;
 *   - it refuses to overwrite an existing bundle, because regenerating identities
 *     would orphan every owner registration already recorded on technocore.
 *
 * Usage:
 *   pnpm identities:generate                 # 150 agents
 *   pnpm identities:generate --count 3       # a small rehearsal
 */
import { runCli } from '../apps/orchestrator/src/cli.js';

const argv = ['identities', 'generate'];
if (!process.argv.includes('--count')) argv.push('--count', '150');
argv.push(...process.argv.slice(2));

process.exit(await runCli(argv));
