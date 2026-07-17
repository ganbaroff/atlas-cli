# ADR-0002: VOLAURA is intent/strategy canon; ANUS `exec-graph` is machine execution-state canon

- **Status:** ACCEPTED
- **Date:** 2026-07-17
- **Deciders:** External CTO (authority correction), CEO (Yusif Ganbarov)

## Context

`ATLAS-CANON.md` (this repo) has, since 2026-04-26, split Atlas across two
repositories: `ANUS` (this repo — CLI shell, terminal commands, Telegram
runtime) and `C:\Projects\VOLAURA` (canonical Atlas memory, canonical swarm
runtime, shared product-facing ecosystem state). That split is unchanged by
this ADR.

What EB-0 adds is a narrower, more load-bearing question that the original
canon note did not answer: when Atlas is executing a specific piece of work
(a task, with a status and evidence), which repository's files are the
ground truth for *that*?

VOLAURA's `memory/atlas/work-queue/` markdown has, in practice, been used as
a pending-work list. It has two structural properties that make it unsafe as
an execution-state authority:

1. **Branch fragmentation.** VOLAURA work has historically spanned multiple
   long-lived branches (see repo-watch digests referenced in
   `docs/AUTONOMY-V0.md`, e.g. `feature/atlas-integration` vs `main`) without
   a single reconciled state — a task's real status depends on which branch
   you're looking at.
2. **Gitignored shared-bus.** `C:\Projects\VOLAURA\memory\shared-bus` (per
   `ATLAS-CANON.md`'s canonical-locations list) is part of VOLAURA's
   filesystem-based inter-process communication layer and is not reliably
   git-tracked the way `state/exec-graph/` in this repo is — state written
   there can be lost on a machine change or a `.gitignore` update without
   leaving a diffable trail.

Neither property makes VOLAURA wrong for what it's for (intent, strategy,
identity, cross-session memory). Both properties make it unsafe as the
system of record for "is this specific task done, and what proves it."

## Decision

- **VOLAURA remains intent/strategy + memory canon.** Per `ATLAS-CANON.md`
  §"What is canonical right now": Atlas memory, swarm state, shared bus, and
  the Python swarm implementation are still edited in VOLAURA when the
  intent is to change real agent state, identity, or cross-session memory.
  This ADR does not move that.
- **Machine execution-state authority for new Atlas-managed work is ANUS
  `state/exec-graph`** (ADR-0001), specifically because it is git-tracked
  inside a single repository with a single branch of record for this state
  (`feat/arsenal-wiring` at EB-0 time, merging to the repo's trunk in the
  normal course of development), append-only, and evidence-gated (ADR-0003).
- VOLAURA's `memory/atlas/work-queue/` becomes a **read-only import source**
  (ADR-0004, classification #4): existing pending items can be imported into
  exec-graph with provenance `volaura-work-queue:<filename>`, but it stops
  being a task authority for new Atlas-managed work. No data in VOLAURA is
  deleted or migrated destructively by this decision.
- This is flagged here as a **known issue, not a resolved one.** The
  branch-fragmentation and gitignored-shared-bus problems are properties of
  VOLAURA as it exists today; fixing them is out of scope for this ANUS-side
  governance pass and is owned by the VOLAURA chat/repo, not by this ADR.

## Alternatives considered

1. **Reconcile VOLAURA's branches first, then make VOLAURA the execution
   authority.** Rejected for EB-0 timing: branch reconciliation is a
   VOLAURA-side project with its own scope; blocking exec-graph's rollout on
   it would leave Atlas without any evidence-gated task authority in the
   meantime.
2. **Un-gitignore the shared-bus.** Not this ADR's call — VOLAURA's
   `.gitignore` is owned by the VOLAURA repo/chat. Noted as a candidate fix
   for whoever picks up the "known issue" flagged above.
3. **Make ANUS the canon for everything (memory too), retiring VOLAURA's
   role entirely.** Rejected: out of scope and unnecessary — the problem
   this ADR solves is specifically about *execution state* for tasks, not
   about identity/memory, which VOLAURA continues to serve.

## Consequences

- **Positive:** a task's status has exactly one place to check
  (`atlas graph status` / `atlas task show <id>` in this repo), independent
  of which VOLAURA branch happens to be checked out on a given machine that
  day.
- **Positive:** clean separation of concerns — VOLAURA answers "what does
  Atlas want and remember," exec-graph answers "what is Atlas doing right
  now and what proves it."
- **Negative / cost:** two places to look depending on the question being
  asked. A reader unfamiliar with this split may still check VOLAURA first
  out of habit — mitigated by `ATLAS-CANON.md`'s "Practical rule" section
  and this ADR both being discoverable from the README.
- **Open debt:** VOLAURA's branch fragmentation and gitignored shared-bus
  remain real risks to intent/memory durability, independent of exec-graph.
  Not fixed here; tracked as a known issue, owner VOLAURA chat.

## Rollback or supersession

If VOLAURA's structural issues (branch fragmentation, gitignored shared-bus)
are fixed on the VOLAURA side, a future ADR can re-evaluate whether
execution state should move there. Until such an ADR is accepted, ANUS
`exec-graph` remains the authority per ADR-0001. This ADR does not require
any code rollback if superseded — VOLAURA's read-only import-source role
(ADR-0004 #4) can be widened without touching exec-graph's internals.

## Links

- `ATLAS-CANON.md` — the pre-existing repo-split canon this ADR narrows.
- ADR-0001 (one task authority: exec-graph)
- ADR-0004 (legacy task source cutover — VOLAURA work-queue classification)
- `docs/AUTONOMY-V0.md` — real repo-watch digest showing VOLAURA branch
  divergence (`feature/atlas-integration` vs the watched default) as
  observed evidence for the branch-fragmentation claim above.
