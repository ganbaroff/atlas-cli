# Runbook: Hand delegation (Hand Contract V0)

**Status of Hand Contract V0:** IMPLEMENTED-LOCAL (tests green — see
`src/__tests__/hands.test.ts`; no live-cloud delegation has been run yet —
delegation is a local CLI flow, same local/cloud boundary as exec-graph
itself, see `docs/architecture/ATLAS-ARCHITECTURE.md`).

## When to use

- A task in `state/exec-graph/` is ready to hand off to a named execution
  target (`sonnet-foreground` or `local-readonly` in V0 — see
  `src/hands/registry.ts`) instead of being worked directly by `atlas`.
- You need to demonstrate or audit the VERIFIED/REJECTED path for a
  delegated task (e.g. a governance/mission review).
- A delegated task is stuck (hand stopped responding / timed out) and
  needs to move sideways to `blocked` without being falsely marked
  `verified`.

## Preconditions

- You are in the ANUS repo root, or have `ATLAS_EXEC_GRAPH_DIR` pointed at
  the correct state directory (same precondition as
  `docs/runbooks/exec-graph-recovery.md`).
- `dist/cli.js` is built (`npm run build`) — or use `npx tsx src/cli.ts
  ...` for a dev-mode equivalent of every command below.
- The task already exists in exec-graph and is at `planned` (the legal
  entry point for `hand assign` — see `src/exec-graph/transitions.ts`'s
  `LEGAL_TRANSITIONS.planned`). If it doesn't exist yet, create it first
  (step 1 below).
- You know which hand you're assigning: `node dist/cli.js hand list`
  prints the full registry (`purpose`, `allowedActions`, `autonomy`,
  `costClass`, etc. for each).

## Exact safe commands (repo-relative)

1. **Create the goal (if it doesn't already exist) and task.**
   ```
   node dist/cli.js goal add "<goal title>"
   node dist/cli.js task add "<task title>" --goal <goal-id> --owner atlas --risk low --source-kind <kind> --source-ref <ref>
   ```
   `--source-kind`/`--source-ref` are optional (default `exec-graph`/`cli`)
   but should be set to something meaningful for provenance (e.g.
   `--source-kind external-cto-brief --source-ref 2026-07-17-mission2`).

2. **Move the task to `planned`** (the only status `hand assign` accepts
   from — see Preconditions):
   ```
   node dist/cli.js task move <task-id> accepted --actor atlas
   node dist/cli.js task move <task-id> planned --actor atlas
   ```

3. **Assign the hand** — moves the task to `delegated` and reassigns owner
   to `hand:<handId>`:
   ```
   node dist/cli.js hand assign <task-id> <hand-id> --actor atlas
   ```
   Add `--unattended` only if this delegation is running with no human
   foreground session watching — `assignHand()` throws `HandContextError`
   if the hand's `autonomy` is `'foreground-only'` (e.g.
   `sonnet-foreground`) and `--unattended` is set; a CEO-supervised hand
   may never be assigned to run unwatched.

4. **Submit the receipt** — moves the task to `evidence-submitted`; this
   step NEVER sets `verified`/`rejected` by itself:
   ```
   node dist/cli.js hand submit <task-id> --by <hand-id> --kind <kind> [--ref <path-or-sha>] [--command "<cmd>"] [--expect "<substring>"] --claim "<narrative>"
   ```
   `--kind` is one of `file-exists` | `commit-exists` | `file-contains` |
   `command-output-match` | `narrative` (the last is always rejected at
   verify time — see step 5). `--ref` is required for
   `file-exists`/`commit-exists`/`file-contains`; `--command` is required
   for `command-output-match` and must match
   `src/hands/verifier.ts`'s `READONLY_COMMAND_ALLOWLIST` (currently:
   `node dist/cli.js graph verify`, `node dist/cli.js graph status`, `git
   log`, `git show`, `git status`, `git rev-parse`, `ls`, `git cat-file` —
   as anchored prefixes); `--expect` is required for `file-contains`/
   `command-output-match` and must be `>=3` meaningful (trimmed)
   characters (`src/hands/contract.ts`'s `receiptSchema`). Never cite a
   `.env`/secret/credential/key-shaped path in `--ref` or `--command` — the
   verifier's protected-path guard refuses it before it's ever opened, and
   `submitReceipt()`'s own secret-shape scan additionally refuses any
   receipt field containing secret-shaped content, before it can reach the
   ledger.

5. **Verify** — the only step that can set `verified`/`rejected`:
   ```
   node dist/cli.js hand verify <task-id> --actor atlas
   ```
   Runs `src/hands/verifier.ts`'s deterministic check against the
   submitted receipt, plus the refuter (`src/hands/refuter.ts`) if the
   re-derived risk class (task title + hand's `allowedActions`, via
   `src/hands/risk.ts`'s `classifyRisk()`) is not `'low'`. Exits 0 with
   `finalStatus: "verified"` on success, exits 1 with `finalStatus:
   "rejected"` and a machine-readable `verdict.reason` on failure — check
   the exit code, don't just eyeball the JSON.

6. **Read the verdict.**
   ```
   node dist/cli.js task show <task-id>
   ```
   Prints the full transition history including the verify step's note
   (`verified: <reason>` or `rejected: <reason>`) and, for
   `evidence-submitted`, the receipt JSON itself (as an evidence entry's
   `note`).

## What VERIFIED vs REJECTED looks like

- **VERIFIED** — `hand verify` exits 0; `task show` shows `"status":
  "verified"`, the final transition's `note` starts with `verified: `
  followed by the primary verifier's reason (e.g. `file exists: <path>` or
  `command output matched expected substring '<substring>'`). If the
  refuter triggered, its `reason` in the JSON output reads `refuter agrees
  with primary verdict (true): ...`.
- **REJECTED** — `hand verify` exits 1; `task show` shows `"status":
  "rejected"`, the final transition's `note` starts with `rejected: `
  followed by either the primary verifier's failure reason (e.g. `file
  <path> does not contain expected substring`) or, if the refuter
  disagreed, `refuter disagreement: <refuter's reason>`. A rejected task
  is NOT automatically closed — it rests at `rejected` until a human
  reviews it (`atlas task move <id> closed --actor <ceo|external-cto|
  atlas>` once reviewed, or `atlas task move <id> proposed --actor ...` to
  retry the whole delegation from scratch — both are legal exits from
  `rejected` per `LEGAL_TRANSITIONS`).

## Abort (timeout / stuck hand) → task returns to blocked

`src/hands/exec-graph-adapter.ts`'s `abortHandTask(taskId, opts)` moves a
`delegated`/`in-progress` task sideways to `blocked` — it NEVER sets
`verified`, so a hand that stops responding is never read as having
succeeded. **Honest gap:** there is no `atlas hand abort` CLI subcommand in
V0 — `abortHandTask()` exists and is tested
(`src/__tests__/hands.test.ts`), but is currently library-only. Until a
CLI wrapper is added, the equivalent recovery for a stuck delegation is the
generic move (safe because the target status is `blocked`, not
`verified`/`rejected`, so it is not gated by `HandAuthorityError` — see
`src/exec-graph/api.ts`'s `moveTask()`):
```
node dist/cli.js task move <task-id> blocked --actor atlas --note "hand task aborted: <reason>"
```
From `blocked`, a task can move back to `in-progress` (retry) or to
`rejected` (give up) per `LEGAL_TRANSITIONS.blocked`.

## Failure symptoms

| Symptom | Likely cause | Fix |
|---|---|---|
| `hand assign` fails with `HandContextError: ... is foreground-only and cannot be assigned in an unattended context` | Assigning `sonnet-foreground` with `--unattended` | Drop `--unattended`, or assign `local-readonly` instead if the work is genuinely read-only and unattended-safe |
| `hand assign` fails with `HandContextError: ... already has an active delegated hand` | Task is already `delegated`/`in-progress` under a different (or the same) hand | `task show <id>` to see the current owner/status; abort (see above) or let the existing delegation resolve first |
| `hand submit` fails with `ReceiptSecretError` | A receipt field (claim/command/ref/expect/artifacts) contains secret-shaped content | Never paste real secret values into a receipt — cite the file/command by name/path only, never its contents |
| `hand submit` fails with schema error on `expectedSubstring` | Substring is empty or `<3` meaningful characters after trim | Use a real, specific expected substring — not a placeholder |
| `hand verify` always rejects a `command-output-match` receipt | Command isn't in `READONLY_COMMAND_ALLOWLIST`, or references a protected path | Use one of the allowlisted read-only commands verbatim (step 4 above); never cite `.env`/secret/key paths |
| `atlas task move <id> verified ...` throws `HandAuthorityError` | Attempting to bypass `hand verify` via the generic CLI on a hand-owned task | Expected and correct (ADR-0006) — use `atlas hand verify <id> --actor <actor>` instead |
| `atlas task reassign <id> hand:<x> ...` throws `HandAuthorityError` | Attempting to create hand ownership via the generic reassign CLI | Expected and correct (ADR-0006) — use `atlas hand assign <id> <hand-id> --actor <actor>` instead |

## Rollback

- Every step through `hand submit` is reversible by continuing the normal
  lifecycle (a rejected verdict is not a dead end — see "What VERIFIED vs
  REJECTED looks like" above).
- `hand verify` itself only ever appends a transition — like every
  exec-graph write, it never rewrites history. If a verdict looks wrong
  because the receipt was wrong (not because the verifier is buggy),
  submit a corrected receipt is not directly possible once
  `evidence-submitted` has resolved to `verified`/`rejected` — move the
  task to `proposed` (from `rejected`) or `escalated` (from either) and
  restart the delegation cleanly rather than trying to patch history.
- If exec-graph state itself looks corrupted (not a delegation-logic
  question), that's `docs/runbooks/exec-graph-recovery.md`'s scope, not
  this runbook's.

## Escalation owner

- **Atlas** — first responder for any Hand Contract delegation question
  (assign/submit/verify mechanics, receipt shape, this runbook end to
  end).
- **CEO / External CTO** — scope decisions: whether a task should be
  delegated at all, whether the two-hand V0 registry needs a third hand,
  whether a `rejected` verdict should be escalated rather than retried.
  This runbook does not cover scope calls — see ADR-0006's "Rollback or
  supersession" for who owns widening the registry.
