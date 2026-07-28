# Atlas Bootstrap Runbook

> **P1.4 — bare machine to running Atlas from this repo alone.**
> Produced: 2026-07-28 · Wave D of P1-RECOVERABILITY.

---

## 1. What you are rebuilding

Atlas has four runtime layers that must be restored together:

1. **Cloud bot** — a Docker container on Railway (`atlas telegram`) that polls Supabase and delivers CEO messages via Telegram.
2. **Local runner** — an `atlas runner start` process on your Windows machine that claims commands from `atlas_command_queue` and executes them locally.
3. **Supabase database** — eight tables plus four RPCs; the single source of truth for commands, sessions, heartbeats, and spend. Must be seeded from `db/migrations/` in MANIFEST order.
4. **Local state** — the `state/` dirs (exec-graph, evidence, goal-budgets) and `~/.atlas/` (spend receipts, instance lease, notify queue). Restored from a dated archive when available; defaults to empty on a fresh machine.

---

## 2. Prerequisites

Verify before starting. Every check is read-only.

| Tool | Min version | Check command | Expected output |
|------|-------------|---------------|-----------------|
| Node.js | ≥ 22.13.0 | `node --version` [tested] | `v22.x.x` or higher |
| npm | bundled with Node | `npm --version` [tested] | `10.x.x` or higher |
| Git | any recent | `git --version` [tested] | `git version 2.x.x` |
| Docker | any recent | `docker --version` [tested] | `Docker version 29.x.x` |
| Railway CLI | any recent | `railway --version` [UNTESTED] | prints version |
| Claude CLI | optional | `claude --version` [UNTESTED] | needed only for executor seat |

Current verified versions on this machine: Node v24.14.0, Git 2.53.0.windows.1, Docker 29.5.2 [tested].

No `.nvmrc` exists. Use any Node ≥ 22.13.0 (set in `package.json` `engines` field, line 29).

---

## 3. Repo checkout, install, build, test

```bash
# 1. Clone
git clone https://github.com/ganbaroff/atlas-cli.git
cd atlas-cli

# 2. Install dependencies (--legacy-peer-deps matches the Dockerfile)
npm install --legacy-peer-deps
```

Expected: resolves ~400 packages, no `npm ERR!` lines. [UNTESTED on a fresh machine — Dockerfile uses `npm ci --legacy-peer-deps` which is the production path]

```bash
# 3. Build
npm run build
```

Expected: tsup bundles `dist/cli.js` and `dist/learning-api.js`, then
`copy-manifests.mjs` runs. No TypeScript errors. [verified in a clean detached
checkout at exact source commit `57042ed`: `npm run build` exit 0]

```bash
# 4. Type-check (zero-tolerance — must be clean before any commit)
npx tsc --noEmit
```

Expected: silent exit 0. [tested — clean on this branch]

```bash
# 5. Full test suite
npx vitest run 2>&1 | tee /tmp/vitest-run.txt
```

Clean detached verification at exact source commit `57042ed`: `npx vitest run`
exit 0 — 123 files, 1036 passed, 2 skipped, 0 failed. Focused runner suite:
4 files, 75/75 passed.

The 2 skipped tests are live-provider guards (`it.skipIf(!process.env['NVIDIA_API_KEY'])`); they skip when the key is absent and are not regressions.

---

## 4. Database

### 4a. Apply migrations to a new Supabase project

You need a Supabase project with its connection string. Apply all 8 migrations in MANIFEST order:

```bash
# Set DATABASE_URL to your Supabase postgres connection string (not the REST URL)
export DATABASE_URL="postgresql://postgres.<project-ref>:<password>@<host>:5432/postgres"

# Apply in MANIFEST order (000 → 001 → ... → 007)
for f in db/migrations/0*.sql; do
  echo "Applying $f ..."
  psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f "$f"
done
```

[UNTESTED against a live Supabase — the loop pattern was verified against local Docker during Waves A–C; the psql command shape is identical]

All migrations are idempotent (IF NOT EXISTS / CREATE OR REPLACE / guarded DO blocks), so re-running is safe. Migration 000 creates roles needed for vanilla Postgres; Supabase provides them natively, so 000 is a no-op on Supabase.

Full migration map: `db/migrations/MANIFEST.md`.

Objects created per migration:

| File | Objects |
|------|---------|
| `000_roles_bootstrap.sql` | roles `service_role`, `anon`, `authenticated` (no-op on Supabase) |
| `001_emotional_memory.sql` | `atlas_learnings`, RPCs `recall_atlas_memories` + `bump_recall_count` |
| `002_learning_decisions.sql` | `learning_decisions`, `learning_outcomes` |
| `003_bot_sessions_messages.sql` | `bot_sessions`, `bot_messages` |
| `004_bot_heartbeats.sql` | `bot_heartbeats` |
| `005_command_queue.sql` | `atlas_command_queue`, RPCs `claim_next_command` + `sweep_stale_commands` |
| `006_llm_spend.sql` | `llm_spend` (with `correlation_id`; supersedes stray `db/llm_spend.sql`) |
| `007_rls_learning_tables.sql` | RLS catch-up for `learning_decisions` + `learning_outcomes` |

### 4b. Safe rehearsal with local Docker first

Before touching a live Supabase, run the restore drill against a scratch local container. This proves migrations apply cleanly and all 8 tables + 4 RPCs are healthy:

```bash
node --import tsx scripts/restore-drill.mts
```

Expected: `=== DRILL COMPLETE: 48 PASS, 0 FAIL ===` and container removed. [tested — two idempotent runs 2026-07-28, see `docs/atlas-cto/RESTORE-DRILL-RECEIPT-2026-07-28.md`]

Requires Docker running locally. The drill is fully self-contained — it spins up `postgres:15`, applies all migrations, runs agent-faithful smoke tests (queue round-trip, spend write/read, learnings recall), then tears down.

---

## 5. Environment variable table

Copy `.env.example` to `.env` and fill in the values marked **required**. All other vars are optional overrides or internal.

**How to read the "Where set" column:**
- **Railway** — set in Railway service environment (dashboard → Variables)
- **local .env** — set in `.env` file in repo root, loaded by `cli.ts` at startup
- **Both** — needs to be set in Railway for the cloud bot AND in `.env` for the local runner
- **runtime** — set programmatically; not an operator config

### LLM providers (set at least one; precedence: NVIDIA → Ollama → freellmapi → Gemini → Groq → OpenRouter → Anthropic)

| Name | What it does | Where set | Required |
|------|-------------|-----------|----------|
| `FREELLMAPI_API_KEY` | Free gateway API key | Both | No (but needed if using freellmapi) |
| `FREELLMAPI_BASE_URL` | Free gateway endpoint (must pair with key) | Both | No |
| `GEMINI_API_KEY` | Gemini provider | Both | No |
| `GROQ_API_KEY` | Groq provider | Both | No |
| `NVIDIA_API_KEY` | NVIDIA NIM provider (free tier, preferred) | Both | No |
| `ANTHROPIC_API_KEY` | Anthropic provider (paid; set `ATLAS_ALLOW_PAID=1` too) | Both | No |
| `ANTHROPIC_MODEL` | Anthropic model override | Both | No |
| `OPENROUTER_API_KEY` | OpenRouter provider (paid) | Both | No |
| `OPENAI_API_KEY` | OpenAI — used for Telegram voice transcription | Both | No |
| `AZURE_OPENAI_API_KEY` | Azure OpenAI key (needs `AZURE_OPENAI_ENDPOINT` too) | Both | No |
| `AZURE_OPENAI_ENDPOINT` | Azure OpenAI endpoint URL | Both | No |

### Telegram bot

| Name | What it does | Where set | Required |
|------|-------------|-----------|----------|
| `TELEGRAM_BOT_TOKEN` | Bot authentication — required for `atlas telegram` | Both | **Yes (bot)** |
| `TELEGRAM_CEO_CHAT_ID` | CEO Telegram chat ID for morning briefing + remote delivery | Both | No (briefing/remote silent if absent) |
| `TELEGRAM_CREATOR_BOT_TOKEN` | Second content bot (distinct from main bot) | Both | No |

### Supabase / database

| Name | What it does | Where set | Required |
|------|-------------|-----------|----------|
| `SUPABASE_URL` | Supabase project REST URL | Both | **Yes (any DB op)** |
| `SUPABASE_SERVICE_ROLE_KEY` | Supabase service-role API key | Both | **Yes (any DB op)** |
| `DATABASE_URL` | Postgres connection string for DB export in backup script | local .env | No (DB export skipped if absent) |

### Memory and filesystem paths

| Name | What it does | Where set | Required |
|------|-------------|-----------|----------|
| `MEMORY_ROOT` | Root for Atlas memory vault (Dockerfile sets `/app`; local default `~/Projects/VOLAURA`) | Both | No |
| `VOLAURA_ROOT` | VOLAURA repo root path | local .env | No |
| `ATLAS_EXEC_GRAPH_DIR` | exec-graph state dir (default: `state/exec-graph`) | local .env | No |
| `ATLAS_EVIDENCE_DIR` | Evidence ledger dir (default: `state/evidence`) | local .env | No |
| `ATLAS_GOAL_BUDGET_DIR` | Goal budgets dir (default: `state/goal-budgets`) | local .env | No |
| `ATLAS_SPEND_RECEIPT_DIR` | Spend receipts dir (default: `~/.atlas`) | local .env | No |
| `ATLAS_INSTANCE_LEASE_DIR` | Instance lease file dir (default: `~/.atlas`) | local .env | No |
| `ATLAS_BREADCRUMB_DIR` | Session breadcrumb dir (default: `~/.atlas`) | local .env | No |
| `ATLAS_NOTIFY_QUEUE_PATH` | Notify queue file path (default: `~/.atlas/notify-queue.json`) | local .env | No |
| `ATLAS_PROVIDER_HEALTH_DIR` | Provider health snapshots (default: `~/.atlas`) | local .env | No |
| `ATLAS_HAND_MANIFEST_DIR` | Hand manifest dir (default: `state/`) | local .env | No |
| `ATLAS_OPSBOARD_EXCHANGE_DIR` | OPSBOARD exchange dir | local .env | No |
| `ATLAS_LEARNING_EXCHANGE_DIR` | Learning request/receipt exchange dir | local .env | No |
| `ATLAS_LEARNING_STATE_DIR` | Learning state dir (alias for exchange dir) | local .env | No |
| `ATLAS_LEARNING_RECEIPTS_BUCKET` | GCS bucket for learning receipts (remote push) | Both | No |
| `ATLAS_LEARNING_API_KEY` | Auth key for learning HTTP API | Railway | No |
| `ATLAS_LEARNING_CLAIM_LEASE_MS` | Claim lease duration ms (default: 60000) | Both | No |
| `ATLAS_PERSPECTIVES_PATH` | Perspectives config path override | local .env | No |
| `ATLAS_POLICY_PATH` | Policy file path override | local .env | No |

### FinOps caps and kill switches

| Name | What it does | Where set | Required |
|------|-------------|-----------|----------|
| `ATLAS_DAILY_TOKEN_CAP` | Global daily token ceiling (default: 500000) | Both | No |
| `ATLAS_ALLOW_PAID` | Set `1` to allow paid providers (default: `0`) | Both | No |
| `ATLAS_PAUSE` | Kill switch: `1` halts brain-loop and swarm | Both | No |
| `ATLAS_BRAIN_QUEUE_CAP` | Max brain-loop seeds per UTC day (default: 20) | Both | No |

### Screen capture and autonomy

| Name | What it does | Where set | Required |
|------|-------------|-----------|----------|
| `ATLAS_CAPTURE_DIR` | Screen capture output dir (default: OS temp) | local .env | No |
| `ATLAS_CAPTURE_SCRIPT` | Screen capture script override | local .env | No |
| `ATLAS_SCREEN_MAX_PER_HOUR` | Max screen captures per hour | local .env | No |
| `ATLAS_SCREEN_VISION` | Vision mode flag | local .env | No |
| `ATLAS_REPO_WATCH_ROOTS` | Comma-separated repo paths to watch | local .env | No |
| `ATLAS_REPO_WATCH_INTERVAL_MIN` | Repo watch check interval (minutes) | local .env | No |
| `ATLAS_REPO_WATCH_STATE` | Repo watch state file path | local .env | No |
| `ATLAS_ALERT_STATE_FILE` | Alert state file path (default: `~/.atlas/alert-state.json`) | local .env | No |
| `ATLAS_AUTONOMY_TEST_STATE_FILE` | Autonomy test notify state file | local .env | No |

### Swarm timeouts

| Name | What it does | Where set | Required |
|------|-------------|-----------|----------|
| `ATLAS_SWARM_WORKER_TIMEOUT_MS` | Per-worker timeout (default in source) | Both | No |
| `ATLAS_SWARM_JUDGE_TIMEOUT_MS` | Judge timeout | Both | No |
| `ATLAS_SWARM_GLOBAL_TIMEOUT_MS` | Global swarm timeout | Both | No |
| `ATLAS_SWARM_ROUTING_TIMEOUT_MS` | Routing timeout | Both | No |

### Tool guards and shell

| Name | What it does | Where set | Required |
|------|-------------|-----------|----------|
| `ATLAS_SHELL_ALLOW_DESTRUCTIVE` | Set `1` to allow destructive shell ops | local .env | No |
| `ATLAS_SHELL_AUDIT_LOG` | Shell audit log path (default: OS temp) | local .env | No |
| `ATLAS_AGENT_ID` | Agent identity for tool guards (`autonomy` / `ceo`) | runtime | No |
| `ATLAS_AUTONOMY` | Autonomy flag for tool guards | runtime | No |
| `ATLAS_WORKSPACE_ROOT` | Workspace root for fs-guard (default: `process.cwd()`) | local .env | No |
| `ATLAS_READONLY` | Read-only mode — set by CLI when another instance holds the lease | runtime | No |
| `ATLAS_CAVEMAN_SHRINK` | Caveman shrink mode | local .env | No |

### Operator integrations

| Name | What it does | Where set | Required |
|------|-------------|-----------|----------|
| `ATLAS_OPENMANUS_CWD` | OpenManus project dir (default: `C:/Projects/OpenManus`) | local .env | No |
| `DAYTONA_API_KEY` | Daytona sandbox API key (enables OpenManus sandbox dispatch) | local .env | No |

### Infrastructure / platform

| Name | What it does | Where set | Required |
|------|-------------|-----------|----------|
| `PORT` | Health HTTP server port (default: 3000; Railway sets this automatically) | Railway | No |
| `NODE_ENV` | `production` in Railway (set in Dockerfile) | Railway | No |
| `POSTHOG_API_KEY` | PostHog analytics (optional) | Both | No |
| `POSTHOG_HOST` | PostHog host URL | Both | No |
| `K_REVISION` | Cloud Run revision (auto-injected by Cloud Run, used as worker ID) | runtime | No |

**Total: 57 named environment variables catalogued.**

---

## 6. Cloud bot (Railway)

The cloud bot runs `atlas telegram` inside the Dockerfile. It exposes a `/health` HTTP endpoint on `$PORT` (default 3000).

### Create the Railway service

```bash
# In the repo root, with Railway CLI logged in:
railway link        # link to existing project, or
railway init        # create a new project

railway up          # build from Dockerfile and deploy
```

[UNTESTED — command shape is standard Railway CLI; actual deploy was done via Railway dashboard + git push in the project history]

Railway uses `railway.json` (already in repo) which specifies:
- Builder: `DOCKERFILE` (uses repo `Dockerfile`)
- Health check path: `/health`, timeout 30s
- Restart policy: `ON_FAILURE`, max 5 retries

### Variables to set in Railway dashboard

At minimum (copy from your `.env`):

```
TELEGRAM_BOT_TOKEN
SUPABASE_URL
SUPABASE_SERVICE_ROLE_KEY
TELEGRAM_CEO_CHAT_ID
```

Plus at least one LLM provider key, e.g. `NVIDIA_API_KEY` or `GROQ_API_KEY`.

`PORT`, `NODE_ENV`, and `MEMORY_ROOT` are already set by the Dockerfile.

### Health check

Once deployed, poll the health endpoint:

```bash
curl https://<your-railway-app>.up.railway.app/health
```

Expected response shape:

```json
{
  "status": "ok",
  "bot": "<telegram-bot-username>",
  "uptime": "2min",
  "providers": 2,
  "bootTime": "2026-07-28T12:00:00.000Z"
}
```

`bootTime` proves the process started. `providers` > 0 proves at least one LLM key is wired. `bot` not `"booting"` proves Telegram handshake succeeded. [tested — endpoint shape verified from source `src/telegram.ts:841-853`]

The live Railway URL is `https://volauraapi-production.up.railway.app/health` (from `src/atlas/deploy.ts:19`).

---

## 7. Local runner

The local runner claims commands from `atlas_command_queue` and executes them on this machine. It requires `SUPABASE_URL` + `SUPABASE_SERVICE_ROLE_KEY` in `.env`.

### Start manually (foreground)

```bash
# Using the compiled binary:
node dist/cli.js runner start

# Or via tsx (dev mode, slower start):
npx tsx src/cli.ts runner start

# Custom poll interval (default 15s):
node dist/cli.js runner start --interval 30
```

Expected log line on start: `[runner] Starting local runner (interval 15s). Ctrl+C to stop.` followed by `[runner] workerId=<id>`. [tested — matches source `src/cli.ts:1432-1450`]

Ctrl-C for a clean stop.

### Check if runner is alive

```bash
node dist/cli.js runner status
```

Expected when running:

```json
{
  "status": "running",
  "pid": 12345,
  "startedAt": "2026-07-28T10:00:00.000Z",
  "heartbeatAt": "2026-07-28T10:05:00.000Z",
  "heartbeatAgeMs": 1200,
  "authEnforcement": "on",
  "build": {
    "entryPath": "C:\\Users\\user\\OneDrive\\Documents\\GitHub\\ANUS\\dist\\cli.js",
    "builtAt": "2026-07-28T09:15:00.000Z",
    "freshnessAtStart": "fresh"
  }
}
```

`status: "running"` proves a live lease carries the runner marker.
`status: "occupied"` is a non-success result: a fresh live Atlas lease exists
without that runner marker.

Only a marked runner declares `authEnforcement` and `build` into the instance
lease at startup; readers merely return those declarations. They describe the
running process, not the shell you typed this in. A reader with no `.env`
loaded still gets the runner's real state. A pre-fix or non-runner lease reports
`occupied` and does not emit auth or build fields.

Binary probes in a clean detached checkout at exact source commit `57042ed`:

- Empty status ⇒ `not-started`, exit 1, no lease.
- Live unmarked holder ⇒ `occupied`, exit 1, no auth/build.
- Competing start ⇒ exit 1 refusal.
- Newer source mtime ⇒ stale start exits 1 before runner annotation.

### Autostart via Windows Task Scheduler

Desired state: register a task that starts the runner at login (requires admin
elevation). Point it at the wrapper, **not** at `dist\cli.js` directly — the
wrapper rebuilds `dist/` before launching:

```powershell
schtasks /Create /TN "AtlasRunner" /TR 'cmd /c "C:\Users\user\OneDrive\Documents\GitHub\ANUS\scripts\start-runner.cmd" --interval 20' /SC ONLOGON /F
```

Existing installations that still invoke `dist\cli.js` directly are not
migrated by this source change. Update the scheduled action only during the
authorized runtime cutover, then verify wrapper log plus `runner status`.

The wrapper appends everything (build output, runner log, exit code) to
`%USERPROFILE%\.atlas\runner-autostart.log` — read that first when the
runner is unexpectedly down.

[UNTESTED — requires admin elevation; was not dry-run. Same limitation applies to the backup task documented in `docs/runbooks/backup.md`.]

### Stale-build refusal

`runner start` compares the mtime of the `dist/cli.js` it is executing
against the newest non-test file under `src/`. If a source is newer, it
prints a `REFUSING TO START` block naming the offending file and exits `1`
**without claiming any work**.

This exists because on 2026-07-28 the autostarted runner was found executing
a build that predated `src/atlas/queue-auth.ts` entirely — the P0.1 signing
gate was inert and nothing said so. A stale build is invisible at runtime;
the only defence is a startup check.

```bash
# The fix is always the same:
npm run build
```

Escape hatch (logs a loud warning and starts anyway — do not leave this on):

```bash
node dist/cli.js runner start --allow-stale-dist
```

`ATLAS_ALLOW_STALE_DIST=1` does the same thing for the scheduled task.
The check reports `unknown` and stays out of the way when it cannot be
trusted: under `tsx` (source *is* the build) or in a deploy that ships no
`src/`.

To verify after registration:

```powershell
schtasks /Query /TN "AtlasRunner" /V
```

To remove: `schtasks /Delete /TN "AtlasRunner" /F`

**Note:** Admin elevation requirement was encountered during Wave C (backup scheduling). Run PowerShell as Administrator for both schtasks commands.

---

## 8. Backup and restore

Full documentation: `docs/runbooks/backup.md`.

### Take a backup

```bash
node --import tsx scripts/backup-atlas.mts
```

Produces a dated archive at `~/AtlasBackups/atlas-backup-<ISO-timestamp>/` containing state dirs and (when `DATABASE_URL` is set) per-table CSV exports. [tested — real archive produced 2026-07-28 with exit 0; see `docs/atlas-cto/RESTORE-DRILL-RECEIPT-2026-07-28.md` Wave C section]

### Prove restore (safe rehearsal, no live DB needed)

```bash
node --import tsx scripts/restore-drill.mts --backup-restore
```

Builds a scratch DB, exports fixtures, tears down, rebuilds, imports, verifies. Expected: `=== DRILL COMPLETE: 78 PASS, 0 FAIL ===`. [tested — 78/78 pass 2026-07-28]

### Restore from a real backup

1. Restore state dirs (see `docs/runbooks/backup.md` § "State dirs only").
2. Apply migrations to the target DB: `for f in db/migrations/0*.sql; do psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f "$f"; done` [UNTESTED against live Supabase]
3. Import CSVs from the archive's `db-export/` dir (see `docs/runbooks/backup.md` § "Database restore"). [UNTESTED against live Supabase — DB export was not produced on this machine because `DATABASE_URL` was unset]

---

## 9. Verification checklist

Run these in order. All are read-only. Expect the outputs shown.

```bash
# 1. Full suite
npx vitest run 2>&1 | tail -5
# Verified at exact source commit 57042ed in a clean detached checkout:
# exit 0; 123 files; 1036 passed; 2 skipped; 0 failed

# 2. TypeScript clean
npx tsc --noEmit && echo "tsc: clean"
# Expected: "tsc: clean"  [tested]

# 3. Build artifact present
ls dist/cli.js
# Expected: file listed  [tested]

# 4. Exec-graph snapshot consistent
node dist/cli.js graph verify
# Expected: {"ok":true,...}   [tested — command verified from source; requires state/exec-graph/ to exist]

# 5. Runner liveness (after atlas runner start)
node dist/cli.js runner status
# Expected: {"status":"running",...}  [tested — command verified from source]

# 6. Health endpoint (cloud bot running)
curl https://volauraapi-production.up.railway.app/health
# Expected: {"status":"ok","bot":"<name>","bootTime":"..."}  [UNTESTED — requires deployed bot]

# 7. Restore drill (local Docker required)
node --import tsx scripts/restore-drill.mts
# Expected: "48 PASS, 0 FAIL"  [tested]

# 8. Telegram round-trip (human check)
# Send /status to the Telegram bot. Expected: one-line status reply from Atlas.
# This is the CEO-reality check — no automated command can substitute for it.  [UNTESTED — requires live bot]
```

---

## 10. Honest gaps

| Gap | Status |
|-----|--------|
| **DB export in backup requires `DATABASE_URL`** | `DATABASE_URL` was not set on this machine; the DB export portion of the backup was skipped. The Wave C receipt documents this honestly. Set `DATABASE_URL` before running backup in production. |
| **Off-machine backup destination** | Backups are local-only (`~/AtlasBackups`). Off-machine destination (cloud storage, NAS, another host) is a pending operator decision — documented as an open CEO gate in `docs/runbooks/backup.md`. Until decided, local backups protect against accidental deletion but not machine loss. |
| **Live Supabase migration apply** | The migration loop was verified against local Docker only (Waves A–C). Applying to a live Supabase project is a CEO gate (see P1-MISSION-2026-07-28.md § "CEO gates"). |
| **`schtasks` runner autostart** | Both the runner autostart command and the backup scheduling command from `docs/runbooks/backup.md` are `[UNTESTED]` — they require admin elevation and were not dry-run. |
| **Railway deploy command** | `railway up` was not invoked during this wave. The cloud bot is already deployed; this command is provided for disaster recovery. |
| **Backup retention scoping** | The retention logic prunes only `atlas-backup-*` dirs inside the destination. Tested with synthetic dirs in Wave C; not tested against a populated production backup root. |

---

## Cross-references

- Migration order + object map: `db/migrations/MANIFEST.md`
- Restore drill script + receipts: `scripts/restore-drill.mts` · `docs/atlas-cto/RESTORE-DRILL-RECEIPT-2026-07-28.md`
- Backup script + scheduling: `scripts/backup-atlas.mts` · `docs/runbooks/backup.md`
- Mission record: `docs/atlas-cto/P1-MISSION-2026-07-28.md`
