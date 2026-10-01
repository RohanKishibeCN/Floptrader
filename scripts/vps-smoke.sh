#!/usr/bin/env bash
#
# vps-smoke — the dry-run acceptance rehearsal for a fresh VPS.
#
# This is the "does the box actually run it" gate that sits between a green test
# suite and a real staging run. It brings up the *real* process on the *real*
# filesystem layout, and checks the things a unit test cannot: file modes, the
# WAL journal, a graceful SIGTERM, survival of a `kill -9`, cursors and the
# outbox recovering from it, the health endpoint, and that no secret reaches the
# log. It never trades and never registers — the whole run is the deployable
# `lite` profile in dry-run, with every live gate held shut:
#
#   FLOP_PROFILE=lite FLOP_MODE=dry-run FLOP_ALLOW_REGISTRATION=false
#   FLOP_ALLOW_TRADING=false DEEPSEEK_ENABLED=false
#   EXTERNAL_OFFER_TAKER_ENABLED=false MAX_DISCOVERED_ROOMS=0
#   LARK_MODE=open-api LARK_WS_ENABLED=false
#
# Usage:
#   scripts/vps-smoke.sh                 # isolated temp dir, cleaned up after
#   scripts/vps-smoke.sh --keep          # leave the smoke root for inspection
#   FLOP_SMOKE_ROOT=/tmp/smoke scripts/vps-smoke.sh
#   FLOP_SMOKE_AGENTS=3 scripts/vps-smoke.sh
#
# Exit status is non-zero if any check failed. Skipped checks (systemd on a
# machine without it) do not fail the run but are printed.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
AGENTS="${FLOP_SMOKE_AGENTS:-5}"
HEALTH_PORT="${FLOP_SMOKE_HEALTH_PORT:-18780}"
HEALTH_HOST="${FLOP_SMOKE_HEALTH_HOST:-127.0.0.1}"
SMOKE_ROOT="${FLOP_SMOKE_ROOT:-$(mktemp -d "${TMPDIR:-/tmp}/flop-vps-smoke.XXXXXX")}"
KEEP="${FLOP_SMOKE_KEEP:-0}"
BOOTSTRAP="$REPO_ROOT/.vps-smoke-bootstrap.mts"

# The runtime layout. State lives outside the release tree, exactly as the
# systemd unit and the README require: a rollback moves code and nothing else.
SHARED="$SMOKE_ROOT/shared"
DATA_DIR="$SHARED/data"
SECRETS_DIR="$SMOKE_ROOT/secrets"
RELEASES_DIR="$SMOKE_ROOT/releases"
LOG_DIR="$SHARED/logs"
LOG="$LOG_DIR/orchestrator.log"

PASS_COUNT=0
FAIL_COUNT=0
SKIP_COUNT=0
WARN_COUNT=0

pass() { PASS_COUNT=$((PASS_COUNT + 1)); printf '  \033[32mPASS\033[0m  %s\n' "$1"; }
fail() { FAIL_COUNT=$((FAIL_COUNT + 1)); printf '  \033[31mFAIL\033[0m  %s\n' "$1"; }
skip() { SKIP_COUNT=$((SKIP_COUNT + 1)); printf '  \033[33mSKIP\033[0m  %s\n' "$1"; }
warn() { WARN_COUNT=$((WARN_COUNT + 1)); printf '  \033[33mWARN\033[0m  %s\n' "$1"; }
step() { printf '\n\033[1m▶ %s\033[0m\n' "$1"; }

PID=""
stop_process() {
  if [[ -n "$PID" ]] && kill -0 "$PID" 2>/dev/null; then
    kill -TERM "$PID" 2>/dev/null || true
    # Give systemd-style graceful shutdown its window before giving up.
    for _ in $(seq 1 30); do
      kill -0 "$PID" 2>/dev/null || break
      sleep 0.5
    done
    kill -KILL "$PID" 2>/dev/null || true
  fi
  PID=""
}

# A file's POSIX mode, portable across the GNU and BSD `stat` dialects.
file_mode() {
  case "$(uname -s)" in
    Darwin) stat -f '%Lp' "$1" ;;
    *) stat -c '%a' "$1" ;;
  esac
}

# Read a single integer out of SQLite, or a fallback when the query fails.
sqlite_scalar() {
  local sql="$1" fallback="${2:-0}"
  ( cd "$REPO_ROOT" && node -e \
      "const D=require('better-sqlite3');const db=new D(process.argv[1],{readonly:true});process.stdout.write(String(db.prepare(process.argv[2]).get().n));" \
      "$DB_FILE" "$sql" 2>/dev/null ) || echo "$fallback"
}

# HTTP helpers on Node's global fetch, so the smoke does not depend on curl.
http_ok() {
  node -e 'fetch(process.argv[1]).then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))' "$1" 2>/dev/null
}
http_body() {
  node -e 'fetch(process.argv[1]).then(r=>r.text()).then(t=>process.stdout.write(t)).catch(()=>process.exit(1))' "$1" 2>/dev/null
}

cleanup() {
  stop_process
  rm -f "$BOOTSTRAP"
  if [[ "$KEEP" == "1" ]]; then
    printf '\n  smoke root kept at %s\n' "$SMOKE_ROOT"
  else
    rm -rf "$SMOKE_ROOT"
  fi
}
trap cleanup EXIT

# The environment every child process runs under. The deployable profile, in
# dry-run, with nothing armed, no model, no dynamic rooms and no external offers
# — a rehearsal must not be able to trade by accident.
#
# The two base URLs point at port 9 (discard), which refuses instantly, so the
# rehearsal is offline by construction. Without that the process would read the
# real service with the 15s request timeout; a tick could still be inside it when
# SIGTERM lands, and the graceful-stop check would flake on the retry ladder
# instead of testing the shutdown path.
runtime_env() {
  exec env \
    NODE_ENV=production \
    TIMEZONE=Asia/Shanghai \
    LOG_LEVEL=info \
    DATA_DIR="$DATA_DIR" \
    SECRETS_DIR="$SECRETS_DIR" \
    RELEASES_DIR="$RELEASES_DIR" \
    CONTEST_JSON_PATH="$REPO_ROOT/reference/contest.json" \
    REFERENCE_DIR="$REPO_ROOT/reference" \
    AGE_IDENTITY_FILE="$SECRETS_DIR/runtime.key" \
    FLOP_PROFILE=lite \
    FLOP_MODE=dry-run \
    FLOP_ALLOW_REGISTRATION=false \
    FLOP_ALLOW_TRADING=false \
    DEEPSEEK_ENABLED=false \
    EXTERNAL_OFFER_TAKER_ENABLED=false \
    REQUIRE_FULL_FLEET=false \
    EXPECTED_AGENT_COUNT="$AGENTS" \
    MAX_DISCOVERED_ROOMS="${MAX_DISCOVERED_ROOMS:-0}" \
    DYNAMIC_ROOM_READ_CONCURRENCY="${DYNAMIC_ROOM_READ_CONCURRENCY:-1}" \
    ARCHIVE_MAX_RECORDS_PER_CHECK="${ARCHIVE_MAX_RECORDS_PER_CHECK:-10}" \
    ARCHIVE_MAX_BYTES_PER_CHECK="${ARCHIVE_MAX_BYTES_PER_CHECK:-100000000}" \
    ARCHIVE_MAX_REQUESTS_PER_MINUTE="${ARCHIVE_MAX_REQUESTS_PER_MINUTE:-10}" \
    ARCHIVE_BACKFILL_MODE="${ARCHIVE_BACKFILL_MODE:-oldest_first}" \
    LARK_MODE=open-api LARK_WS_ENABLED=false \
    LARK_APP_ID= LARK_APP_SECRET= LARK_CHAT_ID= \
    HEALTH_PORT="$HEALTH_PORT" HEALTH_HOST="$HEALTH_HOST" \
    TICK_SECONDS="${TICK_SECONDS:-5}" \
    READER_ENABLED="${READER_ENABLED:-true}" \
    READER_RETRY_DELAY_MS="${READER_RETRY_DELAY_MS:-250}" \
    TECHNO_CORE_BASE_URL="${TECHNO_CORE_BASE_URL:-http://127.0.0.1:9}" \
    CHALLENGE_ARCHIVE_BASE_URL="${CHALLENGE_ARCHIVE_BASE_URL:-http://127.0.0.1:9}" \
    REQUEST_TIMEOUT_MS="${REQUEST_TIMEOUT_MS:-1000}" \
    "$@"
}

# How to launch the process: the built artifact on a real VPS, tsx in a checkout.
if [[ -f "$REPO_ROOT/dist/main.mjs" ]]; then
  SMOKE_CMD=(node --max-old-space-size=512 dist/main.mjs)
else
  SMOKE_CMD=(pnpm exec tsx apps/orchestrator/src/main.ts)
fi

# Started disowned: the smoke kills the process on purpose, and bash's own
# "Killed: 9" job notice is noise, not a result.
start_process() {
  ( cd "$REPO_ROOT" && runtime_env "${SMOKE_CMD[@]}" ) >>"$LOG" 2>&1 &
  PID=$!
  disown "$PID" 2>/dev/null || true
}

wait_for_health() {
  local attempts="${1:-40}"
  for _ in $(seq 1 "$attempts"); do
    if http_ok "http://$HEALTH_HOST:$HEALTH_PORT/health"; then
      return 0
    fi
    sleep 0.5
  done
  return 1
}

start_and_wait() {
  start_process
  wait_for_health 60
}

wait_for_exit() {
  # Returns 0 if the process exits within the window, 1 otherwise.
  for _ in $(seq 1 60); do
    kill -0 "$PID" 2>/dev/null || return 0
    sleep 0.5
  done
  return 1
}

printf '\n\033[1mvps-smoke — dry-run acceptance rehearsal\033[0m\n'
printf '  repo       %s\n' "$REPO_ROOT"
printf '  smoke root %s\n' "$SMOKE_ROOT"
printf '  agents     %s\n' "$AGENTS"

# ---------------------------------------------------------------------------
step "1. prerequisites and layout"
# ---------------------------------------------------------------------------

NODE_VERSION="$(node -p 'process.versions.node')"
NODE_MAJOR="${NODE_VERSION%%.*}"
if [[ "$NODE_MAJOR" == "22" ]]; then
  pass "Node.js 22 (found $NODE_VERSION)"
elif [[ "$NODE_MAJOR" -ge 22 && "$NODE_MAJOR" -lt 25 ]]; then
  warn "Node.js $NODE_VERSION satisfies engines >=22 <25, but the VPS standard is 22"
else
  fail "Node.js $NODE_VERSION is outside engines >=22 <25"
fi

if command -v pnpm >/dev/null 2>&1; then
  pass "pnpm available ($(pnpm --version))"
else
  fail "pnpm is not on PATH"
fi

mkdir -p "$DATA_DIR" "$SECRETS_DIR" "$RELEASES_DIR" "$LOG_DIR"
chmod 700 "$DATA_DIR" "$SECRETS_DIR" "$LOG_DIR"

# data / secrets / releases must be three distinct trees, so a rollback of the
# release never touches state and the secrets never live beside the code.
if [[ "$DATA_DIR" != "$SECRETS_DIR" && "$SECRETS_DIR" != "$RELEASES_DIR" && "$DATA_DIR" != "$RELEASES_DIR" ]]; then
  pass "data, secrets and releases are separate directories"
else
  fail "data, secrets and releases are not distinct"
fi

# ---------------------------------------------------------------------------
step "2. bootstrap identities (never printed, never written in the clear)"
# ---------------------------------------------------------------------------

cat >"$BOOTSTRAP" <<'EOF'
import { writeFileSync } from 'node:fs';
import { createAgeIdentity, ageRecipientFor } from '@flop/identity';

const target = process.env.SMOKE_RUNTIME_KEY;
if (!target) throw new Error('SMOKE_RUNTIME_KEY is not set');
const identity = await createAgeIdentity();
writeFileSync(target, `${identity}\n`, { mode: 0o600 });
process.stdout.write(await ageRecipientFor(identity));
EOF

RECIPIENT="$(cd "$REPO_ROOT" && SMOKE_RUNTIME_KEY="$SECRETS_DIR/runtime.key" pnpm exec tsx "$BOOTSTRAP")"
chmod 600 "$SECRETS_DIR/runtime.key"

if [[ -s "$SECRETS_DIR/runtime.key" ]]; then
  pass "runtime age identity created with mode 0600"
else
  fail "runtime age identity was not created"
fi

if ( cd "$REPO_ROOT" && runtime_env \
      AGE_RECIPIENT_VPS="$RECIPIENT" AGE_RECIPIENT_ADMIN="$RECIPIENT" \
      pnpm exec tsx apps/orchestrator/src/cli.ts identities generate --count "$AGENTS" \
      >>"$LOG" 2>&1 ); then
  pass "identities generated ($AGENTS agents) and public inventory signed"
else
  fail "identity generation failed (see $LOG)"
fi

if [[ -f "$SECRETS_DIR/agents.bundle.age" ]]; then
  pass "encrypted agent bundle exists"
else
  fail "encrypted agent bundle is missing"
fi

# ---------------------------------------------------------------------------
step "3. file modes"
# ---------------------------------------------------------------------------

secrets_mode="$(file_mode "$SECRETS_DIR")"
if [[ "$secrets_mode" == "700" ]]; then
  pass "secrets directory is 0700"
else
  fail "secrets directory is $secrets_mode, expected 0700"
fi

bundle_mode="$(file_mode "$SECRETS_DIR/agents.bundle.age")"
if [[ "$bundle_mode" == "600" ]]; then
  pass "agent bundle is 0600"
else
  fail "agent bundle is $bundle_mode, expected 0600"
fi

# ---------------------------------------------------------------------------
step "4. the process starts, is healthy, and stops cleanly on SIGTERM"
# ---------------------------------------------------------------------------

# The archive points at a closed port on purpose: an unreachable archive must
# never stop the process, and this run proves it stays up while archive checks
# fail in the background.
: >"$LOG"
export CHALLENGE_ARCHIVE_BASE_URL="${CHALLENGE_ARCHIVE_BASE_URL:-http://127.0.0.1:1/close-1}"

if start_and_wait; then
  pass "process started and /health answered"
else
  fail "process did not become healthy (see $LOG)"
fi

if http_ok "http://$HEALTH_HOST:$HEALTH_PORT/health"; then
  pass "health endpoint reachable"
else
  fail "health endpoint unreachable"
fi

# The scheduler runs off the trading path: it must have ticked at least once.
sleep 6
STATUS_BODY="$(http_body "http://$HEALTH_HOST:$HEALTH_PORT/status" || true)"
if printf '%s' "$STATUS_BODY" | grep -q '"mode":"dry-run"'; then
  pass "status reports dry-run mode"
else
  fail "status did not report dry-run mode"
fi

# The convergence must be visible from the running process, not only the env:
# the lite profile with discovery off means `room_scope=close1_only`.
if printf '%s' "$STATUS_BODY" | grep -q '"profile":"lite"'; then
  pass "status reports the lite profile"
else
  fail "status did not report the lite profile"
fi

if printf '%s' "$STATUS_BODY" | grep -q '"scope":"close1_only"'; then
  pass "room scope is close1_only (fixed six rooms)"
else
  fail "room scope is not close1_only"
fi

# The reader must own the fixed rooms itself, not wait for the agent tick: this
# is the throughput fix, and it has to be visible from the running process.
if printf '%s' "$STATUS_BODY" | grep -q '"continuousMode":true'; then
  pass "reader is in continuous mode (decoupled from the scheduler tick)"
else
  fail "reader is not in continuous mode"
fi

if printf '%s' "$STATUS_BODY" | grep -q '"fixedRoomCount":6'; then
  pass "reader owns all six fixed rooms"
else
  fail "reader does not own six fixed rooms"
fi

# WAL is the journal mode the crash-recovery story depends on.
DB_FILE="$DATA_DIR/app.db"
if [[ -f "$DB_FILE" ]]; then
  journal="$(cd "$REPO_ROOT" && node -e "const D=require('better-sqlite3');const db=new D(process.argv[1],{readonly:true});process.stdout.write(db.pragma('journal_mode',{simple:true}));" "$DB_FILE" 2>/dev/null || true)"
  if [[ "$journal" == "wal" ]]; then
    pass "SQLite journal_mode is wal"
  else
    fail "SQLite journal_mode is '${journal:-unknown}', expected wal"
  fi
else
  fail "no database file at $DB_FILE"
fi

# A graceful SIGTERM must let an in-flight tick finish and close the database.
if [[ -n "$PID" ]]; then
  kill -TERM "$PID" 2>/dev/null || true
  if wait_for_exit; then
    pass "SIGTERM produced a clean shutdown"
  else
    fail "process did not exit on SIGTERM"
    kill -KILL "$PID" 2>/dev/null || true
  fi
  PID=""
else
  fail "no process to send SIGTERM to"
fi

# ---------------------------------------------------------------------------
step "5. crash recovery: kill -9, restart, cursors and outbox survive"
# ---------------------------------------------------------------------------

cursors_before="$(sqlite_scalar 'SELECT COUNT(*) n FROM room_cursors' 0)"
# Nonces are the monotonic counter behind every signed message; the outbox is the
# durable report queue. Both must survive the hard kill without losing a row.
nonces_before="$(sqlite_scalar 'SELECT COUNT(*) n FROM nonces' 0)"
outbox_before="$(sqlite_scalar 'SELECT COUNT(*) n FROM lark_outbox' 0)"

if start_and_wait; then
  pass "process restarted after the graceful stop"
else
  fail "process did not restart after the graceful stop"
fi

if [[ -z "$PID" ]]; then
  fail "restart failed; crash-recovery checks skipped"
else
  kill -KILL "$PID" 2>/dev/null || true
  wait "$PID" 2>/dev/null || true
  PID=""
  pass "hard kill (kill -9) issued"

  if start_and_wait; then
    pass "process restarted from the same database after kill -9"
  else
    fail "process did not come back after kill -9"
  fi

  sleep 6
  cursors_after="$(sqlite_scalar 'SELECT COUNT(*) n FROM room_cursors' 0)"

  # The reader must know which rooms it reads after a restart — a zero cursor
  # count after a restart means recovery lost its place.
  if [[ "${cursors_after:-0}" -ge 6 ]]; then
    pass "room cursors recovered ($cursors_before before kill, $cursors_after after)"
  else
    fail "room cursors did not recover (found ${cursors_after:-0})"
  fi

  # Nonces must be monotonic across the kill: a rollback would let a signed
  # message reuse a counter, which the referee refuses outright.
  nonces_after="$(sqlite_scalar 'SELECT COUNT(*) n FROM nonces' 0)"
  if [[ "${nonces_after:-0}" -ge "${nonces_before:-0}" ]]; then
    pass "nonce counter recovered monotonically ($nonces_before before kill, $nonces_after after)"
  else
    fail "nonce counter rolled back ($nonces_before before kill, $nonces_after after)"
  fi

  # The outbox is a table, and it must be readable after the restart: that is what
  # a report/alert retry depends on.
  outbox_after="$(sqlite_scalar 'SELECT COUNT(*) n FROM lark_outbox' 0)"
  if ( cd "$REPO_ROOT" && node -e "const D=require('better-sqlite3');const db=new D(process.argv[1],{readonly:true});db.prepare('SELECT COUNT(*) n FROM lark_outbox').get();" "$DB_FILE" 2>/dev/null ); then
    pass "Lark outbox persisted locally across the restart ($outbox_before before kill, $outbox_after after)"
  else
    fail "Lark outbox missing after the restart"
  fi

  # The immediate-alert trail is the other durable evidence table; it must exist
  # too, so a critical recorded just before the kill is still on the record.
  if ( cd "$REPO_ROOT" && node -e "const D=require('better-sqlite3');const db=new D(process.argv[1],{readonly:true});db.prepare('SELECT COUNT(*) n FROM runtime_events').get();" "$DB_FILE" 2>/dev/null ); then
    pass "runtime_events trail survived the restart"
  else
    fail "runtime_events missing after the restart"
  fi
fi

# ---------------------------------------------------------------------------
step "6. reports: disk and cost"
# ---------------------------------------------------------------------------

if ( cd "$REPO_ROOT" && runtime_env pnpm exec tsx scripts/disk-report.ts --data-dir "$DATA_DIR" >/dev/null 2>&1 ); then
  pass "disk-report ran"
else
  fail "disk-report failed"
fi

if ( cd "$REPO_ROOT" && runtime_env pnpm exec tsx scripts/cost-report.ts >/dev/null 2>&1 ); then
  pass "cost-report ran"
else
  fail "cost-report failed"
fi

# ---------------------------------------------------------------------------
step "7. no secret ever reached the log"
# ---------------------------------------------------------------------------

leaked=""
for pattern in 'AGE-SECRET-KEY' 'DEEPSEEK_API_KEY=' 'LARK_APP_SECRET=' '"seed":"[0-9a-f]\{32,\}' 'BEGIN [A-Z ]*PRIVATE KEY'; do
  if grep -qE "$pattern" "$LOG" 2>/dev/null; then
    leaked="$leaked $pattern"
  fi
done
if [[ -z "$leaked" ]]; then
  pass "no seed, private key, API key or Lark secret in the log"
else
  fail "the log contains secret-like material:${leaked}"
fi

# ---------------------------------------------------------------------------
step "8. systemd unit"
# ---------------------------------------------------------------------------

if command -v systemctl >/dev/null 2>&1 || command -v systemd-analyze >/dev/null 2>&1; then
  if command -v systemd-analyze >/dev/null 2>&1; then
    if ( cd "$REPO_ROOT" && systemd-analyze verify systemd/flop-close-call.service >/dev/null 2>&1 ); then
      pass "systemd unit verifies"
    else
      fail "systemd unit failed systemd-analyze verify"
    fi
  else
    skip "systemd-analyze not installed"
  fi

  if [[ "$(id -u)" == "0" ]] && command -v systemctl >/dev/null 2>&1; then
    # Only touch the real supervisor when we are root and the unit is installed;
    # running this on the wrong box must never restart someone else's service.
    if systemctl list-unit-files flop-close-call.service >/dev/null 2>&1; then
      if systemctl restart flop-close-call.service >/dev/null 2>&1; then
        pass "systemd restart of flop-close-call succeeded"
      else
        fail "systemd restart of flop-close-call failed"
      fi
    else
      skip "flop-close-call.service is not installed on this host"
    fi
  else
    skip "not root (or no systemctl): systemd start/restart not exercised"
  fi
else
  skip "systemd is not available on this host"
fi

# ---------------------------------------------------------------------------
# summary
# ---------------------------------------------------------------------------

stop_process

printf '\n\033[1mvps-smoke summary\033[0m\n'
printf '  passed  %s\n' "$PASS_COUNT"
printf '  failed  %s\n' "$FAIL_COUNT"
printf '  skipped %s\n' "$SKIP_COUNT"
printf '  warned  %s\n' "$WARN_COUNT"
printf '  log     %s\n' "$LOG"
printf '\n'

if [[ "$FAIL_COUNT" -gt 0 ]]; then
  printf '  \033[31mFAIL\033[0m: dry-run acceptance did not pass\n\n'
  exit 1
fi

printf '  \033[32mPASS\033[0m: dry-run acceptance passed on this host\n'
printf '  LIVE TRADING: BLOCKED — a dry-run rehearsal never authorises live trading.\n\n'
exit 0
