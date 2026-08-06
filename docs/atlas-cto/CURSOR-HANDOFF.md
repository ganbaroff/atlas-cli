# Cursor Handoff

> Standing end-of-session ritual. Replaced each session. Cursor seat.

## 1. Date, branch, HEAD

- Date: 2026-08-06
- Repo: `C:/Users/user/OneDrive/Documents/GitHub/ANUS`
- Worktree: `.worktrees/p1b-spend-cap`
- Branch: `codex/p1b-spend-cap`
- HEAD after the wave-2 code commit:

```
$ git log -1 --oneline
671a6cb feat(spend): bounded CEO override, tamper rejection, lease-to-mutation binding (P1-DEBT-01)
```

Started from wave-1 HEAD `a059a45` (restart-durable atomic spend ledger,
21/21 tests, orchestrator-verified). Not pushed. All work happened in this
isolated worktree; no changes on any other branch or checkout.

## 2. Files changed — one line each

- `src/atlas/work-order/executor-gate.ts` (MODIFIED) — P1-DEBT-01 close: added `runExecutorGateMutation()`, a second gate taking the caller's `mutate()` callback directly; it re-validates lease ownership (workOrderId, missionId, executor identity, repo canonical path) **and** `leaseExpiresAt` (a check the original `runExecutorGate()` never had) freshly from disk via `getRepoWriterLeaseInfo()` as the last statement before invoking `mutate()`, so no caller-controlled code can run in the gap; also checks the caller-supplied `authorizedWorkOrderHash` against a fresh `hashPayload(signed)` to bind the mutation call to the exact envelope an earlier `runExecutorGate()` authorized. Added two new `ExecutorGateFailureReason` values: `lease_lost_before_mutation`, `work_order_hash_mismatch`. No `leaseHeld`-style boolean parameter exists anywhere — confirmed absent, not merely undocumented.
- `src/atlas/spend/override.ts` (NEW) — bounded CEO spend-cap override: `CeoOverride`/`SignedCeoOverride` types, `signCeoOverride()`/`checkCeoOverrideSignature()` reusing `work-order/sign.ts`'s HMAC signer/verifier (no second signing key — same `ATLAS_WORK_ORDER_SIGNING_KEY`), and `resolveEffectiveDailyCapMinor()` which returns the unmodified base cap unless handed a validly-signed, unexpired, in-scope (mission/provider/work-order) override, in which case it adds *exactly* that override's declared amount. Pure module — no `node:fs`, no env reads, no reset/bypass/debug path of any kind (asserted by a source-scan test).
- `src/atlas/spend/index.ts` (MODIFIED) — re-exports `override.ts`'s public surface (types + `signCeoOverride`/`checkCeoOverrideSignature`/`resolveEffectiveDailyCapMinor`/constants/errors).
- `src/__tests__/spend-override-and-proof.test.ts` (NEW) — 23 tests: 2 source-scan tests proving override.ts has no bypass/debug/reset/env escape hatch; test 15 (5 cases) executor cannot reset its own spend; test 16 (3 cases) unsigned override rejected; test 17 (2 cases) expired override rejected; test 18 (4 cases) bounded override scope enforcement (mission/provider/amount); test 19 (1 case) receipt binds requestId+workOrderId+state hash; test 20 (1 case) tampered receipt deterministic REJECT; test 23 (4 cases) P1-DEBT-01 lease loss/replacement/expiry before mutation, plus the happy path; and the Task-4 live bounded proof (1 case, see §3).
- `docs/atlas-cto/MISSION-BOARD.md` (MODIFIED) — added standing-debt rows P1-DEBT-01 (CLOSED, this commit) through P1-DEBT-04 (all OPEN, per the mission's exact wording and call sites).
- `docs/atlas-cto/CURSOR-HANDOFF.md` (this file, replaced).

Not touched, deliberately: `src/atlas/work-order/repo-writer-lock.ts`, `src/atlas/work-order/index.ts`, `src/atlas/work-order/types.ts`, `src/atlas/state-writer-inventory.ts` (override.ts imports no `node:fs`, so the structural writer-inventory sweep does not flag it — verified by `state-writer-inventory.test.ts` passing unchanged in the regression run below).

## 3. Receipts — exact commands, output, exit codes

Focused, run TWICE:
```
$ node node_modules/vitest/vitest.mjs run src/__tests__/spend-durable.test.ts src/__tests__/spend-override-and-proof.test.ts
Run 1: Test Files  2 passed (2) | Tests  44 passed (44) | exit 0
Run 2: Test Files  2 passed (2) | Tests  44 passed (44) | exit 0
```
Both runs printed the live-proof evidence pack path, e.g.:
- Run 1: `C:\Users\user\.atlas\quarantine\evidence\p1b-live-2026-08-06T11-36-07-195Z-66c4391b`
- Run 2: `C:\Users\user\.atlas\quarantine\evidence\p1b-live-2026-08-06T11-36-39-223Z-3088c6c1`

(a fresh, differently-timestamped pack each run — both preserved on disk, both
verified to contain all 11 expected claim kinds: `initial-state-hash`,
`reservation-and-commit`, `restart-boundary`, `cap-decision`,
`rejected-request`, `replay-evidence`, `tamper-evidence`,
`final-ledger-total`, `work-order-gate-reject` (automatic, from the
mutation-gate reject), `lease-to-mutation-binding`, `cleanup-result`.)

Regression, run ONCE:
```
$ node node_modules/vitest/vitest.mjs run src/__tests__/work-order-envelope.test.ts src/__tests__/work-order-gate.test.ts src/__tests__/state-writer-inventory.test.ts src/__tests__/cost-router-classify.test.ts src/__tests__/cost-router-clearance.test.ts src/__tests__/cost-router-error-policy.test.ts src/__tests__/cost-router-m2d-integration.test.ts src/__tests__/cost-router-seam-boundary.test.ts src/__tests__/cost-router-state.test.ts src/__tests__/m6-spend-receipt.test.ts src/__tests__/model-router.test.ts src/__tests__/spend-policy.test.ts src/__tests__/spend-rehydrate.test.ts src/__tests__/spend-tracker.test.ts
Test Files  14 passed (14) | Tests  175 passed (175) | exit 0
```
`work-order-gate.test.ts` passing unchanged confirms `runExecutorGate()`
itself was NOT modified — only a new sibling function was added.
`state-writer-inventory.test.ts` passing confirms `override.ts` correctly
needs no writer-inventory registration (it has no `node:fs` import at all).

Full suite, run ONCE:
```
$ node node_modules/vitest/vitest.mjs run
Test Files  2 failed | 155 passed (157)
     Tests  3 failed | 1573 passed | 12 skipped (1588)
exit 1
```
Baseline at `a059a45` was `3 failed | 1550 passed | 12 skipped (1565)`, exit
1. Delta: **+23 passed** (exactly the new `spend-override-and-proof.test.ts`
count), **0 new failures**, **skipped unchanged at 12**. The 3 failures are
the SAME pre-existing ones as baseline — `npx tsup` not found on this host's
PATH inside vitest's child-process context (`m10-install-lifecycle.test.ts`
× 3: install/upgrade/rollback); `integration/e2e-binary.test.ts` fails its
own `beforeAll` tsup build for the same reason (its tests are inside the
unchanged 12 skipped, not failed). Never called green while exit was 1 —
reporting exit 1 here honestly, diff against baseline is the acceptance
evidence.

Typecheck:
```
$ node node_modules/typescript/bin/tsc --noEmit
src/__tests__/runner-health-no-claim.test.ts(390,13): error TS2352 ...
src/__tests__/runner-health-no-claim.test.ts(396,77): error TS2352 ...
src/courier/courier-loop.ts(549,23): error TS2367 ...
exit code: 2
```
Baseline was 3 pre-existing errors in these same two files. Count UNCHANGED
(3 → 3), same files, same error codes. None of this wave's files
(`executor-gate.ts`, `override.ts`, `spend/index.ts`,
`spend-override-and-proof.test.ts`) appear anywhere in the typecheck output.

Commit:
```
$ git show --stat HEAD
671a6cb feat(spend): bounded CEO override, tamper rejection, lease-to-mutation binding (P1-DEBT-01)
 src/__tests__/spend-override-and-proof.test.ts | 1077 ++++++++++++++++++++++++
 src/atlas/spend/index.ts                       |   21 +
 src/atlas/spend/override.ts                    |  291 +++++++
 src/atlas/work-order/executor-gate.ts          |  135 ++-
 4 files changed, 1523 insertions(+), 1 deletion(-)
```

## 4. Known risks / broken items

- `runExecutorGateMutation()` closes the gap to ZERO JS ticks (the fresh
  `getRepoWriterLeaseInfo()` read and the call to `mutate()` are consecutive
  statements in one synchronous function — nothing caller-controlled can run
  between them, and Node's single-threaded execution rules out same-process
  interleaving). It does NOT close the gap to true cross-process atomicity: a
  different OS process could, in principle, still mutate the lease file in
  the microseconds between this function's read and the caller's own fs
  write inside its `mutate()` callback. Full atomicity would require this
  function to hold `repo-writer-lock.ts`'s own file lock across the caller's
  arbitrary mutation — a bigger redesign this wave deliberately avoided
  (`repo-writer-lock.ts` was out of the allowed-files scope). Residual risk,
  not a known-broken item — no test in this repo could currently trigger it,
  since nothing wires `runExecutorGateMutation()` into a real concurrent
  execution path yet (P1-DEBT-03).
- P1-B wave-1's `preflight.ts` (unmodified this wave) invokes the provider
  port again on a REPLAYED request whose reservation had already reached
  `COMMITTED` status via `runSpendPreflight()` specifically (not via plain
  `reserve()`/`commit()`, which ARE fully idempotent and never double-charge
  the ledger). The ledger itself is never double-charged either way — `
  commit()`'s idempotency guarantees that — but a REAL provider adapter
  sitting behind `invokeProvider` would receive a second, wasted call on
  replay through the preflight path specifically. Observed while building
  the Task-4 live proof (which deliberately used raw `reserve()`/`commit()`
  for its replay step to avoid this, and used a hand-rolled
  reserve-then-maybe-invoke helper elsewhere instead of `runSpendPreflight()`
  to keep the fake-provider-invocation-count proof unambiguous). Not one of
  the mission's four named debts; flagging here rather than inventing a
  fifth unilaterally — recommend CEO/orchestrator decide whether this
  becomes P1-DEBT-05 or folds into P1-DEBT-03's wiring work.
- Standing risk carried over from P1-A wave 2 (CURSOR-HANDOFF.md history):
  `RepoWriterLease`'s 20-minute default TTL has no automatic background
  heartbeat; still not wired into any scheduler. Unrelated to this wave's
  changes, still open.
- `npx tsup` PATH resolution failure (pre-existing, out of this wave's
  allowed-files scope) still blocks `m10-install-lifecycle.test.ts` (×3) and
  `e2e-binary.test.ts`'s skipped tests — unchanged from baseline.
- The Task-4 live-proof test writes a real evidence pack to
  `$HOME/.atlas/quarantine/evidence/p1b-live-<timestamp>-<random>/` on every
  run (by design). These accumulate and are not auto-pruned — same
  accumulation pattern already flagged for the P1-A live proof; still no
  retention policy.

## 5. Next three steps

1. Orchestrator verification of P1-B wave 2 (this handoff) — confirm
   `runExecutorGateMutation()`'s lease re-validation, the CEO override
   boundary (`override.ts`), and the live bounded proof against the mission
   spec before anything wires into a real execution path.
2. Wire the spend module into the real call path — P1-DEBT-03
   (`model-router.ts` / `mastra-agent.ts`), the largest open item left by
   both P1-B waves; this is also where `runExecutorGateMutation()` gets its
   first real (non-test) caller.
3. Pause / PANIC — no further scope expansion in this worktree without a new
   mission.

## 6. Blockers for CEO / orchestrator

- None block closing this wave — Task 1 (P1-DEBT-01), Task 2/3 (CEO override
  boundary + tests), and Task 4 (live bounded proof) are done and verified
  twice (focused) plus once each (regression, full suite, typecheck) with
  real receipts above, all showing zero regressions against the `a059a45`
  baseline.
- Open, non-blocking note: P1-DEBT-02 (four provider call sites that bypass
  the spend gate entirely — `telegram-capability.ts:89`,
  `tools/surf.ts:227`, `atlas/emotion.ts:243`, `goal-runner/red-line.ts:292`)
  and P1-DEBT-03 (spend module not wired into the real call path at all yet)
  mean the cap/override machinery built across both P1-B waves enforces
  nothing in production today — it is fully built and tested in isolation,
  not yet load-bearing. Recommend P1-DEBT-03 + P1-DEBT-02 become the next
  scoped mission before any further spend-module feature work.
