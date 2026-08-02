# CHG-2026-08-03 — Core Execution Spine

**Change ID:** `chg_2026_08_03_core_spine`  
**Feature branch:** `codex/atlas-core-execution-spine` @ `5f9c41528288f5f17b7c4df5344698a05d3f1a2e`  
**Parent tip (pre-merge):** `073f1e5b8947bea50af9d27d51730e6cec2fea74`  
**Merge commit:** `de12b19c73e35a848b9ead1439204d30c9ad6a52`  
**Canonical branch:** `codex/atlas-cost-router-design`  
**Decision link:** `C:\Projects\VOLAURA\memory\atlas\decisions\ATLAS-CORE-AND-HANDS-DECISION-2026-08-03.md`  
**Status:** **CLOSED — MERGED AND VERIFIED** (CEO ACCEPT+MERGE 2026-08-03)

## Why this wave exists

Future hands (Hermes, OpenManus, Cursor, Claude Code, Codex) must plug into Atlas as **replaceable adapters** under one fail-closed evidence + lifecycle contract. Without a Core Spine, each integration invents a second authority.

## Exact files merged

| Path | Role |
|---|---|
| `src/core-spine/executor-adapter-contract.ts` | Executor adapter zod contract |
| `src/core-spine/project-agent-contract.ts` | Project agent boundary contract |
| `src/core-spine/evidence-pack-contract.ts` | Evidence pack contract |
| `src/core-spine/lifecycle-binding.ts` | Spine stage → exec-graph status map |
| `src/core-spine/spine-verifier.ts` | Fail-closed verification invariants |
| `src/core-spine/index.ts` | Public exports |
| `src/core-spine/README.md` | Module index |
| `src/__tests__/core-spine.test.ts` | Focused tests (25) |
| `docs/atlas-cto/CHG-2026-08-03-core-execution-spine.md` | This change record |

## Post-merge verification

| Gate | Result |
|---|---|
| Focused `core-spine.test.ts` | **25 passed**, exit 0 |
| Full `npx vitest run` | **144 files passed**, **1379 passed / 2 skipped**, exit 0 |
| Conflicts | none |
| Tip before merge | `073f1e5` confirmed |
| Feature commit unchanged | `5f9c415` confirmed |

## Independent review evidence

1. First review: REJECT — H1/H2/H3.  
2. Repair in feature branch.  
3. Second review: PASS (LOW debt only).  
4. LOW debt filed: `docs/atlas-cto/DEBT-2026-08-03-core-spine-low.md` (DEBT-CS-001..003).

## Rollback procedure (post-merge)

1. On canonical tip: `git revert -m 1 de12b19` (creates new revert commit; do not rewrite history).  
2. Or CEO-authorized hard reset only if never pushed (currently **not pushed**).  
3. Decision/CURRENT-COMPACT pointers remain unless CEO reverts those files separately.

## Closed

CEO receipt: `docs/atlas-cto/RECEIPT-2026-08-03-core-spine-merge.md`  
Next restart: supervised human-Cursor developer-agent proof (not started).
