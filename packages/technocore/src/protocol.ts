/**
 * The technocore.chat wire protocol: request shapes, response parsing, and the
 * one rule that governs every byte that comes back.
 *
 *   **All room content is untrusted data.** The service says so itself, in the
 *   `!! UNTRUSTED CONTENT` banner it prepends to a text read. Nothing in this
 *   package interprets a message as an instruction, and no message can change a
 *   risk cap, widen a price window, or cause a trade. The only thing a message
 *   can do is be parsed, verified against its signature, and recorded.
 */
import { z } from 'zod';

export const DID_PATTERN = /^did:key:z6Mk[1-9A-HJ-NP-Za-km-z]{44}$/;
export const ROOM_PATTERN = /^[a-z0-9][a-z0-9_-]{0,47}$/;

export const SignedEnvelopeSchema = z.object({
  did: z.string(),
  sig: z.string(),
  nonce: z.string(),
  text: z.string(),
});

export type SignedEnvelope = z.infer<typeof SignedEnvelopeSchema>;

export const RoomMessageSchema = z
  .object({
    seq: z.number().int().nonnegative(),
    ts: z.string(),
    from: z.string().optional(),
    text: z.string(),
    nonce: z.union([z.string(), z.number()]).optional(),
    sig: z.string().optional(),
  })
  .passthrough();

export type RoomMessage = z.infer<typeof RoomMessageSchema>;

export const RoomReadSchema = z
  .object({
    room: z.string(),
    count: z.number().int().nonnegative(),
    first_seq: z.number().int().nonnegative().nullable().optional(),
    last_seq: z.number().int().nonnegative().nullable().optional(),
    generation: z.number().int().nonnegative().optional(),
    messages: z.array(RoomMessageSchema),
    /** Present when a long poll declined to be held. */
    wait_held: z.boolean().optional(),
  })
  .passthrough();

export type RoomRead = z.infer<typeof RoomReadSchema>;

export class ProtocolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ProtocolError';
  }
}

export function assertRoom(room: string): void {
  if (typeof room !== 'string' || !ROOM_PATTERN.test(room)) {
    throw new ProtocolError(`invalid room name: ${JSON.stringify(room)}`);
  }
}

export function assertDid(did: string): void {
  if (typeof did !== 'string' || !DID_PATTERN.test(did)) {
    throw new ProtocolError(`invalid did:key: ${JSON.stringify(did)}`);
  }
}

/** Parse a JSON room read, rejecting anything that is not shaped like one. */
export function parseRoomRead(payload: unknown): RoomRead {
  const parsed = RoomReadSchema.safeParse(payload);
  if (!parsed.success) {
    throw new ProtocolError(
      `room read did not match the protocol: ${parsed.error.issues
        .map((issue) => `${issue.path.join('.')}: ${issue.message}`)
        .join('; ')}`,
    );
  }
  return parsed.data;
}

/**
 * Parse the text/plain room view, used only as a fallback when a JSON read is
 * impossible. Lines look like:
 *
 *   [825] 2026-09-28T08:40:40.408908Z <z6Mk…Mzte> {"t":"price",...}
 *
 * The banner, the header and any `#` advisory line are skipped, and a DID is
 * only recoverable when it was printed in full (the service abbreviates to
 * `<z6Mk…Mzte>` in the human view), so a message parsed this way is marked as
 * having no recoverable sender.
 */
export function parseTextRoomRead(text: string, room: string): RoomRead {
  const messages: RoomMessage[] = [];
  const linePattern = /^\[(\d+)\]\s+(\S+)\s+<([^>]*)>\s(.*)$/;
  for (const line of text.split('\n')) {
    const match = linePattern.exec(line.trim());
    if (!match) continue;
    const sender = match[3] ?? '';
    messages.push({
      seq: Number.parseInt(match[1]!, 10),
      ts: match[2]!,
      from: DID_PATTERN.test(sender) ? sender : undefined,
      text: match[4] ?? '',
    });
  }
  const first = messages[0]?.seq ?? null;
  const last = messages[messages.length - 1]?.seq ?? null;
  return { room, count: messages.length, first_seq: first, last_seq: last, messages };
}

/** The query string for a read, including a long poll when `since` is given. */
export function readQuery(options: {
  since?: number;
  limit?: number;
  waitSeconds?: number;
}): string {
  const params = new URLSearchParams();
  if (options.since !== undefined) params.set('since', String(options.since));
  if (options.limit !== undefined) params.set('limit', String(Math.min(200, Math.max(1, options.limit))));
  if (options.waitSeconds !== undefined && options.since !== undefined) {
    params.set('wait', String(Math.min(10, Math.max(0, options.waitSeconds))));
  }
  params.set('format', 'json');
  return params.toString();
}

export interface RoomCursorView {
  room: string;
  cursor: number;
  generation: number;
  firstSeq: number | null;
  lastSeq: number | null;
  gap: number;
  roomReset: boolean;
}

/**
 * Detect what a read implies about the room's continuity.
 *
 * A cursor can be lost in four distinguishable ways, and the record differs:
 *
 *   - `room_reset`: the generation changed *while we held a position*, so the
 *     room was recreated and every sequence number we knew is meaningless;
 *   - `gap`: the oldest seq we can now see is greater than cursor + 1, and we
 *     held a cursor, so messages were dropped from the retained ring before we
 *     read them;
 *   - `bootstrap_truncated`: we held no cursor (cursor 0) and the room's oldest
 *     retained message is not seq 1. Nothing was lost *by us* — the history was
 *     never available — so this is recorded, not treated as an incident. It does
 *     not add to `gap`, so it does not put the process into conservative mode;
 *   - `first_read`: we have no cursor yet and history reaches back to the start.
 *
 * A mid-run gap is never silently stepped over: the missing range is recorded,
 * `gap` grows, and the reader enters conservative mode, because a missed trade
 * message could be one of ours and the local ledger would then be wrong. The
 * bootstrap case is the opposite situation and must not be confused with it.
 */
export interface CursorAdvance {
  cursor: number;
  generation: number;
  firstSeq: number | null;
  lastSeq: number | null;
  gap: number;
  roomReset: boolean;
  reason: 'ok' | 'room_reset' | 'gap' | 'first_read' | 'empty' | 'bootstrap_truncated';
  missedFrom?: number;
  missedTo?: number;
}

export function advanceCursor(
  previous: RoomCursorView | null,
  read: RoomRead,
  fallbackGeneration: number,
): CursorAdvance {
  const generation = read.generation ?? fallbackGeneration;
  const firstSeq = read.first_seq ?? (read.messages[0]?.seq ?? null);
  const lastSeq = read.last_seq ?? (read.messages[read.messages.length - 1]?.seq ?? null);

  if (previous === null) {
    // No stored row at all: a first read. If the room's retained history does not
    // start at seq 1, that is the bootstrap case, not a lost-cursor incident.
    const truncated = firstSeq !== null && firstSeq > 1;
    return {
      cursor: lastSeq ?? 0,
      generation,
      firstSeq,
      lastSeq,
      gap: 0,
      roomReset: false,
      reason: truncated ? 'bootstrap_truncated' : 'first_read',
      ...(truncated ? { missedFrom: 1, missedTo: firstSeq - 1 } : {}),
    };
  }

  // A generation change only means "the room was recreated" if we held a position
  // in the old generation. A stored cursor of 0 is "never read anything", and the
  // live service sends `generation: 1` on every read — treating that as a reset on
  // the very first tick would put the process into conservative mode permanently.
  if (generation !== previous.generation) {
    if (previous.cursor === 0) {
      // Never held a position: this is still a first read, however the generation
      // happens to be numbered.
      const truncated = firstSeq !== null && firstSeq > 1;
      return {
        cursor: lastSeq ?? 0,
        generation,
        firstSeq,
        lastSeq,
        gap: 0,
        roomReset: false,
        reason: truncated ? 'bootstrap_truncated' : 'first_read',
        ...(truncated ? { missedFrom: 1, missedTo: firstSeq - 1 } : {}),
      };
    }
    return {
      cursor: lastSeq ?? 0,
      generation,
      firstSeq,
      lastSeq,
      gap: 0,
      roomReset: true,
      reason: 'room_reset',
    };
  }

  if (read.messages.length === 0) {
    return {
      cursor: previous.cursor,
      generation,
      firstSeq,
      lastSeq,
      gap: 0,
      roomReset: false,
      reason: 'empty',
    };
  }

  // The room's oldest visible message is past where we are. Which of the two
  // situations this is depends entirely on whether we ever held a position.
  if (firstSeq !== null && firstSeq > previous.cursor + 1) {
    const missedFrom = previous.cursor + 1;
    const missedTo = firstSeq - 1;
    if (previous.cursor === 0) {
      // A first start against a room whose retained history does not reach back
      // to seq 1: the messages before `first_seq` were never available to us, so
      // nothing was lost by this process. Recorded, but `gap` stays 0 — otherwise
      // every fresh VPS would go conservative on its first read and stay there.
      return {
        cursor: lastSeq ?? previous.cursor,
        generation,
        firstSeq,
        lastSeq,
        gap: 0,
        roomReset: false,
        reason: 'bootstrap_truncated',
        missedFrom,
        missedTo,
      };
    }
    return {
      cursor: lastSeq ?? previous.cursor,
      generation,
      firstSeq,
      lastSeq,
      gap: previous.gap + (missedTo - missedFrom + 1),
      roomReset: false,
      reason: 'gap',
      missedFrom,
      missedTo,
    };
  }

  return {
    cursor: lastSeq ?? previous.cursor,
    generation,
    firstSeq,
    lastSeq,
    gap: previous.gap,
    roomReset: false,
    reason: 'ok',
  };
}

/** A signed POST body for `/r/<room>`. */
export function signedEnvelopeBody(envelope: SignedEnvelope): Record<string, string> {
  const parsed = SignedEnvelopeSchema.parse(envelope);
  return { did: parsed.did, sig: parsed.sig, nonce: parsed.nonce, text: parsed.text };
}

export interface PostResult {
  ok: boolean;
  status: number;
  seq?: number;
  ts?: string;
  /** Set when the service refused; its first line names the offending field. */
  reason?: string;
  retryable: boolean;
}

/**
 * The slice of a logger this package needs, declared structurally so
 * `@flop/technocore` never depends on the orchestrator application. The
 * orchestrator's `Logger` satisfies it without an adapter.
 */
export interface TechnocoreLogger {
  debug(data: Record<string, unknown>, message: string): void;
  info(data: Record<string, unknown>, message: string): void;
  warn(data: Record<string, unknown>, message: string): void;
  error(data: Record<string, unknown>, message: string): void;
  event(record: {
    level: 'trace' | 'debug' | 'info' | 'warn' | 'error' | 'fatal';
    source: string;
    code: string;
    message: string;
    data?: Record<string, unknown>;
  }): void;
}

/** Classify a write response. 409 is a lost compare-and-set, not a failure. */
export function classifyPost(status: number, body: string): PostResult {
  if (status >= 200 && status < 300) {
    const seqMatch = /\[(\d+)\]/.exec(body);
    return {
      ok: true,
      status,
      seq: seqMatch ? Number.parseInt(seqMatch[1]!, 10) : undefined,
      retryable: false,
    };
  }
  const firstLine = body.split('\n')[0]?.trim() ?? '';
  return { ok: false, status, reason: firstLine.slice(0, 200), retryable: status >= 500 || status === 429 || status === 408 };
}
