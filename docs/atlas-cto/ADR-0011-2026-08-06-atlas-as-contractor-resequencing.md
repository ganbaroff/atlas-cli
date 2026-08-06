# ADR-0011 — Atlas as contractor: re-sequenced phases, money rule, MISSION-BOARD as sole control surface

- **Status:** ACCEPTED
- **Date:** 2026-08-06
- **Deciders:** CEO (directives 2026-08-05 «перо твоё, начинай» + the contractor directive)
- **Homes:** This file (`docs/atlas-cto/`). Numbered twin: `docs/adr/0011-atlas-as-contractor-resequencing.md`
- **Supersedes / binds:** `ATLAS-MEGAPLAN-2026-08-05.md` v3 (merge candidate, deleted on merge per its own §11); does not supersede ADR-0009 or ADR-0010; binds `ATLAS-MASTER-PLAN.md`'s M3→M4 cutover sequencing (unchanged by this ADR)

## Context

`ATLAS-MEGAPLAN-2026-08-05.md` v1 was adversarially reviewed and produced **17
objections, 4 of them BLOCKER**:

1. Plan-layer drift — v1 was written as an independent plan contradicting this
   repo's own Doc Law (`ATLAS-ARCHITECTURE.md` line 5: *"`docs/atlas-cto/ATLAS-MASTER-PLAN.md`
   is the ONLY forward plan... Do not create a second architecture doc or a
   second plan — edit these two."*; `ATLAS-MASTER-PLAN.md` §8 repeats: *"no
   second plan, competing orchestrator, or `ATLAS.next`."*).
2. `PlanContract` was cited in v1 as a CEO-approved, existing artifact; a
   repo-wide grep for `PlanContract` across this repo at HEAD `1c35ddf`
   returns **zero hits** — it does not exist in code.
3. Demo-before-fundament sequencing — v1 put a voice demo ahead of the
   runner-safety envelope, which `ATLAS-ARCHITECTURE.md` §12 itself ranks as
   **"now the top risk in the system."**
4. v1 never targeted the Cursor paste-relay — the heaviest daily human-courier
   burden on the CEO — despite Atlas's stated purpose being courier
   elimination.

v3 of the megaplan (`ATLAS-MEGAPLAN-2026-08-05.md`) addresses all 17
objections (ledger in its §10) and adds the money layer the CEO named as
missing: neither v1 nor v2 had a phase or metric that produces revenue.

## Decision

1. **Atlas operates as CONTRACTOR.** The CEO states a goal; Atlas returns a
   plan; the CEO approves MILESTONES only, never tasks or subtasks; Atlas
   builds, fixes its own defects, and delivers a working product.

2. **Money rule.** Money never comes from Atlas itself — only from the
   projects Atlas builds. No phase is a success until a project Atlas built
   produces a real invoice or a real paid order. Feature completeness alone
   is not success.

3. **Phases re-sequenced P0..P7**, strictly sequential (megaplan §4):
   P0 gate (CEO-only rulings) → P1 hands safety + courier kill → P2 autonomy
   spine → P3 first contract (Integronix) → P4 multi-project brain → P5 voice
   daily organ → P6 emotional memory live → P7 mission gate (2027-Q1,
   personal OS vs. sellable agent OS). Safety and courier-elimination come
   before capability; voice, which was P1 in the rejected v1 sequencing, is
   now P5.

4. **The megaplan file is a MERGE CANDIDATE.** `ATLAS-MEGAPLAN-2026-08-05.md`
   is deleted in the same commit that merges its phases into
   `ATLAS-MASTER-PLAN.md` as new milestones. Until merged it has no
   independent authority — it cannot authorize spend, gate closure, or phase
   start on its own (repo Doc Law, above).

5. **`MISSION-BOARD.md` is the single task-truth surface** and the CEO's only
   control surface. It expresses milestones as first-class rows with
   task/subtask detail collapsed underneath; the CEO reads and approves
   milestones only. No second board.

6. **Model spend follows the 60/30/10 rule** — Haiku 60 / Sonnet 30 /
   Opus-Fable 10. Planner seats (Fable/Opus) never do hands-work; execution
   goes to Sonnet/Haiku executor seats under the canonical executor envelope.

## Consequences

**Now forbidden:**
- A second plan document alongside `ATLAS-MASTER-PLAN.md` (the megaplan file
  itself is provisional and merge-only, per decision 4).
- A second task board alongside `MISSION-BOARD.md`.
- Any phase P1-P7 claiming spend authorization, gate closure, or start
  without the previous phase's DoD closing first (strictly sequential per
  decision 3).
- P2, P3, P4 running live against cloud state before the M3→M4 cutover
  closes (see Relates, below) — they may be designed/specified now but not
  operated live against non-durable state.

**Now unblocked:**
- `MISSION-BOARD.md` exists and is populated (this commit) — P1-P7 can be
  queued and tracked against it immediately once P0 closes.
- The money layer gives every future phase a falsifiable top-level metric
  (megaplan §1b) instead of "feature shipped" alone.
- Integronix (P3) is named explicitly as the first paid-work mission,
  correcting objection #19 (v1 ignored the closest thing on this machine to
  real revenue).

**Relates:**
- ADR-0009 (vision canon: Atlas as portable agent-factory) — unchanged;
  this ADR sequences delivery, not identity.
- ADR-0010 (capability stack: voice + documents) — Phase 1/2 of that ADR
  now lands inside megaplan P5, not before the P1 safety fundament.
- `ATLAS-MASTER-PLAN.md`'s real in-flight milestone, **M3 Shadow
  Consolidation** (M3C VERIFIED, M3D packet written / cutover readiness
  next) — P2, P3, and P4 above depend on the **"Yusif cutover gate"** into
  M4 One Atlas cutover closing first; `ATLAS-MASTER-PLAN.md` line 32:
  *"Physical consolidation is NO-GO. Live provider traffic has not
  started."* This ADR does not change that gate or accelerate it.

## References

- `C:\Projects\ATLAS-MEGAPLAN-2026-08-05.md` (source plan; §4 phases, §7
  standing debts, §10 objection ledger, §11 acceptance conditions)
- `docs/atlas-cto/ATLAS-MASTER-PLAN.md` (parent plan; M3 in-flight milestone,
  Doc Law §8)
- `docs/atlas-cto/MISSION-BOARD.md` (this commit)
- `docs/adr/0009-vision-canon-portable-agent-factory.md`
- `docs/adr/0010-capability-stack-voice-and-documents.md`
