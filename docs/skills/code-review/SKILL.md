# Skill: Code Review (DESIGN)

## Purpose
Independent, defect-first review of diffs before merge — especially safety boundaries.

## Scope
- Fresh read-only subagent preferred (not the implementer).
- Check: scope creep, forbidden imports, false authority claims, missing tests/receipts.
- Wave patterns: import banlist, FS before/after hash, Commander flag semantics.

## Inputs
- Branch/worktree path; base SHA; authorized file list.
- Claimed invariants for the wave.

## Outputs
- VERDICT PASS/STOP.
- Findings (defects only).
- Acceptance case table when relevant.

## Tools
- `git diff`, Read/Grep; optional vitest of touched tests.
- No write unless CEO authorizes repair wave.

## Forbidden
- Rubber-stamp without reading diff.
- Expanding review into unrelated refactors.
- Approving runner/scheduler enable via review alone.

## How agents use it
**After BUILD, before merge auth:** launch independent reviewer with fixed checklist.
**Cursor:** Task tool read-only; **Claude:** separate seat/reviewer prompt.

## Contract chain (required)
`PRECHECK → BUILD → VERIFY → BIND → OBSERVE` or `ROLLBACK`

| Step | This skill |
|---|---|
| PRECHECK | Base SHA; authorized paths; claimed invariants |
| BUILD | N/A (read-only review — no tip edits) |
| VERIFY | Diff vs authorize list; banlist/false-authority checks |
| BIND | Record reviewer id + diff range |
| OBSERVE | VERDICT PASS/STOP + findings |
| ROLLBACK | On STOP: block merge recommendation; implementer may fix in separate auth |

**STOP when:** defect violates safety invariant, scope creep, or evidence missing; verdict = STOP.

**Rollback boundary (design-only):** Review output only. Does not revert merges; may cite `git revert -m 1 <merge>` as text for CEO.

**Enforcement / authority:** This document is **guidance only**. It has **no runtime enforcement** and **no authority** to perform forbidden actions. The complete hard-stop list lives only in `AGENTS.md` (section "Hard stops") — without CEO authorization do not: `runner start` / `runner tick` / `runner peek`; enable, retarget, or create scheduler tasks; claim queue work or mutate task lifecycle; Telegram / Railway / Supabase write / deploy / push / source deletion. Do not treat any shorter paraphrase as complete. Code and process controls remain the enforcement boundary.
