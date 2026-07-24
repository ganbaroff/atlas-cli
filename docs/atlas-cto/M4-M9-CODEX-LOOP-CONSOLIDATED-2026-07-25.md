# M4–M9 Consolidated Codex-Loop Entry (six fields per module)
**Date:** 2026-07-25  
**Integration branch:** `feat/arsenal-wiring` @ `5448b6d` (docs `99e6461`)  
**Independent verifier:** `docs/atlas-cto/M6-M9-VERIFIER-RECEIPT-2026-07-25.md` → PASS-WITH-EXCEPTION  
**VOLAURA transfer:** prepared block for `C:\Projects\VOLAURA\memory\atlas\codex-loop.md` — append by CEO/verifier-lane (atlas-builder does not edit VOLAURA without explicit gate)

---

## M4 — Durable memory (`8815b3f`, verifier PASS-WITH-EXCEPTION)
1. **Shipped:** kill-resume, instance lease, breadcrumb hook, spawn-two + kill/resume E2E  
2. **Proof:** 787 passed; M4 exceptions closed in M5  
3. **Decisions:** title-key resume; child-process tsx ESM scripts  
4. **Deferred:** live Supabase DDL  
5. **Risk:** readonly/heartbeat gaps → closed M5  
6. **Hash:** `8815b3f` / suite 811 on integration tip

## M6 — Provider health + spend (`41312f5`)
1. **Shipped:** durable health store; dead provider never WORKER; local JSONL spend receipts + correlationId  
2. **Proof:** m6-* tests; negative routing test  
3. **Decisions:** local receipts = durable truth without live DDL  
4. **Deferred:** live `llm_spend` apply (CEO b1)  
5. **Risk:** M6-ADV-01..03; Supabase 400 until column applied  
6. **Hash:** `41312f5`

## M5 — Manifest SDK (`a7675e2`)
1. **Shipped:** HandSpec manifest SDK; file-search via JSON; M4 debt (heartbeat, readonly guard, exit breadcrumb)  
2. **Proof:** m5-manifest + m5-m4-debt; registry.ts has no file-search literal  
3. **Decisions:** hand-spec.ts breaks circular import  
4. **Deferred:** migrate all static REGISTRY hands  
5. **Risk:** process.exit monkeypatch best-effort  
6. **Hash:** `a7675e2`

## M8 — Evidence audit (`26820ea`)
1. **Shipped:** typed claims, hash-chain ledger, read-only auditor, CLI `evidence audit`  
2. **Proof:** findingsCount >= 2 fixture; structural import ban  
3. **Decisions:** auditor outside Hand registry  
4. **Deferred:** FP registry; full verify() replay  
5. **Risk:** V0 stale = path existence only  
6. **Hash:** `26820ea`

## M9 — OPSBOARD integration (`5448b6d`)
1. **Shipped:** goal-request port, failure matrix, opsboard drain CLI, OPSBOARD atlas-bridge  
2. **Proof:** m9-* tests; live exchange receipt 2026-07-25  
3. **Decisions:** file exchange only; no shared DB  
4. **Deferred:** OPSBOARD remote push; UI wiring  
5. **Risk:** exchange dir must be configured both sides  
6. **Hash:** `5448b6d`

---

**Stack receipt hash:** `5448b6d`  
**Full suite at close:** 814 passed / 2 skipped (after M10 tests land)
