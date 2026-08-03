# EVIDENCE PACK — First Supervised Developer-Agent Proof

**Proof ID:** `proof_2026_08_03_effect_command_linkage`  
**Change ID:** `chg_2026_08_03_effect_command_linkage`  
**Lifecycle:** CEO GOAL → PRECHECK → PLAN → ISOLATED WORKTREE → HUMAN CURSOR → DIFF → TESTS → INDEPENDENT VERIFICATION → CEO RECEIPT (pending)  
**ceoDecision:** `pending`

## Precheck

| Check | Result |
|---|---|
| Canonical tip | `7a43a49d432f00115b00012fad2b038f8fee316e` MATCH |
| Working tree clean (canonical) | YES |
| AtlasRunner | Disabled |
| AtlasRunnerS4 | Disabled |
| External executor required | NO |
| Network/deploy/push/production | NOT REQUIRED |
| Rollback | discard proof branch/worktree |

## Isolation

| Field | Value |
|---|---|
| Worktree | `C:\Users\user\OneDrive\Documents\GitHub\ANUS\.worktrees\atlas-proof-effect-command-linkage` |
| Branch | `codex/atlas-proof-effect-command-linkage` |
| Base SHA | `7a43a49d432f00115b00012fad2b038f8fee316e` |
| Feature commit | `9b163114b66a1434860d79ec97b23682488e7401` |
| Diff hash (SHA-256 of `git diff 7a43a49..HEAD`) | `04ed81f11769f981195212b75270f3c50747a0c11a154238a4f45714dcfac7da` |

## Executor

- **Identity:** `adapter.human-cursor@proof-2026-08-03`
- **Mode:** human-operated Cursor (this session)
- **Did not issue final verification PASS**

## Exact files changed

1. `src/core-spine/evidence-pack-contract.ts`
2. `src/core-spine/spine-verifier.ts`
3. `src/core-spine/index.ts`
4. `src/core-spine/README.md`
5. `src/__tests__/core-spine.test.ts`
6. `docs/atlas-cto/PLAN-2026-08-03-effect-command-linkage.md`
7. `docs/atlas-cto/CHG-2026-08-03-effect-command-linkage.md`

Stat: +553 / −36 (7 files)

## Declared effects

- `extend-evidence-pack-effect-proofs`
- `strengthen-spine-verifier-linkage`
- `add-focused-linkage-tests`
- `record-proof-plan-and-chg`

## Actual effects

Same as declared (scope held).

## Effect proofs (command/artifact links)

| effectId | provenBy |
|---|---|
| `extend-evidence-pack-effect-proofs` | command `cmd-impl` (edit), artifact `art-diff` |
| `strengthen-spine-verifier-linkage` | command `cmd-impl`, artifact `art-diff` |
| `add-focused-linkage-tests` | test `tst-focused`, artifact `art-diff` |
| `record-proof-plan-and-chg` | command `cmd-impl`, artifact `art-diff` |

## Commands run

| id | command | exit | outputHash |
|---|---|---|---|
| `cmd-precheck` | git rev-parse / status / schtasks AtlasRunner* | 0 | (precheck log; tip match) |
| `cmd-impl` | edit core-spine + tests + docs | 0 | (diff hash above) |
| `tst-focused` | `npx vitest run src/__tests__/core-spine.test.ts` | **0** | `561e365f57d93f059edd6a62957a064b99054aa10637c5f309dee27dc3220036` |
| `tst-full` | `npx vitest run` (after node_modules junction fix) | **0** | `84e4746c0ad8be228d2cc4cac02f379be9a7dc8083340eb7866fbd1b5da9e216` |

### Test results

| Gate | Result |
|---|---|
| Focused Core Spine | **37 passed**, exit 0 |
| Full ANUS Vitest | **144 files passed**, **1391 passed / 2 skipped**, exit 0 |

### Env note (not a code defect)

First full-suite attempt in worktree failed (incomplete local `node_modules`, missing `tsx`). Junctioned worktree `node_modules` → parent ANUS `node_modules`, re-ran: green. Failures were env, not Core Spine changes. Canonical tip still passes same previously-failing suites without this change.

## Independent verifier

| Field | Value |
|---|---|
| Verifier identity | `independent@composer-2.5-fast` (agent `63ae5ee8-fd07-465d-9a34-15102d1f9d4c`) |
| Distinct from executor | YES |
| Verdict | **PASS** |
| Self-certification | NO |

Summary: explicit `effectProofs` enforce linkage; soft heuristics + fragile effect-token RegExp removed; DEBT-CS-001 closed in Core Spine scope; DEBT-CS-003 mitigated on linkage path; residual test gaps noted (orphan-proof direction, artifact hash mismatch negative).

## Remaining debt

| ID | Status after this proof |
|---|---|
| DEBT-CS-001 | **CLOSED pending CEO merge** (linkage enforced) |
| DEBT-CS-002 | OPEN (regex personal-path) |
| DEBT-CS-003 | **MITIGATED** on linkage path; PERSONAL_MEMORY_EFFECT RegExp remains elsewhere |

## Rollback

```text
# discard proof branch (canonical tip untouched)
cd C:\Users\user\OneDrive\Documents\GitHub\ANUS
git worktree remove .worktrees\atlas-proof-effect-command-linkage
git branch -D codex/atlas-proof-effect-command-linkage
```

Or keep worktree and reset branch to `7a43a49`.

## Merge recommendation

**MERGE** (after CEO receipt) — no merge performed in this proof.

## Forbidden held

No merge, push, deploy, runner/scheduler enablement, Hermes/OpenManus, Cursor/Claude/Codex automation, Telegram/browser/desktop, second authorities.
