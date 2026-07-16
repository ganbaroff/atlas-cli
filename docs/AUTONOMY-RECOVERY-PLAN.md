# Autonomy Recovery Plan — Bringing Back a Bounded, Evidence-Gated Brain-Loop

> **This is a plan, not an implementation.** Nothing in this document has been
> built. It went through an internal draft + adversarial verification pass
> against the out-of-scope constraints before being finalized; the fixes that
> verification demanded are applied below. A human reviews and approves before
> any code changes.

## Context

Atlas (ANUS repo) once ran an autonomous, self-directing brain-loop. It was
deliberately gutted on 2026-07-10 and has sat inert since. This plan proposes
the minimal, evidence-gated first step to restore proactive behavior without
repeating the failure mode that got the old loop killed.

## 1. Why was `autonomousBrainLoop` gutted?

Verbatim, from `src/telegram.ts:772-782`:

> `// [removed 2026-07-10] auto-queue to ungoverned external cron deleted (board P0).`
> `// This loop previously polled Supabase for an empty queue, picked a rotating`
> `// task (proactivity-gated), and called queueRemoteCommand(chatId, command) to`
> `// feed the off-repo CEO-machine cron with zero evidence-gate, shell`
> `// classifier, or audit — then told the CEO it had "autonomously" run a check,`
> `// which would now be false since nothing is queued. Left inert; a governed`
> `// in-repo replacement (queue-worker.ts style) can restore autonomy later.`

Removal commit `a1c3189`: `fix(security): remove two ungoverned exec paths —
ACTION_PATTERNS->execSync + /remote external-cron queueing (P0, board
due-diligence)`. Board due-diligence docs called this out directly:
`ATLAS-BUILD-PLAN-2026-07-10.md:32` lists it "BROKEN (deliberately inert)";
`ATLAS-INVESTMENT-MEMORANDUM.md:35-37` flags it as running "via an ungoverned
external cron... no auth, ungoverned exec path, ephemeral memory";
`business-vc.md:156` scores it "-1 for the P0 governance holes."

Plainly: the old loop had **no evidence-gate, no shell classifier, no audit
trail**, and it reported "autonomous" work to the CEO that either didn't
happen or wasn't verifiable. That is the exact failure this plan must not
reproduce. Any replacement must earn autonomy back by construction, not by
promise. Today `autonomousBrainLoop()`'s full body is two early returns
(`isPaused()` / config checks) — it still fires on a timer from `boot()` and
logs "autonomous planning," but does nothing. That log line is itself
slightly dishonest and should be removed or corrected regardless of whether
this plan proceeds.

## 2. Minimal safe first behavior

Every 15 minutes, the loop runs **local, read-only signals only**, reusing
code that already exists and is already trusted:

- `repo_watch` (`src/atlas/repo-watch.ts`) — read-only `git status` of configured roots.
- `runHealthCheck()` (`health-check.ts`) — the existing 7-diagnostic check.
- stale-heartbeat check (`heartbeat-alert.ts`) — reads the heartbeat file, no writes.
- optional queue-depth inspection — read-only count of pending items, no dequeue/consume.

It notifies the CEO **only** on a change, a failure, or a defined threshold,
via the existing `notifyCeo()` gate (kind `important` or `error` — never
`chatter`, never spam). It must **never** deploy, write code, push, send
email, or call a paid model.

**Verified shell-whitelist compliance, not asserted.** This loop's default
signal sources do not even go through the general-purpose `shellTool` /
`classifyShellForActor` whitelist gate at all: `repo_watch`'s `checkRepo()`
calls `execFileSync('git', ['-C', root, ...args], ...)` directly
(`src/atlas/repo-watch.ts`), with a **fixed, code-determined** set of
subcommands (`rev-parse`, `status`, `log`, `rev-list`) — never an
LLM-generated command string. `runHealthCheck()` and the heartbeat check are
pure filesystem reads, no shell at all. This is a *stronger* safety property
than "whitelist-compliant": there is no model-decided shell command in the
default loop to gate in the first place. For the record, `git status/log`
would also be covered if it ever did go through the shell tool —
`config/policy.yaml:50`: `'^git\s+(status|log|diff|show|branch|remote|rev-parse|describe)\b'`
— but that path isn't exercised by this design. This plan proposes **zero
new whitelist entries**; if a future capability needs one, that is a
call-out for that future work, not a decision made here.

## 3. State machine

States: `idle → observing → assessing → notify-or-silent → recorded`.

- **idle**: waiting for the next tick (interval timer).
- **observing**: calls the four read-only signal functions above, collects raw results.
- **assessing**: computes a **change signature** for each signal, modeled exactly on `repo_watch`'s existing pattern (a signature string over dirty-file list / health-check pass-fail vector / heartbeat age). No new dedupe mechanism is invented — this reuses `repo_watch`'s change-signature + interval-elapsed gate verbatim (`decideNotify()` in `repo-watch.ts`).
- **notify-or-silent**: if the signature changed AND the rate-limit interval has elapsed (per-signal, same as `policy.skills.repo_watch.interval_min`, default 15min) → notify via `notifyCeo()`. Otherwise stay silent.
- **recorded**: persist the signal snapshot (for the next tick's diff) and, if notified, the receipt (what was sent, when). This closes the "told the CEO it did work" gap from the old loop — every notification has a corresponding recorded signal snapshot it was derived from.

Dedupe rule, stated precisely: same signature as the last recorded snapshot →
no notify, regardless of interval elapsed. Different signature but interval
not yet elapsed → hold, don't notify until elapsed. Matches `repo_watch`
today exactly.

## 4. Kill path — checked before every tick

Three mechanisms, fastest to most durable:

- (a) Desktop tray PANIC button (`apps/desktop/atlas-tray.ps1`) writes `~/.atlas/PAUSE` → `isPaused()` returns true → loop halts before its next tick.
- (b) Telegram `/pause` (CEO-only, already shipped) → sets `ATLAS_PAUSE=1` in-process.
- (c) Railway env var `ATLAS_PAUSE=1` → durable across redeploy.

**Correctness requirement:** `isPaused()` must be called at the **start of
every tick**, not just at boot/startup. The loop body must be structured so a
pause mid-run is checked before the notify step too, so a PAUSE set while
`observing`/`assessing` is running still suppresses `notify-or-silent` for
that tick.

## 5. Cost model

Every function this loop calls is deterministic and local: `git status`,
health-check diagnostics, heartbeat file read, queue-depth count. **Zero LLM
calls per tick.** Notify-worthiness is decided by fixed thresholds
(dirty-file count changed, heartbeat >24h stale, health-check N-of-7
failing), not by model judgment. **Default expected LLM spend for this loop:
$0/day.** A future v2 that wants an LLM-summarized digest must route through
the existing free-tier-first model router and `enforceSpendPolicy` — flagged
as a v2 idea, explicitly out of scope here.

## 6. Where it runs

**Default recommendation: local Windows process, activated manually first —
NOT wired into the Railway bot's `boot()` as the default.** Rolling this into
`boot()` means shipping new code to the live Railway process, which is itself
a deploy/cloud-mutation event — that is a **second-phase** action gated
separately (§8), not the default rollout path.

**Open question, verified as unresolved, not hand-waved:** does a Railway
container actually have filesystem access to the CEO's local Windows repo
paths (`C:\Users\...\ANUS`, `C:\Projects\VOLAURA`) that `repo_watch` needs to
scan? A cloud container almost certainly does **not** have access to a local
Windows filesystem — this was not verified during this planning pass and
must be confirmed before any cloud-side activation is even considered. If
confirmed unreachable (the likely outcome), `repo_watch`'s portion of the
loop can only ever run as a **local process** — `runHealthCheck()` and the
heartbeat check read local files too, so their cloud-reachability is equally
unverified and should not be assumed either.

Given that, the recommended shape: a **local-only** loop, started manually
(`node dist/cli.js` invocation, or a Task Scheduler entry the CEO sets up
explicitly) — not inside `boot()`, not auto-started, not touching Railway at
all in phase one. If a cloud-side variant is ever wanted, that reuses
`startInProcWorker()`'s exact activation pattern (`ATLAS_INPROC_WORKER`-style
opt-in env var, default OFF) — but only as an explicitly-approved phase two.

## 7. Tests, staged rollout, rollback

- Unit tests for the state machine's dedupe/rate-limit logic, mirroring `repo_watch`'s existing test style (signature-same → no notify; signature-changed-but-interval-not-elapsed → hold; signature-changed-and-elapsed → notify).
- Staged rollout, **local only, in this order**:
  1. Env flag OFF by default.
  2. CEO manually runs one tick via CLI on the local machine to inspect output.
  3. Enable a 60-minute interval for a one-day local trial.
  4. Settle on 15 minutes, still local.
  5. Only if a cloud-side variant is later wanted: that specific deploy goes through the approval gate in §8 — it is not an automatic next step of this rollout.
- Rollback: single env var flip back to OFF. Nothing to undo — the loop is read-only and mutates no external state beyond its own snapshot file.

## 8. What needs CEO approval

For the **local, read-only, manually-started first loop** as designed:
**none** — it reuses only existing, already-approved gates (`ATLAS_PAUSE`,
`notifyCeo()`, `policy.yaml` whitelist semantics it doesn't even need to
invoke, `repo_watch`'s existing pattern).

Two items explicitly DO need a decision, and are not defaults of this plan:

1. **Deploying this loop's code into the Railway bot's `boot()` (or flipping
   any activation env var inside Railway's environment) is a cloud
   mutation/deploy and requires CEO approval before that specific deploy** —
   separate from, and in addition to, the filesystem-reachability question in
   §6.
2. The filesystem-reachability question itself (§6) needs to be verified
   before a cloud-side variant is even designed further, let alone approved.

## Non-goals

This plan does **not**: expand the autonomy shell whitelist; deploy or push
code; write or edit code autonomously; send email; call any paid model by
default; touch OpenManus or computer-control hands; repair voice/Telegram
input; or reintroduce any queueing to an external/ungoverned cron. It
restores observation and notification only, running locally, off by default.
