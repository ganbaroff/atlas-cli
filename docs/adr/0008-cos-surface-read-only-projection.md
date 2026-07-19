# ADR-0008 — Chief-of-Staff Surface V1: read-only projection, NOT an authority

- **Status:** Accepted
- **Date:** 2026-07-19
- **Deciders:** CEO Yusif Ganbarov (brief contract + scope cuts, 2026-07-18) + Atlas-CTO (design, self-approved compound sprint)
- **Supersedes/relates:** ADR-0001 (exec-graph = one task authority), ADR-0006 (Hand Contract V0), ADR-0007 (swarm-exec)

## Context

The existing CEO-facing status surfaces (`status-report.ts`'s `/status`,
`briefing.ts`'s 08:45 morning brief, `exec-graph/brief.ts`'s
`formatStatusMessage`/`formatMorningBriefSection`) mix two things: data
genuinely derived from an authority (exec-graph counts, health checks,
spend) and at least one hand-typed field — `briefing.ts`'s
`MorningBriefingInput.awaitingCeo` is a plain string a caller composes by
hand. A hand-typed field can lie or silently drift from what's actually
true, which undermines the whole point of a status surface: the CEO reading
it needs it to be trustworthy without independently re-verifying every line.

The CEO's own framing (2026-07-18, self-approved sprint): ATLAS should be a
Chief-of-Staff / CTO operating system, not a bot/swarm/skills collection.
That requires a projection that can answer, truthfully and without manual
input, "what needs your decision, what shipped, what's rotting" — every
time, not just when someone remembers to type an accurate brief.

## Decision

**The Chief-of-Staff surface (`src/atlas/cos/*`) is a read-only projection
over existing authorities — it is never itself an authority.** It composes
already-shipped, already-tested read paths (`exec-graph/api.ts`'s
`statusSummary()`/`listTasks()`, `atlas/control-plane.ts`'s control mode,
`atlas/spend-tracker.ts`'s daily spend) plus new read-only observations
(git ahead/behind, `heartbeat.md` age, `graph verify` result, non-terminal
task age) into a fixed six-category brief. It writes nothing:

- `facts.ts` / `drift.ts` / `brief.ts` are pure functions — no I/O, no
  `Date.now()`/`Math.random()`, deterministic given their inputs.
- `gather.ts` is the sole impure module, and every reader in it is
  read-only: `git rev-parse`/`git rev-list` (no `fetch`/`push`), a
  filesystem read of `heartbeat.md`, an in-memory ledger rebuild for
  comparison (`readSnapshotFile()`/`rebuildSnapshot()`/`snapshotsEqual()` —
  none of which write), and `listTasks()`.
- No new state directory, no cache file, no second copy of exec-graph data
  persisted anywhere. Verified every wave via `git status --porcelain
  state/` returning empty.

**Categorization reuses existing authority, it does not invent a second
one.** `CEO_DECISION_OWNERS` (`exec-graph/brief.ts`) is imported, not
re-derived — the same owners (`ceo`, `external-cto`, `atlas`) count as "your
call" here as they do in `/status`. Escalated tasks are owner-split
identically to `exec-graph/brief.ts`'s `splitEscalatedByOwner()`.
Evidence-submitted tasks are **not** owner-split (see "Consequences" —
this was a real bug caught during the sprint, not a design choice made
fresh here) — matching the fact that `exec-graph/brief.ts` never
owner-splits `evidence-submitted` either.

**Commitment-capture is explicitly cut from this release** (CEO rule 7,
2026-07-18). `WAITING ON EXTERNAL OWNER` / any "overdue" framing is derived
purely from exec-graph state (an escalated/evidence-submitted task whose
owner isn't a CEO-decision owner) — never from a new due-date/obligation
store. That returns as its own future release with its own
draft/confirm/rollback contract, per the CEO's explicit instruction not to
smuggle it in to make this wave easier.

## Consequences

- A new CLI surface, `atlas cos brief [--json]` / `atlas cos drift`
  (`src/cli.ts`), gives a truthful, graph-derived brief today — but it is
  **not yet wired into the live Telegram `/status` or the 08:45 scheduled
  brief**. Those still use the pre-existing hand-composed
  `awaitingCeo`/exec-graph-appendage pattern this sprint set out to replace;
  wiring `cos/*` into `telegram.ts` is deliberately left for a future pass
  once this surface has a live-Telegram verification receipt, not just a
  local CLI one.
- An independent adversarial review + cold-reader pass (run against the
  actual live-graph output, not the code) caught a real classification bug
  before it ever shipped to a live surface: evidence-submitted tasks were
  initially owner-split the same as escalated, which meant a hand-owned
  task awaiting Atlas's own `atlas hand verify` step rendered as "handed
  off" — implying the CEO wasn't the one who needed to act, when in this
  case Atlas (a CEO-decision owner) was. Fixed before commit; documented as
  the concrete reason this sprint required independent review, not just
  self-review, before closing a wave the CEO explicitly called
  highest-risk.
- The same review pass found and fixed a header-level misleading-impression
  gap: `NO ACTION REQUIRED` blends `closed` (success) and `rejected`
  (failed attempt) tasks under one neutral count. Section headers with more
  than one distinct status now spell out the breakdown inline (e.g. `(8:
  closed 6, rejected 2)`) so a headers-only skim can't miss a rejection.
- Live-graph runs surfaced a genuine pre-existing data-quality issue unrelated
  to this sprint's code: one rejected task's stored title contains what
  looks like a leaked filesystem path fragment (`C:/Program Files/Git/...`).
  Left as-is — this projection reads and displays exec-graph titles
  verbatim; "fixing" a task's stored title would be a state mutation, which
  this surface is architecturally forbidden from doing. Flagged for
  whoever owns exec-graph task-creation hygiene.
- Known, documented (not silently hidden) limitations: no owner-string case/
  whitespace normalization (shared with `/status`, not fixed here to avoid
  a second, diverging classification); no item-count cap yet (unlike
  `exec-graph/brief.ts`'s `MAX_LIST_ITEMS`), acceptable at the current
  10-task graph size but will need one before the graph grows further.

## Validation

Live run against the real graph (not fixtures): `atlas cos brief` correctly
shows the one escalated task (MIRT) as `WAITING ON EXTERNAL OWNER` (owner
`volaura-product-chat`, per ADR-0004's classification — not a CEO decision)
while independently flagging it as a `stuck-task` drift finding (escalated
52+ hours, past the 48h threshold) — two different, both-true signals about
the same task, not a contradiction. `git` correctly reports the true
unpushed-commit count; `heartbeat-file` correctly reports ~553h stale
(matches `heartbeat.md`'s `Updated: 2026-06-26T16:16:41.372Z` against the
sprint date). `git status --porcelain state/` returned empty after every
real run.

Tests: full suite 569 passed / 0 failed / 2 skipped; `npx tsc --noEmit`
clean; `npm run build` clean.

## References

- `docs/atlas-cto/SPRINT-CHIEF-OF-STAFF-V1.md` — the sprint plan + binding BRIEF CONTRACT.
- `docs/atlas-cto/ATLAS-STATE-NOW.md` — sprint state, wave-by-wave.
- `src/atlas/cos/README.md` — module contracts, authority boundary, known limitations.
- ADR-0001 (exec-graph single authority), ADR-0006 (Hand Contract V0), `exec-graph/brief.ts`.
