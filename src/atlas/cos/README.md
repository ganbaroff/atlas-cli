# Chief-of-Staff (CoS) surface

## Purpose

A **read-only projection** that truthfully tells the CEO — derived from real
authorities (exec-graph, control-plane, git, heartbeat, spend), never
hand-fed — what's waiting on his decision, what shipped, what's drifting,
what's stale. Replaces the manual morning-brief pattern where a human-typed
`awaiting CEO` string could lie or drift from reality (see ADR-0008).

Every displayed item is categorized into exactly one of six fixed
categories — **CEO DECISION REQUIRED · WAITING ON EXTERNAL OWNER · BLOCKED ·
DRIFT / STALE SIGNAL · RECENTLY VERIFIED · NO ACTION REQUIRED** — and every
item carries its source authority, source ref (task id / branch / file,
when applicable), status, evidence freshness (or `UNKNOWN`), and why it's
shown. The full binding contract is
`docs/atlas-cto/SPRINT-CHIEF-OF-STAFF-V1.md`'s "BRIEF CONTRACT" section.

## Modules (pure vs impure boundary)

- `facts.ts` — **PURE.** `gatherCosFacts(providers?)` projects exec-graph
  `statusSummary()`/`listTasks()` + control-plane mode + spend into
  `{waiting, shipped, rejected, counts, controlMode, spend, generatedAt}`.
  Injectable providers for tests; defaults read the live authorities.
- `drift.ts` — **PURE.** `detectDrift(inputs)` turns already-observed
  `DriftInputs` (git ahead/behind, heartbeat age, graph-verify result, stuck
  non-terminal tasks) into `DriftFinding[]`. An unobservable input (`null`)
  becomes an `'unknown'`-severity finding, never a crash or a silent drop.
- `brief.ts` — **PURE.** `composeCosBriefItems(facts, drift)` groups
  everything into the six fixed categories (deterministic order); `formatCosBrief(items)`
  renders the Russian voice text; `composeCosBrief(facts, drift)` does both.
- `gather.ts` — **THE ONLY IMPURE MODULE HERE.** Read-only real-environment
  readers that produce `DriftInputs`: `gatherGitDrift` (git rev-parse/
  rev-list, no fetch), `gatherHeartbeatAge` (reads `heartbeat.md`),
  `gatherGraphVerifyOk` (rebuilds an in-memory snapshot to compare — never
  writes), `gatherStuckTaskCandidates` (non-terminal tasks + age).
  `gatherLiveDriftInputs()` composes all four.

`facts.ts`/`drift.ts`/`brief.ts` never touch `Date.now()`, `Math.random()`,
`fs`, or `child_process` directly — only `gather.ts` does, and only to read.

## AUTHORITY BOUNDARY (ADR-0008)

This surface is a **projection, not an authority**. It never writes to
exec-graph/control-plane/spend state — confirmed every run via
`git status --porcelain state/` (must be empty). If a future change here
ever wants to "just cache this computed value somewhere," that is the
second-authority trap the CEO explicitly forbade for this release — keep
everything derived-on-read.

Commitment-capture (due-dates, "overdue" obligations with their own
lifecycle) is explicitly **cut** from this release (CEO rule 7,
2026-07-18). `WAITING ON EXTERNAL OWNER` is derived from exec-graph state
alone (an escalated/evidence-submitted task not owned by
`ceo`/`external-cto`/`atlas`) — never from a new commitment store.

## CLI surface

- `atlas cos brief [--json]` — the six-category brief (`src/cli.ts`,
  "Chief-of-Staff (CoS) surface" section).
- `atlas cos drift` — drift findings only, `"No drift detected."` when empty.

Both gather live inputs via `gather.ts`, compose via `facts.ts`/`drift.ts`/
`brief.ts`, and print — no state is written by either command.

## Failure behavior

Every `gather.ts` reader fails closed to `null` (or `{ageHours: null}`) on
any error — a missing upstream, a corrupt ledger, a missing heartbeat file,
git not installed — never throws. `drift.ts` turns any `null` input into an
`'unknown'`-severity finding rather than silently omitting the category.
`facts.ts` has no fallback path of its own: exec-graph/control-plane/spend
reads are expected to succeed in-process (same assumption `status-report.ts`
makes) — a caller wrapping `gatherCosFacts()`/`atlas cos brief` in its own
try/catch (as `telegram.ts` does for other exec-graph reads) is the
degradation boundary, not this module.

## Known limitations (documented, not silently hidden)

- **No owner-string normalization.** `CEO_DECISION_OWNERS` (reused from
  `exec-graph/brief.ts`) is a raw case-sensitive string match. A task
  created/reassigned with an unexpected casing or stray whitespace in
  `owner` would misclassify. Shared with `/status` — fixing only here would
  create a second, diverging classification, which the sprint explicitly
  forbids. Fix belongs in `exec-graph/brief.ts` if it's ever fixed.
- **No item cap.** Unlike `exec-graph/brief.ts` (`MAX_LIST_ITEMS = 5` +
  overflow marker), `brief.ts` here renders every waiting/shipped/rejected
  item with no truncation. Not misleading at the current graph size (10
  tasks); will need a cap + overflow marker before the graph grows much
  further.
- **`RECENTLY VERIFIED`/shipped items carry no per-task age** — `ShippedItem`/
  `RejectedItem` (`facts.ts`) don't expose a timestamp, so their
  `evidenceFreshness` is always `'UNKNOWN'`. Honest (the contract's own
  documented escape hatch) rather than fabricated, but it also means the
  category name "recently" isn't literally enforced — a task verified
  months ago renders identically to one verified an hour ago.

## Tests

`src/__tests__/cos-facts.test.ts`, `cos-drift.test.ts`, `cos-brief.test.ts`
(pure, fixture-driven), `cos-gather.test.ts` (real repo/graph/filesystem,
loose assertions — mirrors `repo-watch.test.ts`'s real-environment
convention rather than mocking `child_process`/`fs`).

## Upstream / downstream

- **Upstream (imports from):** `exec-graph/api.ts`, `exec-graph/contracts.ts`,
  `exec-graph/ledger.ts`, `exec-graph/brief.ts` (`CEO_DECISION_OWNERS` only),
  `atlas/control-plane.ts`, `atlas/spend-tracker.ts`, `atlas/path-util.ts`.
- **Downstream (imported by):** `src/cli.ts`'s `cos` command group only, as
  of W4. Not yet wired into `telegram.ts`'s `/status` or the 08:45 morning
  brief (see `docs/runbooks/morning-brief-and-status.md`) — that remains
  future work once this surface has a live-Telegram verification pass.
