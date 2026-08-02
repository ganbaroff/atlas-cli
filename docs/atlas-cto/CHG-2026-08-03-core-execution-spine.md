# CHG-2026-08-03 — Core Execution Spine

**Change ID:** `chg_2026_08_03_core_spine`  
**Branch:** `codex/atlas-core-execution-spine`  
**Parent tip:** `073f1e5b8947bea50af9d27d51730e6cec2fea74`  
**Decision link:** `C:\Projects\VOLAURA\memory\atlas\decisions\ATLAS-CORE-AND-HANDS-DECISION-2026-08-03.md`  
**Status:** locally verified (focused tests)

## Why this wave exists

Future hands (Hermes, OpenManus, Cursor, Claude Code, Codex) must plug into Atlas as **replaceable adapters** under one fail-closed evidence + lifecycle contract. Without a Core Spine, each integration invents a second authority.

## Exact files changed (ANUS worktree)

| Path | Role |
|---|---|
| `src/core-spine/executor-adapter-contract.ts` | Executor adapter zod contract |
| `src/core-spine/project-agent-contract.ts` | Project agent boundary contract |
| `src/core-spine/evidence-pack-contract.ts` | Evidence pack contract |
| `src/core-spine/lifecycle-binding.ts` | Spine stage → exec-graph status map |
| `src/core-spine/spine-verifier.ts` | Fail-closed verification invariants |
| `src/core-spine/index.ts` | Public exports |
| `src/core-spine/README.md` | Module index |
| `src/__tests__/core-spine.test.ts` | Focused tests (20) |
| `docs/atlas-cto/CHG-2026-08-03-core-execution-spine.md` | This change record |

## VOLAURA memory write-back (authorized)

| Path | Role |
|---|---|
| `memory/atlas/decisions/ATLAS-CORE-AND-HANDS-DECISION-2026-08-03.md` | Permanent compact-safe decision |
| `memory/atlas/CURRENT-COMPACT.md` | Pointer section added |

## Affected components

- **Reuses:** exec-graph `TaskStatus` / `taskIdSchema` (no new task engine)
- **Does not touch:** runners, schedulers, Telegram, model-router runtime, Hermes, OpenManus

## Tests run

```text
npx vitest run src/__tests__/core-spine.test.ts
→ 20 passed (2026-08-03)
```

Default CI / skipped QA harness **not** enabled or modified.

## Risks

| Risk | Mitigation |
|---|---|
| Contracts unused until first proof | Next wave is supervised human-Cursor proof only |
| Mapping rolled_back→rejected loses nuance | Documented; repair loop uses existing rejected→proposed edge |
| Zod-only schemas without JSON Schema files | Markdown + zod matches architecture; JSON Schema optional later |

## Deviations

- No JSON Schema files created (zod is the mechanical validator already used by exec-graph/hands).
- Independent review #1 **REJECT** (fail-open without project; commandsRun unchecked; personal paths in allowedWrites). Repaired in-wave; review #2 expected after re-test.
- `verifyEvidencePack` now **requires** `project` (fail-closed allowlist).

## Independent review evidence

1. First review: REJECT — H1/H2/H3 (documented in session).  
2. Repair: project required; commandsRun exit/skip/hash checks; personal memory paths banned in `allowedWrites`; independent verifier id pattern; paid spend gate; extra tests.  
3. Focused tests after repair: **25 passed**.

## Rollback procedure

1. Discard/delete worktree branch `codex/atlas-core-execution-spine` (or revert its commit).  
2. Optionally remove the Permanent architecture pointer section from `CURRENT-COMPACT.md` (decision file may remain as historical ACCEPTED record).  
3. Tip `073f1e5` unchanged until explicit merge authorization.

## Technical debt introduced

- No CLI wiring for spine contracts yet (intentional).  
- No adapter registry persistence yet.  
- `rolled_back` shares `rejected` status — may need note field convention in a later wave.  
- LOW (post-PASS review): effect↔command linkage still weak; personal-path guard is regex-only; fragile RegExp on effect tokens.

## Next restart point

**Supervised proof (NOT executed here):**  
`CEO goal → Atlas plan → isolated worktree → human-operated Cursor executor → diff → tests → independent verification → CEO receipt`
