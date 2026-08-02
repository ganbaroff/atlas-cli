# Skill: QA Runtime (DESIGN)

## Purpose
Exercise Atlas runtime packs on **tmp fixtures only** — state root, lease, health, freshness — without production side effects.

## Scope
- `qa/runtime/**/*.test.ts` via `npm run test:qa` (`vitest.qa.config.ts`).
- Promote Wave1 health matrix and state-root fail-closed cases in later phases (P2+).
- Default `npm test` remains `src/**/*.test.ts` until CI policy changes.

## Inputs
- Fixture roots under `os.tmpdir()`.
- Optional env for activation tests (never real `~\.atlas\state` in automated packs).

## Outputs
- Vitest summary; skipped/todo until implemented.
- Receipt: suite IDs + pass/fail (when live).

## Tools
- `npm run test:qa`
- Read: `docs/qa/ATLAS_QA_HARNESS.md`, `qa/README.md`

## Forbidden
- Pointing fixtures at production lawful root.
- Calling `runner start|tick|peek` from QA packs without CEO auth.
- Supabase/network in runtime packs.
- Wiring `test:qa` into required CI without separate auth (P5).

## How agents use it
**Before merge touching state/runner/lease:** run `test:qa` once packs are unskipped; until then report stub status honestly.
**Cursor/Claude:** Do not treat green default `npm test` as proof of runtime safety.

## Contract chain (required)
`PRECHECK → BUILD → VERIFY → BIND → OBSERVE` or `ROLLBACK`

| Step | This skill |
|---|---|
| PRECHECK | Confirm fixtures = tmp only; no prod root; packs skipped vs live |
| BUILD | Implement/unskip tests only under CEO-authorized wave (not this design alone) |
| VERIFY | `npm run test:qa` (or honest stub report); zero writes outside tmp when live |
| BIND | Record suite IDs + config (`vitest.qa.config.ts`) |
| OBSERVE | Publish pass/skip/todo summary |
| ROLLBACK | Re-skip / discard failing fixture dirs under tmp — **no** prod state restore |

**STOP when:** a pack would touch `~\.atlas\state`, call start/tick/peek, or open network/Supabase.

**Rollback boundary (design-only):** Delete tmp fixtures; leave tip QA stubs as-is unless a separate docs/code wave is authorized.

**Enforcement / authority:** This document is **guidance only**. It has **no runtime enforcement** and **no authority** to perform forbidden actions. The complete hard-stop list lives only in `AGENTS.md` (section "Hard stops") — without CEO authorization do not: `runner start` / `runner tick` / `runner peek`; enable, retarget, or create scheduler tasks; claim queue work or mutate task lifecycle; Telegram / Railway / Supabase write / deploy / push / source deletion. Do not treat any shorter paraphrase as complete. Code and process controls remain the enforcement boundary.
