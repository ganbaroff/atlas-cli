# State & evidence index

Where Atlas-managed task state and its supporting evidence actually live in
this repository, how to inspect them safely, and the retention rule for
each. Companion to `docs/architecture/ATLAS-ARCHITECTURE.md` (map) and
`docs/adr/0001-one-task-authority-exec-graph.md` /
`0003-append-only-ledger-plus-snapshot.md` (why it's shaped this way).

**Status:** IMPLEMENTED-LOCAL — the paths and mechanisms below are real and
tested (`src/__tests__/exec-graph.test.ts`); no live-cloud task activity has
been observed against them yet.

## Where task state lives

| Path | Role | Format | Tracked? |
|---|---|---|---|
| `state/exec-graph/ledger.jsonl` | **Source of truth.** Append-only event log — one `LedgerEvent` JSON object per line (`goal-created`, `task-created`, `transition`, `evidence-added`). | JSONL | git-tracked |
| `state/exec-graph/graph.json` | **Derived read-cache.** `{ goals: Goal[], tasks: Task[] }`, rebuildable at any time by folding the entire ledger. Disposable — never treat it as more authoritative than the ledger. | JSON | git-tracked |
| `state/exec-graph/.gitkeep` | Keeps the directory present in a fresh checkout before any goal/task has ever been created. | empty | git-tracked |

Override the directory via `ATLAS_EXEC_GRAPH_DIR` (tests point this at a
temp dir; default resolution walks up from cwd/module dir looking for
`package.json`, then uses `<that dir>/state/exec-graph` — see
`src/exec-graph/ledger.ts`'s `resolveExecGraphDir()`).

## Where receipts / evidence live

Evidence is not a separate file store — it is **references**, cited on a
`Task`'s `evidence` array and on the specific `Transition` that required
them (`evidenceRefs`). An `Evidence` entry (`src/exec-graph/contracts.ts`)
is `{ ref: string, kind: 'commit'|'test-output'|'file'|'url'|'tool-receipt'|'other', note?: string }`
— `ref` is a pointer (a commit SHA, a file path, a URL, a described tool
receipt), not an inlined blob. What that pointer resolves to depends on
`kind`:

| `kind` | What `ref` points to | Where to actually look |
|---|---|---|
| `commit` | A git commit SHA in this repo (or a named companion repo) | `git show <ref>` |
| `test-output` | A test run's output/summary | Usually pasted inline in the transition `note`, or a path under `logs/`/a CI artifact |
| `file` | A repo-relative file path | `Read` the file directly |
| `url` | An external URL (e.g. a Railway deploy log link, a dashboard) | Open the URL |
| `tool-receipt` | A described tool invocation (e.g. a `curl` output, an `atlas graph verify` result) | Usually pasted inline in the transition `note` |
| `other` | Anything not covered above | Check the `note` field first |

**Enforcement, not convention:** `transitionSchema`'s `superRefine`
(`contracts.ts`) makes a transition to `verified` or `evidence-submitted`
fail schema validation if it has zero `evidenceRefs` — a task cannot be
marked done without at least one cited pointer. `taskSchema`'s own
`superRefine` additionally requires the *task* (not just the transition) to
carry `>=1` evidence entry once it rests in `verified`/`closed`.
`exec-graph/api.ts`'s `moveTask()` bridges the two: any `--evidence` refs
supplied on a CLI `task move` call are promoted into real `Evidence` entries
on the task before the transition is attempted, so a single command can
satisfy both invariants at once.

## swarm-exec run evidence (2026-07-18)

A `swarm-exec` run (see `docs/runbooks/swarm-exec.md`, ADR-0007) produces a durable, correlated bundle that a `file-contains` receipt cites as the task's evidence. Only `hands/verifier.ts`, re-reading `bundle.json` for the `SWARM-VERIFIED:<runId>` token, sets the task's final state — the swarm never self-declares.

| Path | Role | Tracked? |
|---|---|---|
| `state/swarm-runs/<runId>/bundle.json` | **Run verdict of record.** Correlated: parentTaskId, normalized policy, honest completion verdict, provider-health, evidence tokens, `proof` = `SWARM-VERIFIED:<runId>` (iff `done`) else `SWARM-REJECTED:<runId>`, provenance. Written LAST + atomically, so a partial/crashed run is visibly incomplete (`complete !== true` ⇒ `readBundle` returns null). | gitignored (durable on disk) |
| `state/swarm-runs/<runId>/{result,trace,provider-health,evidence-manifest,responder-summary}.*` | Sub-artifacts backing the bundle. | gitignored |
| `state/intake-drafts/<draftId>.json` | The compiled intent draft that became the task (`source.ref = intake:<draftId>`). | gitignored |

Run artifacts are gitignored — durable on disk and reproducible from the ledger + a re-run, not committed.

## How to inspect a task safely

All reads below are non-mutating (`src/exec-graph/README.md`'s "Consumers"
section: nothing outside `api.ts`'s write functions touches the ledger).

```
node dist/cli.js task show <task-id>
```
Prints the full `Task` record — status, owner, source provenance, every
`Transition` in order (each with its `evidenceRefs`), and the accumulated
`evidence` array. This is the single command to answer "what does this task
claim, and what backs that claim."

```
node dist/cli.js task list [--status <status>] [--goal <id>] [--owner <owner>]
```
Filtered listing — useful for "show me everything still `blocked`" or
"everything under this goal."

```
node dist/cli.js graph status
```
Aggregate counts per status, plus the tasks waiting on decision/
verification (`escalated`, `blocked`, `evidence-submitted`).

```
node dist/cli.js graph verify
```
Integrity check — confirms `graph.json` matches a fresh fold of
`ledger.jsonl`. Not itself an evidence inspector, but the precondition for
trusting any of the reads above (see "Recovery pointer").

## Hand Contract V0 delegation evidence (Mission 2)

A hand-owned task's receipt (`kind: 'tool-receipt'`) is just another
`Evidence` entry on the same task, added via `src/hands/exec-graph-adapter.ts`'s
`submitReceipt()` (which itself calls `exec-graph/api.ts`'s `addEvidence()`
— no separate evidence store). Two things specific to this evidence path,
not covered above:

- **Secret-scanned before persistence, not after.** `submitReceipt()`
  refuses (`ReceiptSecretError`) any receipt whose free-text fields match a
  secret-shape pattern BEFORE the evidence entry is written — required
  because `ledger.jsonl` is append-only (ADR-0003); a secret that reached
  it would be permanent. See `src/hands/exec-graph-adapter.ts`'s
  `assertReceiptHasNoSecrets()` and ADR-0006.
- **Hand-owned final transitions are verifier-only.** A hand-owned task
  (`owner` starting `hand:`) can reach `verified`/`rejected` only through
  `src/hands/exec-graph-adapter.ts`'s `verifyAndTransition()` — enforced in
  `exec-graph/api.ts`'s `moveTask()` itself (`HandAuthorityError` if the
  generic `task move`/`task reassign` CLI is used on a hand-owned task
  without the internal `_viaHandAdapter` flag). See
  `docs/adr/0006-hand-contract-authority.md` and
  `docs/runbooks/hand-delegation.md`.

## Recovery pointer

If any of the reads above look wrong, stale, or `graph verify` reports a
mismatch: **`docs/runbooks/exec-graph-recovery.md`**. Do not hand-edit
`graph.json` or `ledger.jsonl` directly — follow that runbook.

## Generated vs. manual files

| File | Generated or manual | Notes |
|---|---|---|
| `state/exec-graph/ledger.jsonl` | **Generated** (append-only, by `appendEvent()`) | Never hand-author new lines; existing lines should also never be hand-edited (breaks the audit trail's integrity) |
| `state/exec-graph/graph.json` | **Generated** (derived from the ledger) | Never hand-edit — see the recovery runbook if it looks wrong |
| `state/exec-graph/.gitkeep` | **Manual** (placeholder) | Only exists so the directory survives a fresh checkout before any events are written |
| `docs/adr/*.md` | **Manual** | Written and updated by hand; not regenerated from code |
| `docs/runbooks/*.md` | **Manual** | Same |
| `src/exec-graph/README.md` | **Manual** | Module contract doc — update by hand when the module's actual behavior changes |
| `dist/` (whole directory) | **Generated** (`npm run build`, tsup) | Never edit — see `ATLAS-CANON.md`'s "not canonical" list |

## Retention / pruning rule

- **`ledger.jsonl`: never pruned, for EB-0.** ADR-0003 documents this as an
  accepted, explicit non-goal — the ledger only grows. Compaction/archival
  is a future concern requiring its own ADR (see ADR-0003's "Rollback or
  supersession" section), not something to do ad hoc.
- **`graph.json`: regenerable, so pruning it is meaningless** — deleting it
  or restoring an old committed version is always safe; it will be
  correctly regenerated by the next successful ledger append, or read
  around via `readGraph()`'s automatic in-memory fallback in the meantime
  (see `docs/runbooks/exec-graph-recovery.md`).
- **Evidence pointers themselves are not retained by exec-graph** — a
  `commit` ref's durability depends on the referenced git history not being
  rewritten; a `url` ref's durability depends on the linked resource
  staying up. exec-graph records the pointer, not a copy of what it points
  to. This is a known tradeoff (lighter ledger, no evidence-blob storage)
  rather than an oversight.

## Links

- `docs/atlas-cto/ATLAS-STATE-NOW.md` — post-compaction orientation doc: read this FIRST on
  resume after a context compaction.
- `docs/atlas-cto/EXTERNAL-CTO-STATE-SNAPSHOT.md` — durable, pushed snapshot of
  the Atlas-CTO status ledger. The canonical original
  (`VOLAURA/memory/atlas/EXTERNAL-CTO-STATE.md`) is stranded on the local,
  unpushed VOLAURA branch `fix/pr-169-rubric-repair` — this copy exists so the
  status survives if that branch is lost (jarvis 2026-07-18 continuity fix).
- `docs/architecture/ATLAS-ARCHITECTURE.md` — full system map.
- `docs/adr/0001-one-task-authority-exec-graph.md`,
  `0003-append-only-ledger-plus-snapshot.md`,
  `0006-hand-contract-authority.md`
- `docs/runbooks/exec-graph-recovery.md`, `hand-delegation.md`
- `src/exec-graph/README.md`, `contracts.ts`, `ledger.ts`, `api.ts`
- `src/hands/README.md`, `exec-graph-adapter.ts`, `contract.ts`
- `src/__tests__/exec-graph.test.ts`, `hands.test.ts`
