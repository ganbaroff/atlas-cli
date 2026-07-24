# Runbook: exec-graph recovery

**Status of exec-graph itself:** IMPLEMENTED-LOCAL (tests green — see
`src/__tests__/exec-graph.test.ts`; no live bot run against it yet).

## When to use

- `atlas graph verify` reports a mismatch between the on-disk snapshot
  (`state/exec-graph/graph.json`) and a fresh rebuild from the ledger.
- `state/exec-graph/graph.json` is missing, truncated, or fails to parse.
- A line in `state/exec-graph/ledger.jsonl` looks malformed (e.g. after a
  crashed write, a bad manual edit, or a merge conflict marker left in the
  file).
- `/status` or the morning brief show "Exec-graph: не смог прочитать
  состояние задач" (the fail-safe degradation message).

## Preconditions

- You are in the ANUS repo root (see `ATLAS-CANON.md` for the canonical
  path) or have `ATLAS_EXEC_GRAPH_DIR` pointed at the correct state
  directory.
- `dist/cli.js` is built (`npm run build`) — or use `npx tsx src/cli.ts ...`
  for a dev-mode equivalent of every command below.
- No other process is actively appending to `ledger.jsonl` while you run
  recovery (exec-graph has no file locking — see "Failure symptoms" below).

## Exact safe commands (repo-relative)

1. **Diagnose — does the snapshot match the ledger?**
   ```
   node dist/cli.js graph verify
   ```
   Exits 0 and prints `"ok": true` with matching goal/task counts when
   healthy. Exits 1 and prints `"ok": false` plus
   `[graph verify] MISMATCH: on-disk snapshot does not match a fresh
   rebuild from the ledger.` on drift. This command is read-only against
   `ledger.jsonl` — it does **not** rewrite `graph.json` itself (see
   `src/cli.ts`'s `graph verify` action: it only reads, compares, and
   reports).

2. **Inspect the current summary (read-only).**
   ```
   node dist/cli.js graph status
   ```
   Prints counts per status plus the list of tasks waiting on
   decision/verification (`escalated`, `blocked`, `evidence-submitted`).
   Uses `readGraph()`, which already falls back to a ledger rebuild if
   `graph.json` is unreadable — so this command alone may already recover
   visibility even before you fix the on-disk snapshot file.

3. **Inspect one task (read-only).**
   ```
   node dist/cli.js task show <task-id>
   ```
   Prints the full task record including its transition history, from
   whichever source (`graph.json` or a ledger rebuild) `readGraph()`
   resolves.

4. **Rebuild `graph.json` from the ledger (the actual fix for drift).**
   Honest gap: there is no dedicated `atlas graph rebuild`/`--fix` CLI
   subcommand today. `graph verify` (step 1) only reads and compares — it
   never writes. `readGraph()` (used by `graph status` / `task show`)
   already falls back to an in-memory ledger rebuild automatically when
   `graph.json` is missing or invalid, so **reads recover on their own**
   without any action from you. The only code path that actually persists a
   freshly-rebuilt `graph.json` to disk is `appendEvent()`'s post-write step
   inside a real mutation. Two safe recovery options, in order of
   preference:
   1. **Restore the last known-good snapshot from git** (the directory is
      git-tracked):
      ```
      git checkout -- state/exec-graph/graph.json
      ```
      Then re-run `node dist/cli.js graph verify`. If the ledger has no new
      events since that commit, this alone resolves the mismatch.
   2. **Let the next legitimate mutation self-heal it.** Any real
      `atlas goal add`, `atlas task add`, `atlas task move`, or
      `atlas task import` call persists a `graph.json` derived from
      `applyEventToSnapshot()` over the *current* full graph state (not just
      the new event) — so the very next legitimate operation leaves
      `graph.json` correct as a side effect, with no separate "rebuild"
      step needed.
   Do not hand-edit `graph.json` directly — it is a disposable derived file
   by design (ADR-0003); any manual edit that isn't a byte-for-byte fold of
   the ledger will just be reported as a fresh mismatch by the next
   `graph verify`.

5. **Re-verify after rebuild.**
   ```
   node dist/cli.js graph verify
   ```
   Must report `"ok": true` before you consider recovery complete.

## Expected receipts

- `graph verify` JSON output pasted into the incident note, both before
  (showing the mismatch/counts) and after (`"ok": true`) recovery.
- If a ledger line was skipped as malformed, the `console.error` line from
  `readLedgerEvents()` (format: `[exec-graph] skipping malformed ledger
  line <N> in <path>: <reason>`) — copy this verbatim; it names the exact
  line number and reason.

## Malformed-line behavior (what NOT to worry about)

A malformed or unparseable line in `ledger.jsonl` is **skipped, not fatal**
— `readLedgerEvents()` logs it via `console.error` and continues folding
the rest of the file (`src/exec-graph/ledger.ts`). This means:

- A single corrupted append (e.g. truncated by a crash mid-write) does not
  take down the whole ledger — only that one event's data is lost, and
  every event before and after it still folds correctly.
- You do not need to manually delete or "fix" a malformed line for the rest
  of exec-graph to keep working — `graph status`, `task show`, and the
  Telegram/brief read paths already degrade gracefully around it.
- You SHOULD still investigate why the line was malformed (crashed process
  mid-append is the expected cause; a manually hand-edited ledger file is
  the other) before deciding whether to leave it in place (preserves the
  line-number-accurate history) or excise it (only if it's actively
  confusing `graph verify` output — the skip logic already means it's not
  breaking anything to leave it).

## Failure symptoms

| Symptom | Likely cause | Fix |
|---|---|---|
| `graph verify` reports mismatch, no error logged | A `graph.json` write failed silently after a successful ledger append (disk full, permission error) | Step 4 above (rebuild from ledger) |
| `[exec-graph] skipping malformed ledger line N` on every read | Corrupted or hand-edited `ledger.jsonl` | Investigate the line, then step 4 to refresh the snapshot around it |
| `/status` shows "не смог прочитать состояние задач" | `state/exec-graph/` unreadable in the deployed environment (e.g. Railway ships state read-only with the image) | Expected/known limitation on cloud — see `docs/architecture/ATLAS-ARCHITECTURE.md`'s local/cloud boundary; exec-graph writes are LOCAL-ONLY today. Not a corruption — no recovery action on the cloud side. |
| Two processes wrote to `ledger.jsonl` concurrently, lines interleaved oddly | exec-graph has no file locking — see `src/exec-graph/README.md`, "No network calls... no process spawning," but concurrent local writers were not an explicit design target | Confirm via `graph verify`; if genuinely corrupted, use the ledger's own JSONL append-only nature to manually excise the interleaved line(s) with a text editor, then step 4 |

## Abort / rollback

- Every step above except step 4 is read-only — safe to abort at any time.
- Step 4 only writes `state/exec-graph/graph.json` (never `ledger.jsonl`).
  If the rebuild produces unexpected output, `git checkout --
  state/exec-graph/graph.json` restores the previous committed snapshot
  (since the directory is git-tracked) — then re-diagnose before retrying.
- `ledger.jsonl` itself is never rewritten by any of these steps — recovery
  cannot lose ledger history.

## Escalation owner

- **Atlas** — first responder for any exec-graph read/write anomaly on the
  local machine (this runbook covers it end to end).
- **External CTO** — if `atlas graph verify` cannot be made to pass after
  following this runbook (i.e. the ledger itself appears structurally
  unrecoverable), or if the drift appears tied to a code change rather than
  an environmental failure.
- **CEO** — only if recovery would require discarding ledger history
  (an irreversible action outside this runbook's scope — do not do this
  without explicit CEO sign-off).
