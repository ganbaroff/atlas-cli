# Skill: Eval Design (DESIGN)

## Purpose
Define critical-flow evals with metrics and receipt schemas so “done” means measured, not vibes.

## Scope
- Specs under `qa/evals/E0N-*.eval.md`.
- Runner: `npm run eval:critical` → `qa/evals/runner.mjs` (P1 stub; P3 implements E01–E03).
- Metrics: exit codes, FS hash stability, banlist, verify-fail-closed.

## Inputs
- Eval ID, fixture set, authority claim.
- Mock keys/ledgers for queue-auth evals (never live claim).

## Outputs
- Eval receipt JSON (proposed `qa/receipts/`, gitignored) + optional `codex-loop` summary line.
- Explicit list of evals **not** run.

## Tools
- `npm run eval:critical` (stub today).
- Design refs: ATLAS_QA_HARNESS §4.2.

## Forbidden
- Calling receipts “signed” without crypto verification.
- Live Supabase claim/peek/write in evals.
- Prod Archive A/B mutation without CEO (E04 = synthetic fixtures).
- Scheduler `/Change`/`Enable` in E05 (query-only).

## How agents use it
**When designing a wave:** name which E0N apply; leave unimplemented evals as TODO.
**When implementing P3:** fill runner; keep sideEffects denial proof like Wave1.

## Contract chain (required)
`PRECHECK → BUILD → VERIFY → BIND → OBSERVE` or `ROLLBACK`

| Step | This skill |
|---|---|
| PRECHECK | Select E0N; confirm mocks vs live; authority claim |
| BUILD | Spec/metrics only until P3 auth; no live claim |
| VERIFY | Receipt schema + sideEffects denial; stub runner OK in P1 |
| BIND | Eval IDs + fixture identity hashes |
| OBSERVE | Receipt JSON / list of evals not run |
| ROLLBACK | Discard failed fixture outputs under tmp; do not mutate prod archives |

**STOP when:** eval would require live Supabase claim, prod Archive A/B write, or scheduler `/Change`/`Enable`.

**Rollback boundary (design-only):** Retract draft eval spec text; leave tip stubs unless a separate authorized wave edits them.

**Enforcement / authority:** This document is **guidance only**. It has **no runtime enforcement** and **no authority** to perform forbidden actions. The complete hard-stop list lives only in `AGENTS.md` (section "Hard stops") — without CEO authorization do not: `runner start` / `runner tick` / `runner peek`; enable, retarget, or create scheduler tasks; claim queue work or mutate task lifecycle; Telegram / Railway / Supabase write / deploy / push / source deletion. Do not treat any shorter paraphrase as complete. Code and process controls remain the enforcement boundary.
