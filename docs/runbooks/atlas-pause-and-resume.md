# Runbook: Atlas pause and resume

**Status:** LOCAL-VERIFIED for the local pause file (real receipt in
`docs/AUTONOMY-V0.md`'s "Kill-path, real file" section) and IMPLEMENTED-LOCAL
for the Telegram `/pause`/`/resume` handlers (code-reviewed against
`telegram.ts`; no fresh live-bot receipt captured in this pass).

Three independent pause surfaces exist. They do **not** all stop the same
things — read the table below before assuming one covers another.

## When to use

- Something Atlas is doing (autonomy loop, `/task` subprocess, swarm
  decompose) needs to stop immediately and you are not sure why.
- Before a risky manual operation on the machine Atlas also runs on, to make
  sure no autonomous process interferes.
- Routine safety check before/after a deploy that touches autonomy paths.

## Preconditions

- For the Telegram surfaces: you are the CEO chat (`TELEGRAM_CEO_CHAT_ID`)
  — the inbound-auth middleware in `telegram.ts` drops every other sender,
  and both `/pause` and `/resume` are already gated by that same middleware
  (no separate check inside the handlers).
- For the local desktop-tray surface: the tray app is running
  (`apps/desktop/start-atlas-tray.cmd`) or you have shell access to write
  the pause file directly.

## The three surfaces

| Surface | Exact command | What it stops | What it does NOT stop | Durability |
|---|---|---|---|---|
| **Local pause file** | Desktop tray **PANIC** button, or manually: `echo 1 > "$USERPROFILE/.atlas/PAUSE"` (override path via `ATLAS_PAUSE_FILE`) | Any **local** Atlas process reading `isPaused()` (`src/atlas/spend-policy.ts`) — the CLI, the `/task` subprocess spawner (`task-spawner.ts`'s `runTask()` returns `blocked`) | The deployed Railway bot process (separate machine/env) | Until the file is deleted — survives local process restarts, not a Railway redeploy (irrelevant, different machine) |
| **Telegram `/pause`** (instant, process-local) | Send `/pause` to the bot | Sets `process.env.ATLAS_PAUSE='1'` **inside the running bot process**: halts the autonomous brain-loop, swarm decompose, and the `/task` subprocess spawner for that process | Does not survive a Railway redeploy/restart (lives only in that process's env); does not stop the HTTP bot itself — normal CEO chat still works | Until `/resume` or a redeploy |
| **Railway env var `ATLAS_PAUSE=1`** (durable) | Railway dashboard → bot service → Variables → set `ATLAS_PAUSE=1` → redeploy/restart | Same halt scope as Telegram `/pause`, but survives redeploys — `isPaused()` reads it live | Nothing extra beyond the process-local pause's scope | Durable until manually cleared in the dashboard |

## Exact safe commands

- **Check pause state locally (read-only):**
  ```
  node dist/cli.js health
  ```
  (Exit code and health report reflect current process state; does not
  itself reveal the pause file directly, but any subsequent local
  autonomy-affecting command will report `blocked` if paused.)
- **Pause via Telegram:** send `/pause` in the CEO chat. Bot replies with
  one of:
  - `⏸ ATLAS_PAUSE=1 — автономия остановлена (этот процесс, до рестарта). Для устойчивой паузы задай переменную на Railway. /resume чтобы снять.`
  - `Не удалось выставить паузу — проверь логи.` (failure — check Railway
    logs)
- **Resume via Telegram:** send `/resume`. Bot replies with one of:
  - `▶️ Пауза снята (этот процесс). Если на Railway стоит ATLAS_PAUSE — сними её там тоже, иначе рестарт вернёт паузу.`
  - `Пауза всё ещё активна — вероятно ATLAS_PAUSE задан в окружении Railway.`
    (means the durable Railway var is still set — clear it in the
    dashboard, not just in chat)
- **Local pause file, manual (no tray running):**
  ```
  echo smoke > ~/.atlas/PAUSE
  node dist/cli.js autonomy-tick --notify
  ```
  Expect: `[autonomy-tick] ... state=paused — ATLAS_PAUSE active — tick
  skipped before observing` (real receipt, `docs/AUTONOMY-V0.md`). Resume:
  ```
  rm ~/.atlas/PAUSE
  node dist/cli.js autonomy-tick
  ```
  Expect: `[autonomy-tick] ... state=observed — dry-run (notify not
  requested)`.
- **Health check after any pause/resume action (cloud):**
  ```
  curl -s https://fantastic-generosity-production-df90.up.railway.app/health
  ```
  Expect `{"status":"ok",...}` HTTP 200 — the pause never stops the health
  endpoint or normal CEO chat, only autonomy.

## Expected receipts

- The bot's exact reply text for `/pause`/`/resume` (paste verbatim — the
  reply text itself indicates which of the two failure/success branches
  fired).
- For the local pause file: the `autonomy-tick` state line (`state=paused`
  or `state=observed`) — this is the ground-truth check, not the presence
  of the file itself, since `isPaused()` is the single source of truth
  `autonomy-tick` reads.
- For the Railway durable var: a screenshot or copy of the Variables tab
  showing `ATLAS_PAUSE=1` (or absent) — do not rely on chat replies alone
  to confirm the durable state, since the CEO chat can only see the
  *current process's* view.

## Failure symptoms

| Symptom | Likely cause | Action |
|---|---|---|
| `/resume` says pause is still active | Railway env var `ATLAS_PAUSE=1` is durable-set | Clear it in the Railway dashboard, not just in chat |
| Local pause file deleted but `autonomy-tick` still reports paused | Wrong path — check `ATLAS_PAUSE_FILE` override wasn't left set in the shell env, or the tray is using a different path than you edited manually | `echo $ATLAS_PAUSE_FILE`; align both to the same path |
| `/pause` / `/resume` produces no reply at all | Message not from the authorized CEO chat (inbound-auth middleware silently drops it, logging `[auth] dropped message from unauthorized chat` server-side only) | Confirm you're messaging from the `TELEGRAM_CEO_CHAT_ID` chat |
| Bot itself unresponsive after pause | Pause does not stop the bot process — if it's unresponsive, that's a separate incident (see PANIC.md lever 3, hard stop) | Escalate per PANIC.md, not this runbook |

## Abort / rollback

All three surfaces are self-reversing (`/resume`, deleting the pause file,
clearing the Railway var) — there is no state these actions can corrupt.
None of them touch `state/exec-graph/`, the ledger, or any persisted task
data; pause only gates autonomy entry points (`isPaused()` checks in
`task-spawner.ts`, `autonomy-loop.ts`, the brain-loop, swarm decompose).

## Escalation owner

- **Atlas / CEO** — routine pause/resume, no escalation needed; this is a
  self-service safety control by design (see `docs/PANIC.md`).
- **External CTO** — if a pause fails to actually halt autonomy (i.e. an
  autonomous action executes despite `ATLAS_PAUSE=1` being confirmed set —
  this would be a guardrail bug, treat as high-priority).
