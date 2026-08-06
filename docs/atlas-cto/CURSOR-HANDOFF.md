# Cursor Handoff

> Standing end-of-session ritual. Replaced each session. Cursor seat.

## 1. Date, branch, HEAD

- Date: 2026-08-06
- Repo: `C:/Users/user/OneDrive/Documents/GitHub/ANUS`
- Worktree: `.worktrees/repair-gate-2026-08-06`
- Branch: `codex/repair-gate-2026-08-06` (created from `codex/atlas-cost-router-design` @ `ab57e66`)
- HEAD after the fix commit:

```
$ git log -1 --oneline
bc25c63 fix(atlas): register state writers, isolate goal-intake tests from real filesystem
```

Not pushed. No changes on `codex/atlas-cost-router-design` or the canonical checkout — all work happened in the isolated worktree.

## 2. What changed this session — files + one line each

- `src/atlas/state-writer-inventory.ts` — registered the two real fs-mutating modules the structural sweep test had found unregistered: `src/atlas/telegram-capability.ts` (ephemeral/temporary — tmp scratch files for local STT/OCR, unlinked in `finally`) and `src/atlas/voice-adapter-client.ts` (configuration-content/caller-target — `voiceTts()` writes to the caller-supplied `outPath`); no new state-root store invented, none needed
- `src/__tests__/state-writer-inventory.test.ts` — added a 4th test pinning the classification of those two new entries, so a future silent downgrade/removal fails loudly even in the edge case the generic sweep test can't catch (writer + its fs call deleted together)
- `src/atlas/goal-intake/intake.ts` — added optional `registryProject?: RegistryProject` to `InterpretGoalInput`, mirroring the existing `ResolveProjectOptions.registryProject` precedent in `resolve-project.ts`; when supplied it substitutes the project row `interpretCeoGoal` resolves against, default omitted → zero production behaviour change
- `src/__tests__/goal-intake.test.ts` — the 2 failing tests now pass a `withRegistryOverrides(...)`-built Integronix row (`projectPath: null`, `memoryConflicts` reworded to include "UNVERIFIED") via the new `registryProject` override, instead of relying on the live registry's real `C:\Projects\INTEGRONIX` path hint

## 3. Receipts — real output

Baseline (before any edit, `ab57e66`, `node node_modules/vitest/vitest.mjs run`):
```
Test Files  4 failed | 149 passed (153)
     Tests  6 failed | 1485 passed | 12 skipped (1503)
```
Failing: `integration/e2e-binary.test.ts` (Failed Suite, `npx tsup` not found), `goal-intake.test.ts` x2, `m10-install-lifecycle.test.ts` x3 (same `npx tsup` cause), `state-writer-inventory.test.ts` x1.

Focused repair tests, run twice for stability (`node node_modules/vitest/vitest.mjs run src/__tests__/state-writer-inventory.test.ts src/__tests__/goal-intake.test.ts`):
```
Run 1: Test Files  2 passed (2) | Tests  17 passed (17)
Run 2: Test Files  2 passed (2) | Tests  17 passed (17)
```

Full suite after both repairs:
```
$ node node_modules/vitest/vitest.mjs run
Test Files  2 failed | 151 passed (153)
     Tests  3 failed | 1489 passed | 12 skipped (1504)
```
Remaining failures — all pre-existing, all `npx tsup` PATH resolution ("'tsup' is not recognized as an internal or external command"), none touch allowed files:
- `src/__tests__/integration/e2e-binary.test.ts` — Failed Suite (PRE-EXISTING)
- `src/__tests__/m10-install-lifecycle.test.ts > install: build + health green from isolated state dirs` (PRE-EXISTING)
- `src/__tests__/m10-install-lifecycle.test.ts > upgrade: rebuild preserves exec-graph + goal budget state` (PRE-EXISTING)
- `src/__tests__/m10-install-lifecycle.test.ts > rollback: restore prior dist; state + health still valid` (PRE-EXISTING)

Repaired (baseline FAIL → final PASS):
- `src/__tests__/goal-intake.test.ts > clear project goal — Integronix read-only audit` — REPAIRED
- `src/__tests__/goal-intake.test.ts > conflicting memory surfaces on Integronix` — REPAIRED
- `src/__tests__/state-writer-inventory.test.ts > classifies every production TypeScript file that calls a filesystem mutator` — REPAIRED

+1 total test count (1503→1504) is the new pinning test added in state-writer-inventory.test.ts. No NEW failures introduced.

Typecheck (repo script is `tsc --noEmit`; invoked via node, no npx per mission constraint):
```
$ node node_modules/typescript/bin/tsc --noEmit
src/__tests__/runner-health-no-claim.test.ts(390,13): error TS2352 ...
src/__tests__/runner-health-no-claim.test.ts(396,77): error TS2352 ...
src/courier/courier-loop.ts(549,23): error TS2367 ...
exit code: 2
```
Verified PRE-EXISTING by `git stash` (reverting the worktree to base `ab57e66`) and re-running — byte-identical output and exit code. Neither error file imports anything from `goal-intake/**` or `state-writer-inventory.ts`. Not touched, not in allowed-files scope.

## 4. Risks / broken things you know about

- `npx tsup` and `npx tsc` do not resolve on this host inside vitest's `execSync`/child-process context (PATH issue specific to this environment, not a code defect) — blocks `e2e-binary.test.ts` and all 3 `m10-install-lifecycle.test.ts` cases. Out of this mission's allowed-files scope; needs a PATH/npx-cache fix on the host or a repo-level script that avoids `npx` inside tests, same class of issue this mission explicitly worked around for vitest/tsc.
- `interpretCeoGoal()` (Goal Intake v0, `intake.ts`) still returns the *live* registry's `projectPath`/`memoryConflicts` for every caller that doesn't pass `registryProject` — including real CEO-chat usage. That's unchanged/expected (HARD RULE required zero production behaviour change), but it means the underlying "legacy path hint" ambiguity documented in `project-registry.ts` (`projectPath` comment: "Never treat as verified without FS check") is still live in production; only the test's coupling to it was removed. If a future session wants `interpretCeoGoal` to stop echoing an unverified path by default, that is a deliberate product decision, not a bug fix, and needs its own review — the two repaired tests now exercise the override path via `withRegistryOverrides`, not the live default.

## 5. Next 3 steps

1. Fix `npx` PATH resolution for this dev host (or make `m10-install-lifecycle.test.ts` / `e2e-binary.test.ts` invoke tsup via `node node_modules/tsup/dist/cli-node.js` the same way this mission had to for vitest/tsc) — would close the last 2 failing files.
2. Decide, with the CEO, whether `interpretCeoGoal`'s default (no-override) `projectPath`/`memoryConflicts` output should stop echoing the live registry hint as if verified — currently by design/HARD RULE untouched this session.
3. `finishing-a-development-branch` workflow for `codex/repair-gate-2026-08-06`: merge into `codex/atlas-cost-router-design` or open a PR, once CEO/orchestrator reviews this handoff.

## 6. Blockers that need CEO or the orchestrator chat

- None to close this mission — both assigned repairs (state-writer-inventory, goal-intake isolation) are done, verified twice, and typecheck-clean relative to baseline.
- Open decision only (not a blocker): item 2 above, whether to change `interpretCeoGoal`'s live default — explicitly deferred, not decided unilaterally.
