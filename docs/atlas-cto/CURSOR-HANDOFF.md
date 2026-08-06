# Cursor Handoff

> Standing end-of-session ritual. Replaced each session. Cursor seat.

## 1. Date, branch, HEAD

- Date: 2026-08-06
- Repo: `C:/Users/user/OneDrive/Documents/GitHub/ANUS`
- Worktree: `.worktrees/p1a-work-orders`
- Branch: `codex/p1a-work-orders`
- HEAD after the wave-2 code commit:

```
$ git log -1 --oneline
ad5153f feat(work-order): RepoWriterLease + executor gate for P1-A wave 2
```

Started from wave-1 HEAD `45b303e` (signed work-order envelope + durable
replay, 18/18 tests, orchestrator-verified). Not pushed. All work happened
in this isolated worktree; no changes on any other branch or checkout.

## 2. Files changed — one line each

- `src/atlas/work-order/repo-writer-lock.ts` (NEW) — `RepoWriterLease`: per-repository single-writer mutual exclusion, reusing `instance-lease.ts`'s atomic-lock-file mechanism and the `instance-lease` state-root store (no new store); stale-lease takeover is never silent — `recoverStaleRepoWriterLease()` is a separate call that requires a non-empty reason and re-verifies expiry from disk; includes the pure `canonicalizeRepoPath()` (case/slash/trailing-separator/realpath-native normalization) with its own tests
- `src/atlas/work-order/executor-gate.ts` (NEW) — `runExecutorGate()`: the single pre-mutation gate; proves signature, independent issuer/executor identity, replay, real git HEAD + real canonical repo path (never a caller claim), a held `RepoWriterLease`, path/action/command scope, and attempt/wall-clock budget, in that order (replay claimed last, deliberately, so an unrelated failure never burns the one-shot nonce); every REJECT is written as a deterministic evidence claim via the existing M8 ledger (`evidence/ledger.ts`), binding the exact work-order hash
- `src/atlas/work-order/validate.ts` (MODIFIED) — carry-over fix: split the old nonce-consuming-on-every-call `validateWorkOrder()` into pure/repeatable `checkWorkOrderScope()` and one-shot `claimWorkOrder()`; `validateWorkOrder()` kept as a thin composition of the two for single-call callers
- `src/atlas/work-order/index.ts` (MODIFIED) — exports the new split validate functions and every `repo-writer-lock.ts` / `executor-gate.ts` public symbol
- `src/atlas/state-writer-inventory.ts` (MODIFIED) — registered `src/atlas/work-order/repo-writer-lock.ts` as `authoritative` against the `instance-lease` store (the only new fs-mutating production file this wave; `executor-gate.ts` does not import `node:fs` at all — it delegates every write to `repo-writer-lock.ts` and `evidence/ledger.ts`, both already registered)
- `src/__tests__/work-order-envelope.test.ts` (MODIFIED) — re-pointed all 18 wave-1 tests from `validateWorkOrder()` to a local `validateAndClaim()` helper composing `checkWorkOrderScope()` + `claimWorkOrder()`; every original assertion is byte-identical, none weakened
- `src/__tests__/work-order-gate.test.ts` (NEW) — 22 tests: `canonicalizeRepoPath` pure-function cases (5), `RepoWriterLease` behavior (7: second-writer refusal, cross-spelling one lock, release recorded, non-owner release refused, crashed-pid-not-silent, explicit stale recovery, pid+bootToken binding/heartbeat), `runExecutorGate` cases (9: valid mutation, out-of-scope-before-write, forbidden command class, lease-not-held, real-HEAD mismatch, issuer/executor substitution resistance, hash-bound receipt, tampered-receipt detection, no-signing-material-leak), and the Step-4 live bounded proof (1)
- `docs/atlas-cto/CURSOR-HANDOFF.md` (this file, replaced)

## 3. Receipts — exact commands, output, exit codes

Focused, run TWICE:
```
$ node node_modules/vitest/vitest.mjs run src/__tests__/work-order-envelope.test.ts src/__tests__/work-order-gate.test.ts
Run 1: Test Files  2 passed (2) | Tests  40 passed (40) | exit 0
Run 2: Test Files  2 passed (2) | Tests  40 passed (40) | exit 0
```
Both runs printed the live-proof evidence pack path, e.g.:
`[p1a-live-proof] evidence pack preserved at: C:\Users\user\.atlas\quarantine\evidence\p1a-live-2026-08-06T10-15-03-271Z-fac8b38c`
(a fresh, differently-timestamped pack each run — both preserved on disk.)

Regression, run ONCE:
```
$ node node_modules/vitest/vitest.mjs run src/__tests__/goal-intake.test.ts src/__tests__/project-resolution.test.ts src/__tests__/context-assembly.test.ts src/__tests__/state-writer-inventory.test.ts src/__tests__/courier-evidence-integrity.test.ts src/__tests__/courier-loop-negatives.test.ts
Test Files  6 passed (6) | Tests  78 passed (78) | exit 0
```
`state-writer-inventory.test.ts` passing confirms the structural sweep accepts `repo-writer-lock.ts`'s registration and does NOT flag `executor-gate.ts` (it has no `node:fs` mutating call).

Full suite, run ONCE:
```
$ node node_modules/vitest/vitest.mjs run
Test Files  2 failed | 153 passed (155)
     Tests  3 failed | 1529 passed | 12 skipped (1544)
exit 1
```
Baseline after wave 1 was `1507 passed / 3 failed / 12 skipped / exit 1`. Delta: **+22 passed** (exactly the new `work-order-gate.test.ts` count), **0 new failures**, **skipped unchanged at 12**. The 3 failures are the SAME pre-existing ones as baseline — all `npx tsup` not found on this host's PATH inside vitest's child-process context (`src/__tests__/m10-install-lifecycle.test.ts` × 3: install/upgrade/rollback); `integration/e2e-binary.test.ts` fails its own `beforeAll` tsup build for the same reason and its 10 tests report skipped (included in the unchanged 12), not failed. Never called green while exit was 1 — reporting exit 1 here honestly, with the diff against baseline shown above as the acceptance evidence.

Typecheck:
```
$ node node_modules/typescript/bin/tsc --noEmit
src/__tests__/runner-health-no-claim.test.ts(390,13): error TS2352 ...
src/__tests__/runner-health-no-claim.test.ts(396,77): error TS2352 ...
src/courier/courier-loop.ts(549,23): error TS2367 ...
exit code: 2
```
Baseline was 3 pre-existing errors in these same two files. Count UNCHANGED (3 → 3), same files, same error codes. None of the wave-2 files (`repo-writer-lock.ts`, `executor-gate.ts`, `validate.ts`, `index.ts`, `state-writer-inventory.ts`, both test files) appear anywhere in the typecheck output.

## 4. Known risks / broken items

- `npx tsup` PATH resolution failure (pre-existing, out of this wave's allowed-files scope) still blocks `m10-install-lifecycle.test.ts` (×3) and `e2e-binary.test.ts`'s 10 skipped tests — same class of host issue prior sessions already logged; not touched here.
- `runExecutorGate()`'s lease check (`getRepoWriterLeaseInfo`) is READ-ONLY by design — it verifies a lease is already held by the calling mission but does not acquire one itself. A caller that forgets to call `acquireRepoWriterLease()` first gets a clean `lease_not_held` REJECT (tested), but this is a two-call protocol (acquire, then gate-per-mutation) that the NEXT integration layer (courier/exec-graph wiring, explicitly out of this wave's scope) must get right — nothing in this wave enforces the ordering across process boundaries.
- `RepoWriterLease`'s default TTL is 20 minutes with no automatic background heartbeat — a caller doing long-running work must call `heartbeatRepoWriterLease()` itself or the lease will silently go stale (recoverable only via the explicit `recoverStaleRepoWriterLease()` path, by design — see module header). Not wired into any scheduler yet.
- `readRealGitHead()` in `executor-gate.ts` shells out to `git rev-parse` synchronously per gate call; fine for the current one-call-per-mutation usage pattern, would need batching/caching if a future caller re-checks scope at high frequency.
- The live bounded proof writes real evidence packs to `$HOME/.atlas/quarantine/evidence/p1a-live-<timestamp>-<random>/` on every test run (by design, per the mission's Step 4) — these accumulate across CI/dev runs and are never auto-pruned by this wave. Left as-is per the "keep the evidence pack" instruction; a retention policy is a separate concern.

## 5. Next three steps

1. Orchestrator verification of P1-A wave 2 (this handoff) — confirm the split (`checkWorkOrderScope`/`claimWorkOrder`), `RepoWriterLease`, and `runExecutorGate` against the mission spec before anything wires into a real execution path.
2. Next P1 item: restart-durable spend cap.
3. Pause / PANIC — no further scope expansion in this worktree without a new mission.

## 6. Blockers for CEO / orchestrator

- None block closing this wave — both the carry-over fix and the wave-2 deliverables (lock primitive, executor gate, tests, live proof) are done and verified twice with real receipts above.
- Open, non-blocking note: the two-call acquire-then-gate protocol (risk #2 above) needs an explicit design decision in whichever wave wires `runExecutorGate` into courier/exec-graph — not decided unilaterally here, since courier/exec-graph integration was explicitly forbidden scope for this wave.
