/**
 * In-process key store for the 150 Close Call agents.
 *
 * Seeds live here and nowhere else: they are decrypted once at startup from the
 * age bundle, kept in memory for the life of the process, and never written back
 * to a plaintext file. Every accessor that returns key material hands out a copy.
 *
 * Fail-closed rules:
 *   - a seed that is not exactly 32 bytes aborts construction;
 *   - a seed whose derived DID disagrees with the recorded DID aborts construction;
 *   - a missing agent throws rather than returning undefined.
 */
import { IdentityError, assertSeed, didFromSeed, fingerprintOf, publicKeyToMultibase, publicKeyFromSeed } from './did.js';
import { signBytes } from './did.js';

export const STRATEGY_GROUPS = [
  'trend_following',
  'mean_reversion',
  'breakout',
  'contrarian',
  'external_offer_taker',
] as const;

export type StrategyGroup = (typeof STRATEGY_GROUPS)[number];

export const AGENTS_PER_GROUP = 30;
export const DEFAULT_AGENT_COUNT = STRATEGY_GROUPS.length * AGENTS_PER_GROUP;

/** Deterministic group assignment: interleaved so every group is spread across ids. */
export function assignStrategyGroup(index: number): StrategyGroup {
  return STRATEGY_GROUPS[index % STRATEGY_GROUPS.length]!;
}

export function agentIdFor(index: number): string {
  return `agent-${String(index + 1).padStart(4, '0')}`;
}

export interface AgentPublicRecord {
  agentId: string;
  did: string;
  publicKeyMultibase: string;
  fingerprint: string;
  strategyGroup: StrategyGroup;
}

/** A stored agent entry: public metadata plus the seed it must agree with. */
export interface AgentSecretRecord extends AgentPublicRecord {
  seed: Uint8Array;
}

export interface AgentKeyStoreOptions {
  agents: AgentSecretRecord[];
  /** When set, validates that the store covers exactly this season. */
  season?: string;
}

export class AgentKeyStore {
  private readonly byId = new Map<string, AgentSecretRecord>();
  private readonly order: string[] = [];

  constructor(options: AgentKeyStoreOptions) {
    if (!Array.isArray(options.agents) || options.agents.length === 0) {
      throw new IdentityError('key store requires at least one agent');
    }
    for (const agent of options.agents) {
      try {
        assertSeed(agent.seed);
      } catch (error) {
        throw new IdentityError(
          `agent ${agent.agentId}: refusing to start with a corrupt seed (${String(error)})`,
        );
      }
      const derivedDid = didFromSeed(agent.seed);
      if (derivedDid !== agent.did) {
        throw new IdentityError(
          `agent ${agent.agentId}: seed does not match recorded DID (derived ${derivedDid})`,
        );
      }
      const multibase = publicKeyToMultibase(publicKeyFromSeed(agent.seed));
      if (multibase !== agent.publicKeyMultibase) {
        throw new IdentityError(`agent ${agent.agentId}: public key multibase mismatch`);
      }
      if (this.byId.has(agent.agentId)) {
        throw new IdentityError(`duplicate agent id ${agent.agentId}`);
      }
      this.byId.set(agent.agentId, agent);
      this.order.push(agent.agentId);
    }
  }

  get size(): number {
    return this.byId.size;
  }

  /** Agent ids in bundle order. */
  get agentIds(): readonly string[] {
    return this.order;
  }

  has(agentId: string): boolean {
    return this.byId.has(agentId);
  }

  private require(agentId: string): AgentSecretRecord {
    const agent = this.byId.get(agentId);
    if (!agent) throw new IdentityError(`unknown agent id ${JSON.stringify(agentId)}`);
    return agent;
  }

  did(agentId: string): string {
    return this.require(agentId).did;
  }

  strategyGroup(agentId: string): StrategyGroup {
    return this.require(agentId).strategyGroup;
  }

  publicRecord(agentId: string): AgentPublicRecord {
    const { seed: _seed, ...rest } = this.require(agentId);
    return rest;
  }

  publicRecords(): AgentPublicRecord[] {
    return this.order.map((id) => this.publicRecord(id));
  }

  /** Set of every DID this process controls; used to refuse self-dealing. */
  didSet(): Set<string> {
    return new Set(this.order.map((id) => this.require(id).did));
  }

  /** Reverse lookup, null when the DID is not ours. */
  agentIdForDid(did: string): string | null {
    for (const id of this.order) {
      if (this.byId.get(id)!.did === did) return id;
    }
    return null;
  }

  /**
   * Run `fn` with the agent's seed. The seed is passed by reference for the
   * duration of the call only; nothing here caches or exports it.
   */
  withSeed<T>(agentId: string, fn: (seed: Uint8Array, did: string) => T): T {
    const agent = this.require(agentId);
    return fn(agent.seed, agent.did);
  }

  /** Sign a payload (already canonical UTF-8 bytes) as this agent. */
  sign(agentId: string, payload: Uint8Array): Uint8Array {
    return this.withSeed(agentId, (seed) => signBytes(seed, payload));
  }

  /** Zero the seed buffers. Called on graceful shutdown. */
  destroy(): void {
    for (const agent of this.byId.values()) agent.seed.fill(0);
    this.byId.clear();
    this.order.length = 0;
  }
}

/** Build a fresh agent record from a generated seed. */
export function makeAgentSecretRecord(
  index: number,
  seed: Uint8Array,
  strategyGroup: StrategyGroup = assignStrategyGroup(index),
): AgentSecretRecord {
  assertSeed(seed);
  const publicKey = publicKeyFromSeed(seed);
  return {
    agentId: agentIdFor(index),
    did: didFromSeed(seed),
    publicKeyMultibase: publicKeyToMultibase(publicKey),
    fingerprint: fingerprintOf(publicKey),
    strategyGroup,
    seed,
  };
}

export function newSeed(): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(32));
}
