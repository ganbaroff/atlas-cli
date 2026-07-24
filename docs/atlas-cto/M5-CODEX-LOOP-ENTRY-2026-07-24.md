# M5 Codex-Loop Entry — Six Fields
**Date:** 2026-07-24  
**Branch:** `codex/m5-manifest-sdk`

## 1. Shipped
- Hand Manifest SDK (`src/hands/manifest.ts` + `hand-spec.ts`)
- `file-search` hand via JSON manifest — **zero REGISTRY literal**
- File-search implementation (`src/hands/file-search.ts`)
- M4 debt closed: instance heartbeat loop, `ATLAS_READONLY` exec-graph guard, CLI exit breadcrumb auto-write

## 2. Proof
```
npm run typecheck → PASS
npm test -- --run → 800 passed, 2 skipped
npm test -- --run src/__tests__/m5-manifest.test.ts src/__tests__/m5-m4-debt.test.ts → PASS
```

## 3. Decisions
- Schema extracted to `hand-spec.ts` to avoid registry↔manifest cycle
- Manifest overlay merged in getHand/listHands; collision with static REGISTRY fails closed
- Readonly guard on createGoal/createTask/moveTask

## 4. Deferred
- Migrating all static REGISTRY hands to manifests
- Broader mutating-path audit beyond exec-graph API

## 5. Residual risk
- process.exit monkeypatch for breadcrumb is best-effort
- createRequire not used; top-level import of manifest from registry

## 6. Commit hash + counts
- Tip: `1fb8c1a`
- vitest: 800 passed, 2 skipped
