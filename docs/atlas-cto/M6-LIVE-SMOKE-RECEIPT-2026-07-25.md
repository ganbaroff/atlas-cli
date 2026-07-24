# M6 Live Smoke Receipt
**Date:** 2026-07-25  
**Status:** **PASS**

## Apply
- `llm_spend` base table + `correlation_id` column applied via Supabase Management API
- PostgREST schema reload: `NOTIFY pgrst, 'reload schema'`

## Smoke row
```
correlation_id: corr_smoke_1784929996805
row_id: 276dd16a-e76f-4cd6-87ec-e69a949d3b2d
provider: ollama
caller: smoke
probe: REST 200
```

## Script
`scripts/apply-llm-spend-live.mts` (idempotent re-run safe for correlation_id)
