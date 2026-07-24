# ATLAS — STATE NOW (post-compaction orientation)
_Last written: 2026-07-24 by Sprint-1 M4 close-out. Previous version superseded;
preserved in git history. Read this FIRST on resume._

## PURPOSE (current mission)
**APP-RUN-01** — portable agent-factory (ADR-0009). Binding plan: M-module map in
`C:\Projects\VOLAURA\memory\atlas\codex-loop.md` (Rounds 6–25).

## MODULE MAP STATE (frozen Round 20; updated receipts 2026-07-24)
- **M1 Trust Floor — CLOSED** `c47a2ea`
- **M2 Browser Hand — CLOSED** `b21228b` (Git-Bash audit debt)
- **M3 Goal Runner — CLOSED** `0983154` (Git-Bash audit debt)
- **M7 Control+Notify+Supervised-Assist — CLOSED** `8456289`
- **Research-swarm reliability — INTEGRATED** `4c25cac` on `feat/arsenal-wiring`
  - Verdict: **RESEARCH_ONLY_LIMITED** — honest infra; live diversity → M6
- **M4 Durable memory — CLOSED** `ed427e2` on `codex/m4-durable-memory`
  - Verifier: `docs/atlas-cto/M4-VERIFIER-RECEIPT-2026-07-24.md` → **PASS-WITH-EXCEPTION**
  - Codex entry: `docs/atlas-cto/M4-CODEX-LOOP-ENTRY-2026-07-24.md`
  - Exceptions deferred to M5: readonly write-path audit, instance heartbeat, exit breadcrumb hard-gate
- **NEXT: M6** Provider health + spend truth → **M5** manifest SDK → **M8** evidence → **M9** OPSBOARD

## VERIFIED 2026-07-24 (Sprint 1)
- typecheck + build + full suite → **787 passed, 2 skipped**
- Kill/resume + spawn-two child-process E2E PASS
- Diff `4c25cac..ed427e2` safe (no VOLAURA, no live DDL)

## OPEN / WHO OWNS WHAT
1. **M6** — next executor token (provider health + spend; live DDL = CEO gate b1)
2. **Git-Bash audit debt (M2+M3)** — codex-verifier seat
3. **b1 spend-table live apply** — CEO gate
4. **M4 exceptions** — close in M5 sprint
5. **License/provenance NOTICE** — pre-external-release

## VERIFY COMMANDS
```
cd "C:\Users\user\OneDrive\Documents\GitHub\ANUS"
git checkout feat/arsenal-wiring && git pull --ff-only
npm run typecheck && npm run build
npm test -- --run
```

## HOW TO RESUME
1. Read this file
2. Start M6 on worktree from current `feat/arsenal-wiring` tip after merge
3. No VOLAURA product edits, no deploy, no Supabase DDL without CEO gate
