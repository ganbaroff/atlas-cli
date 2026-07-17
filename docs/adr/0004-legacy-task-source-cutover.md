# ADR-0004: Legacy task-source cutover — classification + no-write-back contract

- **Status:** ACCEPTED
- **Date:** 2026-07-17
- **Deciders:** External CTO (authority correction), CEO (Yusif Ganbarov)

## Context

ADR-0001 makes `src/exec-graph` the one machine execution authority for new
Atlas-managed work. Four pre-existing mechanisms produced or held
task-shaped state before EB-0. This ADR is the classification decision for
all four, made by the External CTO's authority correction on 2026-07-17 —
the table below is fixed policy, not re-derived here.

## Decision — classification table

| # | Mechanism | Classification | Owner | Boundary |
|---|---|---|---|---|
| 1 | Supabase `atlas_command_queue` | **OUT OF SCOPE WITH EXPLICIT OWNER** | cloud Telegram bot runtime / External CTO | CEO-command transport, not a graph-task source. Zero code path from queue to exec-graph. The queue cannot close a graph task. Revisit at Mission 2 (Hand Contract V0). |
| 2 | Telegram `/task` → `src/atlas/task-spawner.ts` | **TEMPORARY ADAPTER** | live CEO convenience in the deployed bot | Spawned subprocess jobs are ephemeral CEO-direct executions, not graph tasks. Spawner may not write graph state (no code path exists). Mission 2 retires/reroutes it into the graph. |
| 3 | `operator/tasks/*.json` | **READ-ONLY IMPORT SOURCE** | dormant since 2026-05-31 self-test burst | Importable via `atlas task import <title...> --goal <goal-id> --source-kind operator-tasks --source-ref <file>`. No writes back. Operator revalidation deferred to Mission 2. |
| 4 | VOLAURA `memory/atlas/work-queue/` markdown | **READ-ONLY IMPORT SOURCE** | VOLAURA = strategy/intent canon only (ADR-0002) | Pending items importable with provenance `volaura-work-queue:<filename>`. No writes back. Stops being a task authority for new Atlas-managed work. |

**No legacy data is deleted anywhere.** Provenance for every imported task is
`task.source{kind,ref}` plus a deterministic `idempotencyKey`
(`${kind}:${ref}`), and re-import dedupe is enforced in the ledger fold
(`src/exec-graph/ledger.ts`'s `appendEvent()`) — proven by the
reconciliation test in `src/__tests__/exec-graph.test.ts` (double-`importTask`
call for the same `volaura-work-queue:wq-123` ref produces exactly one
task).

## Cutover contract

- No legacy source may close a graph task. There is deliberately no code
  path from any of the four mechanisms into `src/exec-graph` except the
  explicit `importTask()` function (`src/exec-graph/api.ts`), which any
  caller must invoke deliberately — it is never triggered implicitly by the
  legacy mechanism itself.
- Provenance (`source.kind` + `source.ref`) is mandatory on every task,
  enforced by `taskSchema` (`src/exec-graph/contracts.ts`).
- Import is idempotent by construction: `importTask()` always derives
  `idempotencyKey` as `${sourceKind}:${sourceRef}` and never accepts a
  caller-supplied override for imports — re-running an import against the
  same legacy ref can never create a second active task.

## Correction to the record — mechanism #1's current code state

The classification above cites `telegram.ts:503: queued for an off-repo
CEO-machine cron` as the transport's location. At this mission's HEAD
(`ac6d384`, branch `feat/arsenal-wiring`), that citation no longer matches
the code and is corrected here rather than silently carried forward:

- `telegram.ts:503` today is inside the **`/task`** handler (mechanism #2,
  `sendLong(ctx, reply)`), not `/remote`.
- The **`/remote`** handler (`telegram.ts:512-523`) that used to call
  `queueRemoteCommand()` was disabled 2026-07-10 ("board P0" — the code
  comment reads: *"auto-queue to ungoverned external cron deleted"*). It now
  only replies that the command is disabled and does not write to Supabase.
- The **autonomous brain-loop** (`telegram.ts:787-797`,
  `autonomousBrainLoop()`) that also used to call `queueRemoteCommand()` was
  made inert the same day, for the same reason — the function body is now
  two early-return guards and a comment explaining the removal.
- `docs/QUEUE-CONTRACT.md` (pre-existing, not owned by this mission) still
  describes both of the above as active producers. It is **stale relative
  to current HEAD** — flagged here, not fixed, since this mission's scope
  does not include the queue transport (mechanism #1's classification is
  "out of scope with explicit owner"). Correcting `QUEUE-CONTRACT.md` itself
  is a follow-up for the cloud Telegram bot runtime owner / External CTO.
- The classification itself is unaffected by this correction: mechanism #1
  remains "out of scope with explicit owner," the `atlas_command_queue`
  table, `supabase-memory.ts`'s claim/complete/fail/sweep functions, and the
  opt-in in-repo consumer (`src/atlas/queue-worker.ts`, off by default) all
  still exist in code — there is simply, as of this HEAD, no active in-repo
  **producer** feeding the queue. The "zero code path from queue to
  exec-graph" boundary holds regardless of whether the queue is currently
  fed.

## Alternatives considered

1. **Retire all four mechanisms immediately instead of phasing them as
   adapters/import sources.** Rejected: `/task` is live CEO convenience in
   the deployed bot (mechanism #2) — cutting it before Mission 2 has a
   replacement would remove a working CEO-facing capability with nothing to
   replace it. Phased cutover was chosen deliberately.
2. **Auto-import all legacy sources into exec-graph on every read.**
   Rejected: silent, unattributed auto-import would defeat the point of
   evidence-gated, actor-attributed task creation — import must be an
   explicit, auditable act (`atlas task import ... --source-kind ...
   --source-ref ...`), not a background side effect.
3. **Let legacy mechanisms write directly into exec-graph instead of
   through `importTask()`.** Rejected: would reintroduce multiple write
   paths into the ledger, the exact fragmentation ADR-0001 exists to
   eliminate.

## Consequences

- **Positive:** existing legacy work is not lost or force-migrated; it is
  importable on demand with full provenance, at the pace Mission 2 decides.
- **Positive:** the boundary is enforced by absence of code, not by
  discipline — there is no function anywhere outside `importTask()` that
  can write a legacy-sourced event into the ledger.
- **Negative / cost:** until Mission 2, the CEO-facing `/task` path
  (mechanism #2) and any operator-tasks / VOLAURA work-queue items remain
  outside exec-graph unless someone explicitly imports them — dual-tracking
  is an accepted, temporary state, not a bug.
- **Documentation debt:** `docs/QUEUE-CONTRACT.md` needs a follow-up
  correction pass (owner: cloud Telegram bot runtime / External CTO) to
  reflect the 2026-07-10 producer removal; out of this mission's scope to
  fix directly.

## Rollback or supersession

Rollback: none needed for the classification itself — it does not remove
any existing capability, it only fences off write paths that already didn't
write into exec-graph (exec-graph did not exist before EB-0).

Supersession: Mission 2 ("Hand Contract V0", referenced throughout this
table) is expected to retire or reroute mechanism #2 into the graph, and to
revisit mechanism #1's boundary. Any such change must preserve the
provenance + idempotency contract above, or must explicitly supersede this
ADR.

## Links

- ADR-0001 (one task authority: exec-graph)
- ADR-0002 (VOLAURA intent vs ANUS execution state — mechanism #4's owner)
- `src/exec-graph/README.md` — "AUTHORITY BOUNDARY" section
- `docs/QUEUE-CONTRACT.md` — mechanism #1's historical contract (stale re:
  current producer state, see correction above)
- `src/atlas/task-spawner.ts` — mechanism #2 implementation (now carries a
  TEMPORARY ADAPTER header referencing this ADR)
- `src/operator/dispatcher.ts` — mechanism #3's consumer
- `docs/runbooks/legacy-task-cutover.md` — operational import/rollback steps
- `src/__tests__/exec-graph.test.ts` — reconciliation (double-`importTask`)
  test
