# CHG-2026-08-03 — Atlas Goal Intake v0

**Status:** MERGED AND VERIFIED (CEO ACCEPT+MERGE 2026-08-04)  
**Capability:** `ATLAS GOAL INTAKE v0`  
**Branch:** `atlas/goal-intake-v0-2026-08-03`  
**Commits:** `f9ba24d` (feat) → `ac83be3` (repair) → `628b9b2` (docs)  
**Base tip:** `0b75dae` (`codex/atlas-cost-router-design`)  
**Merge commit:** `3e1d8d3`  
**Courier:** Loop v0 — ChatGPT via Comet; isolated ANUS worktree

## Change (4 ≤ 5 production files)

| File | Role |
|---|---|
| `src/atlas/goal-intake/contracts.ts` | `AtlasGoalContract` zod + parse |
| `src/atlas/goal-intake/project-registry.ts` | Thin known-project mirror of CEO-PROJECT-MAP |
| `src/atlas/goal-intake/intake.ts` | Interpret + optional exec-graph bind |
| `src/atlas/goal-intake/index.ts` | Barrel exports |

Tests: `src/__tests__/goal-intake.test.ts` (13 PASS)  
Example: `docs/atlas-cto/EXAMPLE-GOAL-CONTRACT-INTEGRONIX-AUDIT.json`

## Courier chain

1. CEO authorization (this wave)  
2. Cursor implementation (IDE on worktree)  
3. Evidence under `~\.atlas\quarantine\evidence\goal-intake-v0-2026-08-03\`  
4. ChatGPT review #1 → **REPAIR** (idempotent goal/task rebind)  
5. Repair `ac83be3` (max 1)  
6. ChatGPT final (reasoned) → **ACCEPT**  
7. Deterministic verifier: vitest goal-intake **13/13 PASS**  
8. CEO receipt (this document + ceo-feed)

## Non-goals

No second planner/task graph/memory. No runners/daemon. No Integronix production changes. No Hermes/Codex/OpenManus. No merge until CEO receipt.
