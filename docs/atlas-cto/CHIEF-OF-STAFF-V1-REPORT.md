# Compound Sprint Report — Chief-of-Staff Surface V1

**Date:** 2026-07-19. **Branch:** `feat/arsenal-wiring`, 9 commits ahead of
origin, NOT pushed (awaiting explicit go-ahead — see "RESULT").
**Owner:** Atlas (External CTO), self-approved per CEO's "form the next
sprint yourself" directive, North Star = ATLAS is a Chief-of-Staff/CTO
operating system.

## PLAN

Give the CEO a projection that truthfully answers, derived from real
authorities and never hand-fed: what needs your decision, what shipped,
what's drifting, what's stale. Full plan: `SPRINT-CHIEF-OF-STAFF-V1.md`.
Six waves: W1 facts read-model, W2 drift detectors, W3 brief composer, W4
CLI + live-graph proof, W5 hardening + adversarial review, W6 docs.

## DO

- **W1** (`8645fed`) — `facts.ts`: pure `gatherCosFacts()` projecting
  exec-graph/control-plane/spend into waiting/shipped/counts/mode/spend.
- **W2** (`5c0a81b`) — `drift.ts`: pure `detectDrift()`, four detectors
  (unpushed-commits, graph-verify-failed, stale-heartbeat, stuck-task),
  unobservable input → `'unknown'` finding, never a crash.
- **W3** (`0b07c53`) — `brief.ts`: composes facts+drift into the six fixed
  categories, per-item source authority/ref/status/freshness/why.
- **W4** (`f8be853`) — `gather.ts` (the sole impure module: read-only git/
  heartbeat/graph-verify/stuck-task readers) + `atlas cos brief|drift` CLI.
- **W5 fix 1** (`df948c1`) — rejected tasks were invisible in the brief
  (facts.ts never tracked them); added `CosFacts.rejected`, mapped to NO
  ACTION REQUIRED. Found by running the CLI against the real graph, not by
  inspection.
- **W5 fix 2** (`93f8f3f`) — independent adversarial review + cold-reader
  pass (two fresh-context agents, given only the live brief output, asked
  to actively try to break trust in it) found and fixed two real issues —
  see CHECK below.
- **W6** (this commit) — `src/atlas/cos/README.md` (module contract), ADR-0008,
  `docs/runbooks/morning-brief-and-status.md` updated (new surface, marked
  not-yet-wired), `docs/architecture/ATLAS-ARCHITECTURE.md` updated, this report.

## ACT (what the live runs actually did)

Every wave from W3 onward was proven against the real exec-graph, not
fixtures: `node dist/cli.js cos brief` / `cos drift` run repeatedly through
the sprint, each time followed by `git status --porcelain state/` to prove
zero mutation. The live 10-task graph (1 verified, 2 rejected, 6 closed, 1
escalated) was the test bed throughout — including catching the rejected-
task gap (W5 fix 1), which fixtures alone would not have surfaced since the
unit tests were written against the same (incomplete) mental model as the
code.

## CHECK (adversarial + cold-reader, run independently, not self-graded)

Two agents, fresh context, given only the actual generated brief text (not
the code) and told to actively hunt for the contract's own named failure
modes (false urgency, stale evidence, duplicate authority, misleading
language) and to cold-read it as the CEO would. Findings, triaged:

- **Fixed — real bug:** `evidence-submitted` tasks were owner-split like
  `escalated`, so a hand-owned task awaiting Atlas's own `atlas hand verify`
  rendered as "handed off to owner 'hand:x'" — backwards, since
  `submitReceipt()` never reassigns owner and the outstanding action was
  never external. My own module doc comment had claimed parity with
  `/status` that wasn't actually true for this status; both the code and
  the comment are fixed.
- **Fixed — real, confirmed by both reviews independently:** `NO ACTION
  REQUIRED`'s single count blended closed successes with rejections (a
  concrete real example: ADR-0001-closed sitting next to ADR-0002-rejected
  under one "no action" header). Section headers now break down mixed
  statuses inline.
- **Checked, documented, deliberately not changed:** owner-string
  case/whitespace normalization (shared gap with `/status`, fixing only
  here would create a second, diverging classification — the exact trap
  this sprint was told to avoid); no item-count cap yet (not misleading at
  10 tasks, will need one before the graph grows).
- **Surfaced, out of scope:** one rejected task's title contains what
  looks like a leaked filesystem path (`C:/Program Files/Git/...`) — a
  pre-existing exec-graph data-quality issue, not a `cos/*` bug; this
  surface reads titles verbatim by design and is architecturally forbidden
  from mutating the graph to "clean" it.

## COMPARE (plan vs delivered)

All 6 waves delivered as planned. One addition beyond the original plan:
the `rejected` category was not explicitly named in the original W1/W3 plan
text (which said "verified + closed" for shipped) — its absence was a real
gap, not a deferred scope item, so it was added mid-sprint rather than
punted, since leaving rejected tasks invisible would have shipped a brief
that fails its own stated purpose (truthfully tell the CEO what happened).
Everything else matches plan scope exactly, including the explicit CEO-rule-7
cut (commitment-capture stayed out).

## LEARN

- Running the actual CLI against the real graph, every wave, caught a real
  correctness gap (rejected tasks) that pure-fixture unit tests did not —
  because the tests were written by the same author with the same blind
  spot as the code. "Runtime proof, not fixtures-only" (the contract's own
  W4 requirement) earned its keep.
- Self-review missed two real issues that two independent fresh-context
  reviews caught in one pass each, specifically because they were fresh —
  no attachment to having just written the code, no rationalizing "well
  actually that owner split makes sense because...". The sprint contract's
  explicit "highest-risk wave" framing for the brief composer was correct.
- Reusing an existing, shipped authority (`CEO_DECISION_OWNERS`) instead of
  re-deriving a new classification avoided inventing a second, potentially
  diverging rule — but it also meant inheriting that authority's existing
  gaps (owner normalization) verbatim. Reuse-don't-duplicate is still the
  right call; it doesn't make the reused thing perfect.

## RESULT

- Suite: 569 passed / 0 failed / 2 skipped (baseline was 536 at sprint
  start). `npx tsc --noEmit`: clean. `npm run build`: clean.
- `atlas cos brief` / `atlas cos drift` are real, runnable, truthful against
  the live graph — confirmed by repeated real runs throughout, not just at
  the end.
- Zero graph/state mutation from any wave or any run — `git status
  --porcelain state/` empty every time it was checked, including the final
  check after this report.
- **NOT pushed.** 9 commits sit locally on `feat/arsenal-wiring`, ahead of
  `origin/feat/arsenal-wiring` by 9. Per this session's explicit standing
  instruction, `git push` is a stop-and-ask action regardless of the
  sprint's own "push after W6" default — reversible local work is done,
  push is the next explicit step pending CEO go-ahead.
- **Not done (explicitly out of this sprint's scope, not an oversight):**
  wiring `cos/*` into the live Telegram `/status`/morning brief
  (`telegram.ts`, `briefing.ts`) — this sprint shipped the surface and
  proved it locally; making it the thing the CEO actually reads on his
  phone is a separate future pass with its own live-Telegram verification
  requirement.
