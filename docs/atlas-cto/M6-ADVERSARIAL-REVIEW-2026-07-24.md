# M6 Adversarial Review — Provider Health + Spend
**Date:** 2026-07-24  
**Verdict:** **PASS-WITH-EXCEPTION**

## Findings
### HIGH — none

### MEDIUM
| ID | Finding | Residual |
|----|---------|----------|
| M6-ADV-01 | Local spend receipts can be deleted by FS attacker; not hash-chained | Accept for M6; M8 evidence chain can absorb later |
| M6-ADV-02 | Health store fail-open on corrupt JSON (treat as empty → all healthy) | Same pattern as leases; intentional crash recovery |
| M6-ADV-03 | Live `llm_spend` table may lack `correlation_id` until CEO applies additive SQL | Local receipts still durable; Supabase write omits column harmlessly if absent? **Risk:** PostgREST may 400 on unknown column — write is non-blocking |

### Mitigation for ADV-03
Supabase write includes `correlation_id`. If live schema lacks column, insert fails non-fatally (logged). Until CEO applies `db/llm_spend_correlation_id.sql`, local JSONL is source of durable truth for fixtures.

## Attack scenarios
1. Dead provider forced into WORKER — blocked by `isAvailable` + `assertProviderAllowed`. ✓
2. Spend call without receipt — `recordSpend` always appends local receipt before optional remote. ✓
3. Spoof paid spend without ATLAS_ALLOW_PAID — still gated by spend-policy. ✓

## Verdict
**PASS-WITH-EXCEPTION** — ship code+tests; live DDL remains CEO-gated.
