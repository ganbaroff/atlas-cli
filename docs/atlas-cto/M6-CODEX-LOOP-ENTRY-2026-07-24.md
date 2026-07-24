# M6 Codex-Loop Entry — Six Fields
**Date:** 2026-07-24  
**Branch:** `codex/m6-provider-health-spend`

## 1. Shipped
- Durable provider health (healthy/degraded/dead + cooldown)
- Dead provider never WORKER (routeModel + assertProviderAllowed)
- Local durable spend receipts + correlationId per call
- Optional SQL additive for correlation_id (not applied)

## 2. Proof
```
npm run typecheck → PASS
npm test -- --run → 792 passed, 2 skipped
npm test -- --run src/__tests__/m6-*.test.ts → PASS
```

## 3. Decisions
- Health persist to `~/.atlas/provider-health.json` (override via ATLAS_PROVIDER_HEALTH_DIR)
- Spend truth without live DDL via local JSONL receipts
- Live Supabase correlation_id column deferred to CEO gate

## 4. Deferred
- Live apply `db/llm_spend.sql` + `db/llm_spend_correlation_id.sql`
- Swarm live diversity proof (still RESEARCH_ONLY_LIMITED)
- Hash-chained spend receipts (M8)

## 5. Residual risk
- PASS-WITH-EXCEPTION (M6-ADV-01..03)
- Supabase insert may 400 until correlation_id column applied — non-blocking

## 6. Commit hash + counts
- Tip: `7d73cc9`
- Windows / PowerShell / Node
- vitest: 792 passed, 2 skipped
