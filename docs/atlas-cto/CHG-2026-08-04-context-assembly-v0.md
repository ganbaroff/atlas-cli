# CHG-2026-08-04 — Atlas Context Assembly v0

**Status:** OPEN — awaiting CEO receipt  
**Capability:** `ATLAS CONTEXT ASSEMBLY v0`  
**Branch:** `atlas/context-assembly-v0-2026-08-04`  
**Base tip:** `225e461` (post Project Resolution merge; docs tip may be `43bbfa5`)  
**Courier:** Loop v0; `MALFORMED_REVIEW` for invalid reviewer output

## Change (4 ≤ 5 production files)

| File | Role |
|---|---|
| `src/atlas/context-assembly/contracts.ts` | `AtlasContextPack` zod |
| `src/atlas/context-assembly/source-catalog.ts` | Bounded curated sources + authority ranks |
| `src/atlas/context-assembly/assemble.ts` | Read-only assembler |
| `src/atlas/context-assembly/index.ts` | Barrel |

Tests: `src/__tests__/context-assembly.test.ts` (15)

## Policy

`READ-ONLY TARGET READY` ≠ `PROJECT EXECUTION READY`

## Non-goals

No embeddings/vector DB, full memory crawl, planning/execution, writes, push/deploy, Hermes/Codex/OpenManus.
