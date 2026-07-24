# ATLAS — STATE NOW (post-compaction orientation)
_Last written: 2026-07-24 by integration pass (canon-sync D3). Previous version
(2026-07-23) is superseded; preserved in git history. Read this FIRST on resume._

## PURPOSE (current mission)
**APP-RUN-01** — portable agent-factory (ADR-0009). Binding plan: M-module map in
`C:\Projects\VOLAURA\memory\atlas\codex-loop.md` (Rounds 6–25).

## MODULE MAP STATE (frozen Round 20; updated receipts 2026-07-24)
- **M1 Trust Floor — CLOSED** `c47a2ea`
- **M2 Browser Hand — CLOSED** `b21228b` (Git-Bash audit debt)
- **M3 Goal Runner — CLOSED** `0983154` (Git-Bash audit debt)
- **M7 Control+Notify+Supervised-Assist — CLOSED** `8456289` (codex-loop 2026-07-23 06:00)
- **Research-swarm reliability — INTEGRATED-LOCAL** `aa54237` on `feat/arsenal-wiring`
  - `src/research-swarm/*` honest provider routing, bounded lifecycle, schema v1 artifacts
  - Verdict: **RESEARCH_ONLY_LIMITED** — honest infra; not daily consensus driver
  - Live multi-provider proof: **BLOCKED-M6** (CEO order: no provider chase, no key rotation)
  - Known config issue: `~/.atlas/perspectives.json` may declare unsupported providers
    (cerebras, anthropic-as-worker); runtime now fails honestly via `perspective-config.ts`
- **NEXT: M4** Durable memory/resume + instance anti-fork lease (see
  `docs/atlas-cto/M4-MISSION-2026-07-24.md`)
- Then: **M6** provider health+spend → **M5** manifest SDK → **M8** evidence audit → **M9** OPSBOARD

## VERIFIED 2026-07-24 (integration receipts)
- HEAD `aa54237` on `feat/arsenal-wiring` (fast-forward merge `codex/atlas-swarm-reliability`)
- `npm run build` → clean · `npm run typecheck` → 0 errors
- `npm test -- --run` → **771 passed / 0 failed / 2 skipped** (94 files)
- Live swarm smoke **not re-run** — prior receipt `PROVIDER_FAILURE` 0/5 sufficient
- Junction `C:\Projects\ATLAS\apps\cli` tracks same branch after merge

## OPEN / WHO OWNS WHAT
1. **M4 mission** — next executor token (durable resume, write-back, anti-fork lease)
2. **Git-Bash audit debt (M2+M3)** — codex-verifier seat
3. **b1 spend-table live apply** — CEO gate; M6 blocked until applied
4. **License/provenance NOTICE** — pre-external-release
5. **Swarm live diversity proof** — M6 gate only; do not chase providers before then
6. **Heartbeat stale since 2026-06-26** — M4 write-back scope candidate

## VERIFY COMMANDS
```
cd "C:\Users\user\OneDrive\Documents\GitHub\ANUS"
npm run typecheck && npm run build
npm test -- --run
node dist/cli.js graph status
node dist/cli.js cos brief
node dist/cli.js models
```

## HOW TO RESUME
1. Read this file + codex-loop tail (~3 entries)
2. `graph status` + `cos brief` for live drift
3. Swarm = research tool only until M6 proof; main line = **M4 memory**
4. No VOLAURA product edits, no deploy, no key rotation without CEO gate
