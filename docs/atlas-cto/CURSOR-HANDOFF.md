# Cursor Handoff

> Standing end-of-session ritual. This file is replaced each session, not appended to. Written by the orchestrator seat (Claude, via Atlas) for the Cursor seat working in parallel on the same repo.

## 1. Date, branch, HEAD

- Date: 2026-08-04
- Branch: `codex/atlas-cost-router-design`
- HEAD: `b005359` — `docs(context-assembly): Record CLI v0 merge receipt and rollback`

**GROUND-TRUTH CORRECTION vs. the brief this handoff was drafted from:** the brief's commit list in Section 2 below ends at `ffa9b0c`. Live `git log` shows HEAD is 5 commits past that: `66386fe` (merge module into CLI branch) → `b1a8176` (wire goal context pipeline) → `a85c57f` (isolate CLI tests / harden assembly caps) → `cebb67b` (**merge: Context Assembly CLI v0, Intake→Resolve→Assemble**) → `b005359` (docs receipt for that merge). Cursor should treat Context Assembly CLI v0 as **already CEO-accepted and merged**, not pending — see the correction under Section 5/6 below. This is a real state change since the brief text was written, not an error in the brief; noting it per the ground-truth-first rule.

## 2. What changed this session — files + one line each

Orchestrator-seat commits present in `git log`, newest last (verified against `git log --oneline -14` below):

- `4051a68` feat(exec-graph): Centralize mutations in one exclusive strict transaction — ledger.ts/api.ts/verifier-port.ts/instance-lease.ts + 3 test files: one exclusive strict on-disk-lock transaction; strict readers throw on a corrupt ledger; append failure throws inside the held lock; snapshot stays a disposable cache; instance-lease acquisition exclusive.
- `e5ea116` docs(atlas): Record M3D Task 2 mutation transaction completion — plan checkboxes + ATLAS-STATE-NOW.
- `882c82c` docs(atlas): Renew handoff brief for Cursor seat — `docs/archive/ATLAS-HANDOFF.md` rewritten in place (217 lines, English) from a stale April version.
- `ada02e1` fix(courier): Verifier computes verdict; evidence hash-bound; no caller pre-stamp — evidence-pack-contract.ts (required `collectedEvidenceHash`, `computeEvidenceHash`, verifierResult now advisory), spine-verifier.ts (computes its own verdict, internal SPINE_VERIFIER_ID, structural self-cert block, fail-closed hash gate), courier-loop.ts (passes the ORIGINAL frozen pack — no synthetic command substitution, no hardcoded effectProofs, no pre-stamped verdict), core-spine/index.ts exports, 2 test files.
- `a0379e8` fix(courier): Hash-bind cost and rollback fields; honest final-review script — costRecord/rollbackState added to the hash input, deep-freeze extended, `scripts/run-courier-final-review.ts` stops laundering the pack.
- `6ba6c1e` feat(proof): Add tamper-reject and hash-match step to courier proof — `scripts/run-courier-proof.ts`.
- `fc70a5c` fix(courier): Run deterministic verification before advisory review — courier-loop.ts restructured (executor+collect / deterministic verify / advisory reviewer split); receipt separates deterministicVerdict / reviewerStatus / reviewerAdvice / finalStatus / repairsApplied / evidencePack; legacy verifierResult derived from the deterministic verdict; MAX_REPAIR_CYCLES=1; browser crash/timeout/malformed/login → ADVISORY_UNAVAILABLE | MALFORMED_REVIEW, never "incomplete". Plus `src/__tests__/courier-reviewer-decoupling.test.ts` (R1-R8).
- `0838189` fix(courier): Label advisory reject honestly in final status — added canonical status VERIFIED_WITH_ADVISORY_REJECT (a reviewer REJECT on a verified pack was previously mislabeled ...ADVISORY_ACCEPT); test R9.
- `7f31f86` feat(proof): Gate tamper check on deterministic verdict — proof harness reads `deterministicVerdict` with a verifierResult fallback.
- `ffa9b0c` feat(cli): Add read-only goal resolve command and fix tsx entry guard — `src/cli.ts` (+71) and `src/__tests__/cli-goal-resolve.test.ts` (+170). New `atlas goal resolve --message "<text>" --json`: CEO message → interpretCeoGoal (PURE, never intakeCeoGoal) → resolveProjectPath → JSON {goalContract, projectResolution, finalStatus, evidence, reasons}. finalStatus precedence unknown-project→blocked→needs-approval→ready; exit codes ready 0 / invalid 1 / blocked 2 / needs-approval 3 / unknown-project 4. SIDE FIX with whole-CLI blast radius: the entry guard compared `import.meta.url` to a hand-built `file://${process.argv[1]}` string, false on Windows under tsx — EVERY CLI command silently no-op'd with exit 0; now uses `pathToFileURL(process.argv[1]).href` plus an `.endsWith('cli.ts')` clause.

Cursor-seat commits (core-spine, courier-loop v0, goal-intake, project-resolution merges up to `43bbfa5`) are **NOT** listed above — this section covers the orchestrator seat only.

**Additional commits observed past `ffa9b0c` (not in the brief, found live — see Section 1 correction):** `66386fe`, `b1a8176`, `a85c57f`, `cebb67b` (Context Assembly CLI v0: Intake→Resolve→Assemble, merged), `b005359` (merge receipt doc). Full detail: `docs/atlas-cto/RECEIPT-2026-08-04-context-assembly-cli-v0-merge.md`.

## 3. Receipts — real output

Live ground-truth captured this session:

```
$ git log -1 --oneline
b005359 docs(context-assembly): Record CLI v0 merge receipt and rollback

$ git branch --show-current
codex/atlas-cost-router-design

$ git status --porcelain=v1
(empty — clean tree)

$ git log --oneline -14
b005359 docs(context-assembly): Record CLI v0 merge receipt and rollback
cebb67b merge: Context Assembly CLI v0 (Intake→Resolve→Assemble)
a85c57f fix(context-assembly): Isolate CLI tests and harden assembly caps
b1a8176 feat(cli): wire goal context pipeline Intake→Resolve→Assemble
66386fe Merge branch 'atlas/context-assembly-v0-2026-08-04' into atlas/context-assembly-cli-v0-2026-08-04
ffa9b0c feat(cli): Add read-only goal resolve command and fix tsx entry guard
7f31f86 feat(proof): Gate tamper check on deterministic verdict
0838189 fix(courier): Label advisory reject honestly in final status
fc70a5c fix(courier): Run deterministic verification before advisory review
6ba6c1e feat(proof): Add tamper-reject and hash-match step to courier proof
a0379e8 fix(courier): Hash-bind cost and rollback fields; honest final-review script
ada02e1 fix(courier): Verifier computes verdict; evidence hash-bound; no caller pre-stamp
e20e7fb docs(context-assembly): CEO receipt noting MALFORMED_REVIEW transport
b64d465 feat(context-assembly): add Atlas ContextPack assembler v0

$ node node_modules/typescript/bin/tsc --noEmit 2>&1 | grep -c "error TS"
3

$ node node_modules/vitest/dist/cli.js run src/__tests__/cli-goal-resolve.test.ts src/__tests__/courier-reviewer-decoupling.test.ts src/__tests__/courier-evidence-integrity.test.ts src/__tests__/core-spine.test.ts --reporter=basic
 Test Files  4 passed (4)
      Tests  66 passed (66)
   Start at  21:22:07
   Duration  42.16s (transform 828ms, setup 0ms, collect 1.84s, tests 94.02s, environment 1ms, prepare 711ms)
```

Per-wave receipts, recorded-at-the-time (not re-run this session):

- Task 2 focused 83/0, full sharded 741+607 = 1348 pass / 0 fail / 2 skip.
- Evidence integrity focused 58/58, full sharded 1428 pass / 12 skip.
- Reviewer decoupling focused 67/67, full sharded 802+635 = 1437 pass / 12 skip.
- Goal resolve CLI focused 44/44, full sharded 805+641 = 1446 pass / 12 skip.

**Live tsc — 3 errors, verbatim:**

```
src/__tests__/runner-health-no-claim.test.ts(390,13): error TS2352: Conversion of type 'null' to type '{ claim?: boolean | undefined; }' may be a mistake because neither type sufficiently overlaps with the other. If this was intentional, convert the expression to 'unknown' first.
src/__tests__/runner-health-no-claim.test.ts(396,77): error TS2352: Conversion of type '(this: import("node:net").Socket, path: string, connectionListener?: (() => void) | undefined) => never' to type '{ (options: SocketConnectOpts, connectionListener?: (() => void) | undefined): Socket; (port: number, host: string, connectionListener?: (() => void) | undefined): Socket; (port: number, connectionListener?: (() => void) | undefined): Socket; (path: string, connectionListener?: (() => void) | undefined): Socket; }' may be a mistake because neither type sufficiently overlaps with the other. If this was intentional, convert the expression to 'unknown' first.
  Types of parameters 'path' and 'options' are incompatible.
    Type 'SocketConnectOpts' is not comparable to type 'string'.
      Type 'IpcSocketConnectOpts' is not comparable to type 'string'.
src/courier/courier-loop.ts(549,23): error TS2367: This comparison appears to be unintentional because the types '"adapter.cursor-headless"' and '"adapter.chatgpt-browser-reviewer"' have no overlap.
```

## 4. Risks / broken things known

- 2 test files fail for environment reasons only: `m10-install-lifecycle`, `integration/e2e-binary` — `'tsup' is not recognized`. Root cause: `node_modules/.bin` holds ~1 shim for 358 packages, so `npx <tool>` fails repo-wide. Workarounds in use: `node node_modules/vitest/dist/cli.js`, `node node_modules/typescript/bin/tsc`, `node node_modules/tsx/dist/cli.mjs`. A plain `npm install` / `npm rebuild` would likely restore the shims — NOT attempted (install action, needs a decision).
- A single `npm test` invocation stalled >18 minutes twice with no output; cause unknown. Always run the suite sharded (`--shard=1/2`, `--shard=2/2`), ~60 s total.
- Non-blocking debt: the nested `evidencePack.verifierResult` inside a pack still carries a stale pre-verify snapshot `{verified:false, reason:"pending independent verify"}` while the top-level deterministic verdict says verified:true. Audit-clarity nit; must not influence any decision.
- Comet/ChatGPT advisory reviewer transport fails intermittently (Playwright "element outside of the viewport" on the ChatGPT textarea) and runs in an isolated browser profile with no logged-in accounts, so consent/cookie dialogs can stall it. Reclassified LOW/MEDIUM **operational** debt — since `fc70a5c` it can no longer block deterministic verification.
- Remaining tsc errors — 3 total, live-measured this session (see Section 3 for verbatim text): `src/__tests__/runner-health-no-claim.test.ts:390,13` (TS2352, null→object cast), `src/__tests__/runner-health-no-claim.test.ts:396,77` (TS2352, Socket.connect override signature mismatch), `src/courier/courier-loop.ts:549,23` (TS2367, comparing two disjoint string-literal adapter-id types — worth a quick look, may indicate dead/unreachable branch logic in courier-loop.ts).
- Quarantine worktree `anus-context-assembly-v0` was checked out at `225e461` while its branch tip is `b64d465` — unexplained, uninvestigated.
- Nothing has been pushed; the branch is ~90+ commits ahead of origin/main.
- The disposable courier fixture at `C:\Users\user\.atlas\quarantine\disposables\courier-proof-2026-08-03` had a UTF-8 BOM baked into its committed `.cursor/cli.json`, which made Cursor Agent die with NO_TERMINAL_EVENT; fixed and committed in the fixture as `6fe3360`. Do not revert that.

## 5. Next 3 steps

1. **GROUND-TRUTH CORRECTION:** the brief this handoff was drafted from describes Context Assembly v0 as CEO-frozen on HOLD with four pre-merge fixes still outstanding. Live `git log` shows this is stale — `cebb67b` (merge: Context Assembly CLI v0, Intake→Resolve→Assemble) and `b005359` (merge receipt: "CEO ACCEPT + MERGE verified. Tip cebb67b; rollback ffa9b0c.") are both already on this branch. Per `docs/atlas-cto/RECEIPT-2026-08-04-context-assembly-cli-v0-merge.md`, verification at merge time was focused 76/76 and full sharded 150 files / 1484 pass / 2 skip, and the receipt's own "Next restart" note says: prove one real business workflow end to end (CEO message → Goal Intake → Project Resolution → Context Assembly → bounded read-only Integronix website audit) using the existing pipeline only, and do not create another contract before that proof. Treat that proof-run as the actual next step in this slot, not the four pre-merge fixes (those applied to the pre-merge state and are superseded).
2. Fix the stale nested `evidencePack.verifierResult` snapshot and decide on restoring `node_modules/.bin` shims to clear the 2 environment-only test failures.
3. M3D Tasks 3-7 (durable effect journal, full-root migration rehearsal, non-executed cutover packet, CEO gate) remain OPEN but intentionally PAUSED under the single-restart-path decision; do not resume without an explicit CEO instruction.

## 6. Blockers needing CEO or the orchestrator chat

- Push / merge to main: nothing is pushed; requires explicit CEO approval.
- ~~Context Assembly merge decision (CEO gate; Planning must not start before it).~~ **RESOLVED per live git log** — CEO ACCEPT+MERGE already recorded (`cebb67b`, receipt `b005359`). Remaining open item is the proof-run described in Section 5.1, not a merge decision.
- Telegram bot-token rotation — only the CEO can do it via BotFather.
- Standing debt: 460 AZN credited-pending.
- `free-claude-code` audit verdict was ADAPT SELECTED COMPONENTS (never as brain/authority/memory/verifier/scheduler); no action taken, nothing installed — the CEO decides whether to park it or wire it as a long-tail/local-model backend behind `model-router.ts`.
- Integronix Proof Pack v1 spec delivered but blocked on CEO inputs: written permission to name SOCAR / UEFA / F1 BCC (or the decision to drop them), site-access and photography permission per facility, per-person consent for team portraits, actual certificate documents, defensible SLA numbers per Care tariff, and confirmation of the top-20 product set.
