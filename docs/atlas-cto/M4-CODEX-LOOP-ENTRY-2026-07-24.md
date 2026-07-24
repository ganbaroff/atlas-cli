# M4 Codex-Loop Entry — Six Fields
**Round:** M4 closure (terminal-atlas-executor)  
**Date:** 2026-07-24  
**Branch:** `codex/m4-durable-memory`  
**Body:** terminal-atlas-executor

---

## 1. Shipped
- **M4-A** Goal kill-resume: stale goal lease takeover, `resumeGoalId` budget load, exec-graph terminal task reuse (no duplicate tasks on resume), CLI `goal run --resume <goalId>`
- **M4-B** Recall POST-body regression lock (slice B, prior commit)
- **M4-C** Instance anti-fork lease + CLI readonly mode + **spawn-two child-process E2E**
- **M4-D** Session breadcrumb write-back hook + swarm exit wiring (slice D, prior commit)
- **M4 DoD closure:** `m4-kill-resume-e2e.test.ts` (SIGKILL + resume), browser-hand hook timeout fix, adversarial review doc

## 2. Proof
```
cd C:\Projects\ATLAS\worktrees\atlas-m4-memory
npm run typecheck   → PASS (0 errors)
npm run build       → PASS (tsup ESM)
npm test -- --run   → 787 passed, 2 skipped (789 total)
npm test -- --run src/__tests__/browser-hand.test.ts → 15 passed
npm test -- --run src/__tests__/goal-runner.test.ts src/__tests__/m4-*.test.ts → all passed
```
- Kill/resume E2E: child process SIGKILL → fresh process `resumeGoalId` → budget fields unchanged, exec-graph task count unchanged
- Spawn-two E2E: second Node child → `readonly`; after holder SIGKILL → new writer

## 3. Decisions
- Resume reuses **terminal** exec-graph tasks matched by plan title; non-terminal tasks reused for continue (M4 bounded V0)
- Child-process tests use temp `.mts` scripts + `tsx` + `file://` imports (Windows ESM requirement)
- Instance readonly sets `ATLAS_READONLY=1` but does not yet block all write paths (documented exception)
- No live Supabase DDL, no VOLAURA edits (CEO gate unchanged)

## 4. Deferred
- Periodic instance-lease heartbeat in CLI idle loop (M4-ADV-02)
- Full `ATLAS_READONLY` write-path audit (M4-ADV-01)
- LLM goal decomposition + resume matching beyond title key
- Hard-block CLI exit without breadcrumb on all commands
- Live Supabase DDL apply (CEO gate)

## 5. Residual risk
- **PASS-WITH-EXCEPTION** per `docs/atlas-cto/M4-ADVERSARIAL-REVIEW-2026-07-24.md`
- Readonly mode is loud but not enforced on every mutating code path
- Resume task matching by title only — safe for V0 single-task decomposition
- Supabase emotional memory write-back untested against live DB until DDL gate opens

## 6. Commit hash + counts
- **Branch tip:** _(filled at push — see git log)_
- **Windows / PowerShell / Node v24**
- **typecheck:** 0 errors
- **vitest:** 787 passed, 2 skipped
- **Integration base:** `4c25cac` (research-swarm)
