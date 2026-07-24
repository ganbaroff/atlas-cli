# ATLAS Research Swarm Reliability Design

**Date:** 2026-07-24  
**Scope:** TypeScript research-swarm MVP in ANUS (`src/swarm.ts` path + CLI + python-bridge)  
**Verdict target:** Honest multi-provider research with bounded lifecycle and structured evidence

## Root Cause (verified from live artifact `2026-07-24T11-33-41.json`)

1. **Fake provider diversity** — `runWorker()` calls `createAtlasAgentWithRoute('WORKER')` without passing `subtask.provider`. All 5 perspectives routed to `nvidia`; declared providers (anthropic, cerebras) were labels only.
2. **Dedup theater** — `dedupFindings()` runs but `synthesize()` receives raw `results`, not deduped claims.
3. **Unbounded judge/global lifecycle** — per-worker timeout exists (~45s) but no routing, judge, or global caps; CLI may hang on judge; no non-zero exit on all-worker failure.
4. **False success path** — 5/5 worker timeouts still produced judge synthesis (fallback narrative), logged as normal run.
5. **Stale python bridge** — reads `proposals.json` from disk, ignores stdout; silent TS fallback hides which swarm ran.
6. **Memory not degraded formally** — Supabase 401 on recall/spend write has no `DEGRADED_MEMORY` state; swarm continues silently.
7. **No eval harness** — no A/B baseline vs swarm with deterministic verdict.

## Architecture

New module `src/research-swarm/` wraps orchestration. Existing `swarm.ts` becomes thin re-export for backward compat.

```
CLI (atlas swarm / swarm-deep)
  └─ research-swarm/lifecycle.ts  ← bounded orchestrator
       ├─ provider-routing.ts     ← per-worker route, no process.env mutation
       ├─ timeouts.ts             ← routing / worker / judge / global
       ├─ diversity.ts            ← LIMITED_DIVERSITY / STRONG_CONSENSUS gates
       ├─ synthesis.ts            ← deduped inputs, dissent, judge isolation flag
       ├─ memory-state.ts         ← DEGRADED_MEMORY on Supabase 401
       ├─ artifact.ts             ← schema-versioned evidence JSON
       └─ eval-harness.ts         ← baseline vs swarm A/B
```

## Required Properties

### A. Honest provider diversity

- Each worker gets `preferredProvider` / `requiredProvider` passed to `routeModel({ preferredProvider })` — **never** `process.env.ATLAS_PREFERRED_PROVIDER`.
- Artifact stores declared vs actual provider/model/family per worker.
- `LIMITED_DIVERSITY`: ≥2 successful workers from distinct providers.
- `STRONG_CONSENSUS`: ≥3 distinct model families among successful workers; else `MULTIMODEL_UNAVAILABLE`.
- Paid providers blocked via existing `enforceSpendPolicy` unless `ATLAS_ALLOW_PAID=1`.

### B. Bounded execution

| Phase | Env override | Default |
|-------|-------------|---------|
| Routing | `ATLAS_SWARM_ROUTING_TIMEOUT_MS` | 10s |
| Worker | `ATLAS_SWARM_WORKER_TIMEOUT_MS` | 60s |
| Judge | `ATLAS_SWARM_JUDGE_TIMEOUT_MS` | 45s |
| Global | `ATLAS_SWARM_GLOBAL_TIMEOUT_MS` | 180s |

Structured timeout results (`worker_timeout_*`, `judge_timeout_*`, `global_timeout`). Insufficient workers forbids `SUCCESS`. CLI sets `process.exitCode` from status.

### C. Honest synthesis

- Pass deduped unique claims to judge (or skip dedup log if unused).
- Include dissent (failed/timeout workers) in judge prompt.
- Judge cannot recommend from missing evidence — prompt instructs + post-check.
- Judge uses separate `JUDGE` route; artifact marks `judgeIndependent: false` (same process).

### D. Structured evidence artifact (schema v1)

Fields: `schemaVersion`, `runId`, `taskHash`, `timestamps`, `durationMs`, `declaredProviders`, `actualProviders`, `workers[]`, `judge`, `claims[]`, `dissent[]`, `diversity`, `consensus`, `memoryState`, `exitReason`, `status`, `secretScan`.

Statuses: `SUCCESS`, `LIMITED_DIVERSITY`, `MULTIMODEL_UNAVAILABLE`, `NO_CONSENSUS`, `TIMEOUT`, `PROVIDER_FAILURE`, `JUDGE_FAILURE`.

### E. Memory degradation

Supabase 401/unauthorized → `memoryState: DEGRADED_MEMORY`. Local artifact write still attempted. Never read/print `.env`.

### F. Python bridge

- Parse stdout JSON protocol first; reject stale `proposals.json` unless stdout confirms run id.
- No silent fallback — return `EXPERIMENTAL_BRIDGE_DISABLED` or explicit error; CLI must print source.

### G. A/B eval harness

`atlas swarm-eval --fixture <id>` runs baseline single-call vs swarm on deterministic fixtures; verdict `KEEP_DISABLED` | `RESEARCH_ONLY` | `READY_FOR_RESEARCH`.

### H. Safety

No trading, TRADER, Telegram, deploy, push. Max 2 live-smoke runs in verification.

## Approach

Refactor in place via new module (not parallel swarm system). Reuse patterns from `swarm-exec/completion-policy.ts` and `run-bundle.ts` for deterministic gates.

## Out of scope

TRADER, Telegram changes, Python swarm rewrite, deploy/PR.
