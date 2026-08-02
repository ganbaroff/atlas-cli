# Skill: Harness / Instructions (DESIGN)

## Purpose
Keep agents on the canonical instruction stack and QA harness spine so work is governed, not ad-hoc chat.

## Scope
- Load/order: `AGENTS.md` → tool adapter (`CLAUDE.md` / Cursor rules) → wave prompt.
- Point to `docs/qa/ATLAS_QA_HARNESS.md` and `qa/README.md`.
- Treat `codex-loop.md` as evidence journal only.

## Inputs
- Current Cursor/Claude project root path.
- Wave authorization text (what CEO allowed).

## Outputs
- Explicit statement: which contract files apply this session.
- Whether ANUS is project root (`atlas-safety.mdc` is intended/configured to apply; runtime loading unverified) vs ATLAS-only (rule may not apply).

## Tools
- Read: `AGENTS.md`, `CLAUDE.md`, `.cursor/rules/atlas-safety.mdc`, `docs/qa/ATLAS_QA_HARNESS.md`.
- Optional: `npm run typecheck` / `npm test` when verifying.

## Forbidden
- Treating `codex-loop.md` as instructions.
- Inventing parallel constitutions that contradict AGENTS.
- Claiming Cursor rules are loaded from `C:\Projects\ATLAS`-only sessions.
- Enabling runner/scheduler/queue without CEO auth.

## How agents use it
**Cursor:** At wave start, read AGENTS + atlas-safety; state authority claim.
**Claude:** CLAUDE cold-start then AGENTS; do not duplicate long rules into CLAUDE.

## Contract chain (required)
`PRECHECK → BUILD → VERIFY → BIND → OBSERVE` or `ROLLBACK`

| Step | This skill |
|---|---|
| PRECHECK | Confirm project root; list which instruction files apply |
| BUILD | N/A for load-order only (no tip edits from this skill alone) |
| VERIFY | Re-read AGENTS / atlas-safety; confirm no parallel constitution |
| BIND | State tip SHA + `LOCAL ROOT ACTIVE / AUTHORITY PARTIAL` |
| OBSERVE | Report loader scope (ANUS root vs ATLAS-only) |
| ROLLBACK | Discard incorrect session claims; re-read AGENTS — **no git revert** (design-only) |

**STOP when:** instruction sources conflict and cannot be reconciled without contradicting AGENTS; or agent would treat `codex-loop.md` as rules.

**Rollback boundary (design-only):** Correct the session contract text / re-PRECHECK. Do not mutate tip, scheduler, runner, or queue.

**Enforcement / authority:** This document is **guidance only**. It has **no runtime enforcement** and **no authority** to perform forbidden actions. The complete hard-stop list lives only in `AGENTS.md` (section "Hard stops") — without CEO authorization do not: `runner start` / `runner tick` / `runner peek`; enable, retarget, or create scheduler tasks; claim queue work or mutate task lifecycle; Telegram / Railway / Supabase write / deploy / push / source deletion. Do not treat any shorter paraphrase as complete. Code and process controls remain the enforcement boundary.
