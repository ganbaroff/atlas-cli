# M3D Cutover Readiness and Rollback Implementation Plan

> **Execution boundary:** Tasks 1-6 are reversible local code/test/document
> work. Task 7 is a stop point requiring an explicit Yusif physical-cutover GO.

**Goal:** satisfy state-root, mutation-integrity, effect-durability, and cold
recovery gates before any Atlas repository move or live binding change.

**Design:**
[`2026-07-30-m3d-cutover-readiness-and-rollback-design.md`](../specs/2026-07-30-m3d-cutover-readiness-and-rollback-design.md)

## Global constraints

- Preserve the five unrelated ANUS dirty paths exactly.
- No push, merge, deploy, live provider, worktree removal, junction change,
  Git untracking, scheduler/Railway edit, `.env` read/move, or physical move in
  Tasks 1-6.
- TDD for every behavior change. Codex independently reruns each worker claim.
- One bounded worker only for a disjoint mechanical slice; first policy or
  capability block stops that route.
- No success claim from logs alone. Command exit code plus state readback is
  required.

---

### Task 1: Close classified state-store inventory and activation contract

**Files:**

- Modify: `src/atlas/state-root.ts`
- Modify/Add: focused state-root inventory and activation tests
- Add: source-level inventory fixture/allowlist if needed
- Update: M3D design only when source evidence changes it

- [x] Enumerate every production filesystem write call under `src/` and assign
      authoritative, operational, ephemeral, or configuration/content.
- [x] Observe RED for an unclassified writer and for production activation
      without an explicit stable root.
- [x] Add complete classified registry and activation-manifest validation.
- [x] Refuse classified legacy overrides that escape an activated root.
- [x] Migrate slice 1 (`exec-graph`, `evidence`, `goal-budgets`) through a
      compatibility bridge that ignores a merely staged `ATLAS_STATE_ROOT` and
      switches only after required activation plus a valid manifest.
- [x] Migrate slice 2 (`swarm-runs`, `intake-drafts`) through the same bridge;
      preserve explicit temporary roots before activation and make those
      overrides unreachable after required activation.
- [x] Migrate slice 3 (`operator-state`, `operator-runs`); centralize duplicate
      state paths, constrain file-level trace/ledger overrides, reject default
      store junction escape, and use activated paths for manual result readback.
- [x] Migrate slice 4 (`task-results`); preserve the legacy hardcoded directory
      before activation and validate the activated root before subprocess spawn.
- [x] Migrate slice 5 (`learning`); preserve its three legacy precedence modes,
      ignore caller path injection after activation, and bind evidence,
      exec-graph, and spend side effects before claim or receipt mutation.
- [x] Migrate slice 6 (`spend-receipts`); preserve the legacy env/home default
      before activation, fail closed before counter/file mutation on state-root
      denial, and keep ordinary local-I/O/Supabase failures non-blocking.
- [x] Migrate slice 7 (`instance-lease`, `provider-health`, `breadcrumbs`);
      preserve their shared legacy home/env behavior before activation and
      refuse invalid/escaped activation before writer mutation.
- [x] Migrate slice 8 (`queue-auth`, `notify-queue`); preserve legacy directory
      and file overrides before activation, derive fixed activated leaves, and
      refuse existing or dangling leaf symlinks before state I/O.
- [x] Migrate slice 10 (alert-state, emotion-audit, repo-watch, shell-audit);
      rethrow activation denials from state reads, keep never-throw audit
      appends residue-free, and resolve the shared shell-audit leaf at call
      time.
- [x] Migrate remaining call sites in small store-family slices; keep explicit
      temporary roots in tests before activation. (complete as of slice 10;
      pause-control and runner-log are external writers handled at cutover)
- [x] Prove CWD/code-root invariance and no writes to checkout paths. (eae53a7 + 586393c)
- [x] Before any live activation, bind the manifest to an externally expected
      node role and verify allowlisted source-receipt artifacts/hashes; fields
      asserted by the manifest itself are not provenance proof. (504ea45)
- [x] Run focused tests, broader affected tests, `npx tsc --noEmit`, and
      `git diff --check`. (full suite 1344/0, tsc + diff-check clean;
      independently re-run)

Done bar: all production writers classified; all authoritative/selected
operational paths resolve under one explicit root; activation fails closed.

A1 checkpoint `97a300e`: 44 production writer files are source-scanned, 23
root-managed stores are classified, activation requires an explicit root plus
strict complete manifest, and lexical/junction escapes fail closed. Evidence:
8 affected files, 132/132 tests, clean typecheck and diff-check. Call-site
migration and live activation remain open.

A2 slice-1 checkpoint `ca324fe`: three authoritative stores now use the
migration bridge. Independent LUNA review reproduced two hidden-cutover risks:
a staged global root could have rerouted new stores without a manifest, and a
malformed staged root could defeat a valid legacy override. Both were observed
RED then repaired. Evidence: 9 affected files, 146/146 tests, exact-tip 43/43,
clean typecheck and diff-check. The same review correctly identified that
manifest receipt provenance is still an assertion; that remains an explicit
pre-live M3D-A gate, not permission to activate now.

A2 slice-2 checkpoint `0c9723d`: swarm run bundles and intake drafts now use
the migration bridge. RED proved both caller-supplied roots bypassed required
activation; the centralized resolvers now retain those legacy/test overrides
before activation and ignore them after valid required activation. Evidence:
5 affected files, 39/39 exact-tip tests, clean typecheck and diff-check. No live
root, manifest, checkout state, or provider was touched.

A2 slice-3 checkpoint `2cbc85f`: operator state, result traces, lifecycle
results, and run ledger now use the migration bridge. Separate RED waves proved
three unmigrated path seams, two file-level escape hatches, missing directory
creation for a valid contained trace, a default-store junction escape, and
manual promotion readback through the old checkout path. All were repaired.
Evidence: 14 affected files, 173/173 exact-tip tests, clean typecheck and
diff-check. A bounded LUNA review produced no receipt despite stop/interrupt,
so that external lane is **UNVERIFIED** and is not completion evidence.

A2 slice-4 checkpoint `4dca9fe`: the task spawner now resolves its result store
through the migration bridge before any subprocess starts. RED proved staged
and activated path contracts were absent; a mocked subprocess regression proves
a missing activation manifest yields zero spawn calls. Evidence: 5 affected
files, 123/123 exact-tip tests, clean typecheck and diff-check. The legacy
`C:\Projects\ATLAS\data\task-results` directory was not modified.

A2 slice-5 checkpoint `94e7426`: learning state bootstrap, file exchange,
projection locks, HTTP `stateDir`, and direct `exchangeDir` processing retain
stable absolute legacy behavior before activation and converge on `learning`
after activation. A bounded independent review found direct processing could
still write spend receipts outside the activated root. RED reproduced both the
unset binding and escaped alias; atomic validation/binding now occurs before
directory, claim, or receipt mutation. Repeat review returned `ACCEPT`.
Evidence: 8 learning/state-root files / 113 tests, typecheck and diff-check
clean.

A2 slice-6 checkpoint `af3f48a`: the global spend writer now uses the migration
bridge. RED first proved the resolver/activation gap, then a second RED proved
that correlation-ID duplicate lookup could leak an ordinary local-I/O error.
Both paths were repaired while state-root policy/configuration denials remain
fail-closed. Spend-tracker unit tests now use isolated temporary directories.
Bounded independent review returned `ACCEPT`. Evidence: 13 affected test files,
141/141 exact-tip tests, clean typecheck and diff-check; no provider/network call.

A2 slice-7 checkpoint `c3923c9`: three directory-shaped stores that formerly
shared `~/.atlas` now use the migration bridge. Resolver-only RED was 3 failed /
29 passed; post-repair acceptance proves staged-root inertia, exact legacy
defaults, activated real writes under three registered subdirectories, and zero
mutation on invalid activation. Model-router tests now isolate provider health
from user state. Evidence: 11 affected test files, 163/163 tests, clean typecheck
and diff-check, including two real child-process lease races. A bounded
implementation-review lane was interrupted after its stop request returned no
receipt, so it is `UNVERIFIED`; local command evidence is completion authority.

A2 slice-8 checkpoint `746ccf7`: notification queue and runner nonce ledger now
use file/directory migration bridges. The first GREEN passed 247 tests. A
bounded independent review then found existing leaf-symlink escapes; Codex
reproduced them RED and repaired exact-leaf containment. Rereview found the
dangling-symlink variant; a second RED reproduced it and `lstatSync`-aware
canonicalization closed it before any outside target could be created. Final
rereview returned `ACCEPT`. Exact-tip evidence: 11 files, 249/249 tests, clean
typecheck and commit diff-check; Cost Router's explicit nonce ledger remained
caller-owned and unchanged.

A2 slice-9 checkpoint `c0d7f57`: the OPSBOARD file exchange store now uses the
migration bridge. This slice was left uncommitted and RED when the previous
seat's usage quota ran out mid-TDD; its in-flight falsifier exposed that
`processGoalRequest` called `resolveExchangeDir` before validating the
correlation id, so a rejected traversal-shaped id still created the exchange
tree as a side effect. Validation is now hoisted into
`assertValidCorrelationId`, called first in `processGoalRequest` and reused by
`resolveReceiptPaths`, so a rejected request leaves zero filesystem residue and
never reaches the runner. The preserved in-flight patch is
`C:\Projects\VOLAURA\memory\atlas\preservation\atlas-m3d-slice9-inflight-2026-07-31.patch`,
verified by `git apply --check --reverse`. Evidence: focused 3 files/57/57
tests; wider affected matrix 10 files/226/226 tests; clean typecheck; 0 staged
secret-scan hits. Independent review was not obtained (previous reviewer lane
closed, quota exhausted) and is recorded as `UNVERIFIED`.

A2 slice-10 checkpoint `5fd6b29`: the last four production-TypeScript
file-shaped stores — `alert-state`, `emotion-audit`, `repo-watch`, and
`shell-audit` — now use the migration bridge. Legacy env/default placement is
preserved before activation; after required activation each store derives one
fixed leaf under `<root>/<store>/`, escaped overrides are ignored, and leaf
symlinks are refused. State reads rethrow activation denials instead of
fabricating empty state; best-effort audit appends (`logToneShift`,
`auditFsOp`, shell audit) keep their never-throw contracts but write nothing
anywhere on invalid activation. `shell-audit` became a call-time resolver —
the import-time `AUDIT_LOG_PATH` constant is gone. Independently re-run:
122/122 tests across 4 files, clean typecheck. With slice 10, call-site
migration is complete; only the external writers `pause-control` and
`runner-log` remain, handled at cutover.

Invariance proof checkpoint `eae53a7`+`586393c`: three properties are now
proven — (1) pre-activation, checkout-resident legacy defaults for
exec-graph, operator-state, and emotion-audit demonstrably resolve inside
the checkout; (2) after activation every production resolver lands under
the activated root from any cwd, identical across cwds; (3) an adversarial
write exercise from inside the checkout leaves `state/` and `operator/`
byte-for-byte untouched. RED receipt: removing activation fails the test.
An independent adversarial review REFUTED the first cut on three findings —
(a) blocker: the resolved-path map's key set was unpinned, a vacuous-pass
risk; (b) moderate: repo-watch had no positive under-root assertion
anywhere, with a comment falsely citing a slice-10 test; (c) low: external
writers pause-control/runner-log were silently absent from coverage.
`586393c` repairs all three: a literal 22-label sorted `toEqual` pins the
resolved-path map, a full 23-store registry tiling (19 resolver + 2
behavioral + 2 external via imported `EXTERNAL_STATE_WRITERS`) closes the
coverage gap, and an airtight seeded-read repo-watch probe proves a wrong
read yields the opposite notify decision. RED receipt: deleting one label
fails the test. A second independent verifier confirmed CLOSED: 61/61
across the migration and inventory test files, clean typecheck, and the
repo-watch probe traced airtight through both branches of `decideNotify`.
The slice-10 open item (double-run state-leak probe) is now CLOSED: the
migration test file was run consecutively multiple times this session (2×
by the writer, 3× by a verifier) with identical 57/57 pre-repair results.
NEW OPEN residual risk (pre-existing design, not a regression):
`EXTERNAL_STATE_WRITERS` reasons are format-checked prose only — no test
verifies the claimed external writer (e.g. `scripts/start-runner.cmd`)
actually writes the store; a plausible-but-false reclassification would
pass both structural tests. Candidate falsifier for a future slice.

A3 provenance checkpoint `504ea45`: required activation now binds to an
externally expected identity instead of trusting the manifest's own
self-assertions. Four things are enforced inside `assertStateRootActivated()`
— (1) the environment variable `ATLAS_NODE_ROLE` must be set and must match
the manifest's declared role (`node_role_unbound` when unset,
`node_role_mismatch` when it disagrees); (2) every manifest source receipt is
verified against the real artifact bytes at
`<root>/activation-receipts/<kind>` via sha256, not merely against the
manifest's own claimed hash (`source_receipt_mismatch`/
`source_receipt_missing`); (3) a per-role required-kinds allowlist is
enforced, with `m3c-preserved-state-rehearsal` required for both roles; (4)
traversal-shaped receipt kinds are rejected at schema level before any
lookup. TDD discipline held: 6 falsifiers were observed RED before the
implementation went GREEN, and all dummy activation hashes in test fixtures
were replaced with real computed sha256 values, so the 58-test migration
harness now activates against a real artifact and a real hash. An
independent verifier returned CONFIRMED: the enforcement trace shows all
four checks live inside `assertStateRootActivated()`, and all four resolver
paths (`resolveStateDir`, `resolveMigratingStateDir`,
`resolveMigratingStateFile`, `constrainMigratingStatePath`) provably funnel
through it under required activation, with no caching and the environment
re-read on every call. The independently re-run full suite passed 1344/0
with 2 pre-existing skips, `tsc --noEmit` was clean, and `git diff --check`
was clean. One informational, non-blocking note: receipt-artifact symlinks
are followed rather than `lstat`-guarded; this is reasoned non-exploitable
because the manifest hash must still match the real target bytes, and
planting a symlink already requires write access equal to editing the
manifest itself — an optional defense-in-depth parity item for a future
slice.

---

### Task 2: Centralize exec-graph mutation transaction

**Files:**

- Modify: `src/exec-graph/ledger.ts`
- Modify: `src/exec-graph/api.ts`
- Modify: `src/exec-graph/verifier-port.ts`
- Modify: `src/atlas/instance-lease.ts`
- Modify/Add: focused exec-graph and lease tests

- [x] Observe RED: every missing read-only guard, malformed-ledger mutation,
      swallowed append failure, concurrent transition, and concurrent lease.
- [x] Add one typed, exclusive, strict mutation transaction.
- [x] Move read/validate/append/flush into the held transaction.
- [x] Make persistence failure throw; snapshot remains a disposable cache.
- [x] Apply identical safety gates to verifier capability paths.
- [x] Make instance lease acquisition exclusive and root-routed.
- [x] Run focused concurrency in separate child processes, then affected suite,
      typecheck, and diff check.

Done bar: one accepted concurrent mutation, one explicit conflict; damaged
ledger is diagnostic-only; no unpersisted success result.

Checkpoint evidence (2026-07-31): Task 2 done at commit `4051a68` (7 files,
+597/-196). RED-first observed 3 defect families before the fix: malformed-ledger
mutation, swallowed append failure, cross-process race; the race test initially
showed 0 winners due to an actor-argv wiring bug in the test script, fixed to a
literal actor so it became a genuine exactly-one-winner falsifier. Implementation:
`withExclusiveFileLock` (openSync 'wx', stale reclaim 30s, acquire timeout 5s) plus
`withExecGraphMutation` strict transaction in `ledger.ts`; all mutation call sites in
`api.ts` and `verifier-port.ts` route through one transaction each; instance-lease
acquisition uses the same lock; old `persistEvent` removed. Verified: focused
suites 83/0; independent adversarial verifier found no bypass, correct lock release
on all paths via `finally`, reclaim threshold greater than acquire timeout, no
reentrancy; a separate closer ran the full suite in two shards, 741+607 = 1348
pass / 0 fail / 2 skipped, `tsc` clean, `git diff --check` clean, `git status`
matched the five known dirty paths before and after. Residual risks left open,
not fixed: (1) the race test asserts exactly one winner but does not assert the
loser's error kind; (2) the append-specific `ExecGraphPersistError` catch
(~ledger.ts:506-512) is not directly exercised by any test; (3) no mtime
heartbeat while a transaction is held, so a transaction slower than 30s could
theoretically be stale-reclaimed by a persistent retrier. Incident: a single
`npm test` invocation stalled over 18 minutes with no output, twice (cause
unverified; sharded vitest completed in about 60s; a stray backgrounded
`npm test` may still have been running concurrently).

---

### Task 3: Add shared durable effect journal

**Files:**

- Add: effect-journal contract/store module under `src/atlas/`
- Modify: `src/goal-runner/runner.ts`
- Modify: `src/atlas/atlas-runner.ts`
- Modify as required: queue claim/recovery adapter
- Add: child-process crash fixtures and focused tests

- [x] Observe RED for crash-before-effect, crash-after-start, and
      crash-after-receipt windows.
- [x] Derive stable operation IDs from durable command/task identity.
- [x] Flush `started` before invoking effects and terminal receipt afterwards.
- [x] Refuse automatic replay of `outcome_unknown`.
- [x] Make stale queue claims consult the shared journal.
- [x] Resume from an existing terminal receipt without repeating the effect.
- [x] Run crash matrix, affected suites, typecheck, and diff check.

Done bar: no automatic duplicate across any injected crash window; ambiguous
outcome is a named blocker.

Checkpoint `codex/m3d-effect-journal` (worktree tip, unpushed): shared
`src/atlas/effect-journal.ts` under new `effect-journal` state store;
`atlas-runner`, `queue-worker`, and `goal-runner` share `executeOnce` /
`decideStaleClaim`. Child-process crash fixtures cover all three windows.
Evidence: focused 56/56 + state-root 107/107 + goal/integration 37/37;
sharded full suite 745+618 = 1363 pass / 0 fail / 2 skipped; `tsc --noEmit`
clean; `git diff --check` clean. No activation, push, deploy, or live-state
mutation.

---

### Task 4: Rehearse complete root migration in isolation

**Files:**

- Add/modify: full-root copy, manifest, cold verifier, and tests
- Reuse: M3A strict exec-graph comparison and M3C safe cleanup primitives

- [x] Build a fixture root containing every authoritative store.
- [x] Copy via staging + durable rename; derive all proof paths internally.
- [x] Launch a network-denied child with only candidate root and explicit code
      path.
- [x] Run native store checks; missing/empty/unknown input fails closed.
- [x] Execute rollback and issue receipt only after observed cleanup and source
      invariance.
- [x] Run focused suite, affected suite, typecheck, and diff check.

Done bar: fixture full-root restore/replay is exact and checkout-independent.

Checkpoint on `codex/m3d-effect-journal` (local, unpushed):
`src/atlas/full-root-rehearsal.ts` + cold child. Seeds every authoritative
store, atomic tree copy, network-denied cold inspect, M3A exec-graph parity,
identity-bound rollback, bound receipt. Cast destinations ignored; CWD/env
ignored. Evidence: focused 13/13; sharded full suite 745+631 = 1376 pass /
0 fail / 2 skipped; `tsc --noEmit` clean. No live state, activation, push,
or deploy.

---

### Task 5: Run one retained current full-root rehearsal

- [x] Preflight exact branch/HEAD, five unrelated dirty paths, runner status,
      source store manifests, preservation baseline, and candidate absence.
- [x] Stop if any preflight row differs; no retry without diagnosis.
- [x] Run exactly one retained-copy rehearsal to a new generated directory.
- [x] Freshly verify all manifests and store invariants.
- [x] Prove no resolver, live state, runner, scheduler, Railway, Git tracking,
      worktree, junction, or code-root change occurred.

Done bar: retained current-state full-root artifact has a valid rollback receipt
and fresh independent verification.

Checkpoint on `codex/m3d-effect-journal` (local, unpushed):
`src/atlas/full-root-retain.ts` + `scripts/rehearse-full-root.mts`
(`npm run atlas:m3d-rehearse`). One retained artifact:
`C:\Projects\VOLAURA\memory\atlas\preservation\atlas-full-root-m3d-20260731T234811Z-bf74158c`
(tree SHA-256 `e1ef5100f37dc741848882b85f8c4e95c40ca043d6e38ec6a1c3307682b60cf2`).
Copied 11 live stores; empty-policy for 6
(cost-router, goal-budgets, learning, operator-state, opsboard-exchange,
pause-control). Independent verify accepted. Primary ANUS stayed clean at
`d1f0ebf`. Suite 752+631 = 1383 pass / 0 fail / 2 skipped. No activation,
push, deploy, scheduler, or Railway change.

---

### Task 6: Prepare non-executed physical cutover packet

- [ ] Generate exact preflight/readback/rollback command file with destructive
      commands disabled behind an explicit token.
- [ ] Add path-containment and junction-realpath guards.
- [ ] Add manifest schemas for bundles, patches, scheduler XML, Railway binding,
      junctions, `.env` metadata, and old/new roots.
- [ ] Test the packet only against disposable fixture repositories, worktrees,
      junctions, and scheduled-task substitutes.
- [ ] Run one compact rollback-critical review; locally disposition every
      finding.

Done bar: disposable end-to-end cutover and rollback pass; live paths untouched.

---

### Task 7: Stop for Yusif physical-cutover decision

- [ ] Present current evidence, exact live mutations, rollback anchors, expected
      downtime, and remaining unknowns.
- [ ] Do not infer GO from approval of this design or Tasks 1-6.
- [ ] Execute no physical action until Yusif explicitly approves that packet.
