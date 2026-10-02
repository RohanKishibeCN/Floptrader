/**
 * Schema migrations, applied in order inside one transaction each.
 *
 * Every table an operator needs to reconstruct the contest record is permanent
 * by policy (see retention.ts). Nothing here is dropped by a downgrade: an older
 * binary refuses to start against a newer schema rather than mangling it.
 */
import type { SqliteDatabase } from './database.js';

export interface Migration {
  version: number;
  name: string;
  statements: string[];
}

export const MIGRATIONS: Migration[] = [
  {
    version: 1,
    name: 'core-close-call-schema',
    statements: [
      `CREATE TABLE IF NOT EXISTS meta (
         key TEXT PRIMARY KEY,
         value TEXT NOT NULL,
         updated_at TEXT NOT NULL
       )`,

      // ---- identity & participation ----------------------------------------
      `CREATE TABLE IF NOT EXISTS identities (
         agent_id TEXT PRIMARY KEY,
         did TEXT NOT NULL UNIQUE,
         public_key_multibase TEXT NOT NULL,
         fingerprint TEXT NOT NULL,
         strategy_group TEXT NOT NULL,
         season TEXT NOT NULL,
         risk_tier TEXT NOT NULL,
         random_seed INTEGER NOT NULL,
         max_qty TEXT NOT NULL,
         max_open_notional TEXT NOT NULL,
         cooldown_sweeps INTEGER NOT NULL,
         confidence_threshold TEXT NOT NULL,
         strategy_version TEXT NOT NULL,
         last_run_at TEXT,
         last_run_week TEXT,
         enabled INTEGER NOT NULL DEFAULT 1,
         created_at TEXT NOT NULL,
         updated_at TEXT NOT NULL
       )`,
      `CREATE INDEX IF NOT EXISTS idx_identities_group ON identities(strategy_group)`,
      `CREATE INDEX IF NOT EXISTS idx_identities_last_run ON identities(last_run_at)`,

      `CREATE TABLE IF NOT EXISTS nonces (
         did TEXT NOT NULL,
         room TEXT NOT NULL,
         nonce TEXT NOT NULL,
         updated_at TEXT NOT NULL,
         PRIMARY KEY (did, room)
       )`,

      `CREATE TABLE IF NOT EXISTS participation_records (
         agent_id TEXT PRIMARY KEY REFERENCES identities(agent_id) ON DELETE RESTRICT,
         did TEXT NOT NULL,
         season TEXT NOT NULL,
         registration_text TEXT NOT NULL,
         registration_nonce TEXT NOT NULL,
         registration_signature TEXT NOT NULL,
         room TEXT NOT NULL,
         technocore_seq INTEGER,
         technocore_ts TEXT,
         posted_at TEXT,
         readback_at TEXT,
         package_hash TEXT NOT NULL,
         referee_did TEXT,
         status TEXT NOT NULL,
         attempts INTEGER NOT NULL DEFAULT 0,
         last_error TEXT,
         updated_at TEXT NOT NULL
       )`,
      `CREATE INDEX IF NOT EXISTS idx_participation_status ON participation_records(status)`,

      `CREATE TABLE IF NOT EXISTS owner_registrations (
         agent_id TEXT PRIMARY KEY REFERENCES identities(agent_id) ON DELETE RESTRICT,
         did TEXT NOT NULL,
         season TEXT NOT NULL,
         registration_text TEXT NOT NULL,
         registration_nonce TEXT NOT NULL,
         registration_signature TEXT NOT NULL,
         room TEXT NOT NULL,
         technocore_seq INTEGER NOT NULL,
         technocore_ts TEXT NOT NULL,
         readback_at TEXT NOT NULL,
         package_hash TEXT NOT NULL,
         referee_did TEXT,
         raw_record TEXT NOT NULL,
         created_at TEXT NOT NULL
       )`,

      `CREATE TABLE IF NOT EXISTS control_proofs (
         agent_id TEXT PRIMARY KEY REFERENCES identities(agent_id) ON DELETE RESTRICT,
         did TEXT NOT NULL,
         challenge_hash TEXT NOT NULL,
         signature TEXT NOT NULL,
         created_at TEXT NOT NULL,
         verified INTEGER NOT NULL DEFAULT 0,
         verified_at TEXT
       )`,

      // ---- runs & strategy --------------------------------------------------
      `CREATE TABLE IF NOT EXISTS agent_runs (
         id INTEGER PRIMARY KEY AUTOINCREMENT,
         agent_id TEXT NOT NULL,
         run_at TEXT NOT NULL,
         rolling_window_start TEXT NOT NULL,
         strategy_group TEXT NOT NULL,
         strategy_version TEXT NOT NULL,
         action TEXT NOT NULL,
         confidence TEXT NOT NULL,
         reason TEXT NOT NULL,
         source TEXT NOT NULL,
         created_at TEXT NOT NULL
       )`,
      `CREATE INDEX IF NOT EXISTS idx_agent_runs_agent ON agent_runs(agent_id, run_at)`,
      `CREATE INDEX IF NOT EXISTS idx_agent_runs_at ON agent_runs(run_at)`,

      `CREATE TABLE IF NOT EXISTS decisions (
         id INTEGER PRIMARY KEY AUTOINCREMENT,
         agent_id TEXT NOT NULL,
         run_at TEXT NOT NULL,
         action TEXT NOT NULL,
         confidence TEXT NOT NULL,
         reason TEXT NOT NULL,
         strategy_group TEXT NOT NULL,
         strategy_version TEXT NOT NULL,
         params_version TEXT,
         sweep INTEGER,
         reference_px TEXT,
         detail TEXT,
         created_at TEXT NOT NULL
       )`,
      `CREATE INDEX IF NOT EXISTS idx_decisions_agent ON decisions(agent_id, run_at)`,

      `CREATE TABLE IF NOT EXISTS strategy_versions (
         id TEXT PRIMARY KEY,
         strategy_group TEXT NOT NULL,
         version TEXT NOT NULL,
         params_json TEXT NOT NULL,
         source TEXT NOT NULL,
         llm_call_id INTEGER,
         effective_from TEXT NOT NULL,
         superseded_at TEXT,
         created_at TEXT NOT NULL
       )`,
      `CREATE INDEX IF NOT EXISTS idx_strategy_versions_group ON strategy_versions(strategy_group, effective_from)`,

      // ---- rooms, messages, referee ---------------------------------------
      `CREATE TABLE IF NOT EXISTS room_cursors (
         room TEXT PRIMARY KEY,
         cursor INTEGER NOT NULL DEFAULT 0,
         generation INTEGER NOT NULL DEFAULT 0,
         first_seq INTEGER,
         last_seq INTEGER,
         gap INTEGER NOT NULL DEFAULT 0,
         room_reset INTEGER NOT NULL DEFAULT 0,
         consecutive_errors INTEGER NOT NULL DEFAULT 0,
         last_ok_at TEXT,
         updated_at TEXT NOT NULL
       )`,

      `CREATE TABLE IF NOT EXISTS messages (
         room TEXT NOT NULL,
         seq INTEGER NOT NULL,
         ts TEXT NOT NULL,
         sender_did TEXT,
         nonce TEXT,
         sig TEXT,
         text TEXT NOT NULL,
         kind TEXT NOT NULL,
         signature_valid INTEGER,
         ingested_at TEXT NOT NULL,
         PRIMARY KEY (room, seq)
       )`,
      `CREATE INDEX IF NOT EXISTS idx_messages_kind ON messages(kind, room, seq)`,
      `CREATE INDEX IF NOT EXISTS idx_messages_sender ON messages(sender_did)`,

      `CREATE TABLE IF NOT EXISTS referee_snapshots (
         room TEXT NOT NULL,
         seq INTEGER NOT NULL,
         sweep INTEGER,
         kind TEXT NOT NULL,
         payload TEXT NOT NULL,
         ref_px TEXT,
         limits_low TEXT,
         limits_high TEXT,
         package_hash TEXT,
         referee_did TEXT NOT NULL,
         signature_valid INTEGER NOT NULL,
         created_at TEXT NOT NULL,
         PRIMARY KEY (room, seq)
       )`,
      `CREATE INDEX IF NOT EXISTS idx_referee_snapshots_kind ON referee_snapshots(kind, sweep)`,

      `CREATE TABLE IF NOT EXISTS sweep_state (
         id INTEGER PRIMARY KEY CHECK (id = 1),
         current_sweep INTEGER,
         reference_px TEXT,
         limit_low TEXT,
         limit_high TEXT,
         global_px TEXT,
         age_seconds INTEGER,
         package_hash TEXT,
         referee_did TEXT,
         final_px TEXT,
         lock_seen INTEGER NOT NULL DEFAULT 0,
         conservative_mode INTEGER NOT NULL DEFAULT 0,
         conservative_reason TEXT,
         updated_at TEXT NOT NULL
       )`,

      // ---- trades ----------------------------------------------------------
      `CREATE TABLE IF NOT EXISTS trades (
         id TEXT PRIMARY KEY,
         season TEXT NOT NULL,
         maker_did TEXT NOT NULL,
         taker_did TEXT,
         side TEXT NOT NULL,
         qty TEXT NOT NULL,
         px TEXT NOT NULL,
         until_sweep INTEGER NOT NULL,
         maker_sig TEXT NOT NULL,
         taker_sig TEXT,
         status TEXT NOT NULL,
         reason TEXT,
         room TEXT,
         seq INTEGER,
         agent_id TEXT,
         counter_agent_id TEXT,
         settle_sweep INTEGER,
         created_at TEXT NOT NULL,
         updated_at TEXT NOT NULL
       )`,
      `CREATE INDEX IF NOT EXISTS idx_trades_status ON trades(status)`,
      `CREATE INDEX IF NOT EXISTS idx_trades_maker ON trades(maker_did)`,

      // ---- llm -------------------------------------------------------------
      `CREATE TABLE IF NOT EXISTS llm_calls (
         id INTEGER PRIMARY KEY AUTOINCREMENT,
         called_at TEXT NOT NULL,
         day TEXT NOT NULL,
         purpose TEXT NOT NULL,
         model TEXT NOT NULL,
         status TEXT NOT NULL,
         retry_of INTEGER,
         window_ok INTEGER NOT NULL,
         prompt_tokens INTEGER NOT NULL DEFAULT 0,
         completion_tokens INTEGER NOT NULL DEFAULT 0,
         total_tokens INTEGER NOT NULL DEFAULT 0,
         latency_ms INTEGER NOT NULL DEFAULT 0,
         accepted INTEGER NOT NULL DEFAULT 0,
         error TEXT,
         params_version TEXT,
         created_at TEXT NOT NULL
       )`,
      `CREATE INDEX IF NOT EXISTS idx_llm_calls_day ON llm_calls(day, status)`,

      // ---- lark ------------------------------------------------------------
      `CREATE TABLE IF NOT EXISTS lark_outbox (
         id INTEGER PRIMARY KEY AUTOINCREMENT,
         report_id TEXT NOT NULL UNIQUE,
         kind TEXT NOT NULL,
         payload TEXT NOT NULL,
         status TEXT NOT NULL,
         attempts INTEGER NOT NULL DEFAULT 0,
         created_at TEXT NOT NULL,
         sent_at TEXT,
         last_error TEXT
       )`,
      `CREATE INDEX IF NOT EXISTS idx_lark_outbox_status ON lark_outbox(status, id)`,

      // ---- upstream --------------------------------------------------------
      `CREATE TABLE IF NOT EXISTS upstream_events (
         id INTEGER PRIMARY KEY AUTOINCREMENT,
         checked_at TEXT NOT NULL,
         commit_sha TEXT,
         commit_message TEXT,
         changed_files TEXT,
         release TEXT,
         manifest_hash TEXT,
         contest_hash TEXT,
         game_hash TEXT,
         fold_hash TEXT,
         etag TEXT,
         not_modified INTEGER NOT NULL DEFAULT 0,
         drift INTEGER NOT NULL DEFAULT 0,
         drift_detail TEXT,
         created_at TEXT NOT NULL
       )`,
      `CREATE INDEX IF NOT EXISTS idx_upstream_events_at ON upstream_events(checked_at)`,

      `CREATE TABLE IF NOT EXISTS package_pins (
         id INTEGER PRIMARY KEY CHECK (id = 1),
         season TEXT NOT NULL,
         expected_package_hash TEXT,
         observed_package_hash TEXT,
         referee_did TEXT,
         pinned_at TEXT NOT NULL,
         drift INTEGER NOT NULL DEFAULT 0,
         drift_detail TEXT,
         updated_at TEXT NOT NULL
       )`,

      // ---- archives & events ----------------------------------------------
      `CREATE TABLE IF NOT EXISTS archive_manifests (
         id INTEGER PRIMARY KEY AUTOINCREMENT,
         created_at TEXT NOT NULL,
         path TEXT NOT NULL UNIQUE,
         sha256 TEXT NOT NULL,
         bytes INTEGER NOT NULL,
         files INTEGER NOT NULL,
         kind TEXT NOT NULL,
         verified INTEGER NOT NULL DEFAULT 0,
         verified_at TEXT,
         external_backup_path TEXT,
         deleted_at TEXT
       )`,

      `CREATE TABLE IF NOT EXISTS events (
         id INTEGER PRIMARY KEY AUTOINCREMENT,
         at TEXT NOT NULL,
         level TEXT NOT NULL,
         source TEXT NOT NULL,
         code TEXT NOT NULL,
         message TEXT NOT NULL,
         data TEXT,
         created_at TEXT NOT NULL
       )`,
      `CREATE INDEX IF NOT EXISTS idx_events_at ON events(at)`,
      `CREATE INDEX IF NOT EXISTS idx_events_code ON events(code)`,

      `CREATE TABLE IF NOT EXISTS control_commands (
         id INTEGER PRIMARY KEY AUTOINCREMENT,
         received_at TEXT NOT NULL,
         source TEXT NOT NULL,
         command TEXT NOT NULL,
         payload TEXT,
         status TEXT NOT NULL,
         result TEXT
       )`,
    ],
  },
  {
    version: 2,
    name: 'room-registry-anomalies-and-funds-side',
    statements: [
      // ---- room listing (rule 5, as the live referee applies it) ----------
      // A room is listed at the sweep that registers it, kept while owners post
      // activity into it, and taken off the list 12 sweeps after the last such
      // activity. `close1` never leaves the list. Offers and chatter are not
      // activity, so they never extend a room's life here either.
      `CREATE TABLE IF NOT EXISTS room_registry (
         room TEXT PRIMARY KEY,
         listed INTEGER NOT NULL DEFAULT 1,
         last_activity_sweep INTEGER,
         unlisted_at TEXT,
         last_seen_at TEXT,
         source TEXT NOT NULL,
         updated_at TEXT NOT NULL
       )`,
      `CREATE INDEX IF NOT EXISTS idx_room_registry_listed ON room_registry(listed, last_activity_sweep)`,

      // ---- referee anomalies: omitted, missed, unlisted --------------------
      // `omitted` counts entries a flow post could not fit; `missed` names
      // messages the referee never read; `unlisted` names rooms it stopped
      // reading. None of the three is a failure, so they are recorded rather
      // than inferred from an absence.
      `CREATE TABLE IF NOT EXISTS referee_anomalies (
         id INTEGER PRIMARY KEY AUTOINCREMENT,
         sweep INTEGER,
         room TEXT,
         kind TEXT NOT NULL,
         raw_payload TEXT,
         affected_count INTEGER NOT NULL DEFAULT 0,
         created_at TEXT NOT NULL
       )`,
      `CREATE INDEX IF NOT EXISTS idx_referee_anomalies_kind ON referee_anomalies(kind, sweep)`,

      // ---- funds side: the referee names a reason, never a side ------------
      `ALTER TABLE trades ADD COLUMN referee_reason TEXT`,
      `ALTER TABLE trades ADD COLUMN referee_funds_side TEXT`,
      `ALTER TABLE trades ADD COLUMN local_funds_side TEXT`,
      `ALTER TABLE trades ADD COLUMN funds_side_confidence TEXT`,
    ],
  },
  {
    version: 3,
    name: 'challenge-archive-and-repost-queue',
    statements: [
      // ---- the published sweep archive, per sweep --------------------------
      // One row per sweep the archive's `index.json` names. `verified` means the
      // downloaded bytes hashed to what the index claimed (and, for a `full`
      // record, to the hash the referee's signed post pinned). `unavailable`
      // records a 404 as a data gap: never a failure, never a mint verdict.
      `CREATE TABLE IF NOT EXISTS archive_sweeps (
         sweep INTEGER PRIMARY KEY,
         status TEXT NOT NULL,
         path TEXT,
         expected_sha256 TEXT,
         actual_sha256 TEXT,
         verified INTEGER NOT NULL DEFAULT 0,
         redacted_trades INTEGER,
         fetched_at TEXT,
         unavailable INTEGER NOT NULL DEFAULT 0,
         error TEXT,
         updated_at TEXT NOT NULL
       )`,
      `CREATE INDEX IF NOT EXISTS idx_archive_sweeps_verified ON archive_sweeps(verified, status)`,
      `CREATE INDEX IF NOT EXISTS idx_archive_sweeps_unavailable ON archive_sweeps(unavailable)`,

      // ---- the archive monitor's singleton state ---------------------------
      `CREATE TABLE IF NOT EXISTS archive_state (
         id INTEGER PRIMARY KEY CHECK (id = 1),
         latest_index_sweep INTEGER,
         latest_verified_sweep INTEGER,
         lag_sweeps INTEGER,
         last_check_at TEXT,
         last_error TEXT,
         updated_at TEXT NOT NULL
       )`,

      // ---- the missed-message repost queue ---------------------------------
      // One row per local message the referee reported as `missed`. A re-post is
      // the *same business content* re-wrapped in a fresh outer nonce and
      // signature; the unique key is the original (room, seq, did), so a message
      // can never be queued twice — across restarts included.
      `CREATE TABLE IF NOT EXISTS repost_queue (
         id INTEGER PRIMARY KEY AUTOINCREMENT,
         original_room TEXT NOT NULL,
         original_seq INTEGER NOT NULL,
         agent_id TEXT NOT NULL,
         did TEXT NOT NULL,
         message_kind TEXT NOT NULL,
         trade_id TEXT,
         original_text TEXT NOT NULL,
         reason TEXT,
         status TEXT NOT NULL,
         attempts INTEGER NOT NULL DEFAULT 0,
         new_room TEXT,
         new_nonce TEXT,
         new_seq INTEGER,
         created_at TEXT NOT NULL,
         updated_at TEXT NOT NULL,
         UNIQUE(original_room, original_seq, did)
       )`,
      `CREATE INDEX IF NOT EXISTS idx_repost_queue_status ON repost_queue(status, id)`,
    ],
  },
  {
    version: 4,
    name: 'archive-monitor-budgets',
    statements: [
      // The size `index.json` advertised, kept so a re-published entry can be
      // detected. A verified sweep is only skipped while status, path, expected
      // sha256 *and* this size are unchanged; any of them moving means the bytes
      // behind the entry changed and must be re-downloaded and re-verified.
      `ALTER TABLE archive_sweeps ADD COLUMN expected_size INTEGER`,

      // The archive monitor's bounded-batch accounting. `bytes_today` is rolled
      // over by `bytes_today_day`, so a restart mid-day does not reset the count
      // and the daily download volume stays visible across restarts.
      `ALTER TABLE archive_state ADD COLUMN pending_count INTEGER NOT NULL DEFAULT 0`,
      `ALTER TABLE archive_state ADD COLUMN unavailable_count INTEGER NOT NULL DEFAULT 0`,
      `ALTER TABLE archive_state ADD COLUMN mismatch_count INTEGER NOT NULL DEFAULT 0`,
      `ALTER TABLE archive_state ADD COLUMN bytes_this_check INTEGER NOT NULL DEFAULT 0`,
      `ALTER TABLE archive_state ADD COLUMN bytes_today INTEGER NOT NULL DEFAULT 0`,
      `ALTER TABLE archive_state ADD COLUMN bytes_today_day TEXT`,
    ],
  },
  {
    version: 5,
    name: 'runtime-events-and-trade-sweep',
    statements: [
      // ---- the runtime event trail, mirrored to Lark ------------------------
      // Every critical/warning event an operator must be told about lands here
      // first, keyed by a deterministic `event_id` so the same event is never
      // alerted twice (across restarts included). `lark_status` mirrors the
      // outbox row that carries the alert; the outbox owns retry and dedupe, and
      // this row records the outcome so a report can say what was told to whom.
      `CREATE TABLE IF NOT EXISTS runtime_events (
         id INTEGER PRIMARY KEY AUTOINCREMENT,
         event_id TEXT NOT NULL UNIQUE,
         severity TEXT NOT NULL,
         code TEXT NOT NULL,
         message TEXT NOT NULL,
         sweep INTEGER,
         agent_id TEXT,
         created_at TEXT NOT NULL,
         lark_status TEXT NOT NULL DEFAULT 'none',
         sent_at TEXT,
         retry_count INTEGER NOT NULL DEFAULT 0
       )`,
      `CREATE INDEX IF NOT EXISTS idx_runtime_events_severity ON runtime_events(severity, id)`,
      `CREATE INDEX IF NOT EXISTS idx_runtime_events_lark ON runtime_events(lark_status, id)`,
      `CREATE INDEX IF NOT EXISTS idx_runtime_events_code ON runtime_events(code, sweep)`,

      // The sweep a trade was proposed at. `until_sweep` bounds a trade forward
      // and `settle_sweep` records when the referee settled it, but neither says
      // *when we posted it* — which is what "trades in the current sweep" and
      // "trades after the lock" need to be answerable.
      `ALTER TABLE trades ADD COLUMN posted_sweep INTEGER`,
      `CREATE INDEX IF NOT EXISTS idx_trades_posted_sweep ON trades(posted_sweep)`,
    ],
  },
  {
    version: 6,
    name: 'room-bootstrap-state',
    statements: [
      // Why a fresh database must not be read as a mid-run gap.
      //
      // `close1` and the referee rooms retain a bounded history, so a process
      // starting against an empty database sees `first_seq` in the hundreds of
      // thousands and, before this column existed, recorded a 400k-message gap
      // and went conservative on its very first read. That conflates three
      // different facts — a first start whose history was never available to us,
      // a run that lost messages, and a room that was recreated — and only the
      // second one is an incident.
      //
      // `bootstrap_state` names which one applies, and it is durable: a restart
      // must not re-derive it, and it must never be downgraded (a later real gap
      // escalates the state, it does not reset it).
      `ALTER TABLE room_cursors ADD COLUMN bootstrap_state TEXT NOT NULL DEFAULT 'bootstrap_pending'`,
      // The oldest and newest sequence numbers we have actually observed, kept
      // separately from the cursor so a truncated first read is still visible
      // after the cursor has advanced past it.
      `ALTER TABLE room_cursors ADD COLUMN first_observed_seq INTEGER`,
      `ALTER TABLE room_cursors ADD COLUMN last_observed_seq INTEGER`,
      // Gap accounting: how many gaps have been recorded for this room, and the
      // range the most recent one covered.
      `ALTER TABLE room_cursors ADD COLUMN gap_count INTEGER NOT NULL DEFAULT 0`,
      `ALTER TABLE room_cursors ADD COLUMN last_gap_from INTEGER`,
      `ALTER TABLE room_cursors ADD COLUMN last_gap_to INTEGER`,
      // When the room first reached a settled bootstrap state, for the report.
      `ALTER TABLE room_cursors ADD COLUMN bootstrap_at TEXT`,
    ],
  },
  {
    version: 7,
    name: 'room-gap-resolution',
    statements: [
      // Whether a recorded gap is still *unresolved*.
      //
      // A gap is permanent evidence and is never cleared — but "a loss happened"
      // and "the reader is still losing" are different facts, and a live launch
      // needs to be able to tell them apart. A gap becomes resolved only on
      // positive evidence: a contiguous read (`reason = 'ok'`) that resumed past
      // the missed range, which is the reader proving it is back inside the
      // room's retained window. A later gap re-opens it (`gap_resolved_at` goes
      // back to NULL), so the flag always describes the *latest* gap.
      //
      // It is durable on purpose: a restart must not turn a resolved gap back
      // into an unresolved one, and must not lose the fact that one was resolved.
      `ALTER TABLE room_cursors ADD COLUMN gap_resolved_at TEXT`,
      `ALTER TABLE room_cursors ADD COLUMN last_resolved_gap_to INTEGER`,
    ],
  },
  {
    version: 8,
    name: 'local-message-index',
    statements: [
      // The local post index: one column per fact an operator needs to answer
      // "could the close1 gap have swallowed *our* registration".
      //
      // A successful POST is not evidence that the referee received anything —
      // the reply itself says so, and only a readback of our own signed record
      // from the room does. These columns keep the two apart, and keep the
      // request id and the message hash so a specific post can be reconciled
      // against what the room actually served.
      `ALTER TABLE participation_records ADD COLUMN post_request_id TEXT`,
      `ALTER TABLE participation_records ADD COLUMN message_hash TEXT`,
      `ALTER TABLE participation_records ADD COLUMN post_sweep INTEGER`,
      `ALTER TABLE participation_records ADD COLUMN flow_evidence_at TEXT`,
      `ALTER TABLE participation_records ADD COLUMN state_evidence_at TEXT`,
    ],
  },
  {
    version: 9,
    name: 'trade-source',
    statements: [
      // Which decision wrote a trade: the five group profiles, the late-start
      // bootstrap decision, or the participation fallback.
      //
      // The old schema had no such column, and the only signal was the `pl`
      // prefix the fallback happened to use. A prefix is a convention, not a
      // fact, and it cannot name a third source — so the source is now a column,
      // written by whichever path inserted the row.
      `ALTER TABLE trades ADD COLUMN trade_source TEXT`,
      // One-time backfill for rows written before the column existed. `pl%` is
      // the *only* thing the old schema recorded, so it is what the legacy rows
      // are reconstructed from; every row written from here on carries the
      // column and never needs the prefix again.
      `UPDATE trades
          SET trade_source = CASE WHEN id LIKE 'pl%' THEN 'participation' ELSE 'strategy' END
        WHERE trade_source IS NULL`,
      `CREATE INDEX IF NOT EXISTS idx_trades_source ON trades(trade_source, status)`,
    ],
  },
];

export const SCHEMA_VERSION = MIGRATIONS[MIGRATIONS.length - 1]!.version;

export function runMigrations(db: SqliteDatabase): void {
  const current = db.pragma('user_version', { simple: true }) as number;
  if (current > SCHEMA_VERSION) {
    throw new Error(
      `database schema is version ${current} but this build only knows ${SCHEMA_VERSION}; ` +
        'refusing to start against a newer schema',
    );
  }
  for (const migration of MIGRATIONS) {
    if (migration.version <= current) continue;
    const apply = db.transaction(() => {
      for (const statement of migration.statements) db.exec(statement);
      db.pragma(`user_version = ${migration.version}`);
      db.prepare(
        `INSERT OR REPLACE INTO meta(key, value, updated_at) VALUES (?, ?, ?)`,
      ).run('schema_version', String(migration.version), new Date().toISOString());
    });
    apply();
  }
}
