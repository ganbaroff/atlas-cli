# DEBT-2026-08-03 — Core Spine LOW items

**Source change:** `chg_2026_08_03_core_spine` / merge `de12b19`  
**Severity:** LOW  
**Owner:** Atlas DevOS (atlas-builder)  
**Status:** open  

---

## DEBT-CS-001 — Weak effect-to-command linkage

| Field | Value |
|---|---|
| Impact | An `actualEffect` string may verify without a strict 1:1 link to a recorded command; over-relies on soft heuristics |
| Owner | atlas-builder |
| Resolution trigger | Before first automated (non-human) executor adapter is authorized |
| Affected files | `src/core-spine/spine-verifier.ts` |
| Mitigation until then | Human-operated Cursor proof only; independent review of evidence packs |

## DEBT-CS-002 — Personal-path protection is regex-based

| Field | Value |
|---|---|
| Impact | Alternate spellings / junctions / home paths might evade `allowedWrites` personal-memory ban |
| Owner | atlas-builder |
| Resolution trigger | Before any project adapter may write outside a single declared repo root |
| Affected files | `src/core-spine/project-agent-contract.ts`, `src/core-spine/spine-verifier.ts` |
| Mitigation until then | Explicit `forbiddenPaths` + single-repo proofs; no personal-memory effects in packs |

## DEBT-CS-003 — Effect-token RegExp is fragile

| Field | Value |
|---|---|
| Impact | Effect tokens with special characters could throw or over-match during unrecorded-effect checks |
| Owner | atlas-builder |
| Resolution trigger | When strengthening effect↔command linkage (with DEBT-CS-001) |
| Affected files | `src/core-spine/spine-verifier.ts` |
| Mitigation until then | Keep effect strings simple alphanumeric tokens in supervised proofs |
