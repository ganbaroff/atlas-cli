# Atlas QA harness (P1 stubs)

Design spine: `docs/qa/ATLAS_QA_HARNESS.md`.

## Commands (stubs)

| Script | Purpose |
|---|---|
| `npm run test:qa` | Vitest over `qa/runtime/**/*.test.ts` (all **skipped** in P1) |
| `npm run eval:critical` | `qa/evals/runner.mjs` — prints TODO, exit 0, **no** CLI/runtime |

Default `npm test` still only includes `src/**/*.test.ts` (unchanged).

## Rules

- Fixtures must use `os.tmpdir()` only when implemented.
- Never call production `runner start|tick|peek`, scheduler, queue, or live Supabase from these packs without CEO auth.
- Authority claim: `LOCAL ROOT ACTIVE / AUTHORITY PARTIAL`.
