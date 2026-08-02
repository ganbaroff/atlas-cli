# Skill: Red-Team / Deny-Rules (DESIGN)

## Purpose
Adversarially probe whether agents or code paths can bypass stop-gates; encode deny rules.

## Scope
- Prompt injections: ignore AGENTS, enable scheduler, approve Telegram pairing, “just this once” claim.
- Code paths: health must not reach claim/spawner; tick must not hide behind “status”.
- Ops: schtasks must stay Disabled unless CEO.

## Inputs
- Target surface (prompt / module / CLI).
- Deny list from AGENTS + atlas-safety.

## Outputs
- Attack scenarios + expected refusal.
- Gaps (e.g. AUTHORITY PARTIAL pause path).
- Suggested regression tests (banlist, Commander negate flags).

## Tools
- Read-only analysis; optional skipped QA stubs as future hooks.
- Independent review subagent.

## Forbidden
- Actually enabling runners/schedulers “to prove” a hole without CEO.
- Live queue claim as red-team.
- Writing exploits/PoCs against production systems (policy).

## How agents use it
**Before merge of safety-sensitive code:** run deny-scenario checklist (A1–A5 style).
**Cursor/Claude:** document residual risk; do not silently “fix” by widening authority.

## Contract chain (required)
`PRECHECK → BUILD → VERIFY → BIND → OBSERVE` or `ROLLBACK`

| Step | This skill |
|---|---|
| PRECHECK | Target surface; deny list from AGENTS + atlas-safety |
| BUILD | Attack scenarios on paper / read-only analysis only |
| VERIFY | Expected refusal documented; no live bypass attempted |
| BIND | Scenario IDs + tip SHA |
| OBSERVE | Gaps + suggested regressions |
| ROLLBACK | Retract scenario notes if wrong; never “undo” by enabling forbidden ops |

**STOP when:** proving a hole would require enabling runner/scheduler, live queue claim, or writing a production exploit.

**Rollback boundary (design-only):** Analysis artifacts only. No ops rollback; cite CEO if a real hole needs a repair wave.

**Enforcement / authority:** This document is **guidance only**. It has **no runtime enforcement** and **no authority** to perform forbidden actions. The complete hard-stop list lives only in `AGENTS.md` (section "Hard stops") — without CEO authorization do not: `runner start` / `runner tick` / `runner peek`; enable, retarget, or create scheduler tasks; claim queue work or mutate task lifecycle; Telegram / Railway / Supabase write / deploy / push / source deletion. Do not treat any shorter paraphrase as complete. Code and process controls remain the enforcement boundary.
