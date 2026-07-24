# M4 Adversarial Review — Durable Memory / Instance Lease
**Date:** 2026-07-24  
**Reviewer lens:** differential/threat — memory integrity + lease safety  
**Verdict:** **PASS-WITH-EXCEPTION**

## Scope reviewed
- `src/goal-runner/runner.ts` — resumeGoalId, exec-graph task reuse
- `src/goal-runner/budgets.ts` — goal lease, stale pid takeover
- `src/atlas/instance-lease.ts` — anti-fork instance lease
- `src/atlas/write-back-hook.ts` — session breadcrumb
- `src/cli.ts` — readonly mode at startup, `--resume` flag
- Child-process E2E: `m4-kill-resume-e2e.test.ts`, `m4-instance-lease.test.ts`

## Findings

### HIGH — none blocking ship
No exploitable dual-writer or budget-reset paths found in reviewed code paths. Child-process E2E confirms lease + budget behavior under SIGKILL.

### MEDIUM

| ID | Finding | Mitigation / residual |
|----|---------|----------------------|
| M4-ADV-01 | **Goal lease is goal-scoped, instance lease is machine-scoped** — two different lockfiles (`active-lease.json` vs `instance-lease.json`) can confuse operators; readonly CLI does not block exec-graph writes if code path ignores `ATLAS_READONLY`. | Documented in ATLAS-STATE-NOW. Follow-up: audit write paths for `ATLAS_READONLY` guard (M5+). |
| M4-ADV-02 | **Instance lease TTL default 60s** — heartbeat only on acquire; long-idle writer without heartbeat allows stale takeover while process still alive if pid reuse is unlucky (extremely rare on same machine). | Accept for M4; M5+ should add periodic heartbeat in CLI main loop. |
| M4-ADV-03 | **Resume matches tasks by title string** — replan with same objective but different decomposition could collide or skip wrong task. | Bounded V0 decomposition is single-task; LLM decomposition deferred. |
| M4-ADV-04 | **Breadcrumb hook is warn-only on swarm exit** — `assertBreadcrumbBeforeExit` exists but CLI does not hard-block all exit paths yet. | Swarm exit wired; full CLI exit gate deferred (organ 8 size S — partial). |

### LOW

| ID | Finding |
|----|---------|
| M4-ADV-05 | Corrupt lease JSON → treated as acquirable (fail-open). Intentional for crash recovery; attacker with FS write could force dual-writer briefly until heartbeat check. |
| M4-ADV-06 | `releaseLease` writes `{}` instead of unlink — stale goalId field harmless but untidy. |
| M4-ADV-07 | Supabase recall write-back still code-only; live DDL not applied (CEO gate) — no live adversarial surface. |

## Attack scenarios tested (conceptual)

1. **Dual Atlas CLI launch** — second process → readonly + stderr notice. ✓ spawn-two E2E
2. **Crash mid-goal** — stale goal lease + budget persist; resume reuses terminal task, no duplicate exec-graph rows. ✓ kill/resume E2E
3. **Budget reset on resume** — `startedAt`, `totalAttempts`, `totalTasksCreated` preserved. ✓
4. **Recall filter malformed** — regression locked in m4-recall-regression.test.ts (prior slice B). ✓

## Verdict rationale
Memory integrity and lease safety meet M4 DoD for bounded V0 goal-runner. Residual risks are operational (readonly not enforced on all write paths, heartbeat gap) — tracked as exceptions, not ship blockers.

**PASS-WITH-EXCEPTION** — ship pending codex-verifier receipt.
