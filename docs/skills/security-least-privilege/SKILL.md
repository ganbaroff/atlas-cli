# Skill: Security / Least-Privilege (DESIGN)

## Purpose
Minimize authority: local root, no-claim diagnostics first, CEO gates for claim/execute/cloud.

## Scope
- Authority claim: `LOCAL ROOT ACTIVE / AUTHORITY PARTIAL`.
- Prefer wave-authorized `runner health --no-claim` over tick/start (never without wave auth).
- Pause/runner-log still legacy-home — do not pretend full root authority.
- Secrets: never print keys; redact; no commit of `.env`.

## Inputs
- Proposed action (command, path, env).
- Current scheduler posture (expect Disabled).

## Outputs
- Allow / escalate / refuse with invariant name.
- Privilege needed vs privilege held.

## Tools (examples / inspection only — never a capability grant)
- Examples: `runner status`; `schtasks /Query`; `git status`.
- `runner health --no-claim` only when the current wave explicitly authorizes it.
- Refs: `atlas-safety.mdc`, AGENTS.md hard stops, queue-auth docs.

## Forbidden without CEO
- `runner start|tick|peek`
- Scheduler enable/retarget/create
- Queue claim; task lifecycle mutation
- Telegram / Railway / Supabase **write** / deploy / push / source deletion

## How agents use it
**Every mutating wave PRECHECK:** restate claim + forbidden list.
**Subagents:** default read-only; no credential use beyond what’s required for the authorized read.

## Contract chain (required)
`PRECHECK → BUILD → VERIFY → BIND → OBSERVE` or `ROLLBACK`

| Step | This skill |
|---|---|
| PRECHECK | Privilege needed vs held; scheduler Disabled; claim PARTIAL |
| BUILD | Only least-privilege path authorized by CEO |
| VERIFY | Confirm no forbidden op attempted; redact secrets in outputs |
| BIND | Record authority claim + allow/refuse decision |
| OBSERVE | Escalate gaps to CEO |
| ROLLBACK | Refuse action; no compensatory “fix” that widens privilege |

**STOP when:** proposed action is on the CEO-gated forbid list without explicit authorization.

**Rollback boundary (design-only):** Decision rollback = do nothing / escalate. No tip or ops mutation from this skill doc.

**Enforcement / authority:** This document is **guidance only**. It has **no runtime enforcement** and **no authority** to perform forbidden actions. The complete hard-stop list lives only in `AGENTS.md` (section "Hard stops") — without CEO authorization do not: `runner start` / `runner tick` / `runner peek`; enable, retarget, or create scheduler tasks; claim queue work or mutate task lifecycle; Telegram / Railway / Supabase write / deploy / push / source deletion. Do not treat any shorter paraphrase as complete. Code and process controls remain the enforcement boundary.
