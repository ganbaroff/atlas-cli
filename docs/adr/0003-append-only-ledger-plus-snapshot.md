# ADR-0003: Append-only JSONL ledger + disposable JSON snapshot

- **Status:** ACCEPTED
- **Date:** 2026-07-17
- **Deciders:** External CTO (authority correction), CEO (Yusif Ganbarov)

## Context

ADR-0001 makes `src/exec-graph` the one machine execution authority. That
authority needs a persistence design that satisfies three properties this
project already learned the hard way it needs (see
`src/atlas/autonomy-loop.ts`'s and `src/exec-graph/ledger.ts`'s own header
comments, which both cite the same lesson):

1. **Reads must never throw**, even against a missing, empty, or
   partially-corrupt state directory — a fresh checkout, a container image
   shipped read-only, or a crashed write mid-append must all degrade to a
   safe empty/partial result, never crash the caller (Telegram `/status`,
   the morning brief, the CLI).
2. **Writes must be loud, never silent** on failure — a failed persist must
   be visibly logged, not swallowed, so `graph.json` can never silently
   claim state the ledger doesn't actually have.
3. **The full history must be independently auditable** — not just the
   current state, but how it was reached, without relying on any one
   process's in-memory history.

## Decision

Persistence for exec-graph is two files under `state/exec-graph/` (default;
override via `ATLAS_EXEC_GRAPH_DIR`), both git-tracked:

- **`ledger.jsonl` — source of truth.** Append-only, one JSON `LedgerEvent`
  per line (`goal-created` / `task-created` / `transition` /
  `evidence-added`, see `src/exec-graph/contracts.ts`). Never rewritten in
  place; the only write operation is `appendFileSync` (`ledger.ts`'s
  `persistEvent`).
- **`graph.json` — derived, disposable read-cache.** `{ goals: Goal[], tasks:
  Task[] }`, rebuildable at any time by folding the entire ledger
  (`rebuildSnapshot()` = `foldEvents(readLedgerEvents())`). Written as an
  incremental update after every successful ledger append, using the exact
  same fold function (`applyEventToSnapshot()`) that a full rebuild uses —
  this equality (incremental update == full rebuild from event zero) is
  what makes `atlas graph verify` a meaningful integrity check rather than a
  tautology.

Failure behavior, both directions:

- **Read path:** `readLedgerEvents()` skips a malformed JSON line or a line
  that fails `ledgerEventSchema` validation, logs it via `console.error`,
  and keeps loading the rest of the file — one bad line does not lose the
  whole ledger. `readGraph()` prefers the on-disk `graph.json` snapshot if
  it parses and validates; otherwise it transparently falls back to a full
  ledger rebuild. Neither path throws.
- **Write path:** a failed `ledger.jsonl` append (`persistEvent()`)
  `console.error`s and returns *before* attempting the `graph.json` write —
  the snapshot can never advance past what the ledger actually durably
  recorded. A failed `graph.json` write (snapshot out of date) also
  `console.error`s; `atlas graph verify` is the operator-facing check that
  catches this drift by rebuilding from the ledger and diffing.
- **Idempotency:** `appendEvent()` special-cases `task-created` — if a task
  with the same `idempotencyKey` already exists in the current graph, no new
  event is written and the existing task's id is returned instead (the
  reconciliation guarantee ADR-0004 depends on for safe re-import).
- **Key-injection defense:** both the in-memory snapshot (id-keyed
  `Record`) and the on-disk file shape (`goals`/`tasks` arrays, not
  id-keyed objects) reject `__proto__`/`constructor`/`prototype` as task or
  goal ids (`isSafeKey()`), on top of the schema-level `gol_`/`tsk_` id
  prefix requirement.

## Alternatives considered

1. **A single mutable `graph.json`, no ledger.** Rejected: loses the audit
   trail (property 3) — you can see the current state but not how or why it
   got there, and a corrupted write destroys history, not just a cache.
2. **SQLite or another embedded DB file.** Rejected for EB-0: adds a binary
   dependency and a migration story for a single-operator, low-write-volume
   tool where a human-readable, diffable, git-mergeable JSONL file already
   satisfies durability and auditability. Reconsider if write volume or
   concurrent-writer needs grow (see ADR-0001 alternative #4).
3. **Snapshot-only with periodic ledger compaction/rotation.** Rejected:
   compaction reintroduces the "which write actually landed" ambiguity this
   design exists to avoid — an append-only file with no rotation is simpler
   to reason about and cheap enough at EB-0's expected volume.

## Consequences

- **Positive:** `git log -p state/exec-graph/ledger.jsonl` is a real audit
  trail — every transition, every evidence citation, attributed to an actor
  and a timestamp, independent of exec-graph's own code being correct.
- **Positive:** recovery is mechanical and low-risk — delete/rebuild
  `graph.json` from `ledger.jsonl` any time via `atlas graph verify` (or a
  manual `rebuildSnapshot()` call); the ledger itself is never touched by
  recovery. See `docs/runbooks/exec-graph-recovery.md`.
- **Negative / cost:** `graph.json` can go stale relative to the ledger
  between a successful append and a failed snapshot write (rare, but
  possible under disk-full or permission-error conditions) until the next
  `atlas graph verify` or successful append catches and reports it. This is
  an accepted, detectable, self-healing staleness window, not a silent
  correctness bug.
- **Negative / cost:** the ledger only grows — there is no compaction in
  EB-0 scope (see `docs/state-and-evidence-index.md`'s retention rule:
  ledger pruning = never, for EB-0). Long-term ledger size is an accepted
  future concern, not solved here.

## Rollback or supersession

Rollback: none needed — this is the only persistence path exec-graph has
ever had; there is no prior format to revert to.

Supersession: a future ADR could introduce ledger compaction/archival (e.g.
periodic snapshot-and-truncate with the truncated segment archived
elsewhere) once ledger size becomes an operational problem. Any such change
must preserve "reads never throw" and "a rebuild from the retained ledger
segment matches the retained snapshot" as invariants, or must explicitly
supersede this ADR's guarantees.

## Links

- `src/exec-graph/ledger.ts` — implementation (module header comment is the
  detailed technical spec this ADR summarizes).
- `src/exec-graph/contracts.ts` — `LedgerEvent` schema, `GraphSnapshotFile`
  schema.
- ADR-0001 (one task authority: exec-graph)
- `docs/runbooks/exec-graph-recovery.md`
- `src/__tests__/exec-graph.test.ts` — malformed-line handling,
  ledger-rebuild-equals-snapshot, dunder-key rejection, snapshot-write-
  failure handling.
