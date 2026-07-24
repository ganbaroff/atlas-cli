# Runbook — swarm-exec (honest swarm runs verified through exec-graph)

_What this is: how to run a bounded, honestly-verified swarm task and read its verdict. Authority model + rationale: ADR-0007._

## The one-line mental model
CEO intent → **draft** → **exec-graph task** → **delegated swarm run** → **durable bundle** → **deterministic verifier** → **VERIFIED / REJECTED**. The swarm never declares its own success — only `hands/verifier.ts` (via `verifyAndTransition`) sets the final state, by independently re-reading the committed `bundle.json`.

## Run it (3 steps)
```bash
# 1. Compile freeform intent into a draft (does NOT create a task, does NOT run anything)
node dist/cli.js swarm-exec intake "your task in plain words"
#   -> prints draftId (dft_...) + the structured draft

# 2. Commit the draft into an exec-graph task (explicit confirmation step)
node dist/cli.js swarm-exec commit <draftId>          # --goal <id> to attach to an existing goal
#   -> prints taskId (tsk_...) + goalId

# 3. Assign swarm-local + run + verify through the deterministic verifier
node dist/cli.js swarm-exec run <taskId>
#   -> prints status: verified | rejected | blocked, runId, bundlePath, reason
```
Raw natural language never auto-executes: there is no path from `intake` straight to a run — `commit` (step 2) is mandatory.

## Control (single control path)
The executor honors the same control state `atlas control` writes (`operator/state/operator-state.json`):
```bash
node dist/cli.js control pause     # a run started while paused/stopped -> 'blocked', NEVER 'verified'
node dist/cli.js control resume    # back to active
node dist/cli.js control validate  # state hygiene report
```
A paused/stopped run can never become VERIFIED from stale output — it is aborted to `blocked` before the swarm is even called.

## Where the evidence lands
- **Run bundle:** `state/swarm-runs/<runId>/bundle.json` (+ `result.json`, `trace.jsonl`, `provider-health.json`, `evidence-manifest.json`, `responder-summary.json`).
  - `bundle.json` is written **last**; if it's absent or `complete !== true`, the run is visibly incomplete (a crash never looks done).
  - `proof` field = `SWARM-VERIFIED:<runId>` **iff** the honest completion verdict is `done`; otherwise `SWARM-REJECTED:<runId>`.
- **Draft:** `state/intake-drafts/<draftId>.json`.
- **Task:** the exec-graph ledger — `node dist/cli.js task show <taskId>` (status = verified/rejected/blocked), `node dist/cli.js graph verify`.

## How to read a verdict
- `status: verified` → `bundle.json` carries `SWARM-VERIFIED:<runId>`, enough responders returned OK, all policy gates passed, and the deterministic file-contains check confirmed the token. Task is `verified` in the graph.
- `status: rejected` → honest failure. Check `completion.reason` in `bundle.json` (`no_responders_ok`, `failure_budget_exceeded`, `insufficient_responders`, `no_evidence_tokens`, `evaluator_not_passed`, `promotion_not_passed`, `no_policy_fail_closed`, `jidoka_violation`). A rejection is a correct outcome, not a bug — the system refused to fabricate success.
- `status: blocked` → control was paused/stopped, or the swarm run threw (`control_not_active` / `swarm_run_error`). No bundle. Resume control and re-run.

## Knobs
- `ATLAS_SWARM_WORKER_TIMEOUT_MS` — per-worker wall-clock bound (default 60000). A hung/slow provider becomes a fast `worker_timeout_<ms>ms` error result instead of blocking the whole run.
- `ATLAS_DAILY_TOKEN_CAP` — set a spend cap **before** any real run (non-negotiable).
- `ATLAS_EXEC_GRAPH_DIR` — point at a scratch dir to run without touching the canonical ledger (used for smokes).

## Honest completion policy (what makes a run 'done')
`evaluateCompletion()` is deterministic and fail-closed:
- a failed provider (any `error`) is **never** counted OK — re-derived from evidence, never from the caller's `ok` flag;
- missing/invalid policy → `failed` (never a silent pass);
- gates: `requiredResponders`, `failureBudget`, `requireEvidenceTokens`, `requireEvaluator`, `requirePromotion`; first-failing gate wins the reason.

## Known limitation
After a run where **all** workers time out, the CLI process may not exit promptly — abandoned provider sockets keep the event loop alive. The verdict and bundle are already persisted before this; `Ctrl-C` is safe. Follow-up: a `process.exit` guard in the `swarm-exec run` action.
