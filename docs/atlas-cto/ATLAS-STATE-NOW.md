# ATLAS — STATE NOW (post-compaction orientation)
_Last written: 2026-07-19 (handoff, mid-sprint). Committed, NOT YET PUSHED — see "WHERE" below. Read this FIRST on resume._

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
- **Verified this session** (receipts, same turn): `npx tsc --noEmit` → "No errors
  found"; `npx vitest run` → `PASS (536) FAIL (0) skipped (2)`; `git status
  --porcelain state/` → 0 lines (zero graph/state mutation from the new modules).

## IN PROGRESS
Nothing mid-edit — tree is clean, last two waves (W1, W2) are committed and
verified. The sprint is paused between waves for this handoff, not stuck.

## NEXT (priority order)
1. **W3 — brief composer** `src/atlas/cos/brief.ts`: compose `gatherCosFacts()` +
   `detectDrift()` into the CEO-facing brief with the six mandatory categories
   (CEO DECISION REQUIRED / WAITING ON EXTERNAL OWNER / BLOCKED / DRIFT-STALE
   SIGNAL / RECENTLY VERIFIED / NO ACTION REQUIRED). Every item must carry:
   source authority, source ref/task ID, status, evidence freshness or
   `UNKNOWN`, why it's shown. If nothing needs a decision, say plainly `No CEO
   decision required.` — no manufactured urgency. Full contract is in
   `SPRINT-CHIEF-OF-STAFF-V1.md`'s "BRIEF CONTRACT" section — read it before
   writing this module, it's CEO-verbatim and binding.
2. **W4 — CLI + wire-in**: `atlas cos brief` / `atlas cos drift` commands; impure
   gatherers for git ahead/behind, heartbeat file, `graph verify` exit; a REAL
   local run against the live graph (runtime proof, not fixtures-only).
3. **W5 — hardening + adversarial**: negative scenarios (empty graph, stale
   signal, rejected task, escalated external owner, malformed/unknown source);
   prove zero graph/state mutation; independent adversarial pass for false
   urgency / stale evidence / duplicate authority / misleading CEO language;
   cold-reader.
4. **W6 — docs**: ADR-0008 (CoS = read-only projection, NOT an authority),
   update `docs/runbooks/morning-brief-and-status.md`, architecture map,
   module contracts, then the final compound-sprint report (PLAN/DO/ACT/CHECK/
   COMPARE/LEARN/RESULT) — that report is what closes this sprint out to the CEO.
5. Push `feat/arsenal-wiring` to origin once W6 lands (currently 4 commits
   ahead, unpushed — see WHERE).

Per CEO's standing order: no checkpoint needed between W3→W4→W5→W6 as long as
each wave stays GREEN (typecheck+suite clean, no state mutation, docs updated).
Stop and escalate only on a real RED gate (deploy/prod mutation, credentials,
paid budget, irreversible change, security incident, VOLAURA product intrusion,
authority duplication, genuine strategic contradiction).

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

## IMPORTANT FILES FOR THE NEXT STEP
- `docs/atlas-cto/SPRINT-CHIEF-OF-STAFF-V1.md` — the sprint plan + the binding
  BRIEF CONTRACT section W3 must implement exactly.
- `src/atlas/cos/facts.ts`, `src/atlas/cos/drift.ts` — the two inputs W3 composes.
- `src/atlas/status-report.ts` — existing `/status` composer; shows the
  established voice-brief pattern (plain lines, no bullet walls) to match.
- `src/atlas/briefing.ts` — existing 08:45 brief composer (`composeMorningBriefing`)
  that W3/W4 are meant to make graph-derived instead of hand-typed.
- `docs/runbooks/morning-brief-and-status.md` — the runbook W6 must update once
  `atlas cos brief` exists as a new surface.
- `src/exec-graph/contracts.ts` — Task/Goal/Transition schemas `facts.ts`/`drift.ts` depend on.

## VERIFY COMMANDS (what "works" means)
```
cd "C:\Users\user\OneDrive\Documents\GitHub\ANUS"
npx tsc --noEmit                 # must say "No errors found"
npx vitest run                   # must say PASS (>=536) FAIL (0)
git status --porcelain state/    # must be EMPTY — proves no module wrote graph/state
node dist/cli.js graph status    # live exec-graph snapshot (build first: npm run build)
```
A wave is GREEN only when typecheck is clean, the suite is 0 failures with no
regressions from the 536 baseline, `state/` is untouched, and (from W4 onward)
the CLI command runs against the real graph, not just fixtures.

## OPEN RISKS
- Sprint work is **committed but unpushed** (4 commits ahead of origin) — if
  this machine/checkout is lost before the next push, the work is only as safe
  as this local clone. Push after W6, or sooner if asked.
- W3 is the highest-risk wave: it's the one CEO explicitly hand-wrote hard
  rules for (six categories, per-item metadata, "no manufactured urgency").
  Easiest way to fail review is a plausible-but-generic brief that doesn't
  actually trace every line back to a source authority + freshness — read the
  BRIEF CONTRACT section literally, don't paraphrase from memory.
- `heartbeat` has been stale since 2026-06-26 with no assigned writer (known
  problem #7 below) — W4's real-graph run will likely surface a genuine
  stale-heartbeat drift finding; that's expected/correct behavior, not a bug.
- The 12 known structural problems below are unrelated pre-existing debt, not
  blockers for this sprint, but W4's real-graph run may surface more of them.

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
- ANUS remote==local (verify with git rev-parse HEAD vs origin/feat/arsenal-wiring). Latest ~09424ba.
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
1. Read this file top to bottom — the NEXT section above has the concrete next
   step (W3, brief composer). This supersedes the generic guidance below.
2. `node dist/cli.js graph status` for live task state.
3. Continue the Chief-of-Staff Surface V1 sprint wave-by-wave (Sonnet hands,
   Opus/Fable verify per wave) with no CEO checkpoint between GREEN waves, per
   the CEO's standing order — do NOT return to CEO until W6 is done unless a
   genuinely-new strategic question or a real RED gate appears.
4. Do NOT re-audit VOLAURA product; do NOT deploy without a CEO gate.
