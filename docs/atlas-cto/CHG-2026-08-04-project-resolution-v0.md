# CHG-2026-08-04 — Atlas Project Resolution v0

**Status:** OPEN — awaiting CEO receipt  
**Capability:** `ATLAS PROJECT RESOLUTION v0`  
**Branch:** `atlas/project-resolution-v0-2026-08-04`  
**Base tip:** `6106029` (`codex/atlas-cost-router-design`)  
**Courier:** Loop v0 (ChatGPT via Comet; `MALFORMED_REVIEW` required for invalid reviewer schema)

## Change (≤5 production files)

| File | Role |
|---|---|
| `src/atlas/goal-intake/project-registry.ts` | Extended registry (candidates, lifecycle, verification) |
| `src/atlas/goal-intake/resolution-contracts.ts` | `AtlasProjectResolution` zod |
| `src/atlas/goal-intake/resolve-project.ts` | Deterministic resolver + GoalContract bind |
| `src/atlas/goal-intake/index.ts` | Barrel exports |

Tests: `src/__tests__/project-resolution.test.ts` (15)  
Examples: `EXAMPLE-PROJECT-RESOLUTION-ANUS.json`, `EXAMPLE-PROJECT-RESOLUTION-INTEGRONIX.json`

## Non-goals

No project execution, runners, daemon, full-disk scan, second memory/task graph, Hermes/Codex/OpenManus, website changes, push/deploy.
