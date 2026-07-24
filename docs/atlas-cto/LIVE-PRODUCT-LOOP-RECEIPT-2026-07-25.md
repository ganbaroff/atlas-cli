# Live Product Loop Receipt — Sprint D
_Date: 2026-07-25 · Verdict: PASS-WITH-EXCEPTION_

## Scope
Prove Atlas product path: dist CLI → goal → exec-graph/budget persistence. Railway bot health. Fix blockers found.

## Blocker found + fixed
**Symptom:** `node dist/cli.js goal run ... --hand local-readonly` → `hands: unknown hand 'local-readonly'`

**Root cause:** tsup bundle resolves manifests at `dist/manifests/` but build did not copy JSON files.

**Fix:** `scripts/copy-manifests.mjs` + `npm run build` hook; `manifest.ts` fallback to `src/hands/manifests` for dev.

## CLI goal probe (isolated state dirs)
```powershell
$env:ATLAS_EXEC_GRAPH_DIR = <temp>
$env:ATLAS_GOAL_BUDGET_DIR = <temp>
node dist/cli.js goal run "Read h1 text on hub71 fixture" --hand browser-foreground
```

| Check | Result |
|-------|--------|
| Hand resolved from manifest | PASS |
| goalId `gol_*` issued | PASS |
| `graph.json` + `ledger.jsonl` written | PASS |
| `gol_*.json` budget file written | PASS |
| Goal terminal status | `failed` (blocked) |

**Exception:** task blocked with `verifierReason: "hand execution not yet implemented"` — CLI `goal run` does not inject `browserActions`; browser hand needs fixture actions wired separately (E2E tests pass via direct `runGoal({ browserActions })`). Not a regression; product gap documented.

## Railway production bot
```
GET https://fantastic-generosity-production-df90.up.railway.app/health
→ {"status":"ok","bot":"volaurabot","uptime":"103min","providers":4,"bootTime":"2026-07-24T21:52:13.231Z"}
```

| Check | Result |
|-------|--------|
| Bot reachable | PASS |
| Providers reported | 4 |
| bootTime vs local HEAD | **behind** — Railway on pre-Sprint-A deploy; redeploy recommended after manifest fix lands |

## Local health (CEO machine)
```
node dist/cli.js health → 6/7 PASS (heartbeat stale — expected on dev machine)
```

## Verdict
**PASS-WITH-EXCEPTION** — product loop creates durable goal state; manifest dist bug fixed; Railway live but not on latest `main` tip.
