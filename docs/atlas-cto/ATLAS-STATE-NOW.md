# ATLAS — STATE NOW (post-compaction orientation)
_Last written: 2026-07-24 by M4 executor (DoD closure). Previous version superseded;
preserved in git history. Read this FIRST on resume._

## PURPOSE (current mission)
**APP-RUN-01** — portable agent-factory (ADR-0009). Binding plan: M-module map in
`C:\Projects\VOLAURA\memory\atlas\codex-loop.md` (Rounds 6–25).

## MODULE MAP STATE (frozen Round 20; updated receipts 2026-07-24)
- **M1 Trust Floor — CLOSED** `c47a2ea`
- **M2 Browser Hand — CLOSED** `b21228b` (Git-Bash audit debt)
- **M3 Goal Runner — CLOSED** `0983154` (Git-Bash audit debt)
- **M7 Control+Notify+Supervised-Assist — CLOSED** `8456289` (codex-loop 2026-07-23 06:00)
- **Research-swarm reliability — INTEGRATED** `4c25cac` on `feat/arsenal-wiring` (pushed origin)
  - Verdict: **RESEARCH_ONLY_LIMITED** — honest infra; not daily consensus driver
  - Live multi-provider proof: **BLOCKED-M6** (CEO order: no provider chase, no key rotation)
- **M4 Durable memory — CLOSED-PENDING-VERIFIER** branch `codex/m4-durable-memory`
  - A: goal kill-resume + stale lease + exec-graph reuse ✓
  - B: recall POST-body regression lock ✓
  - C: instance anti-fork lease + CLI readonly + spawn-two child E2E ✓
  - D: session breadcrumb hook + swarm exit ✓
  - DoD: kill/resume child E2E ✓, spawn-two child E2E ✓, adversarial review PASS-WITH-EXCEPTION ✓
  - Codex entry: `docs/atlas-cto/M4-CODEX-LOOP-ENTRY-2026-07-24.md`
  - **Non-goals honored:** no Supabase DDL, no VOLAURA edits
- **NEXT after M4 verifier PASS:** **M6** provider health+spend → **M5** manifest SDK → **M8** evidence audit

## VERIFIED 2026-07-24 (M4 closure run)
- `npm run typecheck` + `npm run build` + `npm test -- --run` → **787 passed, 2 skipped**
- Kill/resume child-process E2E: budget + exec-graph preserved across SIGKILL
- Spawn-two child-process E2E: readonly + crash takeover
- Adversarial review: `docs/atlas-cto/M4-ADVERSARIAL-REVIEW-2026-07-24.md` → PASS-WITH-EXCEPTION

## OPEN / WHO OWNS WHAT
1. **M4 codex-verifier PASS** — codex-verifier seat (receipt against this branch)
2. **Git-Bash audit debt (M2+M3)** — codex-verifier seat
3. **b1 spend-table live apply** — CEO gate; M6 blocked until applied
4. **License/provenance NOTICE** — pre-external-release
5. **Swarm live diversity proof** — M6 gate only
6. **M4 exceptions** — readonly write-path audit, instance heartbeat loop (tracked in adversarial review)

## VERIFY COMMANDS
```
cd "C:\Projects\ATLAS\worktrees\atlas-m4-memory"
npm run typecheck && npm run build
npm test -- --run
npm test -- --run src/__tests__/goal-runner.test.ts src/__tests__/m4-*.test.ts
node dist/cli.js graph status
```

## HOW TO RESUME
1. Read this file + `docs/atlas-cto/M4-MISSION-2026-07-24.md`
2. If verifier PASS → proceed M6 per module map
3. No VOLAURA product edits, no deploy, no Supabase DDL without CEO gate
