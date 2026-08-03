# CHG — First Supervised Proof: Effect↔Command Linkage

**Change ID:** `chg_2026_08_03_effect_command_linkage`  
**Proof ID:** `proof_2026_08_03_effect_command_linkage`  
**Branch:** `codex/atlas-proof-effect-command-linkage`  
**Base tip:** `7a43a49d432f00115b00012fad2b038f8fee316e`  
**Debt target:** DEBT-CS-001 (also mitigates DEBT-CS-003 fragile effect RegExp path)  
**Status:** OPEN — awaiting independent verification + CEO receipt  
**Plan:** `docs/atlas-cto/PLAN-2026-08-03-effect-command-linkage.md`

## Intent

Strengthen EvidencePack so every `actualEffect` must cite ≥1 recorded command/test/artifact by stable id. Failed/skipped commands cannot prove effects. Narrative alone cannot prove.

## Files

| Path | Change |
|---|---|
| `src/core-spine/evidence-pack-contract.ts` | `id` on commands; `effectProofs`; `artifacts` |
| `src/core-spine/spine-verifier.ts` | Explicit linkage checks; remove soft heuristics |
| `src/core-spine/index.ts` | Export new schemas/types |
| `src/core-spine/README.md` | Document linkage |
| `src/__tests__/core-spine.test.ts` | Linkage suite + fixture update |
| `docs/atlas-cto/PLAN-…` | Pre-implementation plan |
| `docs/atlas-cto/CHG-…` | This record |

## Forbidden (held)

No merge, push, deploy, runners, Hermes/OpenManus, IDE automation, Telegram/browser/desktop, second authorities.
