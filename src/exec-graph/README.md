# exec-graph (EB-0)

## Purpose

The single machine execution authority for new Atlas-managed work: a
goal/task ledger with an explicit 11-state task lifecycle
(`proposed -> accepted -> planned -> delegated -> in-progress -> blocked ->
evidence-submitted -> verified -> closed`, plus `rejected` and `escalated`
side-states). Every state change is a recorded, actor-attributed,
evidence-gated `Transition` — there is no way to move a task to `verified`
without citing evidence, and no way to close a task that was never verified
or rejected.

## Inputs / outputs

- **Inputs:** `createGoal`, `createTask`, `importTask`, `moveTask`,
  `addEvidence` (see `api.ts`) — or the `atlas goal add` / `atlas task ...` /
  `atlas graph ...` CLI commands in `src/cli.ts`.
- **Outputs:** `getTask`, `listTasks`, `statusSummary` — the last of which is
  what `atlas graph status` prints (counts per status, plus the list of
  tasks waiting on decision/verification: `escalated`, `blocked`,
  `evidence-submitted`).

## State it reads/writes

`state/exec-graph/` (default; override via `ATLAS_EXEC_GRAPH_DIR`),
**git-tracked**:

- `ledger.jsonl` — append-only event log, one JSON event per line. Source of truth.
- `graph.json` — derived snapshot (`{ goals: Goal[], tasks: Task[] }`), a
  disposable read-cache rebuildable at any time from the ledger.

## AUTHORITY BOUNDARY

This module is the ONE machine execution authority for new Atlas-managed
work (ADR-0001). VOLAURA markdown = strategy/intent canon only. Legacy
sources (`supabase-queue`, `telegram-spawner`, `operator-tasks`,
`volaura-work-queue`) are import sources or out-of-scope transports — **none
may close a graph task**; there is deliberately NO code path from them into
this module except `importTask`.

## Allowed side effects

- Append a line to `state/exec-graph/ledger.jsonl`.
- Rewrite `state/exec-graph/graph.json`.
- `console.error` on read/write failure (never silent, never a throw on a
  read path).

No network calls, no Telegram/messaging sends, no scheduler interaction, no
process spawning.

## Failure behavior

- **Reads are fail-safe.** A missing or schema-invalid `graph.json` falls
  back to a full fold of `ledger.jsonl`. A malformed line in `ledger.jsonl`
  is skipped (with a `console.error`) and the rest of the ledger still
  loads. Reads never throw.
- **Writes are loud, not silent, and never throw.** A failed ledger append
  or snapshot write logs via `console.error`; a failed append
  short-circuits before the snapshot write so `graph.json` can never claim
  an event the ledger doesn't actually have.
- `atlas graph verify` is the operator-facing check: it rebuilds the
  snapshot from `ledger.jsonl` and diffs it against what's actually on disk
  in `graph.json`, exiting 1 on any mismatch.

## Idempotency

A task's `idempotencyKey` is required and, for `importTask`, always derived
deterministically as `${source.kind}:${source.ref}` — never caller-supplied
for imports. `ledger.appendEvent()` rejects a `task-created` event whose
`idempotencyKey` already exists in the current graph and returns the
**existing** task's id instead of writing a duplicate. This is the
reconciliation guarantee: importing the same legacy ref twice can never
create a second active task.

## Security

No secrets, no network, no PII. Every write is local-filesystem-only, under
`state/exec-graph/`.

## Tests

`src/__tests__/exec-graph.test.ts` — legal/illegal transitions, evidence
invariants, escalation-exit actor gating, the reconciliation
(double-`importTask`) guarantee, ledger-rebuild-equals-snapshot, malformed
line / dunder-key / snapshot-write-failure handling, and the
`operator/dispatcher.ts` `loadOperatorState()` regression fix.

## Upstream / downstream

- **Upstream (imports from):** nothing outside this module besides
  `node:*` builtins and `zod`.
- **Downstream (imported by):** `src/cli.ts` (`goal`/`task`/`graph`
  commands). Nothing else in this repo writes to `state/exec-graph/`.
