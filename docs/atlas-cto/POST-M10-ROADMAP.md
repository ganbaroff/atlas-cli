# Atlas Post-M10 Roadmap (product phase)
_Last written: 2026-07-25 · CEO: Atlas focus, not OPSBOARD_

## Done (prod)
- M1–M10 internal stack on `main`
- PR #13 merged, Railway redeployed
- Supabase `llm_spend` + live smoke PASS

## Now → Next 3 sprints (executor order)

### Sprint A — Manifest factory (M5 debt)
Migrate static REGISTRY hands → JSON manifests one at a time; zero behavior change.
- [x] file-search
- [x] local-readonly
- [x] browser-foreground
- [x] swarm-local
- [x] sonnet-foreground

**Sprint A CLOSED** — static REGISTRY empty; all hands via manifests.

### Sprint B — Git-Bash audit debt (M2+M3) — CLOSED
Independent verifier re-ran full suite under Git Bash; receipt: `GITBASH-AUDIT-RECEIPT-2026-07-25.md` (818 passed, 2 skipped).

### Sprint C — Swarm honest diversity — CLOSED
M6 provider health wired through research-swarm routing; receipt: `SWARM-HONESTY-RECEIPT-2026-07-25.md`.

### Sprint D — Live product loop — CLOSED (PASS-WITH-EXCEPTION)
Receipt: `LIVE-PRODUCT-LOOP-RECEIPT-2026-07-25.md`. Fixed dist/manifests copy bug; goal state persists; Railway bot ok (redeploy pending).
- OPSBOARD remote push (CEO deferred)
- G-ATLAS-USER external distribution
- VOLAURA product code from atlas-builder lane

## Verify
```
git checkout main && git pull --ff-only
npm run typecheck && npm run build && npm test -- --run
```
