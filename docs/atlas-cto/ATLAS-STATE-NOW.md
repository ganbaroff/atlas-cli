# ATLAS — STATE NOW (post-compaction orientation)
_Last written: 2026-07-25 by proof-closure M6→M10. Read this FIRST on resume._

## PURPOSE (current mission)
**APP-RUN-01** — portable agent-factory (ADR-0009). Binding plan: M-module map in
`C:\Projects\VOLAURA\memory\atlas\codex-loop.md`.

## MODULE MAP STATE (updated 2026-07-25 proof-closure)
- **M1 Trust Floor — CLOSED** `c47a2ea`
- **M2 Browser Hand — CLOSED** `b21228b` (Git-Bash audit debt)
- **M3 Goal Runner — CLOSED** `0983154` (Git-Bash audit debt)
- **M7 Control+Notify+Supervised-Assist — CLOSED** `8456289`
- **Research-swarm — INTEGRATED** `4c25cac` (RESEARCH_ONLY_LIMITED)
- **M4 Durable memory — CLOSED** `8815b3f` / verifier PASS-WITH-EXCEPTION
- **M6 Provider health+spend — CLOSED** `41312f5` / independent verifier PASS-WITH-EXCEPTION
- **M5 Manifest SDK + M4 debt — CLOSED** `a7675e2` / independent verifier PASS
- **M8 Evidence audit — CLOSED** `26820ea` / independent verifier PASS
- **M9 OPSBOARD integration — CLOSED** `5448b6d` / independent verifier PASS
- **M10-internal install/upgrade/rollback — CLOSED** (see M10-VERIFIER-RECEIPT-2026-07-25)
- **Integration tip:** `main` @ **`ae79bf2`** (PR #13 merged, Railway + Supabase live)
- **Roadmap:** [`POST-M10-ROADMAP.md`](POST-M10-ROADMAP.md) — Sprint A manifest migration in progress
- **NEXT:** Sprint B Git-Bash audit → Sprint C swarm honesty → live product loop

## VERIFIED 2026-07-25 (proof-closure)
- Full suite: **814 passed, 2 skipped** (incl. M10 lifecycle)
- Independent re-pass M6→M9: typecheck + build + 811/813 + module DoD replays
- M9 live exchange: bidirectional receipt (`M9-LIVE-CROSS-REPO-RECEIPT-2026-07-25.md`)
- M10: install / upgrade / rollback child-process E2E PASS-WITH-EXCEPTION

## OPEN / CEO GATES
1. **b1 Supabase** — **CLOSED** 2026-07-25 (`M6-LIVE-SMOKE-RECEIPT-2026-07-25.md`)
2. **OPSBOARD remote push** — deferred (CEO: Atlas focus, not OPSBOARD)
3. **VOLAURA codex-loop append** — consolidated block ready; CEO/verifier-lane writes `codex-loop.md`
4. **Git-Bash audit debt (M2+M3)** — codex-verifier seat
5. **G-ATLAS-USER** — external distribution only

## VERIFY COMMANDS
```
cd "C:\Users\user\OneDrive\Documents\GitHub\ANUS"
git checkout main && git pull --ff-only
npm run typecheck && npm run build
npm test -- --run
npm test -- --run src/__tests__/m10-install-lifecycle.test.ts
node scripts/m9-live-cross-repo.mts
```

## HOW TO RESUME
1. Read this file
2. M4–M10 internal stack CLOSED — do not re-open without CEO veto
3. CEO gates (Supabase, OPSBOARD push, VOLAURA codex append) are explicit OPEN items
4. Next allocation: **Atlas CLI product** (merge PR, Supabase spend, deploy from main)
