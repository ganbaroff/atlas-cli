# Atlas — Full Handoff Brief (renewed 2026-08-01, for the Cursor seat)

**Renewed by:** terminal-atlas-executor session, 2026-08-01. The previous
version of this file (written 2026-04-26) described a dead architecture —
a bare Mastra CLI scaffold. Everything below is re-verified against the
repo on this date. If you find this file drifting from reality again,
re-derive it from `docs/atlas-cto/ATLAS-STATE-NOW.md` (the live canon),
not from memory.

**Repo:** `C:\Users\user\OneDrive\Documents\GitHub\ANUS`
**Branch:** `codex/atlas-cost-router-design` (not `main`)

## 1. What Atlas is today (not April)

Atlas is a personal super-assistant ("Jarvis") for CEO Yusif Ganbarov, built
as a TypeScript core in this repo. A Telegram bot (chat persona + agent
brain) is deployed on Railway.

- **Heart = exec-graph.** An append-only task ledger. A task closes ONLY via
  deterministic verification with receipts (verify-before-done gates) — never
  via model self-report. All mutation now runs through one typed, exclusive,
  strict transaction (`src/atlas` exec-graph module, commit `4051a68`):
  read/validate/append/flush happen inside a single held lock; persistence
  failure throws instead of silently degrading.
- **Cost-router:** free providers first, paid last. Provider order per code
  comment in `src/model-router.ts:57`: NVIDIA → Vertex → Azure. **Vertex is
  NOT implemented — comment-only**; no Vertex code path exists in `src/`.
  Live providers are still held off (`M2 VERIFIED LOCAL` — fake-provider
  integration only; no metered spend active).
- **ZenBrain emotional memory is SHIPPED.** `src/atlas/emotion.ts` reads the
  CEO's emotional state from a message using a PAD model (valence/arousal/
  dominance) and computes `decayMultiplier = 1.0 + intensity * 2.0` — higher
  emotional intensity extends memory retention.
- **Operator/hands harness is partial.** A browser hand exists
  (`src/hands/browser-adapter.ts`, `browser-actions.ts`,
  `supervised-assist.ts`, manifest `src/hands/manifests/browser-foreground.json`)
  but is scoped to local/foreground browser actions — no cloud-to-local-PC
  execution path is built yet.
- **Mastra correction:** `@mastra/core` IS installed and IS instantiated —
  `src/atlas/mastra-agent.ts:54` calls `new Agent({...})`. But that file is
  explicitly marked **dead prod code, kept import-compatible** (see comment
  in `src/tools/registry.ts:13`). The live agent path runs on Vercel AI SDK
  providers via `src/model-router.ts` / `src/agent.ts`, not through Mastra.
  Do not "fix" mastra-agent.ts back into the live path without checking with
  the CEO first — it was deliberately retired.
- **swarm-exec CLI exists and is real**, not aspirational:
  `src/swarm-exec/{intake,commands,executor,run-bundle,completion-policy}.ts`
  backs `atlas swarm-exec intake|commit|run`.

## 2. Current state (verified as of this renewal)

- Branch: `codex/atlas-cost-router-design`.
- HEAD before this renewal: `e5ea116` "docs(atlas): Record M3D Task 2
  mutation transaction completion", on top of `4051a68` "feat(exec-graph):
  Centralize mutations in one exclusive strict transaction".
- **90 commits ahead of `origin/main`** — all UNPUSHED. Pushing is
  CEO-gated; do not push.
- Working tree at time of this renewal had exactly five pre-existing dirty
  paths (see Hard Rules below) — verified via `git status --porcelain=v1`.
- Full test suite last verified in the canon doc at commit `4051a68`:
  **1348 pass / 0 fail / 2 skipped**, via a two-shard closer run. `npm test`
  (single unsharded `vitest` run) has stalled past 18 minutes at least twice
  for an unknown reason — prefer sharding (see §6).
- **M3D implementation plan** (`docs/superpowers/plans/2026-07-30-m3d-cutover-readiness-and-rollback.md`),
  checkbox-verified this session:
  - **Task 1** (classified state-store inventory + activation contract) —
    **all items `[x]` DONE.**
  - **Task 2** (centralize exec-graph mutation transaction) — **all items
    `[x]` DONE** (commit `4051a68`).
  - **Task 3** (shared durable effect journal) — **OPEN**, all items `[ ]`.
  - **Task 4** (rehearse complete root migration in isolation) — **OPEN**.
  - **Task 5** (one retained current full-root rehearsal) — **OPEN**.
  - **Task 6** (prepare non-executed physical cutover packet) — **OPEN**.
  - **Task 7** (stop for Yusif's physical-cutover decision) — **OPEN**; no
    physical cutover may execute until Yusif explicitly approves that
    packet — do not infer GO from any earlier approval.
- `STATE_STORES` (`src/atlas/state-root.ts:92-116`) enumerates 22 classified
  root-managed store families (exec-graph, evidence, goal-budgets,
  swarm-runs, operator-state, operator-runs, intake-drafts, task-results,
  cost-router, learning, instance-lease, queue-auth, provider-health,
  spend-receipts, notify-queue, alert-state, emotion-audit, repo-watch,
  breadcrumbs, shell-audit, opsboard-exchange, pause-control, runner-log).
  Only two — **pause-control** and **runner-log** — remain unmigrated
  (external writers), deferred to cutover per canon.

## 3. Strategy rule (CEO decision 2026-08-01)

Build ONLY differentiators:
- (a) receipt-driven honest verification layer (exec-graph gates — this is
  the rare card);
- (b) free-credit-first cost routing;
- (c) CEO-fit protocol (Russian caveman reports, ADHD-tuned delivery);
- (d) emotional memory (ZenBrain/PAD).

TAKE ready-made for commodity surfaces: multi-channel gateway,
control-panel UI, execution sandboxes. Market context: OpenClaw has ~384k
GitHub stars but also CVE-2026-33579 (CVSS 9.4), marketplace malware
reports, and unreliable memory. Nous Hermes Agent covers 300+ models and 5
sandbox backends. Our differentiation is verification; theirs is
distribution — don't compete on distribution, absorb it.

CEO vision: a universal agent HQ pluggable into his other projects (trader,
VOLAURA, opsboard); an autonomous swarm under an orchestrator with hard
token budgets, reporting to the CEO. LATER: open-source this repo —
requires a full secret scrub, English-only docs throughout, and a repo
rename off "ANUS."

## 4. Roadmap — 5 sprints

- **S1** — M3D Task 3: durable effect journal. Must prevent duplicate
  external side effects across crash windows (derive stable operation IDs,
  flush `started` before invoking effects and a terminal receipt after,
  refuse automatic replay of `outcome_unknown`).
- **S2** — M3D Tasks 4-5: full-root migration rehearsal — build an isolated
  fixture root first, then run exactly one retained-copy rehearsal against
  real state in a new generated directory (M3C machinery), fresh-verify
  every manifest and store invariant, prove no resolver/runner/scheduler/
  Railway/Git-tracking side effect occurred.
- **S3** — M3D Tasks 6-7: non-executed physical cutover packet (exact
  preflight/readback/rollback command file, path-containment and
  junction-realpath guards, manifest schemas for bundles/patches/scheduler
  XML/Railway binding) plus the explicit CEO GO gate — present evidence,
  do not infer approval, execute nothing until Yusif approves the packet.
- **S4** — Local state-root activation with a recorded rollback path. CEO
  gave conditional pre-approval 2026-07-31 for LOCAL activation, contingent
  on the S2 rehearsal returning green. Cloud/Railway stays untouched at
  this stage. Physical cutover of live state remains **NO-GO** until then.
- **S5** — Assembly-from-ready: research, then integrate a ready-made
  control panel and multi-channel gateway, sandboxed BEHIND the
  verification layer — not built from scratch. This is the "take
  ready-made for commodity" half of the strategy rule landing in code.

## 5. HARD RULES for any agent in this repo (verbatim — these are law)

- **NEVER stage/commit/revert** these five pre-existing dirty paths:
  `docs/atlas-cto/FABLE-PROTOCOL.md`, `state/exec-graph/graph.json`,
  `state/exec-graph/ledger.jsonl`,
  `docs/atlas-cto/VOLAURA-LEARNING-ENGINE-HANDOFF-2026-07-25.md`,
  `state/evidence/`. Stage files by name only — never `git add -A` or
  `git add .`.
- **NO push, NO merge to main, NO deploy, NO Railway/scheduler change**
  without explicit CEO approval.
- **Secrets never appear in chat, code, commits, or docs** — this project
  has a real history of leaked keys and forced rotations. Read env vars by
  NAME only; never print or echo values.
- **Nothing is "done" without receipts in the same session**: focused
  tests + sharded full suite + `npx tsc --noEmit` + `git diff --check`.
  TDD discipline: new behavior starts with a RED test before the GREEN
  implementation.
- **Tests must never touch live `state/`** — use temp dirs (`mkdtempSync`)
  only. Do not leave stray lock files in `state/exec-graph`.
- **Do not enable `ATLAS_STATE_ROOT_REQUIRED`** or touch activation
  semantics in `src/atlas/state-root.ts` — activation stays gated behind
  the S2 rehearsal + explicit CEO GO (M3D plan, Task 7).
- **New documentation is English only.**
- **Read-first on any resume:** `docs/atlas-cto/ATLAS-STATE-NOW.md`, the
  M3D plan
  (`docs/superpowers/plans/2026-07-30-m3d-cutover-readiness-and-rollback.md`),
  and `C:\Projects\VOLAURA\memory\atlas\CURRENT-COMPACT.md`.

## 6. How to run

```
npm run dev                     # tsx src/cli.ts — dev CLI entry
npm run build                   # tsup bundle + manifest copy
npm test                        # vitest — prefer sharded, see below
npm run typecheck               # tsc --noEmit
npm run atlas:m3c-rehearse      # tsx scripts/rehearse-preserved-exec-graph.mts
```

Prefer sharded test runs over a single `npm test` (the unsharded run has
stalled past 18 minutes twice, cause unknown):

```
npx vitest run --shard=1/2
npx vitest run --shard=2/2
```

Key CLIs: `atlas swarm-exec intake|commit|run` (backed by
`src/swarm-exec/*`); `npm run atlas:m3c-rehearse` for the M3C preserved-copy
rehearsal path.

State location pre-activation: legacy per-store paths, see the
`STATE_STORES` map and `resolveStateDir()` in `src/atlas/state-root.ts`
(each store optionally overridable by an env var named in the map; stores
mapped to `undefined` have no env override and use a hardcoded legacy
directory at their call site).

## 7. Known debts & incidents

- `npm test` (single unsharded run) has stalled past 18 minutes at least
  twice; root cause not diagnosed. Use sharded runs.
- M3D Task 2 residual risks noted in canon: the "loser" error kind in lock
  contention is unasserted by a test; the append-specific persist-failure
  catch path is untested; there is no lock heartbeat versus the 30s
  stale-lock reclaim window.
- Bot-token rotation is pending (CEO/BotFather action — token was
  previously exposed via a Railway variables table).
- Codex quota resets 2026-08-06.
- Standing CEO debt note: 460 AZN credited-pending — keep surfacing this in
  any CEO-facing status until the CEO marks it closed.
- Open secret-rotation list lives in Atlas memory outside this repo — do
  not enumerate secrets in this file.

## 8. Canonical documents (read these, don't re-derive from this file alone)

- `docs/atlas-cto/ATLAS-STATE-NOW.md` — live canon, updated most recently.
- `docs/atlas-cto/ATLAS-MASTER-PLAN.md` — forward plan.
- `docs/superpowers/specs/2026-07-30-atlas-cost-router-design.md` — cost
  router contract.
- `docs/superpowers/plans/2026-07-30-m3d-cutover-readiness-and-rollback.md`
  — the M3D task list this brief summarizes in §2 and §4.
- `docs/atlas-cto/FABLE-PROTOCOL.md` — seat protocol (currently a dirty,
  uncommitted local file — do not stage it, see §5).
- `C:\Projects\VOLAURA\memory\atlas\CURRENT-COMPACT.md` — cross-repo Atlas
  resume truth.
- `C:\Projects\VOLAURA\memory\atlas\codex-loop.md` — cross-instance journal.
