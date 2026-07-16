# Local Autonomy V0 (+ V0.1 notify hardening)

Implementation of `docs/AUTONOMY-RECOVERY-PLAN.md`'s minimal first loop.
**Status: IMPLEMENTED-LOCAL.** Not deployed, not wired into Railway, not
auto-started anywhere. Invoked only via `atlas autonomy-tick` /
`atlas autonomy-test-notify`.

Code: `src/atlas/autonomy-loop.ts`, `src/atlas/notify.ts` (canonical notify
layer, extended) · CLI: `atlas autonomy-tick [--notify]`,
`atlas autonomy-test-notify` · tests: `src/__tests__/autonomy-loop.test.ts`
(18), `src/__tests__/notify.test.ts` (+5 for `notifyCeoResult`).

## What it does

One tick: `isPaused()` check → observe (repo_watch + health-check, read-only)
→ compute a combined change signature → notify the CEO only if the signature
changed AND the rate-limit interval elapsed AND still not paused. Zero LLM
calls. The only shell execution anywhere in this path is repo_watch's own
`execFileSync('git', ...)` with a fixed subcommand set — the autonomy shell
whitelist in `policy.yaml` isn't even exercised.

```
node dist/cli.js autonomy-tick             # dry run, prints signals, sends nothing
node dist/cli.js autonomy-tick --notify    # sends IF changed + interval elapsed + not paused
```

## Two deviations from the plan, found by adversarial review, fixed before commit

An independent review (a fresh pass against the accepted plan + an explicit
"may NOT" checklist, run after the first implementation) caught two real
correctness issues:

1. **Heartbeat 3-strikes counter is architecturally dead in this invocation
   model.** The plan named `heartbeat-alert.ts`'s "3 consecutive stale
   readings" counter as a signal to reuse. That counter is an in-process
   module singleton with no persistence — it resets to 0 every fresh
   `atlas autonomy-tick` process, and V0 runs as a single-tick CLI
   invocation (no daemon), so the threshold can never be reached. Wiring it
   in would show a "consecutive stale" number that's always 0-1, never
   reflecting real history — exactly the kind of misleading status the whole
   recovery effort exists to prevent. **Fix:** dropped the
   `heartbeat-alert.ts` dependency entirely; heartbeat staleness is read
   through `runHealthCheck()`'s own file-based 'heartbeat' check instead,
   which is correct and process-independent (verified live: the real check
   caught a genuinely stale local heartbeat, 484h old, in the smoke test
   below).
2. **A real Telegram send failure was indistinguishable from "no CEO chat
   configured."** `notifyCeo()` (`notify.ts`) internally catches every send
   failure and returns `false` either way. Routing the send through it
   blindly meant a real network/API failure would silently read as "nothing
   to send" — the same false-completion failure mode that got the original
   `autonomousBrainLoop` killed. **Fix (V0.1, see below):** upstreamed into
   `notify.ts` itself as a new canonical function rather than left as an
   ad-hoc bypass in this module.

Both are documented in the module's own header comment, not just here.

## V0.1 hardening — canonical notify layer, controlled live test

A follow-up review requested the send-failure fix above be a real extension of
the shared notify layer, not a parallel notification authority living only in
this module. Delivered:

- **`notify.ts` gained `notifyCeoResult(kind, msg, send?)`** — returns a typed
  `NOT_CONFIGURED | SUPPRESSED | SENT | FAILED` outcome. The CEO chat ID is
  resolved **internally only** (`TELEGRAM_CEO_CHAT_ID`) — there is no
  parameter on this function, or anywhere in `autonomy-loop.ts`'s
  `RunTickOptions`, through which a caller can direct a send at a different
  chat ID. Proven by test (`notify.test.ts`: changing the target requires
  changing the env, not the call).
- **The legacy `notifyCeo()` (boolean contract) is unchanged** — `repo-watch.ts`
  and its existing tests needed zero modification.
- **`autonomy-loop.ts` now calls `notifyCeoResult()` exclusively.** It no
  longer reads `TELEGRAM_BOT_TOKEN` or resolves a chat ID itself — both moved
  into `notify.ts`'s `telegramSend()` / `resolveCeoChatId()` (the latter is
  deliberately unexported).
- **`atlas autonomy-test-notify`** — a one-off verification command. Sends
  exactly one fixed, clearly-prefixed message
  (`[ATLAS V0 TEST — NO ACTION REQUIRED]`, no signals/repo-paths/health
  internals in the body) through the canonical layer, rate-limited via its
  *own* state file (`~/.atlas/autonomy-test-notify.json`, separate from the
  production tick state) so it can never interfere with or be confused with a
  real autonomy signal.

### Controlled live test — V0.2 outcome: NOT_CONFIGURED (later found to be a false negative)

Running `atlas autonomy-test-notify` on this machine returned:
```
[autonomy-test-notify] attempted=true — notifyCeoResult -> NOT_CONFIGURED
[autonomy-test-notify] outcome=NOT_CONFIGURED
```
`TELEGRAM_CEO_CHAT_ID` was genuinely absent from the local ANUS `.env` at the
time. A bounded, name-only Railway variable lookup at the time used a `jq`
pipeline (`jq -r '.TELEGRAM_CEO_CHAT_ID // empty'`) and concluded
`KEY_NOT_FOUND_IN_RAILWAY`. **This conclusion was wrong** — see the compound-
sprint correction below.

### Compound-sprint correction (2026-07-17): the key was there all along

A follow-up bounded discovery pass listed **all** Railway variable names (not
just probing the one key) using a Python JSON parser instead of `jq` — because
`jq` turned out to **not be installed on this machine at all**
(`jq: command not found`). The original V0.2 script piped `jq`'s stderr to
`/dev/null` and had `|| true` on the pipeline, so the missing-binary failure
was silently swallowed and produced an *empty* `VALUE`, which the script
correctly-looking-but-wrongly reported as `KEY_NOT_FOUND_IN_RAILWAY` — a false
negative from a broken tool, not a true absence. The full name listing showed
`TELEGRAM_CEO_CHAT_ID` present in Railway the whole time, alongside
`TELEGRAM_BOT_TOKEN`.

Fixed transfer (Python-based, same safety contract: only ever prints the
target variable's *name*, never its value, in any tool output) wrote the real
value into local `.env`. Confirmed present: `awk -F= '{print $1}' .env | grep
-i telegram` → both `TELEGRAM_BOT_TOKEN` and `TELEGRAM_CEO_CHAT_ID`.

Re-running `atlas autonomy-test-notify` now returns a **different, more
specific** failure:
```
[notify] send failed kind=important: telegram HTTP 401
[autonomy-test-notify] attempted=true — notifyCeoResult -> FAILED
[autonomy-test-notify] outcome=FAILED
[autonomy-test-notify] error=telegram HTTP 401
```
A read-only diagnostic (`GET https://api.telegram.org/bot<token>/getMe` — no
chat ID involved, doesn't send anything) against the same `TELEGRAM_BOT_TOKEN`
also returns `401 Unauthorized`. **The bot token itself is dead** — not a
notify-logic bug, not a missing chat target. `notifyCeoResult`'s `FAILED`
classification worked exactly as designed (V0.1's whole point: a real send
failure must never read as "nothing configured" — and here it correctly
didn't, `FAILED` and `NOT_CONFIGURED` stayed distinguishable outcomes across
two different real failure modes on two different days).

**Current status: BLOCKED on a dead bot token — needs CEO-authorized key
rotation, out of scope for this sprint (no key rotation without CEO word).**
Once a live token is in place, this is the ONLY remaining gap before a real
SENT/SUPPRESSED duplicate-suppression proof and the Task Scheduler smoke.

### Task Scheduler smoke — not started

Gated on a live `SENT` result, which has not yet been reached (see above).

## Real receipts (this machine, 2026-07-16)

**Dry-run against live signals** (`atlas autonomy-tick`):
```
[autonomy-tick] 2026-07-16T20:57:39.949Z state=observed — dry-run (notify not requested)
Repo watch:
- ANUS: branch feat/arsenal-wiring, 5 dirty — 68dcc9a ...
- VOLAURA: branch feature/atlas-integration, 13 dirty — 450cce84 ...
Health: 1/7 checks failed: heartbeat
```
The failed heartbeat check is real — no local `atlas boot`/`atlas cron` has
run recently, so it's genuinely stale. This is the loop correctly catching a
real issue, not a bug.

**Kill-path, real file** (writing/removing `~/.atlas/PAUSE`, the same file
the desktop tray's PANIC button uses):
```
$ echo smoke > ~/.atlas/PAUSE && atlas autonomy-tick --notify
[autonomy-tick] ... state=paused — ATLAS_PAUSE active — tick skipped before observing
$ rm ~/.atlas/PAUSE && atlas autonomy-tick
[autonomy-tick] ... state=observed — dry-run (notify not requested)
```

## Explicitly not built (deferred, not forgotten)

- **No cloud wiring.** Per the plan's §6/§8, wiring this into Railway's
  `boot()` is a separate, CEO-approved second phase — not attempted here.
- **No continuous daemon.** The plan's staged rollout (60min trial → 15min
  settle) is satisfied by an OS-level scheduler (Windows Task Scheduler
  running `atlas autonomy-tick --notify` on an interval) — not a new
  always-on Node process. Task Scheduler already handles "run periodically,
  survive restarts, don't double-run" more robustly than reinventing it.
- **No queue-depth signal.** The plan marked this optional. No safe
  read-only count exists in `supabase-memory.ts` today (only
  `claimNextCommand`, which dequeues — forbidden). Adding one is a new
  Supabase query, out of scope for a minimal first loop.
- **The stale `"[brain-loop] autonomous planning"` log line in
  `src/telegram.ts`** (the old, still-inert `autonomousBrainLoop`) was
  flagged by both the plan and the adversarial review as worth fixing
  regardless of this work, but `telegram.ts` is the live, deployed control
  plane — touching it wasn't part of this package's scope and wasn't done.
  Noted for a future, deliberate pass.

## Tests

**`autonomy-loop.test.ts` (18):** paused-before-observing, silent-no-change,
silent-rate-limited, dry-run, notified + state persisted, paused-re-checked-
before-notify (send never attempted), notify-failed vs no-CEO-chat-configured
(must not collapse to the same reason), important vs error kind selection,
cannot-target-arbitrary-chat-ID (runtime + compile-time guard), and
`sendControlledTestNotification`'s own rate-limit + pause behavior. Gating-
logic tests use hand-constructed fixtures (mirroring `repo-watch.test.ts`'s
pattern) rather than two live `observe()` calls, since real git status of an
OneDrive-synced repo isn't guaranteed identical moments apart — an early
draft hit exactly this flake and was fixed by making the signal source
injectable (`observeFn`).

**`notify.test.ts` (+5 new):** `notifyCeoResult` SENT/FAILED/NOT_CONFIGURED/
SUPPRESSED, plus an explicit proof that only an env change (not a different
call shape) can move the send target.
