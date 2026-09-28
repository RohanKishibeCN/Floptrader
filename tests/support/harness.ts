/**
 * Shared test harness: temp directories, agent generation, fake clocks.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  AGENTS_PER_GROUP,
  AgentKeyStore,
  AgentSecretRecord,
  DEFAULT_AGENT_COUNT,
  STRATEGY_GROUPS,
  assignStrategyGroup,
  makeAgentSecretRecord,
  newSeed,
} from '@flop/identity';

export function tempDir(prefix = 'flop-test-'): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

/** Best-effort recursive removal: macOS temp dirs are watched by Spotlight and
 *  a concurrent scan can make rmdir race. A test's real assertion error is far
 *  more useful than a cleanup ENOTEMPTY, so this never throws. */
export function cleanup(...paths: string[]): void {
  for (const path of paths) {
    try {
      rmSync(path, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 });
    } catch {
      /* leave the temp dir to the OS */
    }
  }
}

/** Deterministic seeds so a test failure is reproducible. */
export function deterministicSeed(index: number): Uint8Array {
  const seed = new Uint8Array(32);
  // A simple xorshift-ish fill; not for production, only for repeatable fixtures.
  let state = (index + 1) * 2654435761;
  for (let i = 0; i < 32; i += 1) {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    seed[i] = Math.abs(state) % 256;
  }
  return seed;
}

export function generateAgents(count = DEFAULT_AGENT_COUNT, deterministic = true): AgentSecretRecord[] {
  const agents: AgentSecretRecord[] = [];
  for (let index = 0; index < count; index += 1) {
    const seed = deterministic ? deterministicSeed(index) : newSeed();
    agents.push(makeAgentSecretRecord(index, seed, assignStrategyGroup(index)));
  }
  return agents;
}

export function storeFrom(agents: AgentSecretRecord[]): AgentKeyStore {
  return new AgentKeyStore({ agents });
}

export function generatedStore(count = DEFAULT_AGENT_COUNT): AgentKeyStore {
  return storeFrom(generateAgents(count));
}

export function groupCounts(agents: AgentSecretRecord[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const group of STRATEGY_GROUPS) counts[group] = 0;
  for (const agent of agents) counts[agent.strategyGroup] = (counts[agent.strategyGroup] ?? 0) + 1;
  return counts;
}

export { AGENTS_PER_GROUP, STRATEGY_GROUPS, DEFAULT_AGENT_COUNT };

/** A clock the test controls, in milliseconds. */
export function fakeClock(startMs: number): { now: () => number; advance: (ms: number) => void; set: (ms: number) => void } {
  let current = startMs;
  return {
    now: () => current,
    advance: (ms: number) => {
      current += ms;
    },
    set: (ms: number) => {
      current = ms;
    },
  };
}
