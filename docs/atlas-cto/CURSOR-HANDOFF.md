# Cursor Handoff

> Standing end-of-session ritual. Replaced each session. Cursor seat.

## 1. Date, branch, HEAD

- Date: 2026-08-06
- Repo: `C:/Users/user/OneDrive/Documents/GitHub/ANUS`
- Worktree: `.worktrees/p1b-spend-cap`
- Branch: `codex/p1b-spend-cap`
- HEAD after the P1-B provider-invocation-idempotency repair commit:

```
$ git log -1 --oneline
0d2a618 fix(spend): durable provider-invocation claim — one requestId, at most one invocation
```

Started from `6f07a5d` (the P1-B wave-2 HEAD this repair envelope was scoped
against). Not pushed. All work happened in this isolated worktree; no
changes on any other branch or checkout. This was a BOUNDED REPAIR — no
pause/PANIC, no courier, no Planning, no model-router/mastra-agent wiring,
no telegram, no adapters, no Integronix, no scope expansion beyond
`src/atlas/spend/`, `src/__tests__/`, and this pair of docs.

## 2. Files changed — one line each

- `src/atlas/spend/types.ts` (MODIFIED) — `SPEND_SCHEMA_VERSION` bumped
  1 -> 2; `SPEND_STATUSES` gains `INVOCATION_STARTED` between `RESERVED`
  and `COMMITTED`; `spendRecordSchema`/`spendDayFileSchema`'s
  `schemaVersion` field now accepts EITHER 1 or 2 (`z.union` of the two
  literals) so a pre-existing v1 day file still parses without crashing —
  fail-closed corruption handling (`SpendStateCorruptError`) is unchanged
  and unaffected. New optional record fields: `invocationClaimedAt`
  (ISO timestamp), `invocationClaimToken` (audit trail only, never itself
  an authority), `committedResult` (the provider's result payload, stored
  so a replay of an already-COMMITTED requestId can return it without
  re-invoking the provider).
- `src/atlas/spend/ledger.ts` (MODIFIED) — new exported
  `claimProviderInvocation()`: the core fix. Runs inside the SAME
  `withLedgerLock` day-file lock `reserve()`/`commit()` already use; loads
  the record fresh from disk, verifies its own `integrityHash`
  (`verifyRecordIntegrity`), then atomically compare-and-sets
  `RESERVED -> INVOCATION_STARTED` via the existing
  `writeDayFileAtomically` (open(wx)+write+fsync+rename), returning
  `outcome: 'claimed'` ONLY to the caller that performed that CAS. Any
  other observed status refuses: `COMMITTED` -> `outcome: 'replay'` (no
  mutation, no re-invocation); `INVOCATION_STARTED` ->
  `reason: 'invocation_in_progress'`; `PENDING_RECONCILIATION` ->
  `reason: 'pending_reconciliation'`; `RELEASED`/`REJECTED` ->
  `reason: 'terminal'`; failed integrity check ->
  `reason: 'integrity_violation'`. `computeDailyTotalMinor()` now also
  counts `INVOCATION_STARTED` records at `reservedMinor` (same as
  `RESERVED`/`PENDING_RECONCILIATION` — worst case, assume it was
  charged). `commit()` now also accepts `INVOCATION_STARTED` as a valid
  source status (in addition to `RESERVED`/`PENDING_RECONCILIATION`) and
  takes an optional `resultForReplay` to persist as `committedResult`
  (only added to the sealed record when a real value is supplied — never
  as an explicit `undefined` key, which would silently break
  `verifyRecordIntegrity()` on the next read via `JSON.stringify`'s
  undefined-key-dropping behaviour). `markPendingReconciliation()` now
  also accepts `INVOCATION_STARTED` as a valid source status (in addition
  to `RESERVED`) — this is the ONLY sanctioned, EXPLICIT path out of a
  stuck `INVOCATION_STARTED` claim; nothing in this file transitions it
  automatically.
- `src/atlas/spend/preflight.ts` (MODIFIED) — `runSpendPreflight()` now
  calls `claimProviderInvocation()` AFTER `reserve()` and BEFORE
  `input.invokeProvider()`, and gates strictly on its result rather than
  on `reserveResult.idempotent` (the root cause: an idempotent
  reservation could already be COMMITTED/INVOCATION_STARTED/
  PENDING_RECONCILIATION, none of which permit a second invocation).
  `SpendPreflightVerdict`'s `ok: true` branch gains `idempotentReplay:
  boolean`; new `ok: false` reasons `invocation_in_progress`,
  `pending_reconciliation`, `terminal_request_id`, `integrity_violation`
  alongside the pre-existing `work_order_scope_denied`, `cap_exceeded`,
  `state_unavailable`, `provider_invocation_failed` (all pre-existing
  reason strings and their payload shapes are unchanged — this is an
  additive change to the verdict union).
- `src/atlas/spend/index.ts` (MODIFIED) — exports `claimProviderInvocation`
  plus its `ClaimProviderInvocationInput`/`ClaimProviderInvocationResult`
  types.
- `src/__tests__/spend-provider-idempotency.test.ts` (NEW) — 16 tests: 12
  named invariant proofs (replay-of-COMMITTED, replay-after-restart,
  concurrent-duplicate, crash-mid-invocation, PENDING_RECONCILIATION
  blocks retry, unresolved charge reduces headroom, RELEASED is terminal,
  new requestId works normally, tampered COMMITTED record deterministic
  REJECT, requestId identity immutable, provider exception preserves
  state, zero-cost path still idempotent); 2 source-scan tests (no
  in-memory `Set`, no `alreadyCalled`, no `process.env`, no ad hoc
  invocation counter, no `.has(requestId)` membership check anywhere in
  `ledger.ts`/`preflight.ts`) plus 1 structural test (the durable claim
  write textually precedes the `invokeProvider()` call in
  `preflight.ts`); and a live proof (`P1-B repair — live
  provider-invocation-idempotency proof`) spawning real child `node`
  processes for both the restart case and the true-concurrency case (see
  §3 for the evidence pack path).
- `docs/atlas-cto/MISSION-BOARD.md` (MODIFIED, debt row only) — added
  `P1-DEBT-05` (this defect, flagged-but-not-yet-tracked in the P1-B
  wave-2 handoff's "Known risks" section) as CLOSED with this commit SHA.
- `docs/atlas-cto/CURSOR-HANDOFF.md` (this file, replaced).

Not touched, deliberately: `override.ts`, `accounting-day.ts`, `store.ts`
(the atomic-write/lock primitives were already correct and are reused
as-is — no new lock mechanism, no second ledger file), `release()` (not
extended to accept `INVOCATION_STARTED` — no call path in this repo
currently needs it, and extending it untested would be scope creep beyond
the named defect).

## 3. Receipts — exact commands, output, exit codes

Focused, run TWICE:
```
$ node node_modules/vitest/vitest.mjs run src/__tests__/spend-durable.test.ts src/__tests__/spend-override-and-proof.test.ts src/__tests__/spend-provider-idempotency.test.ts
Run 1: Test Files  3 passed (3) | Tests  60 passed (60) | exit 0
Run 2: Test Files  3 passed (3) | Tests  60 passed (60) | exit 0
```
Both runs printed a fresh, differently-timestamped live-proof evidence pack:
- Run 1: `C:\Users\user\.atlas\quarantine\evidence\p1b-idem-2026-08-06T12-21-07-843Z-0cb24655`
- Run 2: `C:\Users\user\.atlas\quarantine\evidence\p1b-idem-2026-08-06T12-21-29-230Z-c408376f`

(both preserved on disk, both verified to contain all 8 expected claim
kinds from the new live proof: `genesis`, `a-invoke-and-commit`,
`a-replay-in-process`, `a-restart-boundary-and-replay`,
`b-concurrent-real-processes`, `c-crash-then-reconciliation`,
`tamper-copy-deterministic-reject`, `final-ledger-total`,
`cleanup-result` — 9 kinds total.)

Full suite, run ONCE:
```
$ node node_modules/vitest/vitest.mjs run
Test Files  2 failed | 156 passed (158)
     Tests  3 failed | 1589 passed | 12 skipped (1604)
exit 1
```
Baseline at `6f07a5d` was `3 failed | 1573 passed | 12 skipped (1588)`, exit
1. Delta: **+16 passed** (exactly the new `spend-provider-idempotency.test.ts`
count), **0 new failures**, **skipped unchanged at 12**. The 3 failures are
the SAME pre-existing ones as baseline — `npx tsup` not found on this host's
PATH inside vitest's child-process context
(`m10-install-lifecycle.test.ts` × 3: install/upgrade/rollback). Never
called green while exit was 1 — reporting exit 1 here honestly, the diff
against baseline is the acceptance evidence.

Typecheck:
```
$ node node_modules/typescript/bin/tsc --noEmit
src/__tests__/runner-health-no-claim.test.ts(390,13): error TS2352 ...
src/__tests__/runner-health-no-claim.test.ts(396,77): error TS2352 ...
src/courier/courier-loop.ts(549,23): error TS2367 ...
exit code: 2
```
Baseline was 3 pre-existing errors in these same two files. Count UNCHANGED
(3 → 3), same files, same error codes. None of this repair's files
(`types.ts`, `ledger.ts`, `preflight.ts`, `index.ts`,
`spend-provider-idempotency.test.ts`) appear anywhere in the typecheck
output.

Commit:
```
$ git show --stat HEAD
0d2a618 fix(spend): durable provider-invocation claim — one requestId, at most one invocation
 src/__tests__/spend-provider-idempotency.test.ts | 728 +++++++++++++++++++++++
 src/atlas/spend/index.ts                         |   3 +
 src/atlas/spend/ledger.ts                        | 187 +++-
 src/atlas/spend/preflight.ts                     | 100 +++-
 src/atlas/spend/types.ts                         |  37 +-
 5 files changed, 1018 insertions(+), 37 deletions(-)
```

## 4. Known risks / broken items

- `release()` was deliberately NOT extended to accept `INVOCATION_STARTED`
  as a source status. In this repair's design, `preflight.ts` never calls
  `release()` after a successful claim (only `commit()` on success or
  `markPendingReconciliation()` on a thrown exception) — so no code path
  in this repo can currently produce an `INVOCATION_STARTED -> RELEASED`
  transition, and it would have been untested scope creep to add one
  speculatively. If a future caller needs to cleanly abandon a claimed-but-
  not-yet-invoked reservation (e.g. a synchronous validation failure
  between claim and invoke), `release()` will need this extension then.
- The reconciliation path (`markPendingReconciliation()` on an
  `INVOCATION_STARTED` record) is, by design, EXPLICIT-only — there is no
  automatic sweep or TTL detection anywhere in this repair. This is the
  same shape as the pre-existing `RESERVED -> PENDING_RECONCILIATION` gap
  already tracked as `P1-DEBT-04` ("No automatic TTL detection of stale
  RESERVED spend records") — that debt's scope now also covers stale
  `INVOCATION_STARTED` records left by a crashed invoker. Not closed by
  this repair; not this repair's mission.
- `invocationClaimToken` is audit-trail only (a `pid:<pid>:<uuid>` string
  by default) — it is never consulted as an authority anywhere in the
  code (the persisted `status` field alone gates every decision). This
  means there is currently no way to tell, from the record alone, whether
  the process that holds an `INVOCATION_STARTED` claim is still alive —
  that determination is left entirely to whatever calls
  `markPendingReconciliation()` (an operator, or a future TTL sweep under
  `P1-DEBT-04`).
- `committedResult` stores the provider's raw result payload verbatim in
  the day-file JSON. For a provider whose result payload is large or
  contains sensitive content, this grows the ledger file and could leak
  that content into `.atlas` state directories. No size cap or redaction
  was added — out of this repair's bounded scope; flag for whoever wires
  a real provider adapter in (`P1-DEBT-03`).
- `npx tsup` PATH resolution failure (pre-existing, out of this repair's
  allowed-files scope) still blocks `m10-install-lifecycle.test.ts` (×3) —
  unchanged from baseline.
- The new live-proof test writes a real evidence pack to
  `$HOME/.atlas/quarantine/evidence/p1b-idem-<timestamp>-<random>/` on
  every run (by design, matching the P1-B wave-2 live proof's own
  convention). These accumulate and are not auto-pruned — same
  accumulation pattern already flagged for the wave-2 live proof; still
  no retention policy.
- This repair does NOT change `P1-DEBT-02` (four provider call sites that
  bypass the spend gate entirely) or `P1-DEBT-03` (spend module not wired
  into any real call path yet) — `runSpendPreflight()` is more correct
  now, but still has zero real callers in production code. The cap/claim
  machinery remains fully built and tested in isolation, not yet
  load-bearing.

## 5. Next three steps

1. Orchestrator verification of this repair — confirm the
   `claimProviderInvocation()` state machine, the `preflight.ts` wiring
   order (claim strictly before invoke), and the live proof's real
   child-process concurrency against the mission spec.
2. Decide `P1-DEBT-04`'s scope expansion (stale `INVOCATION_STARTED`
   alongside stale `RESERVED`) and whether it becomes the next scoped
   repair, or folds into `P1-DEBT-03`'s real-call-path wiring work (which
   is also where `claimProviderInvocation()` gets its first non-test
   caller and a real TTL/reconciliation sweep would first matter).
3. No further scope expansion in this worktree without a new mission —
   this was a bounded repair (max one repair cycle per item, single
   worker, no sub-agents).

## 6. Blockers for CEO / orchestrator

- None block closing this repair — the durable invocation-claim mechanism,
  its replay/restart/concurrency/crash/tamper semantics, and the live
  proof are done and verified twice (focused) plus once each (full suite,
  typecheck) with real receipts above, all showing zero regressions
  against the `6f07a5d` baseline.
- Open, non-blocking note (unchanged from the P1-B wave-2 handoff):
  `P1-DEBT-02` (four provider call sites that bypass the spend gate
  entirely) and `P1-DEBT-03` (spend module not wired into the real call
  path at all yet) mean the cap/claim/override machinery built across all
  P1-B work enforces nothing in production today. Recommend `P1-DEBT-03`
  + `P1-DEBT-02` become the next scoped mission before any further
  spend-module feature work.
