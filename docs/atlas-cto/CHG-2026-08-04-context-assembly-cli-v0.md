# CHG-2026-08-04 — Atlas Context Assembly CLI v0

**Status:** COMPLETE — awaiting CEO receipt  
**Capability:** `ATLAS CONTEXT ASSEMBLY CLI v0`  
**Branch:** `atlas/context-assembly-cli-v0-2026-08-04`  
**Base tip:** `ffa9b0c` (+ merge of Context Assembly module)  
**Gate:** Deterministic tests (advisory ChatGPT optional / skipped — transport debt)

## Change (≤5 production files this wave)

| File | Role |
|---|---|
| `src/atlas/context-assembly/pipeline.ts` | `runGoalContext` orchestration + JSON envelope |
| `src/atlas/context-assembly/index.ts` | Export pipeline |
| `src/cli.ts` | `atlas goal context --message --json` |

Also brings prior Context Assembly module via merge (not new this wave).

Tests: `src/__tests__/cli-goal-context.test.ts` (11)

## CLI

```text
atlas goal context --message "<CEO goal>" --json
```

Exit: READY_TO_PLAN=0, BLOCKED=2, NEEDS_APPROVAL=3, invalid=1

## Non-goals

No Planning, no execution, no browser automation, no push/deploy.
