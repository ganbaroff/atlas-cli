# Local Autonomy V0 (+ V0.1 notify hardening, + V1 alert semantics)

Implementation of `docs/AUTONOMY-RECOVERY-PLAN.md`'s minimal first loop.
**Status: IMPLEMENTED-LOCAL / LOCAL-NOTIFY-VERIFIED / ALERT-SEMANTICS-TESTED /
NOT-SCHEDULED.** Not deployed, not wired into Railway, not auto-started
anywhere, no Task Scheduler entry currently active. Invoked only via
`atlas autonomy-tick` / `atlas autonomy-test-notify`.

Code: `src/atlas/autonomy-loop.ts`, `src/atlas/notify.ts` (canonical notify
layer), `src/atlas/health-check.ts` (`ageHours` field, V1) · CLI:
`atlas autonomy-tick [--notify]`, `atlas autonomy-test-notify` · tests:
`src/__tests__/autonomy-loop.test.ts` (27), `src/__tests__/notify.test.ts`
(+5 for `notifyCeoResult`).

## What it does (V1)

One tick: `isPaused()` check → observe (repo_watch + health-check, read-only)
→ evaluate EACH signal (heartbeat; each of the other 6 health checks by name;
repo-watch's own git-health) independently against its own persisted prior
state → notify the CEO only for signals whose transition is `new-failure`,
`escalation`, or `recovery` (never for `unchanged-failure` or `no-change`) →
still gated by `isPaused()`, re-checked immediately before the send. Zero LLM
calls. The only shell execution anywhere in this path is repo_watch's own
`execFileSync('git', ...)` with a fixed subcommand set — the autonomy shell
whitelist in `policy.yaml` isn't even exercised.

See the module's own header comment in `autonomy-loop.ts` for the full
per-signal state-machine design (this is the canonical spec — this doc
summarizes it, not the other way around).

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

## V1 — alert semantics (per-signal dedupe + recovery)

### The bug this replaces

A live 60-minute Task Scheduler smoke (2026-07-17, using the reconciled valid
token) sent **2 real duplicate Telegram alerts for the same, unchanged, already-
known stale-heartbeat condition** — retriggered purely by unrelated commits
landing on ANUS/VOLAURA mid-window. Root cause: V0's `combinedSignature()`
(`repoSig || healthVec`, one string) changed on ANY repo commit, and the tick
notified on ANY combined-signature change — conflating "something, anything,
changed" with "the thing CEO actually needs to know about changed." The
External CTO red-gated and aborted the smoke on this exact finding (not an
infra/Telegram failure — delivery worked correctly both times).

### The fix

`combinedSignature()`/`formatTickMessage()`/the old `LoopState{sig,
lastNotifyMs}` file are **removed** — replaced with a per-signal model.
Each signal (`heartbeat`, `health:<name>` for the other 6 checks,
`repo-watch`) is tracked independently in `~/.atlas/alert-state.json`
(override `ATLAS_ALERT_STATE_FILE`) as `HEALTHY | FAILING` (implicit
`UNKNOWN` before any tick has observed it). Every tick, every signal's raw
reading is compared **only to its own prior record** — never to a combined
snapshot of everything else:

| Transition | Notify? |
|---|---|
| `UNKNOWN\|HEALTHY` → `FAILING` (new-failure) | yes, `error` |
| `FAILING` → `FAILING`, same severity band (unchanged-failure) | **no** |
| `FAILING` → `FAILING`, band changed (escalation) | yes, `error` |
| `FAILING` → `HEALTHY` (recovery) | yes, `important` |
| `UNKNOWN\|HEALTHY` → `HEALTHY` (no-change) | no |

Severity bands (`mild` 24-72h / `moderate` 72-168h / `severe` ≥168h) exist
only for `heartbeat`, the one signal with a genuine continuous severity axis
(`ageHours`, new field on `HealthCheck`, `health-check.ts`). The other 6
health checks are flat booleans — no escalation axis, honestly not modeled
rather than faked. `repo-watch`'s HEALTHY/FAILING tracks only whether `git`
itself works for every watched repo (`RepoStatus.ok`) — the digest CONTENT
(branch/dirty-count/latest-commit) changing on a routine commit is
deliberately **not** a signal transition; that surface already has its own
separate, independent notify path (`atlas repo-watch --notify`, untouched).
Multiple genuinely-new events in one tick fold into ONE `notifyCeoResult()`
call, not one send per event and not suppressed against each other — an
independent new failure still notifies even while an unrelated failure
remains active, because each signal is judged in isolation.

No periodic reminders: an unchanged `FAILING` signal stays silent
indefinitely (explicit CEO decision, recorded in `EXTERNAL-CTO-STATE.md`).
Queue-depth (the plan's optional 4th signal type) still has no safe
read-only producer anywhere in this codebase and remains unmodeled — flagged,
not silently dropped, same as V0.

### Real receipts (this machine, 2026-07-16/17)

**Live CLI-level proof of the exact fix** (real stale heartbeat, real repo,
zero mocking):
```
$ export ATLAS_ALERT_STATE_FILE=<fresh temp file>
$ node dist/cli.js autonomy-tick
[autonomy-tick] ... state=observed — dry-run — would notify on: heartbeat:new-failure
Health: 1/7 checks failed: heartbeat

$ echo "sim-marker $(date)" > .atlas-sim-marker.tmp   # simulates an unrelated real commit landing
$ node dist/cli.js autonomy-tick
[autonomy-tick] ... state=silent — no actionable signal transitions this tick
Health: 1/7 checks failed: heartbeat   # heartbeat unchanged, correctly silent
```
The repo dirty-count visibly changed between the two ticks (6→7); the
heartbeat notification did not resend. This is the precise scenario that
double-sent during the live smoke test, now proven silent.

**27 deterministic tests** (`autonomy-loop.test.ts`, fixed fixtures, no live
git/health/Telegram calls) cover: first failure → one notify; same failure
next tick → suppressed; same failure + unrelated repo change → suppressed
(the storm path, explicit test); recovery → one notify; post-recovery
re-failure → one new notify; a *different* check failing while heartbeat
stays stale → exactly one new alert (not two, not zero); severity escalation
(mild→severe) → one escalation; same band → suppressed; state survives a
simulated fresh process (re-`readAlertState()` from disk); malformed/missing
state file → safe empty bootstrap, never throws, at most one notify (not a
storm); both pause paths; cannot-target-arbitrary-chat-ID (runtime +
compile-time guard); no LLM/model-router import anywhere in the module
(static zero-paid-call proof).

### Adversarial review (Workflow, 2026-07-17)

A dedicated Workflow review (8 lenses: alert-storm paths, state
persistence/restart, recovery false positives, unrelated-signal coupling,
notifier authority/secret exposure, malformed-state fail-safe, severity-band
edge cases, test-coverage gaps) ran against this implementation before it was
considered done. See `EXTERNAL-CTO-STATE.md` for the itemized findings and
which were fixed vs. accepted as documented V1 scope limits.

### Task Scheduler smoke — not re-attempted this pass

Per the External CTO's explicit boundary for this sprint: no new scheduler
window until this alert-semantics work was implemented, tested, and
accepted. The task `ATLAS-Autonomy-V0-Smoke` still exists but remains
**Disabled** (verified, not deleted) from the prior abort.

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

**`autonomy-loop.test.ts` (27, rewritten for V1):** the 12 required
alert-semantics cases (first-failure, repeated-failure-silent,
unrelated-change-silent, recovery, post-recovery-refailure,
independent-new-failure-while-another-active, escalation, same-band-silent,
state-survives-reload, malformed-state-safe, both-pause-paths,
cannot-target-arbitrary-chat-ID) plus the surviving V0/V0.1 end-to-end tick
tests (paused-before-observing, dry-run, notified+state-persisted,
paused-re-checked-before-notify, notify-failed vs no-CEO-chat-configured,
important vs error kind, compile-time chat-ID guard) and
`sendControlledTestNotification`'s own rate-limit + pause behavior
(unchanged by V1, still uses its own separate state file). Gating-logic
tests use hand-constructed fixtures (mirroring `repo-watch.test.ts`'s
pattern) rather than live `observe()` calls, since real git status of an
OneDrive-synced repo isn't guaranteed identical moments apart — an early V0
draft hit exactly this flake and was fixed by making the signal source
injectable (`observeFn`).

**`notify.test.ts` (+5 new):** `notifyCeoResult` SENT/FAILED/NOT_CONFIGURED/
SUPPRESSED, plus an explicit proof that only an env change (not a different
call shape) can move the send target.
