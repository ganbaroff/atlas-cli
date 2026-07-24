# Mission — SWARM HONESTY + SINGLE-CONTROL INTEGRATION V1

_Owner: Atlas (Local-CTO). Started 2026-07-18. Scope: ANUS repo only. No deploy, no VOLAURA product, no key rotation._

## STEP-0 CORRECTION (why the plan changed)
The directive named `scripts/atlas_swarm_daemon.py` (VOLAURA) as the swarm runtime and asked to fix two defects. Ground-truth (receipts in session):
- That daemon was **ARCHIVED by CEO's ADR-018 (2026-07-10)** — cron off, code kept only for CI. Dead code.
- DEFECT "done when responded>0" — **REFUTED** (`atlas_swarm_daemon.py:1562-1585` requires responded>0 AND verified_findings>0).
- DEFECT "401 contaminates success" — **REFUTED** (failed providers return None, excluded from counts).
- The compound chain (exec-graph ↔ swarm ↔ deterministic verify ↔ VERIFIED/REJECTED) **does not exist** in any form.

**CEO decision (this session): Option A — the ANUS in-process TS swarm (`src/swarm.ts`) is the swarm runtime.** Everything below is built in the clean ANUS repo.

## AUTHORITY INVARIANTS (unchanged, enforced)
1. `state/exec-graph/` is the ONLY machine task authority.
2. A swarm/worker cannot declare itself successful. Only `hands/exec-graph-adapter.ts::verifyAndTransition()` (with `_viaHandAdapter`) sets `verified`/`rejected`.
3. Final verdict requires the **deterministic no-LLM verifier** (`hands/verifier.ts`) over committed artifacts.
4. One control authority: `atlas/control-plane.ts` (`operator/state/operator-state.json`). No second queue/graph/notifier/journal.
5. Existing ANUS notifier is the only CEO-notification path. `C:\Projects\ATLAS` read-only. `codex-loop.md` = journal, not task state.

## REUSE MAP (what already exists — do NOT rebuild)
- `exec-graph/api.ts` — task authority (`createGoal`/`createTask`/`moveTask`/`getTask`).
- `hands/exec-graph-adapter.ts` — `assignHand` / `submitReceipt` / `verifyAndTransition` (the sole VERIFIED/REJECTED path).
- `hands/contract.ts` — Receipt schema (kinds: file-exists/commit-exists/file-contains/command-output-match/narrative).
- `hands/verifier.ts` — deterministic `verify(receipt)`; protected-path guard; read-only command allowlist (incl. `node dist/cli.js graph verify`).
- `hands/registry.ts` — hand specs (`sonnet-foreground`, `local-readonly`).
- `atlas/control-plane.ts` — single control state + `controlAllowsModelCalls()` (swarm.ts already gates on it).
- `operator/evaluator.ts` + `promotion.ts` — reusable pure evaluator/promotion.
- `swarm.ts` — `runSwarm(task)` perspectives→workers→dedup→synthesize→`logSwarmRun`.

## INTEGRATION DESIGN (new code under `src/swarm-exec/`)
CEO intent → `atlas intake` compiles a draft → exec-graph task → `assignHand('swarm-local')` → executor runs the swarm → computes an **honest completion verdict** (deterministic) → runs evaluator+promotion → writes a **durable run bundle** to `state/swarm-runs/<runId>/` with a proof token emitted ONLY on DONE+promote → builds a `file-contains` **Receipt** citing that bundle+token → `submitReceipt` → `verifyAndTransition` → exec-graph **VERIFIED** or honest **REJECTED** → one concise CEO result. The deterministic verifier independently re-reads the committed bundle; no LLM in the verify path.

## WAVES (each: Sonnet hand implements + self-tests → Opus verifies typecheck+full suite+`graph verify` → commit)
- **W1 — Honest completion policy + regression lock.** `swarm-exec/completion-policy.ts` (`evaluateCompletion`), fail-closed on missing policy; failed provider never counted; required/optional responders, min success, failure budget, evidence/evaluator/promotion gates. Negative tests per directive. _(This IS the refuted-defects lock, ported to the live ANUS swarm.)_
- **W2 — Durable run bundle.** `swarm-exec/run-bundle.ts` atomic/idempotent writes to `state/swarm-runs/<runId>/`; correlated fields; proof token only on DONE; partial visibly incomplete. Tests.
- **W3 — Swarm hand + detailed run.** register `swarm-local` in `hands/registry.ts`; expose `runSwarmDetailed()` from `swarm.ts` (results, not just synthesis). Tests.
- **W4 — Executor (core).** `swarm-exec/executor.ts::runSwarmForTask(taskId)` = control-gate → runSwarmDetailed → completion-policy → evaluator/promotion → writeRunBundle → receipt → submitReceipt → verifyAndTransition. Prove 1 VERIFIED + 1 REJECTED (mocked swarm). Tests.
- **W5 — Intake compiler.** `atlas intake "<freeform>"` → draft (objective/scope/exclusions/acceptance/deps/risk/proof-spec/executor/timeout/cost/rollback) → confirm → exec-graph task. No exec from raw NL. Tests.
- **W6 — Single control path (prove).** assert executor observes control (paused/stopped → refuse; no VERIFIED from stale). Wire `atlas control …` CLI if missing. Regression test: paused run can't reach VERIFIED.
- **W7 — Live bounded LOCAL smoke.** one real free-provider run end-to-end via CLI. Bounded timeout, no deploy. VERIFIED or honest REJECTED. Capture artifacts.
- **W8 — Docs + cold review.** architecture map, ADR (swarm-as-executor + ADR-018-aware runtime), module contracts, state/evidence index, runbook, codex-loop entry. Independent cold-reader (8 questions).

## GATES
GREEN: isolated new modules, local tests, free/local smoke, deterministic verify, scoped commits to `feat/arsenal-wiring`.
RED (stop + CEO): deploy, credentials/paid, second authority, VOLAURA product edit, migration/rewrite, task-state split ANUS/VOLAURA.

## DoD
typecheck green · full suite green (baseline 455/3-skip) · `node dist/cli.js graph verify` ok:true · one live smoke with a real bundle + VERIFIED-or-honest-REJECTED · docs updated · cold-reader pass.

## FINAL STATUS — 2026-07-18 (all waves shipped)
- W1 completion-policy (`6b1f405`) · W2 run-bundle (`a042913`) · W3 swarm-local hand + runSwarmDetailed (`a31e84e`) · W4 executor core — 1 VERIFIED + 1 REJECTED + 1 BLOCKED proven (`b3a00f7`) · W5 intake compiler (`477003b`) · W6 CLI `swarm-exec intake|commit|run` (`477ad67`) · W7a bounded per-worker timeout (`961a0a2`) · W8 docs (this commit). All pushed to `feat/arsenal-wiring`.
- **W7 live smoke: HONEST REJECTED.** `atlas swarm-exec intake→commit→run` on an isolated graph — 5 workers timed out at 30s (providers unavailable), `completion: failed / no_responders_ok / 0-of-5`, bundle `proof: SWARM-REJECTED`, the deterministic verifier read the bundle and transitioned the task to `rejected`. Canonical 10-task graph untouched; $0 spend; token cap set before the run. Thesis proven live: honest failure recorded, not fabricated success.
- Tests: full suite **505 pass / 0 fail / 2 skip**; typecheck + build green; `graph verify` ok:true. (Baseline note: the "455/3-skip" above was the directive's stale prior-evidence; real pre-mission baseline ≈456, post-mission 505/0/2.)
- Decision + design of record: `docs/adr/0007-swarm-exec-runtime-and-honest-verification.md`. Operator runbook: `docs/runbooks/swarm-exec.md`.
- Known limitation: after an all-workers-timeout run the CLI process may not exit promptly (abandoned provider sockets); the verdict + bundle are already persisted. Follow-up: `process.exit` guard in the `swarm-exec run` action. Pre-existing (out of scope): the model-router routes some WORKER-role calls to `anthropic`/`cerebras` instead of free-tier only.
