# src/hands (Hand Contract V0)

## Purpose

The delegation-control layer over exec-graph: lets a task be handed to a
named **Hand** (a described execution target — e.g. a foreground
CEO-supervised coding session, or a free read-only local inspection agent),
tracks that delegation's evidence, and resolves it to `verified`/`rejected`
by deterministic, falsifiable evidence — never by narrative alone.

## AUTHORITY MODEL (read this before touching anything in this directory)

- **Hands are DESCRIPTIVE metadata only.** A `HandSpec` (`registry.ts`)
  describes what a delegation target is allowed to do — capabilities,
  trust level, allowed/disallowed actions, timeout, abort policy. It is
  **never task state**. Nothing in `registry.ts`, `contract.ts`, `risk.ts`,
  `verifier.ts`, or `refuter.ts` reads or writes `state/exec-graph/` — only
  `exec-graph-adapter.ts` does (see "Structural test" under Tests below).
- **Delegation state lives in exec-graph — there is no second store.**
  Assigning a hand, submitting a receipt, and resolving a verdict are all
  ordinary exec-graph `Task` transitions (`delegated` → `in-progress` →
  `evidence-submitted` → `verified`/`rejected`), recorded in
  `state/exec-graph/ledger.jsonl` exactly like any other task move. A
  hand-owned task is just a `Task` whose `owner` is `hand:<handId>` — there
  is no parallel "delegations" table anywhere in this repo.
- **`verifyAndTransition()` (`exec-graph-adapter.ts`) is THE ONLY place a
  hand-owned task's final state (`verified`/`rejected`) is set.** This is
  enforced twice, not once:
  1. Structurally in this directory — `assignHand()`/`submitReceipt()` only
     ever move a task *forward* (`delegated`, `evidence-submitted`) or
     sideways (`abortHandTask()` → `blocked`); no other function here calls
     `moveTask({ to: 'verified' | 'rejected', ... })`.
  2. **In the exec-graph transition layer itself**
     (`src/exec-graph/api.ts`'s `moveTask()`/`reassignOwner()`), via an
     internal `_viaHandAdapter` capability flag that only
     `exec-graph-adapter.ts` ever sets. See "Generic primitives are now
     hand-aware" below — #2 is the fix for a real bypass found in V0's
     first cut, not defense-in-depth added speculatively.
- **Generic task move/reassign are now hand-aware.** `atlas task move
  <id> verified` (the plain, non-hand CLI path) throws
  `HandAuthorityError` if the target task is hand-owned — a specialized
  safe wrapper (this adapter) is not sufficient on its own if the
  underlying generic primitive (`exec-graph`'s `moveTask`/`reassignOwner`)
  is still willing to do the unsafe thing when called directly. Same for
  `atlas task reassign <id> hand:<x>` — creating `hand:` ownership outside
  `assignHand()` also throws `HandAuthorityError`. See
  `docs/adr/0006-hand-contract-authority.md` for the decision record and
  `docs/architecture/ATLAS-ARCHITECTURE.md`'s LEARN lessons for the
  adversarial-review finding that motivated it.
- **The verifier is deterministic — no LLM, no network.** `verifier.ts`'s
  `verify(receipt)` checks a receipt against real filesystem/git state
  through a fixed set of rules (file exists, file contains substring,
  commit exists, allowlisted read-only command's output contains
  substring). A `narrative`-kind receipt (unverifiable claim, no evidence)
  is always rejected — this is the whole point of the module: a
  plausible-sounding claim and a real receipt must be told apart by
  evidence, not by how convincing the text reads.
- **Receipts are secret-scanned before ledger persistence.**
  `exec-graph-adapter.ts`'s `assertReceiptHasNoSecrets()` runs BEFORE
  `submitReceipt()` writes anything — because the ledger is append-only
  (`state/exec-graph/ledger.jsonl`, ADR-0003), a secret that reaches it is
  permanent, so the guard has to be pre-write, not a post-hoc scrub.
- **The refuter is a deterministic second-check, gated on risk.**
  `refuter.ts`'s `runRefuter()` re-runs `verify()` independently for any
  non-`'low'` `DelegationRiskClass` (`risk.ts`'s `needsRefuter()`) and
  requires it to agree with the primary verdict before a task can be
  marked `verified`. `'low'`-risk delegations skip this — `{triggered:
  false, passed: true}` — so the cheap path never pays the double-verify
  cost. Risk itself is classified by `risk.ts`'s `classifyRisk()`, a fixed
  keyword rule over the task's title + the assigned hand's
  `allowedActions` — **accepted V0 limit:** an obfuscated-malicious
  objective can classify as `'low'` and skip the refuter; not fixed in V0,
  documented here and in ADR-0006's Consequences.

## Module map

| File | Role |
|---|---|
| `registry.ts` | Static `HandSpec` registry — exactly two Hands in V0 (`sonnet-foreground`, `local-readonly`). Descriptive config, no state. |
| `contract.ts` | `DelegationBrief` / `Receipt` zod schemas + `receiptHash()` (the idempotency key `submitReceipt()` uses). |
| `risk.ts` | `classifyRisk()` — deterministic keyword classifier over objective + allowedActions; `needsRefuter()`. |
| `verifier.ts` | `verify(receipt)` — the deterministic, no-LLM, no-network evidence checker. |
| `refuter.ts` | `runRefuter()` — independent second `verify()` call for non-`low` risk, gating the final verdict. |
| `exec-graph-adapter.ts` | The ONLY bridge into exec-graph — `assignHand()`, `submitReceipt()`, `abortHandTask()`, `verifyAndTransition()`. |

## Inputs / outputs

- **Inputs:** `assignHand`, `submitReceipt`, `abortHandTask`,
  `verifyAndTransition` (see `exec-graph-adapter.ts`) — or the `atlas hand
  list` / `atlas hand assign` / `atlas hand submit` / `atlas hand verify`
  CLI commands in `src/cli.ts`.
- **Outputs:** each function returns the resulting exec-graph `Task`
  (`verifyAndTransition` also returns the verdict: `{verified, reason,
  refuter}`). `atlas hand list` prints the static registry
  (`registry.ts`'s `listHands()`).

## State it reads/writes

Same two files as exec-graph itself (`src/exec-graph/README.md`) —
`state/exec-graph/ledger.jsonl` (append) and `state/exec-graph/graph.json`
(derived snapshot) — written exclusively through
`src/exec-graph/api.ts`'s exported functions, never touched directly by
anything in `src/hands/`. No file, directory, or store exists under
`src/hands/` itself for delegation state — see "Delegation state lives in
exec-graph" above.

## Failure behavior

- `assignHand()` throws `HandContextError` (unattended/foreground-only
  mismatch, disallowed action, or an already-active hand delegation) or
  `HandAdapterError` (unknown task).
- `submitReceipt()` throws `ReceiptTaskMismatchError` (receipt.taskId
  doesn't match the task submitted to), `ReceiptSecretError`
  (secret-shaped content in any free-text field), or `HandAdapterError`
  (unknown task). Re-submitting an identical receipt (same
  `receiptHash()`) is a no-op, not an error.
- `abortHandTask()` throws `HandAdapterError` if the task isn't
  `delegated`/`in-progress`. It only ever moves a task to `blocked` — never
  `verified`, so a stuck/unresponsive hand can never be read as having
  succeeded.
- `verifyAndTransition()` throws `HandAdapterError` if the task isn't
  `evidence-submitted`. It never throws on a bad receipt or a failed
  verdict — those resolve to a `rejected` transition with a
  machine-readable reason, not an exception.
- `verify()` (verifier.ts) NEVER throws — every fs/git/process failure
  becomes `{verified: false, reason: <message>}` (mirrors
  `exec-graph/ledger.ts`'s "reads never throw" rule).
- Generic exec-graph primitives called on a hand-owned task outside this
  adapter throw `HandAuthorityError` (`src/exec-graph/api.ts`) — see
  "Generic primitives are now hand-aware" above.

## Security

- No secrets, no network calls, no LLM calls anywhere in `src/hands/`.
- Receipts are secret-scanned (`SECRET_SHAPE_PATTERNS` in
  `exec-graph-adapter.ts`) before persistence — see AUTHORITY MODEL above.
- `verifier.ts`'s protected-path guard refuses to read/cite
  `.env`/secret/credential/key-shaped paths, checked against both the
  `ref` field and (for `command-output-match`) the whole command string.
- `verifier.ts`'s command allowlist only ever runs a fixed set of
  read-only prefixes via `execFileSync` (never a shell) — no command
  injection surface even for an allowlisted command.
- `registry.ts`'s `getHand()` rejects dunder-key (`__proto__`/
  `constructor`/`prototype`) lookups, mirroring `exec-graph/ledger.ts`'s
  `isSafeKey()`.

## Tests

`src/__tests__/hands.test.ts` — full assign/submit/verify/abort lifecycle
per Hand, idempotent resubmission, receipt schema invariants
(`expectedSubstring` minimum-meaningful-length guard), the structural test
(reads every file's own source to assert only `exec-graph-adapter.ts`
imports `exec-graph/api.js`), refuter triggering per `riskClass` (describe
block 10), the `HandAuthorityError` sibling-CLI-bypass regression (block
16), and the secret-guard regression — a receipt with secret-shaped content
never reaches the verifier or the ledger (block 17).

## Upstream / downstream

- **Upstream (imports from):** `src/exec-graph/api.ts` and
  `src/exec-graph/contracts.ts` (`exec-graph-adapter.ts` only), `node:*`
  builtins, `zod`. No other in-repo module.
- **Downstream (imported by):** `src/cli.ts` (`hand list`/`assign`/
  `submit`/`verify` commands). Nothing else in this repo calls into
  `src/hands/`.

## Links

- `docs/adr/0006-hand-contract-authority.md` — the authority-model decision
  record.
- `docs/runbooks/hand-delegation.md` — exact operational commands, VERIFIED
  vs REJECTED, abort, rollback.
- `docs/architecture/ATLAS-ARCHITECTURE.md` — Hand Contract layer in the
  component/authority maps + LEARN lessons.
- `src/exec-graph/README.md` — the underlying task-lifecycle module this
  layer delegates through.
- `docs/adr/0001-one-task-authority-exec-graph.md`,
  `docs/adr/0002-volaura-intent-vs-anus-execution-state.md` — exec-graph's
  own authority model, which this layer does not alter.
