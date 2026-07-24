# Runbook: legacy task-source cutover (import + rollback)

Companion to ADR-0004. This runbook is the operational how-to for importing
work from the four legacy mechanisms into `src/exec-graph`, and for
rolling back safely if an import was wrong.

**Status:** IMPLEMENTED-LOCAL — `atlas task import` is tested
(`src/__tests__/exec-graph.test.ts`'s reconciliation tests exercise the
underlying `importTask()`), not yet exercised against real production
legacy data in this pass.

## When to use

- Mission 2 (or any deliberate follow-up) decides to bring a specific piece
  of legacy-tracked work under exec-graph's evidence-gated lifecycle.
- You need to check "is this VOLAURA work-queue item / operator task
  already tracked in exec-graph" before manually re-creating it.

## The four classifications (from ADR-0004 — repeated here for operational
reference, not re-decided)

| # | Mechanism | Classification | Import command exists? |
|---|---|---|---|
| 1 | Supabase `atlas_command_queue` | OUT OF SCOPE WITH EXPLICIT OWNER | No — deliberately no import path; it is a CEO-command transport, not a task source |
| 2 | Telegram `/task` → `task-spawner.ts` | TEMPORARY ADAPTER | No — ephemeral subprocess jobs, not designed to be imported; Mission 2 retires/reroutes this path itself |
| 3 | `operator/tasks/*.json` | READ-ONLY IMPORT SOURCE | Yes — `atlas task import ... --source-kind operator-tasks --source-ref <file>` |
| 4 | VOLAURA `memory/atlas/work-queue/` markdown | READ-ONLY IMPORT SOURCE | Yes — `atlas task import ... --source-kind volaura-work-queue --source-ref <filename>` |

Only #3 and #4 have an import path. #1 and #2 are intentionally not
importable — see ADR-0004 for why.

## Preconditions

- A goal already exists to attach the imported task to
  (`atlas goal add <title...>` if not), or you have an existing goal id
  (`gol_...`) from `atlas graph status` / a prior `atlas goal add` output.
- You know the source file/ref you're importing from (a path under
  `operator/tasks/`, or a filename under VOLAURA's
  `memory/atlas/work-queue/`).

## Exact safe commands

1. **Create or identify a goal:**
   ```
   node dist/cli.js goal add "Reconcile pre-EB-0 operator tasks"
   ```
   Prints the new `Goal` JSON, including its `id` (e.g. `gol_abc123...`) —
   copy this id for step 2.

2. **Check whether a task is already imported (avoid a needless duplicate
   call — though duplicates are safe by construction, see "Idempotency"
   below):**
   ```
   node dist/cli.js task list --status proposed
   ```
   or list all and grep the `source` field for the ref you're about to
   import.

3. **Import from `operator/tasks/*.json` (classification #3):**
   ```
   node dist/cli.js task import "Operator task: <title>" \
     --goal <goal-id> \
     --source-kind operator-tasks \
     --source-ref operator/tasks/<filename>.json \
     --risk low
   ```
   Prints `{ "created": true|false, "task": {...} }`. `created: false`
   means this exact `source-kind:source-ref` pair was already imported —
   the printed task is the existing one, no duplicate was made.

4. **Import from VOLAURA work-queue (classification #4):**
   ```
   node dist/cli.js task import "VOLAURA work-queue: <title>" \
     --goal <goal-id> \
     --source-kind volaura-work-queue \
     --source-ref <filename> \
     --risk low
   ```
   Same `created`/dedupe semantics as step 3. Use the bare filename (not a
   full path) as `--source-ref` to match the provenance format ADR-0004
   specifies: `volaura-work-queue:<filename>`.

5. **Verify the import landed:**
   ```
   node dist/cli.js task show <task-id-from-step-3-or-4>
   ```
   Confirm `source.kind`, `source.ref`, and `idempotencyKey` match what you
   expect (`idempotencyKey` should equal `${source.kind}:${source.ref}`
   exactly).

## Idempotency (why re-running import is safe)

`importTask()` (`src/exec-graph/api.ts`) always derives `idempotencyKey` as
`${sourceKind}:${sourceRef}` and never accepts a caller override for
imports. `appendEvent()`'s ledger fold (`src/exec-graph/ledger.ts`) rejects
a second `task-created` event with an idempotencyKey that already exists in
the graph and returns the existing task's id instead — proven by the
double-`importTask` reconciliation test in
`src/__tests__/exec-graph.test.ts`. **Running the same import command twice
is always safe** — it will never create a second active task for the same
legacy ref.

## Expected receipts

- The printed `Goal`/`Task` JSON from each command above, pasted into
  whatever tracking note prompted the import.
- `node dist/cli.js graph status` output showing the new task's status
  counted, before and after import.
- For a batch import (multiple legacy items), the full list of
  `{created, task.id, source}` tuples — enough to audit exactly what was
  imported and from where.

## Failure symptoms

| Symptom | Likely cause | Fix |
|---|---|---|
| `task import error: exec-graph: unknown task <id>` | Wrong `--goal <id>` — goal doesn't exist | `atlas graph status` or re-run `goal add`, use the correct id |
| Import succeeds but `created: false` on what you thought was a fresh item | Same `source-kind:source-ref` pair was already imported (working as designed) | `atlas task show <id-from-output>` to confirm it's the right existing task, not a naming collision |
| `--source-kind` rejected | Typo, or trying to import from classification #1/#2 (no import path exists — and shouldn't) | Use exactly `operator-tasks` or `volaura-work-queue`; do not attempt to route #1/#2 through `task import` — that would violate ADR-0004's boundary |

## ROLLBACK

If an import was wrong (wrong goal, wrong title, wrong source ref):

1. **Pause new intake** — do not run further imports against the same
   source until the mistake is understood. No code-level pause exists for
   `task import` specifically; this is a human/process pause (stop running
   the command).
2. **Retain the immutable ledger** — do **not** hand-edit
   `state/exec-graph/ledger.jsonl` to remove the bad import. The ledger is
   append-only by design (ADR-0003); a wrong import is corrected by
   recording a *new* event, not by erasing the old one.
3. **Correct forward, not backward:**
   - If the task is simply wrong and should not proceed:
     ```
     node dist/cli.js task move <task-id> rejected --actor <you> --note "wrong import, see <reason>"
     ```
     (`proposed -> rejected` is a legal transition per
     `src/exec-graph/transitions.ts`'s `LEGAL_TRANSITIONS` table.) The
     mistaken task stays visible in history as `rejected`, not deleted.
   - If the task is right but needs correction (e.g. wrong title), there is
     no in-place edit — `taskSchema`'s `title` is set at creation and has
     no update path in `api.ts` today. Reject the wrong one (as above) and
     re-import correctly under a **different** `--source-ref` if the
     original ref is reusable, or note the discrepancy in the rejection
     note if the ref must stay the same (re-importing the identical
     `source-kind:source-ref` will just return the same, now-rejected,
     task — see "Idempotency" above).
4. **Restore legacy sources to read-only visibility** — nothing needs to be
   "restored," since import never modifies `operator/tasks/*.json` or
   VOLAURA's `memory/atlas/work-queue/` files (ADR-0004: "no writes back").
   The legacy files remain exactly as they were before the import; only the
   exec-graph side needs the rejection above.
5. **NO DATA DELETION** — at any point in this rollback, nothing is ever
   deleted from `ledger.jsonl`, `operator/tasks/`, or VOLAURA's work-queue.
   This mirrors ADR-0004's explicit "No legacy data is deleted anywhere."

## Escalation owner

- **Atlas** — routine imports and rejections following this runbook.
- **External CTO** — Mission 2 scope questions (e.g. "should mechanism #2
  now be imported too?" — that's a classification change, not an
  operational import, and requires a new/amended ADR).
- **CEO** — only if a rollback would need to touch the ledger's append-only
  guarantee itself (it should never need to — if you think it does, stop
  and escalate before acting).
