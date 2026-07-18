# ADR-0007 — swarm-exec: ANUS swarm as runtime + honest deterministic verification

- **Status:** Accepted
- **Date:** 2026-07-18
- **Deciders:** CEO Yusif Ganbarov (runtime decision) + Atlas-CTO (design)
- **Supersedes/relates:** ADR-0006 (Hand Contract V0 authority boundary), ADR-0004 (legacy task-source classification), VOLAURA ADR-018 (autonomous daemon archived)

## Context

A mission ("SWARM HONESTY + SINGLE-CONTROL INTEGRATION V1") asked to (a) fix two swarm defects — a run marked `done` when `perspectives_responded > 0`, and provider failures (e.g. NVIDIA 401) contaminating success counts — and (b) integrate a bounded swarm run under the exec-graph task authority with deterministic verification.

STEP-0 re-anchoring against real code contradicted the premise:

1. The named swarm runtime — VOLAURA `scripts/atlas_swarm_daemon.py` — was **ARCHIVED by CEO's ADR-018 (2026-07-10)**: cron `daemon-task-seeder.yml` disabled, `infra/start.sh` gated behind `VOLAURA_DAEMON_REVIVE=1`, code kept only so `ci.yml` daemon tests stay green. It is retired.
2. Both named defects were already **REFUTED** in that daemon's current code: completion requires `responded>0` **AND** `verified_findings>0` (`atlas_swarm_daemon.py:1562-1585`); failed providers return `None` and never carry a `provider` key, so they are excluded from `perspectives_responded` (`:2538` + `:1029-1123`).
3. The target compound chain (exec-graph ↔ swarm ↔ deterministic verify ↔ VERIFIED/REJECTED) **did not exist** in any form. The ANUS→Python bridge (`python-bridge.ts`) targets a different script (`autonomous_run.py`), not the daemon.

Executing the mission literally would have required reviving CEO-retired dead code (a stated NON-GOAL and an ADR-018 conflict) or silently redesignating the swarm runtime (an authority-boundary change). Per STEP-0's stop clause, this was surfaced to the CEO as a single strategic decision.

## Decision

**The swarm runtime is the ANUS in-process TypeScript swarm (`src/swarm.ts`) — CEO decision, Option A.** All work is built in the clean ANUS repo; no VOLAURA product edits, no dead-code resurrection, no deploy.

The compound capability is delivered as `src/swarm-exec/*`, wired through the **existing** Hand Contract (ADR-0006) rather than a new authority:

- `intake.ts` — freeform intent → deterministic structured draft → **explicit** `commitDraft` → exec-graph task. Raw natural language never auto-executes.
- `completion-policy.ts` — `evaluateCompletion()`: deterministic, no-LLM, **fail-closed** honest completion gate. A failed provider is re-derived as not-OK from its own evidence (error/output/provider), never the caller's `ok` flag. Missing/invalid policy → `failed`. This is the two "defects" locked as an invariant on the live runtime.
- `run-bundle.ts` — one correlated durable bundle per run at `state/swarm-runs/<runId>/`, written atomically with `bundle.json` last (partial writes are visibly incomplete). Proof token `SWARM-VERIFIED:<runId>` is written **iff** the honest verdict is `done`, else `SWARM-REJECTED:<runId>`.
- `executor.ts` — `runSwarmForTask()`: control-gate → run → honest verdict → bundle → a `file-contains` Receipt over `bundle.json` for the `SWARM-VERIFIED` token → `submitReceipt` → `verifyAndTransition`.
- `src/swarm.ts` — added `runSwarmDetailed()` + a **bounded per-worker timeout** (`ATLAS_SWARM_WORKER_TIMEOUT_MS`, default 60s).
- `hands/registry.ts` — new hand `swarm-local` (foreground-only, CEO-supervised, no write/mutation action).
- CLI: `atlas swarm-exec intake|commit|run`.

**Authority model (unchanged, reinforced):**
- `state/exec-graph` remains the ONE machine task authority.
- Only `hands/exec-graph-adapter.ts::verifyAndTransition()` (deterministic no-LLM `hands/verifier.ts`, `_viaHandAdapter` capability) sets a task's final `verified`/`rejected`. **The swarm never self-declares success** — it only submits a receipt the verifier independently re-checks against the committed bundle.
- `atlas/control-plane.ts` (`operator/state/operator-state.json`) is the single control state; `atlas control` writes it and the executor reads it — one control path. A paused/stopped run goes to `blocked`, never `verified`.
- `operator/evaluator.ts` + `promotion.ts` remain available as a **supporting-evidence library**; they were NOT force-fit into the swarm-exec authority path (kept coherent per the mission — operator outputs may support evidence, they cannot close an exec-graph task).

## Consequences

- The mission's real value — an honest, single-authority, deterministically-verified swarm run — is delivered without touching VOLAURA product code, without reviving archived code, and without a deploy.
- The two "defects" are now a tested invariant on the live ANUS runtime (`completion-policy.ts` + negative tests), independent of whether they ever existed on the retired daemon.
- The archived VOLAURA daemon stays archived (ADR-018 honored).
- A follow-up remains: the model-router routes some WORKER-role calls to `anthropic`/`cerebras` (paid/dead) instead of free-tier only — pre-existing, out of this mission's scope, flagged.

## Validation (live smoke, bounded, free-tier intent, isolated graph)

`atlas swarm-exec intake "…" → commit → run` produced an **honest REJECTED**: all 5 workers bounded-out at 30s (providers unavailable), `completion: failed / no_responders_ok / 0-of-5`, bundle `proof: SWARM-REJECTED:<runId>`, the deterministic verifier read the bundle and transitioned the task to `rejected`. Canonical 10-task graph untouched; $0 spend (zero successful provider calls); token cap set before the run. This is the mission thesis proven live: **honest failure recorded, not fabricated success.**

Tests: full suite 505 passed / 0 failed / 2 skipped; typecheck + build green; `graph verify` ok:true.

## References
- `docs/atlas-cto/MISSION-SWARM-INTEGRATION-V1.md`
- `docs/runbooks/swarm-exec.md`
- VOLAURA `docs/adr/ADR-018-2026-07-10-autonomous-daemon-archived.md`
- ADR-0006 (Hand Contract V0), `src/swarm-exec/*`, `src/hands/verifier.ts`, `src/atlas/control-plane.ts`
