# M9 Cross-Repo Interface — FROZEN
**Date:** 2026-07-24  
**Repos:** ANUS (`codex/m9-opsboard-integration`) + OPSBOARD-PRO (`modules/atlas-bridge`)  
**Transport:** shared exchange directory (`ATLAS_OPSBOARD_EXCHANGE_DIR`) — JSON files only.  
**Rule:** no Atlas memory / exec-graph / product state copied between repos.

## Messages

### GoalRequest (`requests/<correlationId>.json`)
```json
{
  "correlationId": "corr_<uuid>",
  "action": "run" | "cancel",
  "objective": "string",
  "issuedAt": "ISO-8601",
  "issuedBy": "opsboard",
  "handId": "browser-foreground",
  "timeoutMs": 60000
}
```

### GoalReceipt (`receipts/<correlationId>.json`)
```json
{
  "correlationId": "corr_<uuid>",
  "status": "completed" | "failed" | "cancelled" | "rejected" | "readonly" | "duplicate" | "timeout",
  "updatedAt": "ISO-8601",
  "goalId": "optional",
  "error": "optional",
  "report": { "status": "...", "tasksVerified": 0 }
}
```

## Writers
- **OPSBOARD-PRO only** writes `requests/`
- **ANUS only** writes `receipts/`
- Neither repo copies the other's `state/` trees

## Failure matrix (required)
| Scenario | Expected receipt status |
|----------|-------------------------|
| timeout | `timeout` |
| cancel before/during | `cancelled` |
| duplicate correlationId | `duplicate` |
| ATLAS_READONLY | `readonly` |
| runner error | `failed` |
| success | `completed` |
