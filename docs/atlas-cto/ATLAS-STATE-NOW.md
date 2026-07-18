# ATLAS — STATE NOW (post-compaction orientation)
_Last written: 2026-07-18 (pre-compaction prep). Durable, pushed. Read this FIRST on resume._

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
1. Read this file + docs/atlas-cto/EXTERNAL-CTO-STATE-SNAPSHOT.md.
2. `node dist/cli.js graph status` for live task state.
3. A large CEO /goal mission may be in progress or incoming — execute wave-by-wave (Sonnet hands,
   Opus verify per wave), do NOT return to CEO until done unless a genuinely-new strategic question.
4. Do NOT re-audit VOLAURA product; do NOT deploy without a CEO gate.
