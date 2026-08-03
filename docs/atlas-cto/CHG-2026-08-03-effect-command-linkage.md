# CHG — First Supervised Proof: Effect↔Command Linkage

**Change ID:** `chg_2026_08_03_effect_command_linkage`  
**Proof ID:** `proof_2026_08_03_effect_command_linkage`  
**Branch:** `codex/atlas-proof-effect-command-linkage` @ `6440175` (code `9b16311`)  
**Base tip:** `7a43a49d432f00115b00012fad2b038f8fee316e`  
**Merge commit:** `5a9eafbf9a7e76efd96171a347ebaf19896e41f0`  
**Canonical branch:** `codex/atlas-cost-router-design`  
**Debt target:** DEBT-CS-001 (mitigates DEBT-CS-003 linkage RegExp)  
**Status:** **CLOSED — MERGED AND VERIFIED** (CEO ACCEPT+MERGE 2026-08-03)  
**Plan:** `docs/atlas-cto/PLAN-2026-08-03-effect-command-linkage.md`  
**Receipt:** `docs/atlas-cto/RECEIPT-2026-08-03-first-supervised-proof.md`

## Intent

Strengthen EvidencePack so every `actualEffect` must cite ≥1 recorded command/test/artifact by stable id. Failed/skipped commands cannot prove effects. Narrative alone cannot prove.

## Files merged

| Path | Change |
|---|---|
| `src/core-spine/evidence-pack-contract.ts` | `id` on commands; `effectProofs`; `artifacts` |
| `src/core-spine/spine-verifier.ts` | Explicit linkage checks; remove soft heuristics |
| `src/core-spine/index.ts` | Export new schemas/types |
| `src/core-spine/README.md` | Document linkage |
| `src/__tests__/core-spine.test.ts` | Linkage suite + fixture update |
| `docs/atlas-cto/PLAN-…` / `CHG-…` / `EVIDENCE-…` / `DEBT-NOTE-…` | Proof records |

## Post-merge verification

| Gate | Result |
|---|---|
| Focused `core-spine.test.ts` | **37 passed**, exit 0 |
| Full `npx vitest run` | **144 files**, **1391 passed / 2 skipped**, exit 0 |
| Conflicts | none |
| Tip before merge | `7a43a49` confirmed |
| Feature tip | `6440175` confirmed (descendant of `9b16311`) |

## Rollback

```text
git revert -m 1 5a9eafb
```

## Forbidden (held through merge)

No push, deploy, runners, Hermes/OpenManus, IDE automation, Telegram/browser/desktop, second authorities.
