# FLOP Technocore Close Call — multi-DID agent orchestrator

One Node.js 22 process that runs 150 independent Ed25519 `did:key` owners in the
FLOP Labs **Technocore Close Call** contest (`contest_id` `close-1`).

Not 150 processes. Not 150 PM2 apps. One process, one shared reader, one writer
queue, one SQLite database in WAL mode, and 150 seeds that never touch the disk
in the clear.

```
                    ┌─────────────────── one node process ────────────────────┐
  technocore.chat   │  OrchestratorReader ──► RefereeVerifier ──► MarketSnapshot │
  6 rooms ◄────────►│        │                      │                            │
                    │        ▼                      ▼                            │
                    │   room_cursors          referee_snapshots                 │
                    │        │                      │                            │
                    │        ▼                      ▼                            │
                    │  150 agents ──► 5 deterministic strategy groups            │
                    │        │              (30 agents each)                      │
                    │        ▼                                                   │
                    │  deterministic gate ──► trade validator ──► risk engine     │
                    │        │                                                   │
                    │        ▼                                                   │
                    │  OrchestratorWriter (ONE queue, ONE in-flight POST)         │
                    └────────┬──────────────────────────────┬────────────────────┘
                             │                              │
                    SQLite WAL (app.db)            Lark WebSocket (in) +
                                                   Open API (out) + outbox
```

## What this satisfies, and where to check

Every claim below is enforced by code and asserted by a test. The mapping is
deliberate so nothing has to be taken on faith.

| Requirement | Where |
| --- | --- |
| 150 unique `did:key`, 5 groups × 30 | `packages/identity`, `tests/identity.test.ts` |
| Seeds never in plaintext; age bundle, two recipients | `packages/identity/src/backup.ts`, `tests/control-proof.test.ts` |
| A control proof per agent, verified against a signed inventory | `packages/identity/src/control-proof.ts` |
| Owner registration + readback evidence for all 150 | `apps/orchestrator/src/scheduler.ts`, `tests/participation.test.ts` |
| `mint_unknown` is never treated as failure | `scheduler.ts` `reconcileMints`, `tests/omitted-flow.test.ts` |
| Every agent runs a local evaluation inside a rolling 7×24 h window | `packages/strategy/src/group-runner.ts`, `tests/weekly-run.test.ts` |
| Five deterministic strategy groups | `packages/strategy/src/profiles.ts`, `tests/strategy-groups.test.ts` |
| The official fold, ported byte-for-byte | `packages/close-call/src/fold.ts`, `tests/official-fold.test.ts` |
| Trade protocol: both signatures, limits, lock, duplicate ids | `packages/close-call/src/trade-*.ts`, `tests/trade-protocol.test.ts` |
| Referee posts verified per room; drift enters conservative mode | `packages/technocore/src/referee-verifier.ts`, `tests/referee-verifier.test.ts` |
| Package pin; a mismatch pauses trading and never auto-switches | `packages/technocore/src/package-pin.ts`, `tests/package-pin.test.ts` |
| DeepSeek budget: ≤2 normal, ≤1 retry, ≤3 hard, idle windows only | `apps/orchestrator/src/llm.ts`, `tests/llm-budget.test.ts`, `tests/llm-window.test.ts` |
| The model cannot bypass the risk engine: bounded parameters only, caps live outside its reach | `packages/strategy/src/parameter-validator.ts`, `deterministic-gate.ts`, `packages/close-call/src/risk.ts`, `tests/model-cannot-bypass-risk.test.ts` |
| Lark: one WebSocket, Open API reports, outbox, `report_id` de-dup | `apps/orchestrator/src/lark.ts`, `tests/lark-*.test.ts` |
| Degradation ladder under CPU/RAM/disk/queue pressure | `apps/orchestrator/src/load-guard.ts`, `tests/load-guard.test.ts` |
| History pruning never touches contest evidence | `packages/storage/src/retention.ts`, `tests/archive-retention.test.ts` |
| Crash recovery: WAL, nonces, cursors, no duplicate trades | `tests/crash-recovery.test.ts` |
| 24 simulated hours inside the resource budget | `scripts/soak-test.ts` |

## Requirements

- Node.js 22 (`>=22 <25`) — `better-sqlite3` is a native addon and its ABI is
  pinned to the Node major. A mismatch fails loudly at load time, on purpose.
- pnpm 9

## Setup

```bash
pnpm install --frozen-lockfile

cp .env.example .env
# fill in AGE_RECIPIENT_VPS / AGE_RECIPIENT_ADMIN, the Lark credentials,
# and (optionally) DEEPSEEK_API_KEY

# 1. two age identities: one the VPS can use to decrypt at runtime, one kept
#    offline as the admin recovery key.
age-keygen -o secrets/runtime.key
age-keygen -o secrets/admin.key
chmod 700 secrets && chmod 600 secrets/runtime.key secrets/admin.key
# each command prints its public key (age1...); put the runtime key's public key
# in AGE_RECIPIENT_VPS, the admin key's in AGE_RECIPIENT_ADMIN, and the runtime
# key path in AGE_IDENTITY_FILE
# keep a copy of secrets/admin.key somewhere that is not this machine

# 2. the 150 identities, encrypted at rest, plus the signed public inventory
pnpm cli identities generate --count 150

# 3. the control proof set (proves the process holds the keys, not that it is
#    any particular real-world person)
pnpm cli identities create-challenge
pnpm cli identities prove-control
pnpm cli identities verify-control

# 4. prove the backup is a backup
pnpm cli identities backup --out data/backups/agents-close-1.age
pnpm verify:backup --input data/backups/agents-close-1.age
```

There is **no** command that prints or writes a plaintext seed. `generate`
refuses to run without an age recipient, and refuses to overwrite an existing
bundle, because regenerating identities would orphan every registration already
recorded on technocore.

## Running

```bash
pnpm start                       # dry-run by default, health on 127.0.0.1:8780
curl -s localhost:8780/health
curl -s localhost:8780/status | jq .
```

Live takes four separate decisions, and the process refuses to start
half-armed. `FLOP_MODE=live` alone is a startup error, not a configuration that
looks armed and is not:

```bash
FLOP_MODE=live \
FLOP_LIVE_CONFIRM=close-1 \
FLOP_ALLOW_REGISTRATION=true \
EXPECTED_REFEREE_DID=did:key:z6Mk... \
pnpm start
```

| Gate | Why it is separate |
| --- | --- |
| `FLOP_LIVE_CONFIRM=close-1` | confirms the contest id, so `live` cannot be armed by one stray variable |
| `FLOP_ALLOW_REGISTRATION=true` | required in live: 150 unregistered agents would trade on accounts the referee never minted |
| `EXPECTED_REFEREE_DID` | required in live: without a pin the first signed post on a public room decides who the referee is |
| `FLOP_ALLOW_TRADING=true` | a second, later decision — run live+registration until all 150 readbacks are in, then arm trading |

`REQUIRE_FULL_FLEET=true` (the default) also holds the fleet to exactly 150
agents in five groups of thirty at startup; `pnpm cli identities generate` refuses
to write a short one. `REQUIRE_FULL_FLEET=false` is for dry runs only.

## Deploying on the VPS (from git)

The VPS runs the code straight out of this repository. `data/`, `secrets/`,
`logs/` and `dist/` are gitignored, so a clone carries code, configuration
templates and the vendored reference artifacts — and nothing that identifies an
agent.

State lives **outside** the release directory, so a rollback moves code and
nothing else:

```text
/opt/flop-close-call/
├── releases/
│   ├── <version>/          # code, dist, reference/, package.json, lockfile
│   └── ...
├── current -> releases/<version>
├── shared/
│   ├── flop.env            # the environment file systemd loads
│   └── data/               # SQLite, archive, backups, participation evidence
└── secrets/                # agents.bundle.age, runtime.key, admin-public.key
```

The paths in `shared/flop.env` are absolute for exactly this reason:

```env
DATA_DIR=/opt/flop-close-call/shared/data
SECRETS_DIR=/opt/flop-close-call/secrets
```

Logs are not a file: the unit sends stdout and stderr to the journal, so use
`journalctl -u flop-close-call`.

```bash
# once
sudo mkdir -p /opt/flop-close-call/{releases,shared,secrets}
sudo chown -R flop:flop /opt/flop-close-call
sudo chmod 700 /opt/flop-close-call/secrets

git clone https://github.com/RohanKishibeCN/Floptrader.git /opt/flop-close-call/releases/0.1.0
cd /opt/flop-close-call/releases/0.1.0
pnpm install --frozen-lockfile && pnpm build
ln -sfn /opt/flop-close-call/releases/0.1.0 /opt/flop-close-call/current

# age keygen + `pnpm cli identities generate --count 150` as above, writing into
# /opt/flop-close-call/secrets, so the bundle is created here and never travels
# through git. `identities generate` writes secrets/admin-public.key — only that
# public half belongs on this host.
install -m 600 /dev/null /opt/flop-close-call/shared/flop.env
# fill it in from .env.example, with the absolute paths above

sudo cp systemd/flop-close-call.service /etc/systemd/system/
sudo systemd-analyze verify /etc/systemd/system/flop-close-call.service
sudo systemctl daemon-reload && sudo systemctl enable --now flop-close-call
```

Updating is a pull plus a rebuild — never a `git push` of runtime state:

```bash
cd /opt/flop-close-call/releases/0.1.1    # a fresh clone or a ff-only pull
pnpm install --frozen-lockfile && pnpm build
ln -sfn /opt/flop-close-call/releases/0.1.1 /opt/flop-close-call/current
sudo systemctl restart flop-close-call
curl -s localhost:8780/health
# on failure: point `current` back at 0.1.0 and restart
```

Three rules make this safe. First, a deployment never regenerates identities:
the bundle in `secrets/` and the cursor and registration evidence in `shared/`
are the contest record, and they stay on the machine. Second, the official
package pin is a separate, human decision — see the release procedure below;
pulling a new commit of *our* code does not move the pin, and a drift in the
*official* package still pauses active trading rather than switching anything.
Third, systemd is the only supervisor; `ecosystem.config.cjs` is a development
tool and must not be run beside the unit.

## The five strategy groups

Exactly five, exactly thirty agents each, assigned deterministically by index so
restarting does not reshuffle the roster.

| Group | Idea | Risk tier |
| --- | --- | --- |
| `trend_following` | slope of the 6- and 12-sweep references; stand down without a clear trend; smaller size in high volatility | `max_qty` 25, `max_open_notional` 8000 |
| `mean_reversion` | fade a clear deviation from the EMA; off in high volatility and near the limits | 20 / 6000 |
| `breakout` | 12/24-sweep high/low with confirmation and a cooldown after consecutive same-direction breaks | 20 / 6000 |
| `contrarian` | small counter-position after a single over-large sweep move; off in a real trend; never adds to a losing fade | 10 / 3000 |
| `external_offer_taker` | takes other people's open `taker:"any"` offers; never posts one; refuses any offer from one of our own DIDs | 15 / 4500 |

Every evaluation is a pure function of the referee snapshot and local state.
DeepSeek may move thresholds *inside* the ranges in
`packages/strategy/src/parameter-validator.ts`; it can never raise a cap, generate
a signature, contact technocore, or edit the risk limits.

## Model usage: the numbers, not a vibe

- Blocked windows (Asia/Shanghai): **09:00–12:00** and **14:00–18:00**.
- Allowed: 00:00–09:00, 12:00–14:00, 18:00–24:00. Default slots 06:30 and 20:30.
- At most **2** normal calls and **1** retry per day; a hard ceiling of **3**;
  concurrency **1**; a minimum of 1.5 s between calls.
- Every request passes `isDeepSeekIdleWindow(now, timezone)` and the budget check
  *before* a prompt is built.
- Prompts are numbers only — never a room transcript, never a seed, never a DID.
  The output goes through zod, numeric bounds, the contest rules, a local
  simulator, the official fold, and a version audit before it can take effect.
- A failure keeps the previous parameters. The trade path never waits on a model.

```bash
pnpm cost-report           # per-day calls, tokens, retries, off-window attempts
```

## Lark

One inbound WebSocket long connection, with our own backoff ladder. Reports are
sent through the **Open API** — writing text to the socket would not send a
message. The outbox is the durability boundary: a report is written to SQLite
before any network call, so a crash mid-send requeues it, and the `UNIQUE`
`report_id` makes a duplicate impossible.

Reports go out at **08:50** and **18:10** Asia/Shanghai, generated purely from
local SQLite and process metrics. They never call DeepSeek, and they never
contain a seed, a key, a secret, or the full list of 150 DIDs — sender DIDs are
summarised before they reach the text.

Three honest caveats about the WebSocket half:

1. `@larksuiteoapi/node-sdk` is pinned to **exactly `1.48.0`** in `package.json`
   (no caret). The adapter reads two things that are version facts, not API:
   the private field it calls during `stop()` to clear the ping timer and
   terminate the socket, and the log text it matches on. The pin has no caret,
   so `pnpm install` cannot resolve a different build behind our back.
2. That version exposes no lifecycle API — `WSClient` has `start()` and nothing
   else, and `start()` resolves even when connect fails. The "is the connection
   alive" signal therefore comes from the SDK's `logger` channel, which is why
   `loggerLevel` must stay `trace`; `SDK_LIFECYCLE_HINTS` maps the six strings
   the SDK emits (`ws client ready`, `ws connect success`, `ws connect failed`,
   `client closed`, `ws error`, `receive pong`). If the pin is ever bumped, the
   test `finds every lifecycle hint in the installed SDK build` fails first and
   names what moved.
3. **No real-network staging test has been run.** Every assertion here is driven
   by a fake transport and a fake notifier; the real WebSocket has never been
   dialled from this repository. That is the one claim in this README that rests
   on the SDK's documented behaviour rather than on a test.

## Reading the referee

The referee's `price` post carries **four different numbers**, and conflating
them is the most expensive mistake available here. Per `docs/close-1-referee.md`:

| Field | Meaning | What we do with it |
| --- | --- | --- |
| `applied` | the reference *this* sweep's trades were checked against | verified against existing trades only |
| `ref.px` | this sweep's **close** — prices fees/clawback, sets the next band | stored as `close`, used as the pricing baseline |
| `limits` | the band the referee will enforce on the **next** sweep | copied verbatim; a new offer is bounded by this, never by a locally rebuilt ±5% |
| `for` | the sweep `limits` apply to | must equal `n + 1`; any other value is `limits_for_mismatch` → conservative mode |
| `age_s` | seconds from `ref.time` to the close | the staleness input, persisted |

`ref.px` is never promoted into the historical reference, and the official
reference is never rewritten or back-adjusted. When a post omits `applied`, the
previous close is the only stand-in used.

**Stale reference.** When `age_s > MAX_REFERENCE_AGE_SECONDS` (default 60) the
snapshot is marked `staleReference`: the official reference still stands and the
reader keeps reading, but no **new** active maker trade is built and external
offers are refused. Staleness is derived only from the referee's own `age_s`,
never from the local clock — a replay read days later is not a stale feed.
`STALE_REFERENCE_MODE=off` disables the signal for fixtures.

**External offers.** An offer from another owner is refused unless it stays
inside the published band *and* inside `MAX_EXTERNAL_OFFER_QTY`,
`MAX_EXTERNAL_OFFER_NOTIONAL`, and a worst-case clawback estimate plus
`MAX_CLAWBACK_BUFFER`. The future close a new trade settles against is unknown,
so the estimate is deliberately the pessimistic side; a local estimate passing
is not a claim that the referee will settle.

**Rooms: unlisted, omitted, missed.** `room_registry` records where a room was
listed and when it fell off; `referee_anomalies` records every `unlisted`,
`omitted` and `missed` the referee reports, with the raw payload. `close1` is
always listed. Only owner registration, room registration and a signed trade
count as activity — offers and chatter do not. `omitted` means the referee did
not see the post; it is not `failed` and not `mint_unknown`. `missed` names a
message the referee did not read; where it involves a local agent the original
is kept and re-published with a **new nonce**, never the old signed envelope.
Dynamic room discovery is bounded by `MAX_DISCOVERED_ROOMS`, and exceeding it is
a `room_overflow` alert rather than an unbounded number of polls.

**Sweep archive.** `CHALLENGE_ARCHIVE_BASE_URL` points at the published archive
(`.../close-1`). `ArchiveClient` reads `index.json`, `ArchiveVerifier` checks a
`full` record's bytes against the hash the signed post named and a `redacted`
record against its own `sha256`, and `ArchiveReconciler` compares local mints
with the archive's. A 404 is `archive_unavailable`, i.e. a recorded gap — never
a contest failure — and redacted records cannot restore private-room trade text.
The archive is an audit aid: it never overwrites a verified Technocore message
and never marks a mint as failed.

**`reason: funds` is ambiguous.** The referee does not say *which* side was
short, so `referee_funds_side` is always `unknown`. `trades` also stores a
locally computed `local_funds_side` and `funds_side_confidence`; the Lark report
labels it as a local inference, not a referee conclusion.

## Degradation ladder

The box is shared. Each tier is entered by measurement, and leaving it is
automatic once the pressure clears.

| Trigger | What stops |
| --- | --- |
| RSS > 70% | model calls, compression/archiving |
| RSS > 85% | active trading (the reader keeps running) |
| event loop lag > 250 ms for 60 s | weekly backfill, archiving |
| disk > 75% | normal history is compressed |
| disk > 85% | verbose debug, non-essential archiving |
| disk > 90% | new active trading; a Lark critical alert is sent |
| disk > 95% | read-only protection mode |
| writer queue > 100 | new active offers |
| model queue > 5 | low-priority tasks are dropped |

```bash
pnpm disk-report           # sizes, retention windows, and what maintenance would do
```

## Release procedure

**The runtime never applies an upstream change.** `upstream-monitor` polls the
official repository every 12 minutes (ETag / `If-Modified-Since`), records the
commit, the release, and the hashes of `manifest.json`, `contest.json`,
`close-call-game.md` and `close_call_fold.py`, and stops there. It never runs
`git pull`, `npm install`, `pnpm update`, or `systemctl restart`, and
`ReleaseManager.assertNoAutomaticApply()` throws if a future patch tries to wire
that in.

A release is a human sequence:

```bash
# fetch, then build a candidate beside the current release
/opt/flop-close-call/releases/<version>/
/opt/flop-close-call/current -> releases/<version>/

pnpm install --frozen-lockfile
pnpm lint && pnpm typecheck && pnpm test && pnpm build
pnpm verify:all
# official fold comparison, then a dry-run
# human confirmation
ln -sfn /opt/flop-close-call/releases/<version> /opt/flop-close-call/current
sudo systemctl restart flop-close-call
curl -s localhost:8780/health
# on failure: point `current` back and restart
```

The rollback moves a symlink, so it cannot switch the database, the key bundle or
the environment file: those are absolute paths under `shared/` and `secrets/`,
outside every release.

If the referee's seed quotes a package hash that disagrees with the pin, active
trading stops, the reader keeps reading, both hashes are recorded, and a Lark
critical alert goes out. Nothing switches automatically.

## Acceptance

```bash
pnpm install --frozen-lockfile
pnpm lint
pnpm typecheck
pnpm test
pnpm build
pnpm verify:all          # reference hashes, fold parity, identity invariants, schema
pnpm soak-test           # 150 agents, 288 sweeps, kill -9, disk and Lark fault injection
pnpm soak-test --quick   # the same script, 30 agents and 36 sweeps
pnpm cost-report
pnpm disk-report
```

`pnpm soak-test` prints the resource numbers against their targets. The last
recorded run of the full 24-hour rehearsal:

| Metric | Target | Observed |
| --- | --- | --- |
| RSS average | < 600 MiB | 179 MiB |
| RSS peak | < 1.2 GiB | 191 MiB |
| CPU duty cycle at the real 5-minute cadence | < 35% | 0.01% (29 ms per sweep) |
| event loop lag | < 100 ms | 5.0 ms |
| participation rows / readback | 150 / 150 | 150 / 150 |
| cursor sequences lost | 0 | 0 |
| nonce rollbacks | 0 | 0 |
| duplicate trade ids | 0 | 0 |
| duplicate Lark report ids | 0 | 0 |
| model calls in a blocked window | 0 | 0 |
| model calls per day | ≤ 3 | 3 |
| stale agents outside the window | 0 | 0 |
| SQLite integrity | `ok` | `ok` |

## What this deliberately does not do

- **No weekly heartbeat.** The published contest repository does not require one,
  so nothing here posts on a timer to look busy.
- **No forced trading.** A group that finds no reason to trade records
  `NO_TRADE`, and that is a valid outcome. A trade is never manufactured to fill
  a quota.
- **No per-agent rooms.** `close1` is already registered; 150 trading rooms would
  be 150 ways to violate the rules.
- **No trades between our own DIDs.** Moving value between two keys we hold pays
  two fees and gains nothing, so `local_did` is a refusal.
- **No community rules.** Only the pinned package counts. A tweet is not a rule,
  and a room message is untrusted data — nothing in it is ever executed.
- **No automatic release.** See above; a human decides.

## Layout

```
apps/orchestrator/src/     main, cli, config, scheduler, reader, writer, lark,
                           llm, health, load-guard, upstream-monitor,
                           archive-maintenance
packages/identity/         did:key, canonical JSON, signing, nonces, key store,
                           control proofs, inventory, age backup
packages/close-call/       Decimal, clawback fee, risk ledger, trade terms and
                           signatures, the validator, the official fold port
packages/strategy/         indicator maths, the five profiles, the deterministic
                           gate, the group runner, parameter bounds
packages/technocore/       client, protocol, room reader/writer, cursor store,
                           referee verifier, archive, retry, package pin
packages/storage/          SQLite (WAL) schema, repositories, retention, backup
tests/                     27 files covering the invariants above
scripts/                   build, verify-all, soak-test, cost-report, disk-report,
                           generate-identities, verify-backup
reference/                 the vendored, hash-pinned official artifacts
```
