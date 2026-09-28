/**
 * The one writer, and the two things this process ever posts.
 *
 * All 150 agents share this queue. There is no per-agent poster, because 150
 * concurrent signers would breach technocore's write rate during exactly the
 * minutes that matter, and because the nonce counter has to be serialised per
 * (DID, room) anyway.
 *
 * What gets posted, in the whole program, is:
 *   1. `{"t":"owner","season":"close-1","key":"<did>"}` — the owner registration.
 *      This is the minimum participation record for the contest, so it is queued
 *      at `critical` priority and is the one thing the queue never sheds.
 *   2. a signed `trade` message, and only after the trade validator and the
 *      local risk engine have both agreed.
 *
 * Nothing else. No heartbeats, no keep-alive chatter, no per-agent room, no
 * per-agent duplication.
 */
import { NonceStore, canonicalJson, signRoomMessage, type NoncePersistence } from '@flop/identity';
import { SEASON } from '@flop/close-call';
import { RoomWriter, type TechnocoreClient, type WriteResult } from '@flop/technocore';
import type { AgentKeyStore } from '@flop/identity';
import type { Repositories } from '@flop/storage';
import type { Logger } from './logger.js';

/**
 * The durable half of `NonceStore`, backed by the `nonces` table.
 *
 * `setLastNonce` is monotonic in SQL, so a late write can never lower the stored
 * counter — that is the "nonce rollback = 0" property, and it is enforced in the
 * database rather than in a branch here.
 */
export class RepositoryNoncePersistence implements NoncePersistence {
  constructor(
    private readonly repositories: Repositories,
    private readonly now: () => Date = () => new Date(),
  ) {}

  getLastNonce(did: string, room: string): string | null {
    return this.repositories.nonces.getLastNonce(did, room);
  }

  setLastNonce(did: string, room: string, nonce: string): void {
    this.repositories.nonces.setLastNonce(did, room, nonce, this.now().toISOString());
  }
}

export interface OrchestratorWriterOptions {
  client: TechnocoreClient;
  keyStore: AgentKeyStore;
  repositories: Repositories;
  logger: Logger;
  writeRatePerMinute?: number;
  queueCapacity?: number;
  maxRetries?: number;
  now?: () => Date;
}

/** The canonical owner-registration text. Sorted keys, no whitespace. */
export function ownerRegistrationText(did: string): string {
  return canonicalJson({ t: 'owner', season: SEASON, key: did });
}

export class OrchestratorWriter {
  readonly nonceStore: NonceStore;
  readonly roomWriter: RoomWriter;
  private readonly keyStore: AgentKeyStore;
  private readonly logger: Logger;

  constructor(options: OrchestratorWriterOptions) {
    this.keyStore = options.keyStore;
    this.logger = options.logger;
    this.nonceStore = new NonceStore({
      persistence: new RepositoryNoncePersistence(options.repositories, options.now),
      ...(options.now ? { now: () => options.now!().getTime() } : {}),
    });
    this.roomWriter = new RoomWriter({
      client: options.client,
      nonceStore: this.nonceStore,
      logger: options.logger,
      // The seed never leaves the key store: the signer closure reads it for the
      // duration of the call and nothing keeps a reference.
      signer: (agentId, room, nonce, text) =>
        this.keyStore.withSeed(agentId, (seed, did) => signRoomMessage(did, seed, room, nonce, text)),
      ...(options.writeRatePerMinute === undefined
        ? {}
        : { writeRatePerMinute: options.writeRatePerMinute }),
      ...(options.queueCapacity === undefined ? {} : { queueCapacity: options.queueCapacity }),
      ...(options.maxRetries === undefined ? {} : { maxRetries: options.maxRetries }),
    });
  }

  get depth(): number {
    return this.roomWriter.depth;
  }

  stats(): Record<string, number> {
    return this.roomWriter.snapshot();
  }

  /**
   * Queue one owner registration for `agentId`.
   *
   * `critical` priority: this is the participation floor for the whole project,
   * so it outranks every other write and is not shed when the queue is deep.
   */
  async postOwnerRegistration(agentId: string, room: string): Promise<WriteResult> {
    const did = this.keyStore.did(agentId);
    return this.roomWriter.enqueue({
      room,
      agentId,
      did,
      text: ownerRegistrationText(did),
      priority: 'critical',
      label: 'owner-registration',
    });
  }

  /**
   * Queue a fully signed trade message.
   *
   * The caller has already validated the terms, the signatures and the risk
   * caps; this method signs the *outer* room envelope and nothing else. A model
   * can never reach this function: `text` is built by `trade-signing.ts` from
   * terms the risk engine has approved.
   */
  async postTrade(agentId: string, room: string, text: string): Promise<WriteResult> {
    return this.roomWriter.enqueue({
      room,
      agentId,
      did: this.keyStore.did(agentId),
      text,
      priority: 'normal',
      label: 'trade',
    });
  }

  /** Used by the CLI and by tests to post an arbitrary already-prepared text. */
  async postRaw(
    agentId: string,
    room: string,
    text: string,
    label: string,
    priority: 'critical' | 'normal' | 'low' = 'normal',
  ): Promise<WriteResult> {
    return this.roomWriter.enqueue({
      room,
      agentId,
      did: this.keyStore.did(agentId),
      text,
      priority,
      label,
    });
  }
}
