# Runbook: morning brief and `/status`

**Status:** IMPLEMENTED-LOCAL for the exec-graph sections (tests green —
`src/__tests__/exec-graph-brief.test.ts`); the surrounding `/status` command
and the 08:45 scheduled brief are the pre-existing, deployed Telegram
surfaces (LIVE on Railway) — this pass only added the exec-graph appendage
to each, and that appendage itself has not yet been observed on a live bot
run (IMPLEMENTED-LOCAL, not LIVE-VERIFIED).

## When to use

- Daily: read the 08:45 Baku morning brief for what happened overnight,
  what's planned, and what's waiting on a CEO decision.
- On demand: send `/status` in the CEO Telegram chat for a live snapshot at
  any time (health, spend, queue, heartbeat, exec-graph counts).
- Debugging: either surface degrading to a partial/short message is a
  signal worth checking (see "Degradation behavior" below) — it's not
  necessarily broken, but it's worth confirming why.

## Preconditions

- You are the CEO chat (`TELEGRAM_CEO_CHAT_ID`) for both surfaces.
- The morning brief additionally requires `CEO_CHAT_ID` to be set at boot
  time — if unset, the bot logs `[briefing] skipped — TELEGRAM_CEO_CHAT_ID
  not set` and never schedules it (checked once at `boot()`, not re-checked
  per tick).

## Exact safe commands

- **On-demand status (Telegram):** send `/status` in the CEO chat.
- **On-demand status (CLI, local machine only, no exec-graph section):**
  ```
  node dist/cli.js status
  ```
  Note the CLI `status` command (`src/cli.ts`, "parity with Telegram
  /status" comment) prints `buildStatusReport()` only — health, spend,
  brain-loop queue, heartbeat. It does **not** append the exec-graph section
  the Telegram `/status` handler does; that section is wired only into
  `telegram.ts`'s `bot.command('status', ...)`. Use the Telegram surface if
  you specifically need exec-graph visibility.
- **Read-only exec-graph section preview (local, no Telegram needed):**
  ```
  node dist/cli.js graph status
  ```
  Same underlying `statusSummary()`/`listTasks()` data the Telegram
  `/status` section renders, formatted differently (CLI-native text vs.
  `exec-graph/brief.ts`'s `formatStatusMessage()`).
- **Health check underlying both surfaces:**
  ```
  node dist/cli.js health
  ```

## What reads what

**`/status`** (`telegram.ts`, `bot.command('status', ...)`):
1. `buildStatusReport()` (`src/atlas/status-report.ts`) — health checks +
   today's spend (`spend-tracker.ts`) + brain-loop queue depth
   (`spend-policy.ts`'s `getBrainQueueCount()`/`brainQueueCap()`) +
   heartbeat freshness.
2. Exec-graph section — lazy `import('./exec-graph/api.js')` +
   `import('./exec-graph/brief.js')`, calls `statusSummary()` +
   `listTasks()`, formats with `formatStatusMessage()`, appended in its own
   try/catch.

**Morning brief** (`telegram.ts`, `sendMorningBriefing()`, scheduled at
08:45 Baku via `scheduleMorningBriefing()`):
1. **Night** — first non-empty line of the last persisted health report
   (`readLastReport()`), falling back to a calm default string if none
   exists or the read fails.
2. **Today** — `readOperatorState()`'s `phase.next`, falling back to
   "продолжаю по текущему плану."
3. **Awaiting CEO** — `readOperatorState()`'s `last_run` status, only
   surfaced if the last run's status wasn't `success`; otherwise "ничего не
   блокирует — жду сигнала."
4. `composeMorningBriefing({night, today, awaitingCeo})`
   (`src/atlas/briefing.ts`) — appends today's in-memory spend line.
5. Exec-graph section — same lazy-import pattern as `/status`, calls
   `formatMorningBriefSection()` (decision-framed: escalated / in-progress /
   closed-in-last-24h), appended only if non-empty (a quiet graph adds
   nothing, not a blank trailer).
6. Sent via `bot.telegram.sendMessage(chatId, text.slice(0, 4096))`.

## Related but separate: the Chief-of-Staff (`cos`) surface (2026-07-19)

`src/atlas/cos/*` (ADR-0008) is a **newer, separate, read-only projection**
— NOT yet wired into either surface above. It answers the same underlying
question ("what needs the CEO's decision, what shipped, what's drifting")
but derives it into six fixed categories (CEO DECISION REQUIRED / WAITING
ON EXTERNAL OWNER / BLOCKED / DRIFT-STALE SIGNAL / RECENTLY VERIFIED / NO
ACTION REQUIRED) instead of the free-form `awaitingCeo` string
`briefing.ts`'s `composeMorningBriefing()` still takes today.

- **On demand (CLI, local machine only):**
  ```
  node dist/cli.js cos brief
  node dist/cli.js cos brief --json
  node dist/cli.js cos drift
  ```
- This is **local-only, IMPLEMENTED-LOCAL** — it has not been wired into
  `telegram.ts`'s `/status` or the 08:45 scheduled brief, and has no live
  Telegram verification receipt. Do not assume it appears on the deployed
  bot; it currently only runs where you invoke `atlas cos ...` directly.
- Full module contract, authority boundary, and known limitations:
  `src/atlas/cos/README.md`.
- Wiring this into `telegram.ts` (replacing `briefing.ts`'s hand-typed
  `awaitingCeo` with `composeCosBrief()`'s output) is explicitly future
  work, not done as part of the sprint that shipped this surface — see
  ADR-0008's Consequences.

## Degradation behavior (by design, not a bug)

- **Exec-graph read fails** (either surface): own try/catch around the
  dynamic import + read. `/status` appends `"\n\nExec-graph: не смог
  прочитать состояние задач."` and logs `[status error][exec-graph]`
  server-side. The brief just skips the section silently (logs
  `[briefing] exec-graph section failed:` server-side) — the rest of the
  brief still sends. Neither failure blocks the surrounding message.
- **`readLastReport()` fails** (brief only): caught, falls back to "бот
  работал стабильно, инцидентов не зафиксировано" — a calm default, not an
  error message, since a missing health report on a fresh checkout is
  expected, not exceptional.
- **`readOperatorState()` fails** (brief only): caught, falls back to
  "продолжаю по текущему плану" / "ничего не блокирует — жду сигнала."
- **Whole `/status` handler throws** (outer catch): replies with
  `"Не смог собрать статус, причина: <message>. Проверь логи бота."` and
  logs `[status error]` server-side — this is the only case that surfaces
  an explicit failure to the CEO instead of degrading quietly, because it
  means the core health/spend/queue report itself (not just the exec-graph
  appendage) couldn't be built.
- **Container ships state read-only** (Railway): `src/exec-graph/README.md`
  notes the image ships `state/` read-only, so a missing/empty graph must
  render "no tasks tracked," never take down the rest of the output — this
  is the exact scenario the exec-graph try/catch blocks above exist for.

## Expected receipts

- `/status` full reply text, pasted verbatim (shows whether the exec-graph
  section rendered, degraded, or was entirely absent due to an outer
  failure).
- Morning brief full text at 08:45 Baku, pasted verbatim, on the day you're
  verifying.
- If debugging a degradation: the corresponding server-side log line
  (`[status error][exec-graph]`, `[briefing] exec-graph section failed:`,
  or `[status error]`) from the Railway deploy logs.

## Failure symptoms

| Symptom | Likely cause | Escalation |
|---|---|---|
| `/status` shows core report but "не смог прочитать состояние задач" | Exec-graph state unreadable in the deployed environment (read-only image, or state genuinely empty/corrupt) | Atlas — not urgent, exec-graph is local-authority by design (see architecture doc's local/cloud boundary) |
| `/status` shows nothing at all, just the "не смог собрать статус" error | Core `buildStatusReport()` failed — a real regression | Atlas first, External CTO if it recurs after a fix attempt |
| Morning brief never arrives at 08:45 | `TELEGRAM_CEO_CHAT_ID` unset at boot (check deploy logs for `[briefing] skipped`), or the bot process wasn't running at 08:45 Baku | Atlas — check Railway env vars and process uptime |
| Morning brief arrives but has no exec-graph section | Expected when the graph has nothing to report (empty section is omitted, not sent blank) — not a bug | No action needed unless you expected tasks to be visible |

## Abort / rollback

Both surfaces are read-only against exec-graph (`statusSummary()` /
`listTasks()` — see `src/exec-graph/README.md`'s "Consumers" section: none
of them write to the graph). There is nothing to roll back; worst case is a
degraded/missing section, never a corrupted read.

## Escalation owner

- **Atlas** — routine degradation (exec-graph section missing/short).
- **External CTO** — core status/brief failure (the outer catch fires), or
  the exec-graph read consistently fails even when `atlas graph verify`
  passes locally (points to an environment-specific gap, e.g. a Railway
  volume/permissions issue).
- **CEO** — only if the brief schedule itself needs to change (time,
  timezone, or whether it should send at all) — a product decision, not an
  operational one.
