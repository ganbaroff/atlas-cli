# M6 Live Smoke Gate (CEO b1)
**Status:** OPEN until CEO applies DDL and runs smoke  
**Prepared:** 2026-07-25

## Apply (CEO only)
```powershell
cd "C:\Users\user\OneDrive\Documents\GitHub\ANUS"
$env:DATABASE_URL = "<postgres connection string>"
.\db\apply-llm-spend.ps1
```

Manual order (Supabase SQL editor):
1. [`db/llm_spend.sql`](../../db/llm_spend.sql)
2. [`db/llm_spend_correlation_id.sql`](../../db/llm_spend_correlation_id.sql)

## Smoke (after apply)
Requires live `SUPABASE_URL` + `SUPABASE_SERVICE_ROLE_KEY` in `.env`.

```powershell
node --import tsx -e "
import { recordSpend } from './src/atlas/spend-tracker.ts';
const cid = 'corr_smoke_' + Date.now();
await recordSpend({ provider: 'ollama', model: 'test', tokensIn: 1, tokensOut: 1, caller: 'smoke', correlationId: cid });
console.log(JSON.stringify({ correlationId: cid, localReceipt: true }));
"
```

Verify in Supabase:
```sql
select id, provider, model, correlation_id, ts
from public.llm_spend
where correlation_id like 'corr_smoke_%'
order by ts desc
limit 1;
```

## Receipt template (fill after live run)
```
LIVE_SMOKE: PASS | FAIL
correlation_id: <value>
row_id: <uuid>
applied_by: CEO
date: YYYY-MM-DD
```

Until filled → M6 live spend remains **OPEN**, local JSONL receipts remain source of durable truth.
