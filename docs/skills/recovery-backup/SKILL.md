# Skill: Recovery & Backup (DESIGN)

## Purpose
Plan and (when authorized) rehearse restore without destroying lawful root or archives.

## Scope
- Know Wave0 Archive A/B locations and restore drills as **CEO-gated**.
- Fixture-only recovery evals (E04) under tmp.
- Document rollback: `git revert -m 1 <merge>` for instruction/code merges.

## Inputs
- Archive path / fixture path; target empty dir for restore test.
- Current tip SHA; activation claim.

## Outputs
- Restore proof (hash match) or explicit “not run”.
- Rollback command text (not executed unless authorized).

## Tools
- Read runbooks: `docs/runbooks/backup.md`, restore receipts under docs/atlas-cto.
- Future: E04 eval runner.

## Forbidden
- Deleting or overwriting Archive A/B without CEO.
- “Cleanup” of recovery directories not in scope.
- Using prod restore as casual smoke.

## How agents use it
**Design waves:** cite rollback command.
**Drill waves:** only after CEO auth; prefer synthetic fixtures first.

## Contract chain (required)
`PRECHECK → BUILD → VERIFY → BIND → OBSERVE` or `ROLLBACK`

| Step | This skill |
|---|---|
| PRECHECK | Fixture vs prod archive; CEO drill auth present? |
| BUILD | Plan/docs only unless CEO authorizes drill |
| VERIFY | Hash match plan; target dir empty/safe |
| BIND | Archive/fixture identity + tip SHA |
| OBSERVE | “not run” or drill receipt |
| ROLLBACK | Document `git revert -m 1 <merge>` for code/instruction merges; restore drills use CEO-gated procedure |

**STOP when:** drill would overwrite Archive A/B, lawful root, or require source deletion without CEO.

**Rollback boundary (design-only):** Default = document rollback command **without executing**. Prod restore only under separate CEO auth.

**Enforcement / authority:** This document is **guidance only**. It has **no runtime enforcement** and **no authority** to perform forbidden actions. The complete hard-stop list lives only in `AGENTS.md` (section "Hard stops") — without CEO authorization do not: `runner start` / `runner tick` / `runner peek`; enable, retarget, or create scheduler tasks; claim queue work or mutate task lifecycle; Telegram / Railway / Supabase write / deploy / push / source deletion. Do not treat any shorter paraphrase as complete. Code and process controls remain the enforcement boundary.
