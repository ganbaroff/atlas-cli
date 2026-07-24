# M10-internal Codex-Loop Entry — Six Fields
**Date:** 2026-07-25  
**Branch:** `feat/arsenal-wiring`

## 1. Shipped
- Install/upgrade/rollback lifecycle proofs via child-process E2E
- Isolated state dir contract (`ATLAS_GOAL_BUDGET_DIR`, `ATLAS_EXEC_GRAPH_DIR`)
- Live cross-repo runner script for M9 (`scripts/m9-live-cross-repo.mts`)

## 2. Proof
```
npm test -- --run src/__tests__/m10-install-lifecycle.test.ts → 3 passed
```

## 3. Decisions
- M10-internal only; G-ATLAS-USER unchanged for external release
- Health proof = structured report output (not strict exit 0 on stale heartbeat)

## 4. Deferred
- Clean-machine `npm ci` from tarball on fresh VM
- External npm publish / onboarding flow

## 5. Residual risk
- PASS-WITH-EXCEPTION (M10-ADV-01..03)

## 6. Commit hash + counts
- Tip: (fill on commit)
- vitest M10: 3 passed
