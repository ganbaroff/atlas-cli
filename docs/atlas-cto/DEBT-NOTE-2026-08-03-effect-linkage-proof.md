# DEBT update note — after proof_2026_08_03_effect_command_linkage

**Branch only — not merged.** Canonical tip still carries open DEBT-CS-001 until CEO merges.

## DEBT-CS-001 — Weak effect-to-command linkage

| Field | Value |
|---|---|
| Status on proof branch | **RESOLVED** by explicit `effectProofs` + command/test/artifact ids |
| Impact if unmerged | Tip still has soft heuristics |
| Owner | atlas-builder |
| Resolution trigger | CEO merge of `codex/atlas-proof-effect-command-linkage` @ `9b16311` |
| Affected files | `src/core-spine/evidence-pack-contract.ts`, `src/core-spine/spine-verifier.ts`, `src/__tests__/core-spine.test.ts` |

## DEBT-CS-003 — Effect-token RegExp fragile

| Field | Value |
|---|---|
| Status on proof branch | **MITIGATED** for linkage path (dynamic effect RegExp removed) |
| Residual | `PERSONAL_MEMORY_EFFECT` RegExp remains for memory ban |
| Owner | atlas-builder |
| Resolution trigger | Separate personal-path hardening (with DEBT-CS-002) |
| Affected files | `src/core-spine/spine-verifier.ts` |

## Still open

DEBT-CS-002 — personal-path protection regex-based (unchanged).
