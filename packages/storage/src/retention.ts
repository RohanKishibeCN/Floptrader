/**
 * Retention: what is permanent, what is compressible, and how deletion is gated.
 *
 * The Close Call record is the asset. A Lark report succeeding is not a reason to
 * drop anything that proves an agent took part, registered, or traded. So the
 * permanent list is explicit, and the "compressible" path archives to a
 * checksummed file first and deletes second.
 *
 * PERMANENT (never pruned by any code path here):
 *   owner_registrations           the 150 signed registrations
 *   participation_records         readback evidence and status
 *   control_proofs                control proofs
 *   package_pins, strategy_versions, llm_calls, lark_outbox, archive_manifests
 *   referee_snapshots             referee DID, package hash, ref price, limits
 *   agent_runs, decisions         the per-agent 7x24h evidence: "weekly run
 *                                 missing = 0" is provable only from these rows
 *   room_cursors                  read position; losing one is a cursor gap
 *   messages of kind owner/room/trade, and every message from a local DID
 *   trades                        local trades and referee outcomes touching them
 *   nonces                        the replay counter
 *   events with a critical code   error and alert history
 *
 * COMPRESSIBLE (archived to gzip JSONL, then deleted):
 *   messages older than the chatter window that involve no local DID and are not
 *   registration/trade evidence: third-party close1 conversation.
 *   debug-level events older than the debug window.
 */
import type { SqliteDatabase } from './database.js';

export const PERMANENT_TABLES = [
  'identities',
  'owner_registrations',
  'participation_records',
  'control_proofs',
  'package_pins',
  'strategy_versions',
  'llm_calls',
  'lark_outbox',
  'archive_manifests',
  'referee_snapshots',
  'trades',
  'nonces',
  // The 7x24h participation floor is measured from `agent_runs`, and the
  // acceptance criterion is "no cursor loss" — both are evidence, not chatter.
  'agent_runs',
  'decisions',
  'room_cursors',
  // Where a room was listed and when it fell off, and every omitted/missed/
  // unlisted the referee reported: a data gap is evidence about the feed.
  'room_registry',
  'referee_anomalies',
] as const;

/** Event codes that survive every prune, however old they are. */
export const PERMANENT_EVENT_CODES = [
  'package_hash_drift',
  'disk_critical',
  'disk_readonly',
  'writer_blocked',
  'load_shed',
  'crash_recovered',
  'sqlite_corrupt',
  'lark_report_failed',
  'mint_unknown',
  // A registration that never got a readback before the lock is a permanent
  // fact about the season, and the weekly report has to be able to prove it.
  'registration_closed',
  'owner_registration_closed',
  'conservative_mode',
  'human_override',
  // The live referee's own anomalies. Each one explains a hole in the record, so
  // losing the row would turn a known gap into an unexplained one.
  'stale_reference',
  'limits_for_mismatch',
  'room_unlisted',
  'referee_omitted',
  'referee_missed',
  'room_overflow',
  'archive_unavailable',
] as const;

/** Message kinds that are evidence and are never candidates for pruning. */
export const EVIDENCE_MESSAGE_KINDS = ['owner', 'room', 'trade', 'price', 'flow', 'state', 'seed', 'final'] as const;

export interface RetentionPolicy {
  /** Hours after which third-party chatter may be archived and deleted. */
  chatterHours: number;
  /** Hours after which debug events may be deleted. */
  debugHours: number;
  /** How many recent messages per room to keep regardless of age. */
  keepRecentPerRoom: number;
}

export const DEFAULT_RETENTION: RetentionPolicy = {
  chatterHours: 24,
  debugHours: 72,
  keepRecentPerRoom: 200,
};

export interface PruneCandidate {
  room: string;
  seq: number;
  ts: string;
  text: string;
  sender_did: string | null;
  kind: string;
  signature_valid: number | null;
}

export interface RetentionReport {
  chatterArchived: number;
  chatterDeleted: number;
  debugEventsDeleted: number;
  cutoffIso: string;
  dryRun: boolean;
}

function localDidList(localDids: string[]): string[] {
  return localDids.filter((did) => typeof did === 'string' && did.length > 0);
}

/**
 * Select the messages that may leave the database.
 *
 * Excluded, always: registration/trade evidence kinds, anything sent by one of
 * our 150 DIDs (our own trade posts are the record of what we did), anything a
 * stored trade points at, and the newest `keepRecentPerRoom` messages of a room.
 */
export function selectChatterCandidates(
  db: SqliteDatabase,
  localDids: string[],
  now: Date,
  policy: RetentionPolicy = DEFAULT_RETENTION,
): PruneCandidate[] {
  const cutoff = new Date(now.getTime() - policy.chatterHours * 3600_000).toISOString();
  const dids = localDidList(localDids);
  const kindPlaceholders = EVIDENCE_MESSAGE_KINDS.map(() => '?').join(',');
  const params: Array<string | number> = [cutoff];
  let localClause = '';
  if (dids.length > 0) {
    localClause = ` AND (m.sender_did IS NULL OR m.sender_did NOT IN (${dids.map(() => '?').join(',')}))`;
    params.push(...dids);
  }
  params.push(...EVIDENCE_MESSAGE_KINDS);
  params.push(policy.keepRecentPerRoom);

  return db
    .prepare(
      `SELECT m.room, m.seq, m.ts, m.text, m.sender_did, m.kind, m.signature_valid
         FROM messages m
        WHERE m.ts < ?
          ${localClause}
          AND m.kind NOT IN (${kindPlaceholders})
          AND NOT EXISTS (SELECT 1 FROM trades t WHERE t.room = m.room AND t.seq = m.seq)
          AND m.seq < COALESCE(
                (SELECT MAX(inner_m.seq) FROM messages inner_m WHERE inner_m.room = m.room) - ?,
                0)
        ORDER BY m.room ASC, m.seq ASC`,
    )
    .all(...params) as PruneCandidate[];
}

/** Delete exactly the rows previously selected. Returns the number removed. */
export function deleteChatter(db: SqliteDatabase, candidates: PruneCandidate[]): number {
  if (candidates.length === 0) return 0;
  const statement = db.prepare('DELETE FROM messages WHERE room = ? AND seq = ?');
  let deleted = 0;
  const run = db.transaction(() => {
    for (const row of candidates) deleted += statement.run(row.room, row.seq).changes;
  });
  run();
  return deleted;
}

/** Debug events older than the window, minus every permanent code. */
export function deleteDebugEvents(
  db: SqliteDatabase,
  now: Date,
  policy: RetentionPolicy = DEFAULT_RETENTION,
): number {
  const cutoff = new Date(now.getTime() - policy.debugHours * 3600_000).toISOString();
  const placeholders = PERMANENT_EVENT_CODES.map(() => '?').join(',');
  return db
    .prepare(`DELETE FROM events WHERE at < ? AND code NOT IN (${placeholders})`)
    .run(cutoff, ...PERMANENT_EVENT_CODES).changes;
}

/**
 * Safety net for the acceptance criterion "no key contest evidence deleted":
 * assert that every permanent table still holds what it held before a prune.
 */
export function assertEvidenceIntact(db: SqliteDatabase, before: Record<string, number>): void {
  const changed: string[] = [];
  for (const [table, count] of Object.entries(before)) {
    const current = (db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
    if (current !== count) changed.push(`${table}: ${count} -> ${current}`);
  }
  if (changed.length > 0) {
    throw new Error(`retention violated the permanent set: ${changed.join(', ')}`);
  }
}

function tableExists(db: SqliteDatabase, table: string): boolean {
  const row = db
    .prepare("SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = ?")
    .get(table) as { present: number } | undefined;
  return row !== undefined;
}

export function snapshotPermanentCounts(db: SqliteDatabase): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const table of PERMANENT_TABLES) {
    // `disk-report` inspects whatever database is on disk *without* migrating it,
    // and `assertEvidenceIntact` only checks the tables it was handed. A database
    // written before a table existed is a diagnostic input, not a startup error,
    // so an absent table is skipped rather than thrown on. On a migrated database
    // (the retention path) every table is present and this is a no-op.
    if (!tableExists(db, table)) continue;
    counts[table] = (db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
  }
  return counts;
}
