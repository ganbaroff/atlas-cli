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
- [ ] Migrate remaining call sites in small store-family slices; keep explicit
      temporary roots in tests before activation.
- [ ] Prove CWD/code-root invariance and no writes to checkout paths.
- [ ] Before any live activation, bind the manifest to an externally expected
      node role and verify allowlisted source-receipt artifacts/hashes; fields
      asserted by the manifest itself are not provenance proof.
- [ ] Run focused tests, broader affected tests, `npx tsc --noEmit`, and
      `git diff --check`.

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

---

### Task 2: Centralize exec-graph mutation transaction

**Files:**

- Modify: `src/exec-graph/ledger.ts`
- Modify: `src/exec-graph/api.ts`
- Modify: `src/exec-graph/verifier-port.ts`
- Modify: `src/atlas/instance-lease.ts`
- Modify/Add: focused exec-graph and lease tests

- [ ] Observe RED: every missing read-only guard, malformed-ledger mutation,
      swallowed append failure, concurrent transition, and concurrent lease.
- [ ] Add one typed, exclusive, strict mutation transaction.
- [ ] Move read/validate/append/flush into the held transaction.
- [ ] Make persistence failure throw; snapshot remains a disposable cache.
- [ ] Apply identical safety gates to verifier capability paths.
- [ ] Make instance lease acquisition exclusive and root-routed.
- [ ] Run focused concurrency in separate child processes, then affected suite,
      typecheck, and diff check.

Done bar: one accepted concurrent mutation, one explicit conflict; damaged
ledger is diagnostic-only; no unpersisted success result.

---

### Task 3: Add shared durable effect journal

**Files:**

- Add: effect-journal contract/store module under `src/atlas/`
- Modify: `src/goal-runner/runner.ts`
- Modify: `src/atlas/atlas-runner.ts`
- Modify as required: queue claim/recovery adapter
- Add: child-process crash fixtures and focused tests

- [ ] Observe RED for crash-before-effect, crash-after-start, and
      crash-after-receipt windows.
- [ ] Derive stable operation IDs from durable command/task identity.
- [ ] Flush `started` before invoking effects and terminal receipt afterwards.
- [ ] Refuse automatic replay of `outcome_unknown`.
- [ ] Make stale queue claims consult the shared journal.
- [ ] Resume from an existing terminal receipt without repeating the effect.
- [ ] Run crash matrix, affected suites, typecheck, and diff check.

Done bar: no automatic duplicate across any injected crash window; ambiguous
outcome is a named blocker.

---

### Task 4: Rehearse complete root migration in isolation

**Files:**

- Add/modify: full-root copy, manifest, cold verifier, and tests
- Reuse: M3A strict exec-graph comparison and M3C safe cleanup primitives

- [ ] Build a fixture root containing every authoritative store.
- [ ] Copy via staging + durable rename; derive all proof paths internally.
- [ ] Launch a network-denied child with only candidate root and explicit code
      path.
- [ ] Run native store checks; missing/empty/unknown input fails closed.
- [ ] Execute rollback and issue receipt only after observed cleanup and source
      invariance.
- [ ] Run focused suite, affected suite, typecheck, and diff check.

Done bar: fixture full-root restore/replay is exact and checkout-independent.

---

### Task 5: Run one retained current full-root rehearsal

- [ ] Preflight exact branch/HEAD, five unrelated dirty paths, runner status,
      source store manifests, preservation baseline, and candidate absence.
- [ ] Stop if any preflight row differs; no retry without diagnosis.
- [ ] Run exactly one retained-copy rehearsal to a new generated directory.
- [ ] Freshly verify all manifests and store invariants.
- [ ] Prove no resolver, live state, runner, scheduler, Railway, Git tracking,
      worktree, junction, or code-root change occurred.

Done bar: retained current-state full-root artifact has a valid rollback receipt
and fresh independent verification.

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
