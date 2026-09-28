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
