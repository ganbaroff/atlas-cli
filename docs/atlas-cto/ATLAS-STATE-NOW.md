# ATLAS — STATE NOW (post-compaction orientation)
_Last written: 2026-07-19 (Chief-of-Staff Surface V1 sprint COMPLETE, W1-W6
all done). Committed, NOT YET PUSHED — see "WHERE" below. Read this FIRST
on resume._

## PURPOSE (current sprint)
Compound sprint **Chief-of-Staff Surface V1** (self-approved by Atlas per CEO's
"form the next sprint yourself, North Star = ATLAS is a Chief-of-Staff / CTO
operating system, not a bot/swarm/skills collection"). Goal: a READ-ONLY
projection that truthfully tells the CEO — derived from real authorities
(exec-graph, control-plane, git, heartbeat, spend), never hand-fed — what's
waiting on his decision, what shipped, what's drifting, what's stale. Full
plan + brief contract: `docs/atlas-cto/SPRINT-CHIEF-OF-STAFF-V1.md`.

## DONE (this sprint, with proof)
- **W1 — facts read-model** `src/atlas/cos/facts.ts`: pure `gatherCosFacts(providers?)`
  projecting exec-graph `statusSummary`/`listTasks` + control-plane mode + spend
  into `{waiting, shipped, counts, controlMode, spend, generatedAt}`. Injectable
  providers, writes nothing. Committed `8645fed`.
- **W2 — drift detectors** `src/atlas/cos/drift.ts`: pure `detectDrift(inputs)` →
  `DriftFinding[]` for unpushed-commits / graph-verify-failed / stale-heartbeat /
  stuck-task. Unobservable input → `'unknown'` finding, never a crash. Fixed
  emission order, documented thresholds (heartbeat 24h, stuck-task 48h).
  Committed `5c0a81b`.
- Plan refinement (CEO rule 7: cut commitment-capture from this release; encoded
  the 6-category brief contract) committed `14c255e`.
- **W3 — brief composer** `src/atlas/cos/brief.ts`: composes facts+drift into the
  six fixed categories, per-item source authority/ref/status/freshness/why, CEO-
  verbatim `No CEO decision required.` fallback when empty. Committed `0b07c53`.
- **W4 — CLI + impure gatherers** `src/atlas/cos/gather.ts` (read-only git ahead/
  behind, heartbeat age, graph-verify-ok, stuck-task candidates) + `atlas cos
  brief [--json]` / `atlas cos drift` (`src/cli.ts`). Real run against the live
  10-task graph proved truthful (correct MIRT handoff classification, correct
  unpushed-commit count, correct ~553h stale heartbeat). Committed `f8be853`.
- **W5 fix 1** — rejected tasks were invisible in the brief (facts.ts never
  tracked them); the live run against the real graph (2 rejected tasks) is what
  caught it, not inspection. Added `CosFacts.rejected` → NO ACTION REQUIRED.
  Committed `df948c1`.
- **W5 fix 2** — independent adversarial review + cold-reader (two fresh-context
  agents, given only the live brief text, told to actively hunt for false
  urgency/stale evidence/duplicate authority/misleading language) found and
  fixed two real issues: (a) evidence-submitted tasks were owner-split like
  escalated, mislabeling a hand-owned task awaiting Atlas's own `atlas hand
  verify` as "handed off" — now unconditionally CEO DECISION REQUIRED; (b)
  `NO ACTION REQUIRED`'s count blended closed successes with rejections (a real
  live collision: ADR-0001-closed next to ADR-0002-rejected under one "no
  action" header) — section headers now break down mixed statuses inline.
  Committed `93f8f3f`.
- **W6 — docs**: `src/atlas/cos/README.md` (module contract, authority boundary,
  documented known limitations), `docs/adr/0008-cos-surface-read-only-projection.md`,
  `docs/runbooks/morning-brief-and-status.md` updated (new surface, explicitly
  marked NOT yet wired into Telegram), `docs/architecture/ATLAS-ARCHITECTURE.md`
  updated, full report at `docs/atlas-cto/CHIEF-OF-STAFF-V1-REPORT.md`
  (PLAN/DO/ACT/CHECK/COMPARE/LEARN/RESULT).
- **Verified this session** (receipts, same turn, after every wave): `npx tsc
  --noEmit` → "No errors found"; `npx vitest run` → `PASS (569) FAIL (0) skipped
  (2)` (baseline was 536 at sprint start); `git status --porcelain state/` → 0
  lines every single time (zero graph/state mutation from any wave or any real
  run); `npm run build` clean.

## IN PROGRESS
Nothing. Tree is clean, all six waves (W1-W6) are committed and verified. The
sprint is DONE, not paused — the only remaining step is the push (see NEXT).

## NEXT (priority order)
1. **Push `feat/arsenal-wiring` to origin** — 9 commits ahead, all local, none
   pushed yet. This session's standing instruction explicitly names `git push`
   as a stop-and-ask action regardless of the sprint's own "push after W6"
   default — so this is a pending explicit CEO/user go-ahead, not a dropped
   step. If you're a fresh instance resuming and were told to push: verify with
   `git rev-list --left-right --count origin/feat/arsenal-wiring...HEAD` first
   (should read `0	9` before you push), then push, then re-verify with
   `git rev-parse HEAD` vs `git rev-parse origin/feat/arsenal-wiring`.
2. **Future, separate work (not part of this sprint, don't start without a new
   go-ahead):** wire `cos/*` into the live Telegram `/status` and the 08:45
   morning brief (`telegram.ts`, `briefing.ts`'s hand-typed `awaitingCeo`) —
   this sprint proved the surface locally; making it what the CEO actually
   reads on his phone needs its own live-Telegram verification pass. Also
   flagged, out of scope: a pre-existing exec-graph data-quality issue (one
   rejected task's title contains a leaked filesystem path fragment) surfaced
   by this sprint's live runs but not fixed (would require a graph-state
   write, which this read-only surface may never do).

## DECISIONS & DEAD-ENDS (don't redo this thinking)
- **Commitment-capture is explicitly CUT from this release** (CEO rule 7,
  2026-07-18). "WAITING ON EXTERNAL OWNER" / overdue-style signals must be
  DERIVED from existing exec-graph state (e.g. an escalated task whose owner
  isn't `atlas`/`hand:*`) — do NOT add a new commitment/due-date store to make
  W3 easier. That's a separate future release with its own draft/confirm/
  rollback contract.
- **CoS is a projection, not an authority.** It must never write to
  exec-graph/control-plane/spend state. If W3/W4 catch yourselves wanting to
  "just cache this computed value somewhere," that's the second-authority trap
  the CEO explicitly forbade — keep it derived-on-read.
- Prior mission (**swarm-exec V1**, separate from this sprint) is DONE and
  pushed (not part of this handoff's open work) — live end-to-end VERIFIED
  stays BLOCKED BY FREE-PROVIDER AVAILABILITY (env/quota, not code); CEO said
  explicitly do not chase that further, no provider/key changes authorized.

## IMPORTANT FILES (sprint reference, now complete)
- `docs/atlas-cto/SPRINT-CHIEF-OF-STAFF-V1.md` — the sprint plan + the binding BRIEF CONTRACT.
- `docs/atlas-cto/CHIEF-OF-STAFF-V1-REPORT.md` — the closing sprint report (PLAN/DO/ACT/CHECK/COMPARE/LEARN/RESULT).
- `src/atlas/cos/README.md` — module contracts, authority boundary, documented known limitations.
- `docs/adr/0008-cos-surface-read-only-projection.md` — the ADR.
- `src/atlas/status-report.ts`, `src/atlas/briefing.ts` — the pre-existing Telegram
  surfaces `cos/*` is NOT yet wired into (future work, not this sprint).
- `src/exec-graph/contracts.ts` — Task/Goal/Transition schemas `facts.ts`/`drift.ts` depend on.

## VERIFY COMMANDS (what "works" means)
```
cd "C:\Users\user\OneDrive\Documents\GitHub\ANUS"
npx tsc --noEmit                 # must say "No errors found"
npx vitest run                   # must say PASS (>=569) FAIL (0)
git status --porcelain state/    # must be EMPTY — proves no module wrote graph/state
node dist/cli.js cos brief       # live Chief-of-Staff brief (build first: npm run build)
node dist/cli.js cos drift       # live drift findings only
node dist/cli.js graph status    # live exec-graph snapshot
```
A wave was GREEN only when typecheck was clean, the suite was 0 failures with
no regressions from the 536 baseline (now 569), `state/` was untouched, and
(from W4 onward) the CLI command ran against the real graph, not just fixtures.

## OPEN RISKS
- Sprint work is **committed but unpushed** (9 commits ahead of origin) — if
  this machine/checkout is lost before the next push, the work is only as safe
  as this local clone. This session's standing instruction requires an explicit
  go-ahead before `git push` — see NEXT §1.
- `heartbeat` has been stale since 2026-06-26 with no assigned writer (known
  problem #7 below) — `atlas cos drift`/`atlas cos brief` correctly surfaces
  this as a live stale-heartbeat finding every run; that's expected/correct
  behavior, not a bug in this sprint's code.
- A pre-existing exec-graph data-quality issue (one rejected task's title
  contains a leaked filesystem path fragment) is now visible in the brief
  output (it wasn't before, since rejected tasks were invisible) — flagged,
  not fixed, since fixing it would require a graph-state write this read-only
  surface is architecturally forbidden from making.
- The 12 known structural problems below are unrelated pre-existing debt, not
  touched by this sprint.

## WHO / SCOPE (locked)
This chat = ATLAS / ANUS / Jarvis control-plane work ONLY. VOLAURA PRODUCT (assessment, auth,
scoring, migrations, PR #169, CV Truth Machine) is owned by a SEPARATE chat — do NOT touch it.
VOLAURA is in scope here ONLY as canonical Atlas memory / shared-bus integration (read + the
worktree write protocol). Standing constraints: changes go through Sonnet agents (hands),
Opus/Fable verifies each wave; NO cloud deploy / key rotation / prod-DB / VOLAURA-product changes
without an explicit CEO gate; never print secrets/tokens/chat-IDs.

## WHAT IS SHIPPED (this session, 2026-07-17/18) — all on ANUS feat/arsenal-wiring, PUSHED
- EB-0 Executive Brain V0: `src/exec-graph/` is the ONE machine task authority. 11-state machine,
  append-only ledger (state/exec-graph/), evidence-gated transitions, CLI (atlas goal/task/graph),
  /status + decision-framed morning brief read from the graph. Governance: docs/architecture/
  ATLAS-ARCHITECTURE.md, ADR-0001..0005, runbooks, cold-reader 5/5. Legacy task sources classified
  (ADR-0004): supabase queue=OUT-OF-SCOPE, task-spawner=TEMP ADAPTER, operator/tasks + VOLAURA
  work-queue=READ-ONLY IMPORT — none may close a graph task.
- Mission 2 Hand Contract V0: `src/hands/` delegation layer OVER exec-graph (Hands = descriptive
  metadata only, never write state; ONLY verifyAndTransition sets a hand-owned final state).
  Deterministic NO-LLM verifier, secret-guarded receipts, risk-gated deterministic refuter.
  ADR-0006, runbook hand-delegation.md. Adversarial review + cold-reader found & fixed 5 real holes
  (generic-CLI authority bypass, unscrubbed receipts, degenerate substring, cross-task receipt,
  create/import hand-owner). Tests 456/0, tsc+build clean.
- Live graph state: 10 tasks — 1 verified, 2 rejected, 6 closed, 1 escalated (MIRT, owner
  volaura-product-chat = handed to product owner, do NOT reopen/execute).

## WHERE / DURABLE COPIES
- ANUS remote != local: local HEAD is 9 commits ahead of
  `origin/feat/arsenal-wiring` (Chief-of-Staff Surface V1, W1-W6, unpushed —
  verify with `git rev-list --left-right --count
  origin/feat/arsenal-wiring...HEAD`, should read `0	9` until pushed).
- Atlas-CTO status ledger DURABLE MIRROR (pushed): docs/atlas-cto/EXTERNAL-CTO-STATE-SNAPSHOT.md.
- Canonical ORIGINAL of that ledger: VOLAURA memory/atlas/EXTERNAL-CTO-STATE.md — STRANDED on local
  UNPUSHED branch fix/pr-169-rubric-repair (@~460821ec), NOT on origin/main. Continuity risk;
  mirror above is the hedge. VOLAURA working tree is usually on a DIFFERENT branch
  (fix/pr-169-rubric-repair-r3) with a concurrent chat's uncommitted work — use the isolated
  git-worktree protocol to write memory/atlas/*, never touch that working tree directly.

## PROTOCOLS IN FORCE
- Compound-sprint / wave mode: plan → Sonnet-hands do → Opus verify+test each wave → one final report.
- exec-graph is the single task authority; run `node dist/cli.js graph status` to see current work.
- Worktree write protocol for VOLAURA canon (git worktree add <temp> fix/pr-169-rubric-repair; edit;
  commit; worktree remove; never push VOLAURA — that chat owns it).
- Every completion claim needs a same-turn tool receipt. CEO-verified turns end with
  «Что проверено / Что НЕ проверено».

## THE 12 KNOWN PROBLEMS (ranked; full detail in EXTERNAL-CTO-STATE snapshot)
Structural: (1) canon memory fragmented across VOLAURA branches, never reaches main; (2)
memory/shared-bus is gitignored = zero durability; (3) two repos, cloud bot runs MEMORY_ROOT=/app
= different near-empty memory, identity falls to hardcoded fallback. Debt: (4) operator/ real but
never runs (crash fixed, routes fake/blocked); (5) 2 extra memory systems (Supabase store, live use
UNKNOWN); (6) dead code getToolDict + false header, no MCP client; (7) heartbeat stale since
2026-06-26, no assigned writer. Capability: (8) autonomy/hands are LOCAL-only, nothing live on the
cloud bot; (9) legacy task authorities not retired; (10) NO commitment-capture / decision surface
(biggest CEO-value gap); (11) local/cloud config drift, no reconciliation. Governance: (12) multiple
live agents write the same repos concurrently, collisions already seen (dup Class 59); + carried
security debt (leaked keys, CEO-deferred).

## HOW TO RESUME
1. Read this file top to bottom — the Chief-of-Staff Surface V1 sprint (W1-W6)
   is DONE. The only remaining step is the push (NEXT §1) — pending explicit
   go-ahead, not a dropped task.
2. `node dist/cli.js graph status` and `node dist/cli.js cos brief` for live state.
3. If asked to push: verify ahead-count first, push, re-verify HEAD==origin.
4. If asked to keep going without a specific target: the next real work is
   wiring `cos/*` into the live Telegram surfaces (NEXT §2) — confirm that's
   actually wanted before starting, since it touches `telegram.ts`, a file
   that's part of the always-on production bot.
5. Do NOT re-audit VOLAURA product; do NOT deploy without a CEO gate.
