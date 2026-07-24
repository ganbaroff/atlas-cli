# Atlas Policy — one page

Phase 1 consolidated Atlas's guardrails into a single declarative surface,
`config/policy.yaml`, loaded by `src/atlas/policy.ts`. The enforcement code
(`shell.ts`, `fs-guard.ts`, `spend-policy.ts`) is unchanged — the YAML is a
documented, testable read-model over it, plus **one** new behaviour: the
autonomy shell whitelist.

## Precedence (who wins)
1. **Environment variable** (e.g. `ATLAS_DAILY_TOKEN_CAP`, `ATLAS_PAUSE`) — always wins. Flip a value without a rebuild/redeploy.
2. **`config/policy.yaml`** — the declared default.
3. **Hard-coded safe default** in `policy.ts` (`DEFAULT_POLICY`).

## Fail-closed
If `config/policy.yaml` is missing or unparseable **in production**
(`NODE_ENV=production`), the loader logs `[policy] FAIL-CLOSED` and returns the
safe default: the autonomy shell whitelist is **empty** (autonomy shell fully
denied) and caps fall back to defaults. The loader never throws — the live
Telegram bot / Railway `/health` stay green even if policy is broken.

## What autonomy may do (the new gate)
"Autonomy" = an unattended actor with **no live CEO turn**: the `/task`
subprocess (`task-spawner.ts`, tagged `ATLAS_AGENT_ID=autonomy`), and any future
brain-loop / swarm executor. Its shell tool may run **only** commands matching a
`shell.whitelist_autonomy` regex in `policy.yaml` (read-only git, ls/cat/grep,
`node dist/cli.js …`, `npm test/build/typecheck`, `curl -s`, `railway
status/logs`). Anything else — even a harmless `touch` — is denied
(`autonomy-not-whitelisted`, exit 126).

CEO Telegram turns and the interactive CLI are **not** whitelist-gated; they use
the existing BLOCKED/GATED denylist floor, which still applies to autonomy too
(the whitelist is *on top of* the floor, never instead of it).

### To let autonomy run a new command
Add a regex to `shell.whitelist_autonomy` in `config/policy.yaml`. Keep it
read-only / non-mutating. Redeploy (or it's picked up on next process start).

## How to raise the daily token cap
- **Temporary / this process:** set `ATLAS_DAILY_TOKEN_CAP=1000000` in the
  environment (Railway variable) and redeploy — env wins immediately.
- **New default:** edit `token.daily_cap` in `config/policy.yaml`.
Paid providers stay off unless `ATLAS_ALLOW_PAID=1`, and are hard-blocked once
over cap regardless.

## How to panic
See **[PANIC.md](PANIC.md)**. Short version: Telegram `/pause` (instant,
process-local) or set `ATLAS_PAUSE=1` on Railway (durable).

## YAML parser note
`policy.ts` parses YAML with **js-yaml**, a production transitive dependency
(via `@mastra/core → gray-matter`, so it survives `npm prune --omit=dev`). We
deliberately did **not** add `yaml`/`@types/js-yaml` as new dependencies: the
lockfile is in a `--legacy-peer-deps` state (a pre-existing zod peer conflict
from `ollama-ai-provider`), so any `npm install` re-resolves the whole tree.
js-yaml is loaded via `createRequire` in a try/catch — if it ever went missing,
the loader degrades fail-closed instead of crashing.

## Tests
`src/__tests__/policy.test.ts` (loader + hybrid whitelist),
`src/__tests__/shell.test.ts` (denylist floor),
`src/__tests__/spend-policy.test.ts` (caps/paid/pause),
`src/__tests__/task-spawner-safety.test.ts` (pause halts autonomy).
