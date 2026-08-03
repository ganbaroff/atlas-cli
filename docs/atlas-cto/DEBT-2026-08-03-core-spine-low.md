# DEBT-2026-08-03 — Core Spine LOW items

**Source change:** `chg_2026_08_03_core_spine` / merge `de12b19`  
**Follow-on:** `chg_2026_08_03_effect_command_linkage` / merge `5a9eafb`  
**Severity:** LOW  
**Owner:** Atlas DevOS (atlas-builder)

---

## DEBT-CS-001 — Weak effect-to-command linkage

| Field | Value |
|---|---|
| Status | **CLOSED** (CEO ACCEPT+MERGE 2026-08-03) |
| Closed by | `codex/atlas-proof-effect-command-linkage` @ `9b16311` / merge `5a9eafb` |
| Resolution | Required `effectProofs` + stable command/test/artifact ids; soft heuristics removed |
| Affected files | `src/core-spine/evidence-pack-contract.ts`, `src/core-spine/spine-verifier.ts`, `src/__tests__/core-spine.test.ts` |

---

## DEBT-CS-002 — Personal-path protection is regex-based

| Field | Value |
|---|---|
| Status | open |
| Impact | Alternate spellings / junctions / home paths might evade `allowedWrites` personal-memory ban |
| Owner | atlas-builder |
| Resolution trigger | Before any project adapter may write outside a single declared repo root |
| Affected files | `src/core-spine/project-agent-contract.ts`, `src/core-spine/spine-verifier.ts` |
| Mitigation until then | Explicit `forbiddenPaths` + single-repo proofs; no personal-memory effects in packs |

---

## DEBT-CS-003 — Effect-token RegExp is fragile

| Field | Value |
|---|---|
| Status | **MITIGATED** on effect↔command linkage path (dynamic effect RegExp removed with DEBT-CS-001) |
| Residual | `PERSONAL_MEMORY_EFFECT` RegExp remains for memory ban (separate from linkage) |
| Owner | atlas-builder |
| Resolution trigger | With DEBT-CS-002 personal-path hardening |
| Affected files | `src/core-spine/spine-verifier.ts` |

---

## Residual LOW (from independent review of supervised proof)

### DEBT-CS-004 — Orphan-proof negative coverage missing

| Field | Value |
|---|---|
| Status | open |
| Impact | Proof `effectId` ∉ `actualEffects` is enforced at parse/verify but lacks a dedicated negative unit test |
| Owner | atlas-builder |
| Resolution trigger | Next Core Spine test hardening wave |
| Affected files | `src/__tests__/core-spine.test.ts`, `src/core-spine/evidence-pack-contract.ts`, `src/core-spine/spine-verifier.ts` |

### DEBT-CS-005 — Artifact hash mismatch negative coverage missing

| Field | Value |
|---|---|
| Status | open |
| Impact | Diff-artifact hash vs `pack.diffHash` mismatch is enforced at verify but only positive artifact tests exist |
| Owner | atlas-builder |
| Resolution trigger | Next Core Spine test hardening wave |
| Affected files | `src/__tests__/core-spine.test.ts`, `src/core-spine/spine-verifier.ts` |
