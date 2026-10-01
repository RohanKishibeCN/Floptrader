/**
 * Typed repositories over the SQLite schema.
 *
 * Conventions that matter for correctness:
 *   - prices, quantities and confidence values are TEXT decimals, never JS
 *     floats: Close Call settles with exact decimal arithmetic and a float round
 *     trip is a one-cent bug waiting to happen;
 *   - every multi-statement write goes through `transaction()`;
 *   - the nonce repository is the durable half of NonceStore: the counter is
 *     written before a signed message is posted, so a crash cannot reuse one.
 */
import type { SqliteDatabase } from './database.js';

const nowIso = () => new Date().toISOString();

/** Values SQLite can bind. */
export type SqlValue = string | number | bigint | Buffer | null;

export class MetaRepository {
  constructor(private readonly db: SqliteDatabase) {}

  get(key: string): string | null {
    const row = this.db.prepare('SELECT value FROM meta WHERE key = ?').get(key) as
      | { value: string }
      | undefined;
    return row?.value ?? null;
  }

  set(key: string, value: string): void {
    this.db
      .prepare('INSERT OR REPLACE INTO meta(key, value, updated_at) VALUES (?, ?, ?)')
      .run(key, value, nowIso());
  }
}

export interface IdentityRow {
  agent_id: string;
  did: string;
  public_key_multibase: string;
  fingerprint: string;
  strategy_group: string;
  season: string;
  risk_tier: string;
  random_seed: number;
  max_qty: string;
  max_open_notional: string;
  cooldown_sweeps: number;
  confidence_threshold: string;
  strategy_version: string;
  last_run_at: string | null;
  last_run_week: string | null;
  enabled: number;
  created_at: string;
  updated_at: string;
}

export class IdentityRepository {
  constructor(private readonly db: SqliteDatabase) {}

  upsert(row: Omit<IdentityRow, 'created_at' | 'updated_at'> & { created_at?: string }): void {
    const at = nowIso();
    this.db
      .prepare(
        `INSERT INTO identities (
           agent_id, did, public_key_multibase, fingerprint, strategy_group, season,
           risk_tier, random_seed, max_qty, max_open_notional, cooldown_sweeps,
           confidence_threshold, strategy_version, last_run_at, last_run_week,
           enabled, created_at, updated_at)
         VALUES (@agent_id, @did, @public_key_multibase, @fingerprint, @strategy_group, @season,
           @risk_tier, @random_seed, @max_qty, @max_open_notional, @cooldown_sweeps,
           @confidence_threshold, @strategy_version, @last_run_at, @last_run_week,
           @enabled, @created_at, @updated_at)
         ON CONFLICT(agent_id) DO UPDATE SET
           did = excluded.did,
           public_key_multibase = excluded.public_key_multibase,
           fingerprint = excluded.fingerprint,
           strategy_group = excluded.strategy_group,
           season = excluded.season,
           strategy_version = excluded.strategy_version,
           updated_at = excluded.updated_at`,
      )
      .run({
        ...row,
        created_at: row.created_at ?? at,
        updated_at: at,
      });
  }

  get(agentId: string): IdentityRow | undefined {
    return this.db.prepare('SELECT * FROM identities WHERE agent_id = ?').get(agentId) as
      | IdentityRow
      | undefined;
  }

  all(): IdentityRow[] {
    return this.db.prepare('SELECT * FROM identities ORDER BY agent_id').all() as IdentityRow[];
  }

  byGroup(): Map<string, IdentityRow[]> {
    const grouped = new Map<string, IdentityRow[]>();
    for (const row of this.all()) {
      const list = grouped.get(row.strategy_group) ?? [];
      list.push(row);
      grouped.set(row.strategy_group, list);
    }
    return grouped;
  }

  count(): number {
    return (this.db.prepare('SELECT COUNT(*) AS n FROM identities').get() as { n: number }).n;
  }

  setEnabled(agentId: string, enabled: boolean): void {
    this.db
      .prepare('UPDATE identities SET enabled = ?, updated_at = ? WHERE agent_id = ?')
      .run(enabled ? 1 : 0, nowIso(), agentId);
  }

  setStrategyVersion(agentId: string, version: string): void {
    this.db
      .prepare('UPDATE identities SET strategy_version = ?, updated_at = ? WHERE agent_id = ?')
      .run(version, nowIso(), agentId);
  }

  recordRun(agentId: string, runAt: string, week: string): void {
    this.db
      .prepare(
        'UPDATE identities SET last_run_at = ?, last_run_week = ?, updated_at = ? WHERE agent_id = ?',
      )
      .run(runAt, week, nowIso(), agentId);
  }

  /** Agents whose last run is older than `cutoff`, or that never ran. */
  staleSince(cutoffIso: string): IdentityRow[] {
    return this.db
      .prepare(
        `SELECT * FROM identities
          WHERE enabled = 1 AND (last_run_at IS NULL OR last_run_at < ?)
          ORDER BY COALESCE(last_run_at, '') ASC`,
      )
      .all(cutoffIso) as IdentityRow[];
  }
}

export class NonceRepository {
  constructor(private readonly db: SqliteDatabase) {}

  getLastNonce(did: string, room: string): string | null {
    const row = this.db
      .prepare('SELECT nonce FROM nonces WHERE did = ? AND room = ?')
      .get(did, room) as { nonce: string } | undefined;
    return row?.nonce ?? null;
  }

  /**
   * Monotonic write: never lowers a stored nonce, even if an older value arrives
   * late. The SQL comparison is textual, which is why nonces must never be
   * zero-padded — technocore.chat compares them numerically.
   */
  setLastNonce(did: string, room: string, nonce: string, updatedAt: string): void {
    this.db
      .prepare(
        `INSERT INTO nonces(did, room, nonce, updated_at) VALUES (?, ?, ?, ?)
         ON CONFLICT(did, room) DO UPDATE SET
           nonce = CASE
             WHEN LENGTH(excluded.nonce) > LENGTH(nonces.nonce) THEN excluded.nonce
             WHEN LENGTH(excluded.nonce) = LENGTH(nonces.nonce) AND excluded.nonce > nonces.nonce
               THEN excluded.nonce
             ELSE nonces.nonce END,
           updated_at = excluded.updated_at`,
      )
      .run(did, room, nonce, updatedAt);
  }

  count(): number {
    return (this.db.prepare('SELECT COUNT(*) AS n FROM nonces').get() as { n: number }).n;
  }
}

export type ParticipationStatus =
  | 'created'
  | 'posted'
  | 'readback_confirmed'
  | 'before_lock_confirmed'
  | 'mint_observed'
  | 'mint_unknown'
  /**
   * The lock passed with no readback. Terminal: this agent never became an owner,
   * and saying so is better than leaving it looking like a registration in flight.
   */
  | 'registration_closed'
  | 'failed';

export interface ParticipationRow {
  agent_id: string;
  did: string;
  season: string;
  registration_text: string;
  registration_nonce: string;
  registration_signature: string;
  room: string;
  technocore_seq: number | null;
  technocore_ts: string | null;
  posted_at: string | null;
  readback_at: string | null;
  package_hash: string;
  referee_did: string | null;
  status: ParticipationStatus;
  attempts: number;
  last_error: string | null;
  updated_at: string;
  /** The POST's own request id, so a specific write can be reconciled later. */
  post_request_id: string | null;
  /** sha256 of the signed body we sent, so the echo can be matched byte for byte. */
  message_hash: string | null;
  /** The sweep the registration was posted in. */
  post_sweep: number | null;
  /** When the referee's flow evidence was seen to list this registration. */
  flow_evidence_at: string | null;
  /** When the referee's state evidence was seen to list this registration. */
  state_evidence_at: string | null;
}

export class ParticipationRepository {
  constructor(private readonly db: SqliteDatabase) {}

  upsert(row: ParticipationRow): void {
    this.db
      .prepare(
        `INSERT INTO participation_records (
           agent_id, did, season, registration_text, registration_nonce,
           registration_signature, room, technocore_seq, technocore_ts, posted_at,
           readback_at, package_hash, referee_did, status, attempts, last_error, updated_at,
           post_request_id, message_hash, post_sweep, flow_evidence_at, state_evidence_at)
         VALUES (@agent_id, @did, @season, @registration_text, @registration_nonce,
           @registration_signature, @room, @technocore_seq, @technocore_ts, @posted_at,
           @readback_at, @package_hash, @referee_did, @status, @attempts, @last_error, @updated_at,
           @post_request_id, @message_hash, @post_sweep, @flow_evidence_at, @state_evidence_at)
         ON CONFLICT(agent_id) DO UPDATE SET
           technocore_seq = excluded.technocore_seq,
           technocore_ts = excluded.technocore_ts,
           posted_at = excluded.posted_at,
           readback_at = excluded.readback_at,
           referee_did = excluded.referee_did,
           status = excluded.status,
           attempts = excluded.attempts,
           last_error = excluded.last_error,
           updated_at = excluded.updated_at,
           post_request_id = COALESCE(excluded.post_request_id, participation_records.post_request_id),
           message_hash = COALESCE(excluded.message_hash, participation_records.message_hash),
           post_sweep = COALESCE(excluded.post_sweep, participation_records.post_sweep),
           flow_evidence_at = COALESCE(excluded.flow_evidence_at, participation_records.flow_evidence_at),
           state_evidence_at = COALESCE(excluded.state_evidence_at, participation_records.state_evidence_at)`,
      )
      .run(row);
  }

  get(agentId: string): ParticipationRow | undefined {
    return this.db.prepare('SELECT * FROM participation_records WHERE agent_id = ?').get(agentId) as
      | ParticipationRow
      | undefined;
  }

  all(): ParticipationRow[] {
    return this.db
      .prepare('SELECT * FROM participation_records ORDER BY agent_id')
      .all() as ParticipationRow[];
  }

  count(): number {
    return (this.db.prepare('SELECT COUNT(*) AS n FROM participation_records').get() as { n: number })
      .n;
  }

  countByStatus(): Record<string, number> {
    const rows = this.db
      .prepare('SELECT status, COUNT(*) AS n FROM participation_records GROUP BY status')
      .all() as Array<{ status: string; n: number }>;
    return Object.fromEntries(rows.map((row) => [row.status, row.n]));
  }

  countWithReadback(): number {
    return (
      this.db
        .prepare(
          `SELECT COUNT(*) AS n FROM participation_records
            WHERE readback_at IS NOT NULL AND technocore_seq IS NOT NULL`,
        )
        .get() as { n: number }
    ).n;
  }

  /**
   * Registrations posted but never read back.
   *
   * `technocore_seq` is set from the POST's own reply, so a row here is a write
   * the service accepted and the room has not yet echoed. It is the "pending"
   * set an operator watches: a pending registration is not a failure, and it is
   * not evidence of success either.
   */
  pendingReadback(): ParticipationRow[] {
    return this.db
      .prepare(
        `SELECT * FROM participation_records
          WHERE technocore_seq IS NOT NULL AND readback_at IS NULL
          ORDER BY agent_id`,
      )
      .all() as ParticipationRow[];
  }

  /** Readback progress, for the 150/150 gate and the report. */
  readbackProgress(): { completed: number; pending: number; total: number } {
    const row = this.db
      .prepare(
        `SELECT
           SUM(CASE WHEN readback_at IS NOT NULL AND technocore_seq IS NOT NULL THEN 1 ELSE 0 END) AS completed,
           SUM(CASE WHEN readback_at IS NULL THEN 1 ELSE 0 END) AS pending,
           COUNT(*) AS total
         FROM participation_records`,
      )
      .get() as { completed: number | null; pending: number | null; total: number };
    return { completed: row.completed ?? 0, pending: row.pending ?? 0, total: row.total };
  }

  /**
   * Our own posted seqs in a room, so a gap can be checked against them.
   *
   * This is the local half of the coverage question: a band that brackets one of
   * these is a band that provably swallowed one of our own writes.
   */
  localSeqsInRoom(room: string): Array<{ agent_id: string; seq: number }> {
    return this.db
      .prepare(
        `SELECT agent_id, technocore_seq AS seq FROM participation_records
          WHERE room = ? AND technocore_seq IS NOT NULL
          ORDER BY technocore_seq`,
      )
      .all(room) as Array<{ agent_id: string; seq: number }>;
  }

  /** Record that the referee's own evidence mentions a registration. */
  markRefereeEvidence(agentId: string, kind: 'flow' | 'state', at: string): void {
    const column = kind === 'flow' ? 'flow_evidence_at' : 'state_evidence_at';
    this.db
      .prepare(
        `UPDATE participation_records SET ${column} = COALESCE(${column}, @at), updated_at = @at
          WHERE agent_id = @agentId`,
      )
      .run({ agentId, at });
  }

  /** Agents that have no participation row at all. */
  missing(agentIds: string[]): string[] {
    const present = new Set(this.all().map((row) => row.agent_id));
    return agentIds.filter((id) => !present.has(id));
  }

  /** Readback evidence: the raw signed registration record, kept forever. */
  upsertOwnerRegistration(row: {
    agent_id: string;
    did: string;
    season: string;
    registration_text: string;
    registration_nonce: string;
    registration_signature: string;
    room: string;
    technocore_seq: number;
    technocore_ts: string;
    readback_at: string;
    package_hash: string;
    referee_did: string | null;
    raw_record: string;
  }): void {
    this.db
      .prepare(
        `INSERT INTO owner_registrations (
           agent_id, did, season, registration_text, registration_nonce,
           registration_signature, room, technocore_seq, technocore_ts, readback_at,
           package_hash, referee_did, raw_record, created_at)
         VALUES (@agent_id, @did, @season, @registration_text, @registration_nonce,
           @registration_signature, @room, @technocore_seq, @technocore_ts, @readback_at,
           @package_hash, @referee_did, @raw_record, @created_at)
         ON CONFLICT(agent_id) DO NOTHING`,
      )
      .run({ ...row, created_at: nowIso() });
  }

  ownerRegistrationCount(): number {
    return (
      this.db.prepare('SELECT COUNT(*) AS n FROM owner_registrations').get() as { n: number }
    ).n;
  }

  ownerRegistrations(): Array<Record<string, unknown>> {
    return this.db
      .prepare('SELECT * FROM owner_registrations ORDER BY agent_id')
      .all() as Array<Record<string, unknown>>;
  }
}

export interface AgentRunRow {
  id?: number;
  agent_id: string;
  run_at: string;
  rolling_window_start: string;
  strategy_group: string;
  strategy_version: string;
  action: string;
  confidence: string;
  reason: string;
  source: string;
}

export class AgentRunRepository {
  constructor(private readonly db: SqliteDatabase) {}

  insert(row: AgentRunRow): number {
    const info = this.db
      .prepare(
        `INSERT INTO agent_runs (
           agent_id, run_at, rolling_window_start, strategy_group, strategy_version,
           action, confidence, reason, source, created_at)
         VALUES (@agent_id, @run_at, @rolling_window_start, @strategy_group, @strategy_version,
           @action, @confidence, @reason, @source, @created_at)`,
      )
      .run({ ...row, created_at: nowIso() });
    return Number(info.lastInsertRowid);
  }

  countSince(sinceIso: string): number {
    return (
      this.db
        .prepare('SELECT COUNT(*) AS n FROM agent_runs WHERE run_at >= ?')
        .get(sinceIso) as { n: number }
    ).n;
  }

  countForAgentSince(agentId: string, sinceIso: string): number {
    return (
      this.db
        .prepare('SELECT COUNT(*) AS n FROM agent_runs WHERE agent_id = ? AND run_at >= ?')
        .get(agentId, sinceIso) as { n: number }
    ).n;
  }

  distinctAgentsSince(sinceIso: string): string[] {
    return (
      this.db
        .prepare('SELECT DISTINCT agent_id FROM agent_runs WHERE run_at >= ? ORDER BY agent_id')
        .all(sinceIso) as Array<{ agent_id: string }>
    ).map((row) => row.agent_id);
  }

  count(): number {
    return (this.db.prepare('SELECT COUNT(*) AS n FROM agent_runs').get() as { n: number }).n;
  }

  byGroupSince(sinceIso: string): Array<{ strategy_group: string; runs: number; agents: number }> {
    return this.db
      .prepare(
        `SELECT strategy_group, COUNT(*) AS runs, COUNT(DISTINCT agent_id) AS agents
           FROM agent_runs WHERE run_at >= ? GROUP BY strategy_group ORDER BY strategy_group`,
      )
      .all(sinceIso) as Array<{ strategy_group: string; runs: number; agents: number }>;
  }

  lastRunAt(agentId: string): string | null {
    const row = this.db
      .prepare('SELECT run_at FROM agent_runs WHERE agent_id = ? ORDER BY run_at DESC LIMIT 1')
      .get(agentId) as { run_at: string } | undefined;
    return row?.run_at ?? null;
  }
}

export interface DecisionRow {
  agent_id: string;
  run_at: string;
  action: string;
  confidence: string;
  reason: string;
  strategy_group: string;
  strategy_version: string;
  params_version?: string | null;
  sweep?: number | null;
  reference_px?: string | null;
  detail?: string | null;
}

export class DecisionRepository {
  constructor(private readonly db: SqliteDatabase) {}

  insert(row: DecisionRow): number {
    const info = this.db
      .prepare(
        `INSERT INTO decisions (
           agent_id, run_at, action, confidence, reason, strategy_group,
           strategy_version, params_version, sweep, reference_px, detail, created_at)
         VALUES (@agent_id, @run_at, @action, @confidence, @reason, @strategy_group,
           @strategy_version, @params_version, @sweep, @reference_px, @detail, @created_at)`,
      )
      .run({
        ...row,
        params_version: row.params_version ?? null,
        sweep: row.sweep ?? null,
        reference_px: row.reference_px ?? null,
        detail: row.detail ?? null,
        created_at: nowIso(),
      });
    return Number(info.lastInsertRowid);
  }

  countSince(sinceIso: string): number {
    return (
      this.db.prepare('SELECT COUNT(*) AS n FROM decisions WHERE run_at >= ?').get(sinceIso) as {
        n: number;
      }
    ).n;
  }

  countByActionSince(sinceIso: string): Record<string, number> {
    const rows = this.db
      .prepare('SELECT action, COUNT(*) AS n FROM decisions WHERE run_at >= ? GROUP BY action')
      .all(sinceIso) as Array<{ action: string; n: number }>;
    return Object.fromEntries(rows.map((row) => [row.action, row.n]));
  }
}

export interface StrategyVersionRow {
  id: string;
  strategy_group: string;
  version: string;
  params_json: string;
  source: string;
  llm_call_id?: number | null;
  effective_from: string;
  superseded_at?: string | null;
}

export class StrategyVersionRepository {
  constructor(private readonly db: SqliteDatabase) {}

  insert(row: StrategyVersionRow): void {
    this.db
      .prepare(
        `INSERT INTO strategy_versions (
           id, strategy_group, version, params_json, source, llm_call_id,
           effective_from, superseded_at, created_at)
         VALUES (@id, @strategy_group, @version, @params_json, @source, @llm_call_id,
           @effective_from, @superseded_at, @created_at)`,
      )
      .run({
        ...row,
        llm_call_id: row.llm_call_id ?? null,
        superseded_at: row.superseded_at ?? null,
        created_at: nowIso(),
      });
  }

  /** The effective (non-superseded) version for a group, newest first. */
  effective(strategyGroup: string): StrategyVersionRow | undefined {
    return this.db
      .prepare(
        `SELECT * FROM strategy_versions
          WHERE strategy_group = ? AND superseded_at IS NULL
          ORDER BY effective_from DESC, rowid DESC LIMIT 1`,
      )
      .get(strategyGroup) as StrategyVersionRow | undefined;
  }

  supersede(strategyGroup: string, at: string): void {
    this.db
      .prepare(
        'UPDATE strategy_versions SET superseded_at = ? WHERE strategy_group = ? AND superseded_at IS NULL',
      )
      .run(at, strategyGroup);
  }

  history(strategyGroup: string): StrategyVersionRow[] {
    return this.db
      .prepare(
        'SELECT * FROM strategy_versions WHERE strategy_group = ? ORDER BY effective_from DESC',
      )
      .all(strategyGroup) as StrategyVersionRow[];
  }

  count(): number {
    return (this.db.prepare('SELECT COUNT(*) AS n FROM strategy_versions').get() as { n: number }).n;
  }

  /** Audit for the cost report: how many parameter sets came from the model. */
  llmSourcedCount(): number {
    return (
      this.db
        .prepare("SELECT COUNT(*) AS n FROM strategy_versions WHERE source = 'deepseek'")
        .get() as { n: number }
    ).n;
  }
}

export interface ControlProofRow {
  agent_id: string;
  did: string;
  challenge_hash: string;
  signature: string;
  created_at: string;
  verified: number;
  verified_at: string | null;
}

export class ControlProofRepository {
  constructor(private readonly db: SqliteDatabase) {}

  upsert(row: ControlProofRow): void {
    this.db
      .prepare(
        `INSERT INTO control_proofs (agent_id, did, challenge_hash, signature, created_at, verified, verified_at)
         VALUES (@agent_id, @did, @challenge_hash, @signature, @created_at, @verified, @verified_at)
         ON CONFLICT(agent_id) DO UPDATE SET
           did = excluded.did,
           challenge_hash = excluded.challenge_hash,
           signature = excluded.signature,
           created_at = excluded.created_at,
           verified = excluded.verified,
           verified_at = excluded.verified_at`,
      )
      .run(row);
  }

  all(): ControlProofRow[] {
    return this.db
      .prepare('SELECT * FROM control_proofs ORDER BY agent_id')
      .all() as ControlProofRow[];
  }

  countVerified(): number {
    return (
      this.db.prepare('SELECT COUNT(*) AS n FROM control_proofs WHERE verified = 1').get() as {
        n: number;
      }
    ).n;
  }

  count(): number {
    return (this.db.prepare('SELECT COUNT(*) AS n FROM control_proofs').get() as { n: number }).n;
  }
}

/**
 * How a room's history began, as far as this process can tell.
 *
 *   bootstrap_pending    nothing read from this room yet
 *   bootstrap_truncated  first read; the room retained only a suffix of history,
 *                        so the earliest messages were never available to us
 *   ready                read normally
 *   cursor_gap           a gap was detected *after* we held a position: messages
 *                        we should have seen were dropped before we read them
 *   cursor_reset         the room was recreated (generation changed)
 *
 * The states only ever escalate, by this order. `bootstrap_truncated` is a
 * permanent record of how we started and is never overwritten by `ready`; a
 * later real gap escalates it to `cursor_gap`.
 */
export type RoomBootstrapState =
  | 'bootstrap_pending'
  | 'bootstrap_truncated'
  | 'ready'
  | 'cursor_gap'
  | 'cursor_reset';

export interface RoomCursorRow {
  room: string;
  cursor: number;
  generation: number;
  first_seq: number | null;
  last_seq: number | null;
  gap: number;
  room_reset: number;
  consecutive_errors: number;
  last_ok_at: string | null;
  bootstrap_state: RoomBootstrapState;
  first_observed_seq: number | null;
  last_observed_seq: number | null;
  gap_count: number;
  last_gap_from: number | null;
  last_gap_to: number | null;
  bootstrap_at: string | null;
  /** Set once a contiguous read proved the latest gap is behind us; NULL while open. */
  gap_resolved_at: string | null;
  /** The `missedTo` of the most recent gap that was resolved. */
  last_resolved_gap_to: number | null;
  updated_at: string;
}

export class RoomCursorRepository {
  constructor(private readonly db: SqliteDatabase) {}

  get(room: string): RoomCursorRow | undefined {
    return this.db.prepare('SELECT * FROM room_cursors WHERE room = ?').get(room) as
      | RoomCursorRow
      | undefined;
  }

  all(): RoomCursorRow[] {
    return this.db.prepare('SELECT * FROM room_cursors ORDER BY room').all() as RoomCursorRow[];
  }

  ensure(room: string): RoomCursorRow {
    const existing = this.get(room);
    if (existing) return existing;
    const row: RoomCursorRow = {
      room,
      cursor: 0,
      generation: 0,
      first_seq: null,
      last_seq: null,
      gap: 0,
      room_reset: 0,
      consecutive_errors: 0,
      last_ok_at: null,
      bootstrap_state: 'bootstrap_pending',
      first_observed_seq: null,
      last_observed_seq: null,
      gap_count: 0,
      last_gap_from: null,
      last_gap_to: null,
      bootstrap_at: null,
      gap_resolved_at: null,
      last_resolved_gap_to: null,
      updated_at: nowIso(),
    };
    this.db
      .prepare(
        `INSERT INTO room_cursors (room, cursor, generation, first_seq, last_seq, gap,
           room_reset, consecutive_errors, last_ok_at, bootstrap_state, first_observed_seq,
           last_observed_seq, gap_count, last_gap_from, last_gap_to, bootstrap_at,
           gap_resolved_at, last_resolved_gap_to, updated_at)
         VALUES (@room, @cursor, @generation, @first_seq, @last_seq, @gap, @room_reset,
           @consecutive_errors, @last_ok_at, @bootstrap_state, @first_observed_seq,
           @last_observed_seq, @gap_count, @last_gap_from, @last_gap_to, @bootstrap_at,
           @gap_resolved_at, @last_resolved_gap_to, @updated_at)`,
      )
      .run(row);
    return row;
  }

  update(room: string, patch: Partial<Omit<RoomCursorRow, 'room' | 'updated_at'>>): void {
    const current = this.ensure(room);
    const next = { ...current, ...patch };
    this.db
      .prepare(
        `UPDATE room_cursors SET cursor = @cursor, generation = @generation,
           first_seq = @first_seq, last_seq = @last_seq, gap = @gap, room_reset = @room_reset,
           consecutive_errors = @consecutive_errors, last_ok_at = @last_ok_at,
           bootstrap_state = @bootstrap_state, first_observed_seq = @first_observed_seq,
           last_observed_seq = @last_observed_seq, gap_count = @gap_count,
           last_gap_from = @last_gap_from, last_gap_to = @last_gap_to,
           bootstrap_at = @bootstrap_at, gap_resolved_at = @gap_resolved_at,
           last_resolved_gap_to = @last_resolved_gap_to, updated_at = @updated_at
         WHERE room = @room`,
      )
      .run({ ...next, room, updated_at: nowIso() });
  }

  /** Rooms whose bootstrap recorded a truncated history. */
  truncatedRooms(): RoomCursorRow[] {
    return this.db
      .prepare("SELECT * FROM room_cursors WHERE bootstrap_state = 'bootstrap_truncated' ORDER BY room")
      .all() as RoomCursorRow[];
  }

  anyGap(): boolean {
    return (
      this.db.prepare('SELECT COUNT(*) AS n FROM room_cursors WHERE gap > 0').get() as { n: number }
    ).n > 0;
  }

  totalGaps(): number {
    return (
      this.db.prepare('SELECT COALESCE(SUM(gap), 0) AS n FROM room_cursors').get() as { n: number }
    ).n;
  }
}

export interface MessageRow {
  room: string;
  seq: number;
  ts: string;
  sender_did: string | null;
  nonce: string | null;
  sig: string | null;
  text: string;
  kind: string;
  signature_valid: number | null;
  ingested_at: string;
}

export class MessageRepository {
  constructor(private readonly db: SqliteDatabase) {}

  insert(row: MessageRow): boolean {
    const info = this.db
      .prepare(
        `INSERT OR IGNORE INTO messages (
           room, seq, ts, sender_did, nonce, sig, text, kind, signature_valid, ingested_at)
         VALUES (@room, @seq, @ts, @sender_did, @nonce, @sig, @text, @kind, @signature_valid, @ingested_at)`,
      )
      .run(row);
    return info.changes > 0;
  }

  insertMany(rows: MessageRow[]): number {
    // One page of a room can be hundreds of rows. A single statement is already
    // atomic, but the batch must be too: a crash mid-page would otherwise leave
    // a partially ingested page and a cursor that cannot tell where it stopped.
    let inserted = 0;
    const run = this.db.transaction(() => {
      for (const row of rows) if (this.insert(row)) inserted += 1;
    });
    run();
    return inserted;
  }

  count(): number {
    return (this.db.prepare('SELECT COUNT(*) AS n FROM messages').get() as { n: number }).n;
  }

  /** One stored message, used to re-post a local message the referee missed. */
  get(room: string, seq: number): MessageRow | undefined {
    return this.db.prepare('SELECT * FROM messages WHERE room = ? AND seq = ?').get(room, seq) as
      | MessageRow
      | undefined;
  }

  countByKind(): Record<string, number> {
    const rows = this.db
      .prepare('SELECT kind, COUNT(*) AS n FROM messages GROUP BY kind')
      .all() as Array<{ kind: string; n: number }>;
    return Object.fromEntries(rows.map((row) => [row.kind, row.n]));
  }

  /** Records still needed as evidence; the retention policy never touches these. */
  countRegistrationEvidence(): number {
    return (
      this.db
        .prepare("SELECT COUNT(*) AS n FROM messages WHERE kind = 'owner' AND seq IS NOT NULL")
        .get() as { n: number }
    ).n;
  }

  recent(room: string, limit: number): MessageRow[] {
    return this.db
      .prepare('SELECT * FROM messages WHERE room = ? ORDER BY seq DESC LIMIT ?')
      .all(room, limit) as MessageRow[];
  }

  /**
   * Messages of one kind in one room, oldest first.
   *
   * Two callers, both of them evidence-critical and both of them unable to work
   * from the reader's tick summary alone:
   *   - owner-registration readback: our own `{"t":"owner"}` posts, by seq, so
   *     the participation record can cite the exact seq and timestamp the room
   *     echoed back;
   *   - open external offers in the trading room, which the strategy layer needs
   *     and which are cheap to re-read from the local mirror rather than held in
   *     memory for the life of the process.
   */
  byKind(room: string, kind: string, sinceSeq = 0, limit = 2000): MessageRow[] {
    return this.db
      .prepare(
        'SELECT * FROM messages WHERE room = ? AND kind = ? AND seq > ? ORDER BY seq ASC LIMIT ?',
      )
      .all(room, kind, sinceSeq, limit) as MessageRow[];
  }

  /**
   * Messages of one room inside an inclusive seq range, oldest first.
   *
   * This exists for one question only: does a recorded loss band contain
   * anything of *ours*. `limit` is required to be small because a mid-run gap
   * can span millions of seqs, and the answer has to be cheap enough to ask on
   * every report.
   */
  inRange(room: string, from: number, to: number, limit = 1): MessageRow[] {
    if (to < from) return [];
    return this.db
      .prepare('SELECT * FROM messages WHERE room = ? AND seq BETWEEN ? AND ? ORDER BY seq ASC LIMIT ?')
      .all(room, from, to, limit) as MessageRow[];
  }

  /**
   * The oldest seq in one room sent by any of `dids`, or null if none is stored.
   *
   * This is the sound half of "can this loss band contain one of ours". Our own
   * posts are strictly ordered by seq, so if the whole band sits *below* the
   * oldest post of ours we have ever read back, no post of ours can be inside it.
   * Nothing weaker than that is proof: an unread post could sit anywhere.
   */
  earliestSeqFromSenders(room: string, dids: string[]): number | null {
    if (dids.length === 0) return null;
    const placeholders = dids.map(() => '?').join(',');
    const row = this.db
      .prepare(
        `SELECT MIN(seq) AS seq FROM messages WHERE room = ? AND sender_did IN (${placeholders})`,
      )
      .get(room, ...dids) as { seq: number | null } | undefined;
    return row?.seq ?? null;
  }

  /**
   * The newest message of one kind in a room.
   *
   * `signedOnly` restricts it to rows whose room signature verified, which is
   * what the dynamic room ranking means by "has a recent signed trade" — an
   * unsigned claim in an owner room is not evidence of anything.
   */
  lastOfKind(room: string, kind: string, signedOnly = false): MessageRow | undefined {
    const sql = signedOnly
      ? `SELECT * FROM messages WHERE room = ? AND kind = ? AND signature_valid = 1
          ORDER BY seq DESC LIMIT 1`
      : 'SELECT * FROM messages WHERE room = ? AND kind = ? ORDER BY seq DESC LIMIT 1';
    return this.db.prepare(sql).get(room, kind) as MessageRow | undefined;
  }
}

export interface RefereeSnapshotRow {
  room: string;
  seq: number;
  sweep: number | null;
  kind: string;
  payload: string;
  ref_px: string | null;
  limits_low: string | null;
  limits_high: string | null;
  package_hash: string | null;
  referee_did: string;
  signature_valid: number;
  created_at: string;
}

export class RefereeRepository {
  constructor(private readonly db: SqliteDatabase) {}

  insertSnapshot(row: RefereeSnapshotRow): boolean {
    const info = this.db
      .prepare(
        `INSERT OR IGNORE INTO referee_snapshots (
           room, seq, sweep, kind, payload, ref_px, limits_low, limits_high,
           package_hash, referee_did, signature_valid, created_at)
         VALUES (@room, @seq, @sweep, @kind, @payload, @ref_px, @limits_low, @limits_high,
           @package_hash, @referee_did, @signature_valid, @created_at)`,
      )
      .run(row);
    return info.changes > 0;
  }

  latestPrice(): RefereeSnapshotRow | undefined {
    return this.db
      .prepare(
        `SELECT * FROM referee_snapshots WHERE kind = 'price' AND signature_valid = 1
          ORDER BY sweep DESC, seq DESC LIMIT 1`,
      )
      .get() as RefereeSnapshotRow | undefined;
  }

  latestFlow(): RefereeSnapshotRow | undefined {
    return this.db
      .prepare(
        `SELECT * FROM referee_snapshots WHERE kind = 'flow' AND signature_valid = 1
          ORDER BY sweep DESC, seq DESC LIMIT 1`,
      )
      .get() as RefereeSnapshotRow | undefined;
  }

  latestSeed(): RefereeSnapshotRow | undefined {
    return this.db
      .prepare(
        `SELECT * FROM referee_snapshots WHERE kind = 'seed' AND signature_valid = 1
          ORDER BY seq ASC LIMIT 1`,
      )
      .get() as RefereeSnapshotRow | undefined;
  }

  latestFinal(): RefereeSnapshotRow | undefined {
    return this.db
      .prepare(
        `SELECT * FROM referee_snapshots WHERE kind = 'final' AND signature_valid = 1
          ORDER BY seq DESC LIMIT 1`,
      )
      .get() as RefereeSnapshotRow | undefined;
  }

  snapshotsSince(kind: string, sweep: number): RefereeSnapshotRow[] {
    return this.db
      .prepare(
        `SELECT * FROM referee_snapshots WHERE kind = ? AND sweep >= ? ORDER BY sweep ASC, seq ASC`,
      )
      .all(kind, sweep) as RefereeSnapshotRow[];
  }

  /**
   * The signature-valid price/flow rows for one sweep.
   *
   * Used to recover the `file` hash the referee signed for that sweep, which is
   * what makes a `full` archive record a second copy of a signed post rather
   * than an unchecked download.
   */
  signedForSweep(sweep: number): RefereeSnapshotRow[] {
    return this.db
      .prepare(
        `SELECT * FROM referee_snapshots
          WHERE sweep = ? AND signature_valid = 1 AND kind IN ('price', 'flow')
          ORDER BY seq ASC`,
      )
      .all(sweep) as RefereeSnapshotRow[];
  }

  /**
   * Signature-validated snapshots in the order the verifier must replay them.
   *
   * The seed fixes the season, the package and the referee's baseline, so it has
   * to come first; `final` last; everything else by sweep and seq. Only rows that
   * verified when they were ingested are returned — a row we rejected is not
   * evidence and must not be replayed as if it were.
   */
  orderedForReplay(limit = 5000): RefereeSnapshotRow[] {
    return this.db
      .prepare(
        `SELECT * FROM referee_snapshots
          WHERE signature_valid = 1
          ORDER BY CASE kind WHEN 'seed' THEN 0 WHEN 'final' THEN 2 ELSE 1 END ASC,
                   COALESCE(sweep, 0) ASC,
                   seq ASC
          LIMIT ?`,
      )
      .all(limit) as RefereeSnapshotRow[];
  }

  count(): number {
    return (this.db.prepare('SELECT COUNT(*) AS n FROM referee_snapshots').get() as { n: number }).n;
  }

  countSignatureInvalid(): number {
    return (
      this.db
        .prepare('SELECT COUNT(*) AS n FROM referee_snapshots WHERE signature_valid = 0')
        .get() as { n: number }
    ).n;
  }

  getSweepState(): SweepStateRow | undefined {
    return this.db.prepare('SELECT * FROM sweep_state WHERE id = 1').get() as SweepStateRow | undefined;
  }

  setSweepState(patch: Partial<Omit<SweepStateRow, 'id' | 'updated_at'>>): void {
    const current = this.getSweepState();
    const next: SweepStateRow = {
      id: 1,
      current_sweep: patch.current_sweep ?? current?.current_sweep ?? null,
      reference_px: patch.reference_px ?? current?.reference_px ?? null,
      limit_low: patch.limit_low ?? current?.limit_low ?? null,
      limit_high: patch.limit_high ?? current?.limit_high ?? null,
      global_px: patch.global_px ?? current?.global_px ?? null,
      age_seconds: patch.age_seconds ?? current?.age_seconds ?? null,
      package_hash: patch.package_hash ?? current?.package_hash ?? null,
      referee_did: patch.referee_did ?? current?.referee_did ?? null,
      final_px: patch.final_px ?? current?.final_px ?? null,
      lock_seen: patch.lock_seen ?? current?.lock_seen ?? 0,
      conservative_mode: patch.conservative_mode ?? current?.conservative_mode ?? 0,
      conservative_reason: patch.conservative_reason ?? current?.conservative_reason ?? null,
      updated_at: nowIso(),
    };
    this.db
      .prepare(
        `INSERT OR REPLACE INTO sweep_state (
           id, current_sweep, reference_px, limit_low, limit_high, global_px, age_seconds,
           package_hash, referee_did, final_px, lock_seen, conservative_mode,
           conservative_reason, updated_at)
         VALUES (1, @current_sweep, @reference_px, @limit_low, @limit_high, @global_px, @age_seconds,
           @package_hash, @referee_did, @final_px, @lock_seen, @conservative_mode,
           @conservative_reason, @updated_at)`,
      )
      .run(next);
  }
}

export interface SweepStateRow {
  id: number;
  current_sweep: number | null;
  reference_px: string | null;
  limit_low: string | null;
  limit_high: string | null;
  global_px: string | null;
  age_seconds: number | null;
  package_hash: string | null;
  referee_did: string | null;
  final_px: string | null;
  lock_seen: number;
  conservative_mode: number;
  conservative_reason: string | null;
  updated_at: string;
}

export interface TradeRow {
  id: string;
  season: string;
  maker_did: string;
  taker_did: string | null;
  side: string;
  qty: string;
  px: string;
  until_sweep: number;
  maker_sig: string;
  taker_sig: string | null;
  status: string;
  reason?: string | null;
  room?: string | null;
  seq?: number | null;
  agent_id?: string | null;
  counter_agent_id?: string | null;
  settle_sweep?: number | null;
  /** The sweep this trade was proposed at, so "posted in sweep N" is answerable. */
  posted_sweep?: number | null;
  /**
   * The referee's own reason for a void, when it named one.
   *
   * `funds` is the only one that is ambiguous — the referee does not say *which*
   * side was short — so this is paired with `referee_funds_side`, which is always
   * `unknown` for a referee `funds` verdict.
   */
  referee_reason?: string | null;
  /** The referee's side, which for `funds` is `unknown`. Never a local guess. */
  referee_funds_side?: string | null;
  /** Our own inference: `maker` | `taker` | `both` | `unknown`. Not a verdict. */
  local_funds_side?: string | null;
  /** `official` when the values came from the referee; `local_inference` otherwise. */
  funds_side_confidence?: string | null;
  created_at?: string;
  updated_at?: string;
}

export class TradeRepository {
  constructor(private readonly db: SqliteDatabase) {}

  /** Returns false when the id was already recorded (first copy wins). */
  insert(row: TradeRow): boolean {
    const at = nowIso();
    const info = this.db
      .prepare(
        `INSERT OR IGNORE INTO trades (
           id, season, maker_did, taker_did, side, qty, px, until_sweep, maker_sig, taker_sig,
           status, reason, room, seq, agent_id, counter_agent_id, settle_sweep, posted_sweep,
           referee_reason, referee_funds_side, local_funds_side, funds_side_confidence,
           created_at, updated_at)
         VALUES (@id, @season, @maker_did, @taker_did, @side, @qty, @px, @until_sweep,
           @maker_sig, @taker_sig, @status, @reason, @room, @seq, @agent_id, @counter_agent_id,
           @settle_sweep, @posted_sweep, @referee_reason, @referee_funds_side, @local_funds_side,
           @funds_side_confidence, @created_at, @updated_at)`,
      )
      .run({
        ...row,
        taker_did: row.taker_did ?? null,
        taker_sig: row.taker_sig ?? null,
        reason: row.reason ?? null,
        room: row.room ?? null,
        seq: row.seq ?? null,
        agent_id: row.agent_id ?? null,
        counter_agent_id: row.counter_agent_id ?? null,
        settle_sweep: row.settle_sweep ?? null,
        posted_sweep: row.posted_sweep ?? null,
        referee_reason: row.referee_reason ?? null,
        referee_funds_side: row.referee_funds_side ?? null,
        local_funds_side: row.local_funds_side ?? null,
        funds_side_confidence: row.funds_side_confidence ?? null,
        created_at: row.created_at ?? at,
        updated_at: at,
      });
    return info.changes > 0;
  }

  exists(id: string): boolean {
    return this.db.prepare('SELECT 1 FROM trades WHERE id = ?').get(id) !== undefined;
  }

  get(id: string): TradeRow | undefined {
    return this.db.prepare('SELECT * FROM trades WHERE id = ?').get(id) as TradeRow | undefined;
  }

  /**
   * Move a trade's status, and optionally record the referee's verdict.
   *
   * `patch.refereeReason`/`refereeFundsSide` are write-once: the referee is the
   * authority, so a later local pass cannot overwrite `official` with a guess.
   */
  updateStatus(
    id: string,
    status: string,
    reason: string | null,
    settleSweep?: number,
    patch: {
      refereeReason?: string | null;
      refereeFundsSide?: string | null;
    } = {},
  ): void {
    this.db
      .prepare(
        `UPDATE trades SET status = ?, reason = ?, settle_sweep = COALESCE(?, settle_sweep),
           referee_reason = COALESCE(?, referee_reason),
           referee_funds_side = COALESCE(?, referee_funds_side),
           updated_at = ? WHERE id = ?`,
      )
      .run(
        status,
        reason,
        settleSweep ?? null,
        patch.refereeReason ?? null,
        patch.refereeFundsSide ?? null,
        nowIso(),
        id,
      );
  }

  /** Record the referee's verdict without touching the local status. */
  recordRefereeVerdict(
    id: string,
    verdict: { reason: string; fundsSide?: string | null; settleSweep?: number | null },
  ): boolean {
    if (!this.exists(id)) return false;
    const officialFundsSide =
      verdict.reason === 'funds' ? (verdict.fundsSide ?? 'unknown') : (verdict.fundsSide ?? null);
    // `funds_side_confidence` is `official` whenever the referee named a reason:
    // the reason is the referee's own conclusion, even when the side is unknown.
    this.db
      .prepare(
        `UPDATE trades SET referee_reason = ?, referee_funds_side = ?,
           funds_side_confidence = 'official',
           settle_sweep = COALESCE(?, settle_sweep), updated_at = ? WHERE id = ?`,
      )
      .run(verdict.reason, officialFundsSide, verdict.settleSweep ?? null, nowIso(), id);
    return true;
  }

  /**
   * Store the local funds-side inference.
   *
   * Refuses to touch a row whose `funds_side_confidence` is already `official`:
   * the referee's `unknown` is the answer, and a local guess must never overwrite
   * it. When the row has no official verdict yet, the inference is recorded with
   * `local_inference` so the report can label it correctly.
   */
  setLocalFundsSide(id: string, side: 'maker' | 'taker' | 'both' | 'unknown'): void {
    const row = this.get(id);
    if (!row) return;
    if (row.funds_side_confidence === 'official') return;
    this.db
      .prepare(
        `UPDATE trades SET local_funds_side = ?, funds_side_confidence = 'local_inference',
           updated_at = ? WHERE id = ?`,
      )
      .run(side, nowIso(), id);
  }

  countByStatus(): Record<string, number> {
    const rows = this.db
      .prepare('SELECT status, COUNT(*) AS n FROM trades GROUP BY status')
      .all() as Array<{ status: string; n: number }>;
    return Object.fromEntries(rows.map((row) => [row.status, row.n]));
  }

  /** Trades the referee voided for `funds`, with the official side `unknown`. */
  fundsVerdicts(): TradeRow[] {
    return this.db
      .prepare("SELECT * FROM trades WHERE referee_reason = 'funds' ORDER BY id")
      .all() as TradeRow[];
  }

  /** Official reason labels, for the report. */
  refereeReasonCounts(): Record<string, number> {
    const rows = this.db
      .prepare(
        `SELECT referee_reason AS reason, COUNT(*) AS n FROM trades
          WHERE referee_reason IS NOT NULL GROUP BY referee_reason`,
      )
      .all() as Array<{ reason: string; n: number }>;
    return Object.fromEntries(rows.map((row) => [row.reason, row.n]));
  }

  /**
   * Trades carrying our own funds-side inference, and none from the referee.
   *
   * The count the report needs to say "local inference, not a referee
   * conclusion": a row the referee has ruled on is `official` and excluded.
   */
  countLocalInference(): number {
    return (
      this.db
        .prepare(
          `SELECT COUNT(*) AS n FROM trades
            WHERE local_funds_side IS NOT NULL AND (funds_side_confidence IS NULL
              OR funds_side_confidence = 'local_inference')`,
        )
        .get() as { n: number }
    ).n;
  }


  /**
   * How many trades were proposed at each of two sweeps of interest.
   *
   * `inSweep` is the current sweep; `afterLock` is everything proposed past the
   * lock sweep, which the lock gate should hold at zero. Both are counted from
   * `posted_sweep`, the sweep the trade was written at.
   */
  sweepCounts(currentSweep: number | null, lockSweep: number): { inSweep: number; afterLock: number } {
    const inSweep =
      currentSweep === null
        ? 0
        : (this.db
            .prepare('SELECT COUNT(*) AS n FROM trades WHERE posted_sweep = ?')
            .get(currentSweep) as { n: number }).n;
    const afterLock = (
      this.db
        .prepare('SELECT COUNT(*) AS n FROM trades WHERE posted_sweep > ?')
        .get(lockSweep) as { n: number }
    ).n;
    return { inSweep, afterLock };
  }

  count(): number {
    return (this.db.prepare('SELECT COUNT(*) AS n FROM trades').get() as { n: number }).n;
  }

  openForAgent(agentId: string): TradeRow[] {
    return this.db
      .prepare("SELECT * FROM trades WHERE agent_id = ? AND status = 'pending'")
      .all(agentId) as TradeRow[];
  }

  /**
   * Trade ids the referee has already settled (or voided).
   *
   * Feeds `TradeValidationContext.settledIds`, where a duplicate id is refused:
   * re-posting a settled trade is the one way a local ledger and the referee's
   * could disagree about how much was paid.
   */
  settledIds(): string[] {
    return (
      this.db
        .prepare("SELECT id FROM trades WHERE status IN ('settled','void')")
        .all() as Array<{ id: string }>
    ).map((row) => row.id);
  }
}

export interface LlmCallRow {
  called_at: string;
  day: string;
  purpose: string;
  model: string;
  status: string;
  retry_of?: number | null;
  window_ok: number;
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
  latency_ms?: number;
  accepted?: number;
  error?: string | null;
  params_version?: string | null;
}

export class LlmCallRepository {
  constructor(private readonly db: SqliteDatabase) {}

  insert(row: LlmCallRow): number {
    const info = this.db
      .prepare(
        `INSERT INTO llm_calls (
           called_at, day, purpose, model, status, retry_of, window_ok,
           prompt_tokens, completion_tokens, total_tokens, latency_ms, accepted, error,
           params_version, created_at)
         VALUES (@called_at, @day, @purpose, @model, @status, @retry_of, @window_ok,
           @prompt_tokens, @completion_tokens, @total_tokens, @latency_ms, @accepted, @error,
           @params_version, @created_at)`,
      )
      .run({
        ...row,
        retry_of: row.retry_of ?? null,
        prompt_tokens: row.prompt_tokens ?? 0,
        completion_tokens: row.completion_tokens ?? 0,
        total_tokens: row.total_tokens ?? 0,
        latency_ms: row.latency_ms ?? 0,
        accepted: row.accepted ?? 0,
        error: row.error ?? null,
        params_version: row.params_version ?? null,
        created_at: nowIso(),
      });
    return Number(info.lastInsertRowid);
  }

  /**
   * Every row ever written, whether it reached the model or was only blocked /
   * planned. Used by tests and the cost report to prove that a window in which
   * no call should happen really wrote nothing at all.
   */
  count(): number {
    return (this.db.prepare('SELECT COUNT(*) AS n FROM llm_calls').get() as { n: number }).n;
  }

  /** Calls that actually reached the model (success or an HTTP attempt). */
  countDay(day: string): number {
    return (
      this.db
        .prepare(
          `SELECT COUNT(*) AS n FROM llm_calls
            WHERE day = ? AND status IN ('ok', 'failed', 'timeout', 'invalid')`,
        )
        .get(day) as { n: number }
    ).n;
  }

  countDayNormal(day: string): number {
    return (
      this.db
        .prepare(
          `SELECT COUNT(*) AS n FROM llm_calls
            WHERE day = ? AND status IN ('ok', 'failed', 'timeout', 'invalid') AND retry_of IS NULL`,
        )
        .get(day) as { n: number }
    ).n;
  }

  countDayRetries(day: string): number {
    return (
      this.db
        .prepare("SELECT COUNT(*) AS n FROM llm_calls WHERE day = ? AND retry_of IS NOT NULL")
        .get(day) as { n: number }
    ).n;
  }

  countDayBlocked(day: string): number {
    return (
      this.db
        .prepare("SELECT COUNT(*) AS n FROM llm_calls WHERE day = ? AND status = 'blocked'")
        .get(day) as { n: number }
    ).n;
  }

  tokensDay(day: string): { prompt: number; completion: number; total: number } {
    const row = this.db
      .prepare(
        `SELECT COALESCE(SUM(prompt_tokens),0) AS prompt,
                COALESCE(SUM(completion_tokens),0) AS completion,
                COALESCE(SUM(total_tokens),0) AS total
           FROM llm_calls WHERE day = ?`,
      )
      .get(day) as { prompt: number; completion: number; total: number };
    return row;
  }

  /** Latest call per purpose, for cost-report. */
  history(days: number): Array<Record<string, unknown>> {
    return this.db
      .prepare('SELECT * FROM llm_calls ORDER BY id DESC LIMIT ?')
      .all(days * 16) as Array<Record<string, unknown>>;
  }

  distinctDays(): string[] {
    return (
      this.db.prepare('SELECT DISTINCT day FROM llm_calls ORDER BY day').all() as Array<{
        day: string;
      }>
    ).map((row) => row.day);
  }
}

export type OutboxStatus = 'pending' | 'sending' | 'sent' | 'failed';

export interface LarkOutboxRow {
  id?: number;
  report_id: string;
  kind: string;
  payload: string;
  status: OutboxStatus;
  attempts: number;
  created_at?: string;
  sent_at?: string | null;
  last_error?: string | null;
}

export class LarkOutboxRepository {
  constructor(private readonly db: SqliteDatabase) {}

  /** INSERT OR IGNORE on the unique report_id is the duplicate-report guard. */
  enqueue(row: { report_id: string; kind: string; payload: string }): boolean {
    const info = this.db
      .prepare(
        `INSERT OR IGNORE INTO lark_outbox (report_id, kind, payload, status, attempts, created_at)
         VALUES (?, ?, ?, 'pending', 0, ?)`,
      )
      .run(row.report_id, row.kind, row.payload, nowIso());
    return info.changes > 0;
  }

  markSending(id: number): boolean {
    return (
      this.db
        .prepare("UPDATE lark_outbox SET status = 'sending', attempts = attempts + 1 WHERE id = ? AND status IN ('pending','failed')")
        .run(id).changes > 0
    );
  }

  markSent(id: number): void {
    this.db
      .prepare("UPDATE lark_outbox SET status = 'sent', sent_at = ?, last_error = NULL WHERE id = ?")
      .run(nowIso(), id);
  }

  markFailed(id: number, error: string): void {
    this.db
      .prepare("UPDATE lark_outbox SET status = 'failed', last_error = ? WHERE id = ?")
      .run(error, id);
  }

  /** Requeue rows left mid-flight by a crash. */
  requeueStale(maxAttempts: number): number {
    return this.db
      .prepare(
        `UPDATE lark_outbox SET status = 'pending'
          WHERE status = 'sending' AND attempts < ?`,
      )
      .run(maxAttempts).changes;
  }

  pending(limit: number): LarkOutboxRow[] {
    return this.db
      .prepare(
        `SELECT * FROM lark_outbox WHERE status IN ('pending','failed') AND attempts < 12
          ORDER BY id ASC LIMIT ?`,
      )
      .all(limit) as LarkOutboxRow[];
  }

  get(id: number): LarkOutboxRow | undefined {
    return this.db.prepare('SELECT * FROM lark_outbox WHERE id = ?').get(id) as
      | LarkOutboxRow
      | undefined;
  }

  byReportId(reportId: string): LarkOutboxRow | undefined {
    return this.db.prepare('SELECT * FROM lark_outbox WHERE report_id = ?').get(reportId) as
      | LarkOutboxRow
      | undefined;
  }

  countByStatus(): Record<string, number> {
    const rows = this.db
      .prepare('SELECT status, COUNT(*) AS n FROM lark_outbox GROUP BY status')
      .all() as Array<{ status: string; n: number }>;
    return Object.fromEntries(rows.map((row) => [row.status, row.n]));
  }

  sentCountSince(sinceIso: string): number {
    return (
      this.db
        .prepare("SELECT COUNT(*) AS n FROM lark_outbox WHERE status = 'sent' AND sent_at >= ?")
        .get(sinceIso) as { n: number }
    ).n;
  }
}

export interface UpstreamEventRow {
  checked_at: string;
  commit_sha: string | null;
  commit_message: string | null;
  changed_files: string | null;
  release: string | null;
  manifest_hash: string | null;
  contest_hash: string | null;
  game_hash: string | null;
  fold_hash: string | null;
  etag: string | null;
  not_modified: number;
  drift: number;
  drift_detail: string | null;
}

export class UpstreamRepository {
  constructor(private readonly db: SqliteDatabase) {}

  insert(row: UpstreamEventRow): number {
    const info = this.db
      .prepare(
        `INSERT INTO upstream_events (
           checked_at, commit_sha, commit_message, changed_files, release, manifest_hash,
           contest_hash, game_hash, fold_hash, etag, not_modified, drift, drift_detail, created_at)
         VALUES (@checked_at, @commit_sha, @commit_message, @changed_files, @release, @manifest_hash,
           @contest_hash, @game_hash, @fold_hash, @etag, @not_modified, @drift, @drift_detail, @created_at)`,
      )
      .run({ ...row, created_at: nowIso() });
    return Number(info.lastInsertRowid);
  }

  latest(): UpstreamEventRow | undefined {
    return this.db
      .prepare('SELECT * FROM upstream_events ORDER BY id DESC LIMIT 1')
      .get() as UpstreamEventRow | undefined;
  }

  latestWithCommit(): UpstreamEventRow | undefined {
    return this.db
      .prepare('SELECT * FROM upstream_events WHERE commit_sha IS NOT NULL ORDER BY id DESC LIMIT 1')
      .get() as UpstreamEventRow | undefined;
  }

  countSince(sinceIso: string): number {
    return (
      this.db.prepare('SELECT COUNT(*) AS n FROM upstream_events WHERE checked_at >= ?').get(sinceIso) as {
        n: number;
      }
    ).n;
  }

  driftCount(): number {
    return (
      this.db.prepare('SELECT COUNT(*) AS n FROM upstream_events WHERE drift = 1').get() as {
        n: number;
      }
    ).n;
  }

  getPin(): PackagePinRow | undefined {
    return this.db.prepare('SELECT * FROM package_pins WHERE id = 1').get() as
      | PackagePinRow
      | undefined;
  }

  setPin(row: Omit<PackagePinRow, 'id' | 'updated_at'>): void {
    this.db
      .prepare(
        `INSERT OR REPLACE INTO package_pins (
           id, season, expected_package_hash, observed_package_hash, referee_did,
           pinned_at, drift, drift_detail, updated_at)
         VALUES (1, @season, @expected_package_hash, @observed_package_hash, @referee_did,
           @pinned_at, @drift, @drift_detail, @updated_at)`,
      )
      .run({ ...row, updated_at: nowIso() });
  }
}

export interface PackagePinRow {
  id: number;
  season: string;
  expected_package_hash: string | null;
  observed_package_hash: string | null;
  referee_did: string | null;
  pinned_at: string;
  drift: number;
  drift_detail: string | null;
  updated_at: string;
}

export class ArchiveManifestRepository {
  constructor(private readonly db: SqliteDatabase) {}

  record(row: {
    path: string;
    sha256: string;
    bytes: number;
    files: number;
    kind: string;
    created_at?: string;
  }): number {
    const info = this.db
      .prepare(
        `INSERT OR REPLACE INTO archive_manifests (created_at, path, sha256, bytes, files, kind, verified)
         VALUES (?, ?, ?, ?, ?, ?, 0)`,
      )
      .run(row.created_at ?? nowIso(), row.path, row.sha256, row.bytes, row.files, row.kind);
    return Number(info.lastInsertRowid);
  }

  markVerified(path: string, verified: boolean, externalBackupPath: string | null): void {
    this.db
      .prepare(
        'UPDATE archive_manifests SET verified = ?, verified_at = ?, external_backup_path = ? WHERE path = ?',
      )
      .run(verified ? 1 : 0, nowIso(), externalBackupPath, path);
  }

  markDeleted(path: string): void {
    this.db
      .prepare('UPDATE archive_manifests SET deleted_at = ? WHERE path = ?')
      .run(nowIso(), path);
  }

  unverified(): Array<Record<string, unknown>> {
    return this.db
      .prepare('SELECT * FROM archive_manifests WHERE verified = 0 AND deleted_at IS NULL')
      .all() as Array<Record<string, unknown>>;
  }

  get(path: string): Record<string, unknown> | undefined {
    return this.db.prepare('SELECT * FROM archive_manifests WHERE path = ?').get(path) as
      | Record<string, unknown>
      | undefined;
  }

  totalBytes(): number {
    return (
      this.db
        .prepare(
          'SELECT COALESCE(SUM(bytes), 0) AS n FROM archive_manifests WHERE deleted_at IS NULL',
        )
        .get() as { n: number }
    ).n;
  }

  count(): number {
    return (this.db.prepare('SELECT COUNT(*) AS n FROM archive_manifests').get() as { n: number }).n;
  }
}

export interface EventRow {
  at: string;
  level: string;
  source: string;
  code: string;
  message: string;
  data?: string | null;
}

export class EventRepository {
  constructor(private readonly db: SqliteDatabase) {}

  insert(row: EventRow): number {
    const info = this.db
      .prepare(
        `INSERT INTO events (at, level, source, code, message, data, created_at)
         VALUES (@at, @level, @source, @code, @message, @data, @created_at)`,
      )
      .run({ ...row, data: row.data ?? null, created_at: nowIso() });
    return Number(info.lastInsertRowid);
  }

  countSince(sinceIso: string, level?: string): number {
    if (level) {
      return (
        this.db
          .prepare('SELECT COUNT(*) AS n FROM events WHERE at >= ? AND level = ?')
          .get(sinceIso, level) as { n: number }
      ).n;
    }
    return (
      this.db.prepare('SELECT COUNT(*) AS n FROM events WHERE at >= ?').get(sinceIso) as {
        n: number;
      }
    ).n;
  }

  recent(limit: number): Array<Record<string, unknown>> {
    return this.db
      .prepare('SELECT * FROM events ORDER BY id DESC LIMIT ?')
      .all(limit) as Array<Record<string, unknown>>;
  }

  errorCount(): number {
    return (
      this.db.prepare("SELECT COUNT(*) AS n FROM events WHERE level = 'error'").get() as {
        n: number;
      }
    ).n;
  }

  /** Delete non-evidence diagnostics older than `cutoff`. Returns rows removed. */
  pruneOlderThan(cutoffIso: string, keepCodes: string[]): number {
    const placeholders = keepCodes.map(() => '?').join(',');
    const sql = keepCodes.length
      ? `DELETE FROM events WHERE at < ? AND code NOT IN (${placeholders})`
      : 'DELETE FROM events WHERE at < ?';
    return this.db.prepare(sql).run(cutoffIso, ...keepCodes).changes;
  }

  insertCommand(row: {
    received_at: string;
    source: string;
    command: string;
    payload: string | null;
    status: string;
    result: string | null;
  }): number {
    const info = this.db
      .prepare(
        `INSERT INTO control_commands (received_at, source, command, payload, status, result)
         VALUES (@received_at, @source, @command, @payload, @status, @result)`,
      )
      .run(row);
    return Number(info.lastInsertRowid);
  }
}

export type RuntimeEventSeverity = 'critical' | 'warning';
export type RuntimeEventLarkStatus = 'none' | 'pending' | 'sent' | 'failed';

export interface RuntimeEventRow {
  id?: number;
  /** Deterministic per occurrence, so the same event is never alerted twice. */
  event_id: string;
  severity: RuntimeEventSeverity;
  code: string;
  message: string;
  sweep: number | null;
  agent_id: string | null;
  created_at?: string;
  lark_status?: RuntimeEventLarkStatus;
  sent_at?: string | null;
  retry_count?: number;
}

/**
 * The runtime event trail that feeds the Lark alerts.
 *
 * The durable outbox owns retry and dedupe for the *message*; this table owns
 * the *event*: whether it happened, and whether the operator was told. `record`
 * is idempotent on `event_id`, so a restart that re-observes the same condition
 * neither duplicates the row nor re-alerts.
 */
export class RuntimeEventRepository {
  constructor(private readonly db: SqliteDatabase) {}

  /** Returns false when this event_id was already recorded. */
  record(row: RuntimeEventRow): boolean {
    const info = this.db
      .prepare(
        `INSERT OR IGNORE INTO runtime_events
           (event_id, severity, code, message, sweep, agent_id, created_at, lark_status, retry_count)
         VALUES (@event_id, @severity, @code, @message, @sweep, @agent_id, @created_at, @lark_status, 0)`,
      )
      .run({
        ...row,
        sweep: row.sweep ?? null,
        agent_id: row.agent_id ?? null,
        created_at: row.created_at ?? nowIso(),
        lark_status: row.lark_status ?? 'none',
      });
    return info.changes > 0;
  }

  /**
   * Mirror the outbox's outcome onto the event row.
   *
   * `retryCount` is the outbox row's own attempt count, so the two stay in step
   * rather than being counted twice from different places.
   */
  markLarkStatus(
    eventId: string,
    status: RuntimeEventLarkStatus,
    retryCount: number | null = null,
  ): void {
    this.db
      .prepare(
        `UPDATE runtime_events
            SET lark_status = ?,
                sent_at = CASE WHEN ? = 'sent' THEN ? ELSE sent_at END,
                retry_count = COALESCE(?, retry_count)
          WHERE event_id = ?`,
      )
      .run(status, status, nowIso(), retryCount, eventId);
  }

  /** Rows whose alert has not yet been confirmed as sent. */
  unsettled(limit: number): RuntimeEventRow[] {
    return this.db
      .prepare(
        `SELECT * FROM runtime_events
          WHERE lark_status IN ('pending','failed')
          ORDER BY id ASC LIMIT ?`,
      )
      .all(limit) as RuntimeEventRow[];
  }

  countBySeverity(): Record<string, number> {
    const rows = this.db
      .prepare('SELECT severity, COUNT(*) AS n FROM runtime_events GROUP BY severity')
      .all() as Array<{ severity: string; n: number }>;
    return Object.fromEntries(rows.map((row) => [row.severity, row.n]));
  }

  countByCode(code: string): number {
    return (
      this.db.prepare('SELECT COUNT(*) AS n FROM runtime_events WHERE code = ?').get(code) as {
        n: number;
      }
    ).n;
  }

  /** How the alerts fared: none / pending / sent / failed. */
  countByLarkStatus(): Record<string, number> {
    const rows = this.db
      .prepare('SELECT lark_status, COUNT(*) AS n FROM runtime_events GROUP BY lark_status')
      .all() as Array<{ lark_status: string; n: number }>;
    return Object.fromEntries(rows.map((row) => [row.lark_status, row.n]));
  }

  count(): number {
    return (
      this.db.prepare('SELECT COUNT(*) AS n FROM runtime_events').get() as { n: number }
    ).n;
  }

  recent(limit: number): RuntimeEventRow[] {
    return this.db
      .prepare('SELECT * FROM runtime_events ORDER BY id DESC LIMIT ?')
      .all(limit) as RuntimeEventRow[];
  }
}

/**
 * The room listing the referee maintains (rule 5, as the live service applies it).
 *
 * `close1` never leaves the list, so its row is written once and never unlisted.
 * A dynamically discovered owner room is listed while it carries activity and
 * unlisted 12 sweeps after the last one — read back from the flow post's
 * `unlisted` list rather than guessed from silence.
 */
export interface RoomRegistryRow {
  room: string;
  listed: number;
  last_activity_sweep: number | null;
  unlisted_at: string | null;
  last_seen_at: string | null;
  source: string;
  updated_at: string;
}

export class RoomRegistryRepository {
  constructor(private readonly db: SqliteDatabase) {}

  upsert(row: {
    room: string;
    listed: boolean;
    lastActivitySweep?: number | null;
    unlistedAt?: string | null;
    lastSeenAt?: string | null;
    source: string;
  }): void {
    this.db
      .prepare(
        `INSERT INTO room_registry
           (room, listed, last_activity_sweep, unlisted_at, last_seen_at, source, updated_at)
         VALUES (@room, @listed, @lastActivitySweep, @unlistedAt, @lastSeenAt, @source, @updated_at)
         ON CONFLICT(room) DO UPDATE SET
           listed = excluded.listed,
           last_activity_sweep = COALESCE(excluded.last_activity_sweep, room_registry.last_activity_sweep),
           unlisted_at = excluded.unlisted_at,
           last_seen_at = excluded.last_seen_at,
           source = excluded.source,
           updated_at = excluded.updated_at`,
      )
      .run({
        room: row.room,
        listed: row.listed ? 1 : 0,
        lastActivitySweep: row.lastActivitySweep ?? null,
        unlistedAt: row.unlistedAt ?? null,
        lastSeenAt: row.lastSeenAt ?? null,
        source: row.source,
        updated_at: nowIso(),
      });
  }

  markUnlisted(room: string, at: string): void {
    this.db
      .prepare('UPDATE room_registry SET listed = 0, unlisted_at = ?, updated_at = ? WHERE room = ?')
      .run(at, nowIso(), room);
  }

  get(room: string): RoomRegistryRow | undefined {
    return this.db.prepare('SELECT * FROM room_registry WHERE room = ?').get(room) as
      | RoomRegistryRow
      | undefined;
  }

  listListed(): RoomRegistryRow[] {
    return this.db
      .prepare('SELECT * FROM room_registry WHERE listed = 1 ORDER BY room ASC')
      .all() as RoomRegistryRow[];
  }

  count(): number {
    return (this.db.prepare('SELECT COUNT(*) AS n FROM room_registry').get() as { n: number }).n;
  }
}

/**
 * Everything the referee's flow post says it could not deliver.
 *
 * `omitted` (a list was cut for length), `missed` (messages it never read) and
 * `unlisted` (rooms it stopped reading) are all recorded, never inferred. The
 * distinction that matters operationally is that none of them is a failure: a
 * gap in our record is a gap, not a verdict, and the archive is what fills it.
 */
export interface RefereeAnomalyRow {
  id: number;
  sweep: number | null;
  room: string | null;
  kind: string;
  raw_payload: string | null;
  affected_count: number;
  created_at: string;
}

export class RefereeAnomalyRepository {
  constructor(private readonly db: SqliteDatabase) {}

  record(row: {
    sweep: number | null;
    room: string | null;
    kind: string;
    rawPayload?: unknown;
    affectedCount?: number;
  }): number {
    const info = this.db
      .prepare(
        `INSERT INTO referee_anomalies (sweep, room, kind, raw_payload, affected_count, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        row.sweep,
        row.room,
        row.kind,
        row.rawPayload === undefined ? null : JSON.stringify(row.rawPayload),
        row.affectedCount ?? 0,
        nowIso(),
      );
    return Number(info.lastInsertRowid);
  }

  byKind(kind: string): RefereeAnomalyRow[] {
    return this.db
      .prepare('SELECT * FROM referee_anomalies WHERE kind = ? ORDER BY id ASC')
      .all(kind) as RefereeAnomalyRow[];
  }

  /** The rooms a given anomaly kind named, for the dynamic room ranking. */
  roomsWithKind(kind: string): Set<string> {
    const rows = this.db
      .prepare(
        'SELECT DISTINCT room FROM referee_anomalies WHERE kind = ? AND room IS NOT NULL',
      )
      .all(kind) as Array<{ room: string }>;
    return new Set(rows.map((row) => row.room));
  }

  count(): number {
    return (this.db.prepare('SELECT COUNT(*) AS n FROM referee_anomalies').get() as { n: number }).n;
  }
}

/**
 * One sweep of the published archive, as the monitor found it.
 *
 * The three outcomes are kept apart on purpose: `verified` (bytes matched the
 * index, and for a `full` record the referee's signed hash), `unavailable` (a
 * 404 — the archive is behind, which is not a contest failure) and a mismatch
 * (`verified = 0` with an `error`). Nothing here can mark a mint failed.
 */
export interface ArchiveSweepRow {
  sweep: number;
  status: string;
  path: string | null;
  expected_sha256: string | null;
  /** The size `index.json` advertised, so a re-published entry is detectable. */
  expected_size?: number | null;
  actual_sha256: string | null;
  verified: number;
  redacted_trades: number | null;
  fetched_at: string | null;
  unavailable: number;
  error: string | null;
  updated_at?: string;
}

export class ArchiveSweepRepository {
  constructor(private readonly db: SqliteDatabase) {}

  upsert(row: ArchiveSweepRow): void {
    this.db
      .prepare(
        `INSERT INTO archive_sweeps (
           sweep, status, path, expected_sha256, expected_size, actual_sha256, verified,
           redacted_trades, fetched_at, unavailable, error, updated_at)
         VALUES (@sweep, @status, @path, @expected_sha256, @expected_size, @actual_sha256, @verified,
           @redacted_trades, @fetched_at, @unavailable, @error, @updated_at)
         ON CONFLICT(sweep) DO UPDATE SET
           status = excluded.status,
           path = excluded.path,
           expected_sha256 = excluded.expected_sha256,
           expected_size = excluded.expected_size,
           actual_sha256 = excluded.actual_sha256,
           verified = excluded.verified,
           redacted_trades = excluded.redacted_trades,
           fetched_at = excluded.fetched_at,
           unavailable = excluded.unavailable,
           error = excluded.error,
           updated_at = excluded.updated_at`,
      )
      .run({
        ...row,
        path: row.path ?? null,
        expected_sha256: row.expected_sha256 ?? null,
        expected_size: row.expected_size ?? null,
        actual_sha256: row.actual_sha256 ?? null,
        redacted_trades: row.redacted_trades ?? null,
        fetched_at: row.fetched_at ?? null,
        error: row.error ?? null,
        updated_at: nowIso(),
      });
  }

  get(sweep: number): ArchiveSweepRow | undefined {
    return this.db.prepare('SELECT * FROM archive_sweeps WHERE sweep = ?').get(sweep) as
      | ArchiveSweepRow
      | undefined;
  }

  all(): ArchiveSweepRow[] {
    return this.db.prepare('SELECT * FROM archive_sweeps ORDER BY sweep ASC').all() as ArchiveSweepRow[];
  }

  /** Sweeps the index named but the archive has not served (a 404). */
  unavailableSweeps(): number[] {
    return (
      this.db
        .prepare('SELECT sweep FROM archive_sweeps WHERE unavailable = 1 ORDER BY sweep ASC')
        .all() as Array<{ sweep: number }>
    ).map((row) => row.sweep);
  }

  /** Sweeps whose bytes did not hash to what was claimed: a finding, not a gap. */
  mismatchedSweeps(): number[] {
    return (
      this.db
        .prepare(
          'SELECT sweep FROM archive_sweeps WHERE unavailable = 0 AND verified = 0 ORDER BY sweep ASC',
        )
        .all() as Array<{ sweep: number }>
    ).map((row) => row.sweep);
  }

  countByStatus(): Record<string, number> {
    const rows = this.db
      .prepare('SELECT status, COUNT(*) AS n FROM archive_sweeps GROUP BY status')
      .all() as Array<{ status: string; n: number }>;
    return Object.fromEntries(rows.map((row) => [row.status, row.n]));
  }

  verifiedCount(): number {
    return (
      this.db.prepare('SELECT COUNT(*) AS n FROM archive_sweeps WHERE verified = 1').get() as {
        n: number;
      }
    ).n;
  }

  /**
   * How many of the sweeps the index names are still not verified.
   *
   * Scoped to the index we just read, so a sweep the archive has since dropped
   * from its listing does not inflate the backlog.
   */
  pendingCount(knownSweeps: number[]): number {
    if (knownSweeps.length === 0) return 0;
    const verified = new Set(
      (
        this.db.prepare('SELECT sweep FROM archive_sweeps WHERE verified = 1').all() as Array<{
          sweep: number;
        }>
      ).map((row) => row.sweep),
    );
    return knownSweeps.filter((sweep) => !verified.has(sweep)).length;
  }

  maxVerifiedSweep(): number | null {
    const row = this.db
      .prepare('SELECT MAX(sweep) AS sweep FROM archive_sweeps WHERE verified = 1')
      .get() as { sweep: number | null };
    return row.sweep;
  }

  count(): number {
    return (this.db.prepare('SELECT COUNT(*) AS n FROM archive_sweeps').get() as { n: number }).n;
  }
}

export interface ArchiveStateRow {
  id: number;
  latest_index_sweep: number | null;
  latest_verified_sweep: number | null;
  lag_sweeps: number | null;
  pending_count: number;
  unavailable_count: number;
  mismatch_count: number;
  bytes_this_check: number;
  bytes_today: number;
  bytes_today_day: string | null;
  last_check_at: string | null;
  last_error: string | null;
  updated_at: string;
}

export class ArchiveStateRepository {
  constructor(private readonly db: SqliteDatabase) {}

  get(): ArchiveStateRow | undefined {
    return this.db.prepare('SELECT * FROM archive_state WHERE id = 1').get() as
      | ArchiveStateRow
      | undefined;
  }

  set(patch: {
    latestIndexSweep: number | null;
    latestVerifiedSweep: number | null;
    lagSweeps: number | null;
    pendingCount?: number;
    unavailableCount?: number;
    mismatchCount?: number;
    bytesThisCheck?: number;
    bytesToday?: number;
    bytesTodayDay?: string | null;
    lastCheckAt: string | null;
    lastError: string | null;
  }): void {
    this.db
      .prepare(
        `INSERT OR REPLACE INTO archive_state (
           id, latest_index_sweep, latest_verified_sweep, lag_sweeps, pending_count,
           unavailable_count, mismatch_count, bytes_this_check, bytes_today, bytes_today_day,
           last_check_at, last_error, updated_at)
         VALUES (1, @latestIndexSweep, @latestVerifiedSweep, @lagSweeps, @pendingCount,
           @unavailableCount, @mismatchCount, @bytesThisCheck, @bytesToday, @bytesTodayDay,
           @lastCheckAt, @lastError, @updated_at)`,
      )
      .run({
        pendingCount: patch.pendingCount ?? 0,
        unavailableCount: patch.unavailableCount ?? 0,
        mismatchCount: patch.mismatchCount ?? 0,
        bytesThisCheck: patch.bytesThisCheck ?? 0,
        bytesToday: patch.bytesToday ?? 0,
        bytesTodayDay: patch.bytesTodayDay ?? null,
        ...patch,
        updated_at: nowIso(),
      });
  }
}

/**
 * A local message the referee reported as `missed`, and the re-post of it.
 *
 * `missed` means the referee never read the message, so it does not count. The
 * queue is the audit trail: one row per original message, at most one re-post,
 * carrying the same business content under a new outer nonce.
 */
export type RepostStatus = 'pending' | 'posted' | 'failed' | 'skipped';

export interface RepostRow {
  id?: number;
  original_room: string;
  original_seq: number;
  agent_id: string;
  did: string;
  message_kind: string;
  trade_id: string | null;
  original_text: string;
  reason: string | null;
  status: RepostStatus;
  attempts: number;
  new_room: string | null;
  new_nonce: string | null;
  new_seq: number | null;
  created_at?: string;
  updated_at?: string;
}

export class RepostRepository {
  constructor(private readonly db: SqliteDatabase) {}

  /** The unique key (room, seq, did) makes a re-queue after a restart a no-op. */
  enqueue(
    row: Omit<RepostRow, 'id' | 'attempts' | 'status' | 'new_room' | 'new_nonce' | 'new_seq'> & {
      status?: RepostStatus;
      new_room?: string | null;
      new_nonce?: string | null;
      new_seq?: number | null;
    },
  ): boolean {
    const info = this.db
      .prepare(
        `INSERT OR IGNORE INTO repost_queue (
           original_room, original_seq, agent_id, did, message_kind, trade_id, original_text,
           reason, status, attempts, new_room, new_nonce, new_seq, created_at, updated_at)
         VALUES (@original_room, @original_seq, @agent_id, @did, @message_kind, @trade_id,
           @original_text, @reason, @status, 0, @new_room, @new_nonce, @new_seq, @created_at, @updated_at)`,
      )
      .run({
        ...row,
        trade_id: row.trade_id ?? null,
        reason: row.reason ?? null,
        status: row.status ?? 'pending',
        new_room: row.new_room ?? null,
        new_nonce: row.new_nonce ?? null,
        new_seq: row.new_seq ?? null,
        created_at: row.created_at ?? nowIso(),
        updated_at: nowIso(),
      });
    return info.changes > 0;
  }

  /** Rows already handled for a given original message. */
  has(originalRoom: string, originalSeq: number, did: string): boolean {
    return (
      this.db
        .prepare(
          'SELECT 1 FROM repost_queue WHERE original_room = ? AND original_seq = ? AND did = ?',
        )
        .get(originalRoom, originalSeq, did) !== undefined
    );
  }

  pending(limit = 20): RepostRow[] {
    return this.db
      .prepare("SELECT * FROM repost_queue WHERE status = 'pending' ORDER BY id ASC LIMIT ?")
      .all(limit) as RepostRow[];
  }

  /**
   * Rows to attempt on this pass: never-attempted, plus bounded retries.
   *
   * A failure is retried a fixed number of times and then left as `failed` for
   * the report. There is no unbounded retry loop: a message the service keeps
   * refusing must not become a permanent write every tick.
   */
  retryable(limit = 20, maxAttempts = 3): RepostRow[] {
    return this.db
      .prepare(
        `SELECT * FROM repost_queue WHERE status IN ('pending','failed') AND attempts < ?
          ORDER BY id ASC LIMIT ?`,
      )
      .all(maxAttempts, limit) as RepostRow[];
  }

  all(): RepostRow[] {
    return this.db.prepare('SELECT * FROM repost_queue ORDER BY id ASC').all() as RepostRow[];
  }

  markPosted(
    id: number,
    result: { newRoom: string; newNonce: string; newSeq: number | null },
  ): void {
    this.db
      .prepare(
        `UPDATE repost_queue SET status = 'posted', attempts = attempts + 1, new_room = ?,
           new_nonce = ?, new_seq = ?, updated_at = ? WHERE id = ?`,
      )
      .run(result.newRoom, result.newNonce, result.newSeq, nowIso(), id);
  }

  markFailed(id: number, error: string): void {
    this.db
      .prepare(
        `UPDATE repost_queue SET status = 'failed', attempts = attempts + 1, reason = ?,
           updated_at = ? WHERE id = ?`,
      )
      .run(error, nowIso(), id);
  }

  /** Terminal, and deliberately not retried: e.g. the lock has passed. */
  markSkipped(id: number, reason: string): void {
    this.db
      .prepare(
        `UPDATE repost_queue SET status = 'skipped', reason = ?, updated_at = ? WHERE id = ?`,
      )
      .run(reason, nowIso(), id);
  }

  countByStatus(): Record<string, number> {
    const rows = this.db
      .prepare('SELECT status, COUNT(*) AS n FROM repost_queue GROUP BY status')
      .all() as Array<{ status: string; n: number }>;
    return Object.fromEntries(rows.map((row) => [row.status, row.n]));
  }

  count(): number {
    return (this.db.prepare('SELECT COUNT(*) AS n FROM repost_queue').get() as { n: number }).n;
  }
}

export interface Repositories {
  /**
   * Run `work` inside one SQLite transaction.
   *
   * Exposed so callers that write several tables as one logical event — a run
   * (`agent_runs` + `decisions` + `identities`), a page ingest, the identity
   * seed — can be atomic without reaching for the database handle. Nested calls
   * become savepoints, so composing two of these is safe.
   */
  transaction<T>(work: () => T): T;
  meta: MetaRepository;
  identities: IdentityRepository;
  nonces: NonceRepository;
  participation: ParticipationRepository;
  agentRuns: AgentRunRepository;
  decisions: DecisionRepository;
  strategyVersions: StrategyVersionRepository;
  controlProofs: ControlProofRepository;
  roomCursors: RoomCursorRepository;
  messages: MessageRepository;
  referee: RefereeRepository;
  trades: TradeRepository;
  llmCalls: LlmCallRepository;
  larkOutbox: LarkOutboxRepository;
  upstream: UpstreamRepository;
  archiveManifests: ArchiveManifestRepository;
  archiveSweeps: ArchiveSweepRepository;
  archiveState: ArchiveStateRepository;
  reposts: RepostRepository;
  roomRegistry: RoomRegistryRepository;
  refereeAnomalies: RefereeAnomalyRepository;
  events: EventRepository;
  runtimeEvents: RuntimeEventRepository;
}

export function createRepositories(db: SqliteDatabase): Repositories {
  return {
    transaction: (work) => db.transaction(work)(),
    meta: new MetaRepository(db),
    identities: new IdentityRepository(db),
    nonces: new NonceRepository(db),
    participation: new ParticipationRepository(db),
    agentRuns: new AgentRunRepository(db),
    decisions: new DecisionRepository(db),
    strategyVersions: new StrategyVersionRepository(db),
    controlProofs: new ControlProofRepository(db),
    roomCursors: new RoomCursorRepository(db),
    messages: new MessageRepository(db),
    referee: new RefereeRepository(db),
    trades: new TradeRepository(db),
    llmCalls: new LlmCallRepository(db),
    larkOutbox: new LarkOutboxRepository(db),
    upstream: new UpstreamRepository(db),
    archiveManifests: new ArchiveManifestRepository(db),
    archiveSweeps: new ArchiveSweepRepository(db),
    archiveState: new ArchiveStateRepository(db),
    reposts: new RepostRepository(db),
    roomRegistry: new RoomRegistryRepository(db),
    refereeAnomalies: new RefereeAnomalyRepository(db),
    events: new EventRepository(db),
    runtimeEvents: new RuntimeEventRepository(db),
  };
}
