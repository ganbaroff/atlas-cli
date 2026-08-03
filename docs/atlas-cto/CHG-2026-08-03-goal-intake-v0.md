# CHG-2026-08-03 — Atlas Goal Intake v0

**Status:** OPEN — awaiting CEO receipt  
**Capability:** `ATLAS GOAL INTAKE v0`  
**Branch:** `atlas/goal-intake-v0-2026-08-03`  
**Base tip:** `0b75dae`  
**Courier:** Loop v0 (ChatGPT review via Comet; isolated ANUS worktree)

## Change (≤5 production files)

| File | Role |
|---|---|
| `src/atlas/goal-intake/contracts.ts` | `AtlasGoalContract` zod + parse |
| `src/atlas/goal-intake/project-registry.ts` | Thin known-project mirror of CEO-PROJECT-MAP |
| `src/atlas/goal-intake/intake.ts` | Interpret + optional exec-graph bind |
| `src/atlas/goal-intake/index.ts` | Barrel exports |

Tests: `src/__tests__/goal-intake.test.ts`

## Non-goals

No second planner/task graph/memory. No runners/daemon. No Integronix production changes. No Hermes/Codex/OpenManus.
