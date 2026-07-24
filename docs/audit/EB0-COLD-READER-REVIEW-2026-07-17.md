# EB-0 Cold-Reader Acceptance Review — 2026-07-17

Reviewer: independent read-only agent, zero mission context, docs+code only.
Overall verdict: PASS — a new engineer could safely make a scoped change tomorrow
(understand → locate authority → change → test → recover → prove).

## Q1 Task authority + legacy boundaries — PASS
exec-graph is the one machine execution authority (ADR-0001, src/exec-graph/README.md).
Four legacy mechanisms classified in ADR-0004; none may close a graph task; sole entry
point importTask(). Code matches docs: api.ts write surface = createGoal/createTask/
importTask/moveTask/addEvidence; telegram.ts:515,788 carry the "[removed 2026-07-10]"
comments ADR-0004 cites.

## Q2 Intent vs execution state — PASS
VOLAURA = intent/strategy/memory canon; ANUS state/exec-graph = machine execution state
(ATLAS-CANON.md EB-0 amendment, ADR-0002). VOLAURA branch fragmentation + gitignored
shared-bus documented as the reason, flagged as known issue.

## Q3 Verify/close requirements — PASS (one nuance)
closed only reachable from verified|rejected; closed terminal. Transitions to verified/
evidence-submitted require >=1 evidenceRefs (schema-enforced); tasks resting in verified/
closed require >=1 evidence entries. Nuance: the closed hop itself needs no fresh
evidenceRefs — task-level evidence suffices (correctly documented in state-and-evidence-index).

## Q4 Pause + recovery — PASS
Three pause surfaces (local pause file/tray PANIC, /pause in-process, Railway ATLAS_PAUSE)
per PANIC.md + runbook. exec-graph recovery via graph verify + git-restore of snapshot;
ledger never rewritten. Honest gap: no graph rebuild --fix subcommand yet.

## Q5 Excluded-by-design — PASS
No second router, no second Telegram authority, no VOLAURA execution state, no OpenClaw
runtime, no unbounded swarm, no cloud exec-graph writer (ATLAS-ARCHITECTURE.md).

## Q6 Evidence trace — GENUINE
tsk_f993015b... cites commit:8774627 — exists, diff matches claim. Cross-checked
tsk_687ea07b... (ac6d384) and tsk_38fc69ae... (5842212 + ADR-0004 file): all resolve,
content matches. Gap (documented tradeoff): test-receipt evidence entries are free-text
pointers, not independently checkable artifacts.

## Gaps found (all pre-flagged in docs, none hidden)
1. QUEUE-CONTRACT.md stale (self-flagged via ADR-0004 correction) — follow-up debt.
2. No graph rebuild/--fix CLI companion to graph verify.
3. Q3 nuance above — easy first-read misreading.
4. Test-receipt free-text evidence not independently verifiable.

No doc-vs-code contradictions found in anything checked.
