# ATLAS — STATE NOW (post-compaction orientation)
_Last written: 2026-07-24 by CTO roadmap execution (M4→M9). Read this FIRST on resume._

## PURPOSE (current mission)
**APP-RUN-01** — portable agent-factory (ADR-0009). Binding plan: M-module map in
`C:\Projects\VOLAURA\memory\atlas\codex-loop.md`.

## MODULE MAP STATE (updated 2026-07-24 end-of-roadmap)
- **M1 Trust Floor — CLOSED** `c47a2ea`
- **M2 Browser Hand — CLOSED** `b21228b` (Git-Bash audit debt)
- **M3 Goal Runner — CLOSED** `0983154` (Git-Bash audit debt)
- **M7 Control+Notify+Supervised-Assist — CLOSED** `8456289`
- **Research-swarm — INTEGRATED** `4c25cac` (RESEARCH_ONLY_LIMITED; live diversity → health/spend)
- **M4 Durable memory — CLOSED** `8815b3f` / verifier PASS-WITH-EXCEPTION
- **M6 Provider health+spend — CLOSED** `41312f5` (live DDL still CEO gate b1)
- **M5 Manifest SDK + M4 debt — CLOSED** `a7675e2` (file-search via manifest; heartbeat/readonly/breadcrumb)
- **M8 Evidence audit — CLOSED** `26820ea` (hash-chain + auditor stale/tamper)
- **M9 OPSBOARD integration — CLOSED** `5448b6d` (file exchange; OPSBOARD `modules/atlas-bridge`)
- **Integration tip:** `feat/arsenal-wiring` @ **`5448b6d`** (pushed origin)
- **NEXT:** M10-internal (install/upgrade/rollback) OR return allocation to OPSBOARD product; G-ATLAS-USER gates external distribution only

## VERIFIED 2026-07-24 (roadmap close)
- Full suite on M9 tip: **811 passed, 2 skipped**
- No live Supabase DDL applied; no VOLAURA product edits
- OPSBOARD-PRO bridge committed on OPSBOARD `main` `0923b5f` (local; push separately if remote configured)

## OPEN / WHO OWNS WHAT
1. **b1** live apply `db/llm_spend.sql` (+ correlation_id) — CEO gate
2. **Git-Bash audit debt (M2+M3)** — codex-verifier
3. **Independent verifier re-pass** on stacked M6–M9 if required by fable-orchestrator
4. **License/provenance NOTICE** — pre-external-release
5. **M10-internal** — when scheduled

## VERIFY COMMANDS
```
cd "C:\Users\user\OneDrive\Documents\GitHub\ANUS"
git checkout feat/arsenal-wiring && git pull --ff-only
npm run typecheck && npm run build
npm test -- --run
```

## HOW TO RESUME
1. Read this file
2. Do not re-open M4–M9 without CEO veto — next is M10-internal or OPSBOARD product work
3. No deploy / live DDL / VOLAURA without CEO gate
