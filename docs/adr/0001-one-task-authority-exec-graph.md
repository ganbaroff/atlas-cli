# ADR-0001: `src/exec-graph` is the one machine execution authority

- **Status:** ACCEPTED
- **Date:** 2026-07-17
- **Deciders:** External CTO (authority correction), CEO (Yusif Ganbarov)

## Context

Before EB-0, Atlas-managed work state was scattered across four uncoordinated
mechanisms, none of which shared a schema, a lifecycle, or an evidence
requirement:

1. Supabase `atlas_command_queue` — a CEO-command transport, produced by
   `telegram.ts`'s `/remote` handler and the autonomous brain-loop, consumed
   by an external, off-repo Claude Code cron (see `docs/QUEUE-CONTRACT.md`).
2. Telegram `/task` → `src/atlas/task-spawner.ts` — spawns a subprocess job,
   returns output straight to the CEO's chat, records nothing durable beyond
   a JSON file under `C:/Projects/ATLAS/data/task-results`.
3. `operator/tasks/*.json` — one-off dispatch task specs consumed by
   `src/operator/dispatcher.ts`.
4. VOLAURA `memory/atlas/work-queue/` markdown — a strategy/intent list
   maintained by hand in a separate, branch-fragmented, partly gitignored
   repository (see ADR-0002).

None of these four had a shared task lifecycle, none required evidence
before a task could be considered "done," and a task's true status depended
on which of the four places you looked. That is the condition EB-0 (this
governance pass) exists to fix.

## Decision

At EB-0 activation, `src/exec-graph` (`src/exec-graph/contracts.ts`,
`ledger.ts`, `transitions.ts`, `api.ts`) is **the one machine execution
authority for new Atlas-managed work**. Concretely:

- Every new task Atlas is asked to execute gets a `Task` in the exec-graph,
  created via `createTask()`/`createGoal()` (`src/exec-graph/api.ts`) or the
  `atlas goal add` / `atlas task add` CLI commands (`src/cli.ts`).
- A task moves through the explicit 11-state lifecycle defined in
  `src/exec-graph/contracts.ts` (`proposed -> accepted -> planned ->
  delegated -> in-progress -> blocked -> evidence-submitted -> verified ->
  closed`, plus `rejected` and `escalated`) only via a recorded, schema-
  validated `Transition` (`src/exec-graph/transitions.ts`).
- A task cannot rest in `verified` or `closed` without at least one
  `Evidence` entry (`contracts.ts`'s `taskSchema` `superRefine`), and cannot
  transition to `verified` or `evidence-submitted` without citing
  `evidenceRefs` on that specific transition.
- The four legacy mechanisms above are reclassified per ADR-0004 — none of
  them may close a graph task, and there is deliberately no code path from
  any of them into exec-graph except the explicit `importTask()` function.

## Alternatives considered

1. **Keep all four mechanisms, add a reconciliation job that periodically
   merges them.** Rejected: a periodic merge cannot provide the "cannot
   claim verified without evidence" guarantee at write time — it can only
   detect drift after the fact, and drift is exactly the current failure
   mode.
2. **Make VOLAURA's `memory/atlas/work-queue/` the authority (extend it with
   a lifecycle schema).** Rejected — see ADR-0002: VOLAURA is
   branch-fragmented and its shared-bus directory is gitignored, so
   execution-critical state written there is not reliably durable or
   auditable from ANUS.
3. **Make the Supabase queue the authority (add lifecycle columns to
   `atlas_command_queue`).** Rejected: the queue's consumer is, by design,
   allowed to be an external, off-repo, unaudited executor (see
   `docs/QUEUE-CONTRACT.md`); making it the task authority would mean the
   authority's write path lives partly outside this repository's audit
   surface.
4. **Build a new service (DB-backed) instead of an in-repo, git-tracked
   ledger.** Rejected for EB-0: adds an operational dependency (a database)
   for a single-operator, local-first tool where a git-tracked append-only
   file already gives durability, diffability, and free audit history. Not
   ruled out permanently — revisit if/when exec-graph needs concurrent
   writers across machines.

## Consequences

- **Positive:** one place to ask "what is Atlas working on and what proves
  it's done" (`atlas graph status`, `atlas task show <id>`). Evidence is
  structurally mandatory, not a convention that can be skipped under time
  pressure.
- **Positive:** the ledger is append-only and git-tracked
  (`state/exec-graph/ledger.jsonl`, `state/exec-graph/graph.json`), so the
  full history of every decision survives independently of any one
  process's memory.
- **Negative / cost:** every new task-shaped piece of work now has one more
  step (create a task, cite evidence, transition it) versus firing off a
  Telegram `/task` and reading the reply. This is intentional friction in
  exchange for auditability — see ADR-0004 for how legacy low-friction paths
  are still available as temporary adapters/import sources during the
  transition.
- **Negative / scope:** exec-graph does not (yet) do anything with a task
  besides record its state — it has no scheduler, no executor, no retry
  logic. Today a task's `in-progress`/`blocked`/`evidence-submitted` moves
  are made by whichever actor (Atlas, CEO, external-cto) is doing the work,
  by hand or by a future integration. Automating that is out of scope for
  EB-0.

## Rollback or supersession

Rollback: exec-graph reads are already fail-safe (missing/corrupt
`graph.json` rebuilds from `ledger.jsonl`; a malformed ledger line is
skipped, not fatal — see `src/exec-graph/README.md` "Failure behavior"). If
exec-graph needed to be abandoned, the ledger stays a valid historical
record; no other system currently depends on it being live, since nothing
outside `src/exec-graph/` and `src/cli.ts` writes to it (see
`src/exec-graph/README.md` "Upstream / downstream").

Supersession: a future ADR may extend this authority to a shared/networked
store if exec-graph needs concurrent writers from more than one machine —
see ADR-0001's "alternatives considered" #4. Any such change must preserve
the append-only-ledger-plus-evidence-gate guarantees from ADR-0003, or must
explicitly supersede ADR-0003 too.

## Links

- `src/exec-graph/README.md` — module contract (purpose, inputs/outputs,
  authority boundary, failure behavior, consumers).
- `src/exec-graph/contracts.ts`, `transitions.ts`, `ledger.ts`, `api.ts` —
  implementation.
- ADR-0002 (VOLAURA intent vs ANUS execution state)
- ADR-0003 (append-only ledger + snapshot)
- ADR-0004 (legacy task source cutover — the four mechanisms above,
  classified)
- `src/__tests__/exec-graph.test.ts` — legal/illegal transitions, evidence
  invariants, reconciliation guarantee.
