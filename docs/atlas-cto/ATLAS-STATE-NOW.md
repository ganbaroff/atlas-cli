# ATLAS — STATE NOW

Updated: 2026-07-30 Baku

## One sentence

ATLAS is preserved and recoverable, but physical consolidation and live
multi-provider research remain **NO-GO**. Durable foundation M1 and fake-only
Cost Router M2 are verified locally. Current work is M3 shadow consolidation:
copy/replay/outcome-diff proof without physical move. No live provider traffic,
push, merge, deployment, scheduler cutover, or live-state activation is active.

## CEO dashboard

| Track | Status | Evidence | Next gate |
|---|---|---|---|
| Runner recovery | **DONE** | verified checkpoint `243864d`; source fix `57042ed` | preserve until integration |
| Legacy Atlas preservation | **DONE** | bundle, ZIP, patch, manifest, dirty worktree ref | no deletion |
| State root resolver | **REPAIR VERIFIED** | accepted branch history through `f017add`; 22/22 tests, typecheck, direct CWD probe | preserve before call-site migration |
| Cost Router design | **ACCEPTED** | two Opus reviews closed; roadmap and ceilings approved | implement package-by-package |
| Cost Router implementation | **M2 VERIFIED LOCAL** | `23e8574`; 97/97 focused tests, typecheck, runtime refusal-receipt enforcement | keep live providers off |
| Fable session router | **REPAIRED GLOBAL** | stale `/model` and thread-context regressions fixed; 32/32 hook tests | use Opus for contaminated threads |
| Shadow consolidation | **M3A REPAIRED / M3B NOW** | `0dfb15d` + `28c8f79`; 10/10 focused and 104/104 regression tests | isolated synthetic copy/replay |
| Physical consolidation | **NO-GO** | nested worktrees, unique legacy state, runtime bindings remain | completed shadow rehearsal plus CEO cutover gate |
| Subscription research | **OFF** | Perplexity interactive access only; no durable adapter proof | public synthetic live gate |
| Research swarm | **OFF** | `RESEARCH_ONLY_LIMITED` | two-provider `READY_FOR_RESEARCH` gate |
| Product/learning expansion | **PARKED** | not critical path | after stable One-Atlas foundation |

## Exact current point

We are at **Milestone M3 — Shadow Consolidation**. M1 durable foundation and
M2 safe router are complete on the local
`codex/atlas-cost-router-design` branch. Active package: M3B.

1. **Done:** define a strict explicit-path shadow manifest and semantic
   comparator; reject empty authoritative input;
2. **Now:** prove copy/replay/outcome parity in temporary fixtures;
3. execute rollback, verify it, then emit its receipt without switching any
   live resolver;
4. only then rehearse against a separately preserved copy of current state.

## External review closure

Source: one sequential `claude-opus-5` no-tool review stream with two
responses. Two Fable 5 attempts returned server-side `529` and produced no
review.

Codex disposition:

- **ACCEPT:** durable per-goal router record; goal-level ceilings; objective
  model-free route predicates; one T3 escalation per task; destination-bound
  privacy; explicit error buckets; no local-model substitute for unavailable
  research.
- **MODIFY:** keep one scheduled resume event at a time with bounded
  inspections and expiry. Do not require only one total inspection when a
  legitimate managed job is still running.
- **REJECT:** claims that full design had no pre-send privacy gate or treated a
  browser subscription as an API. Full design already separated both, but its
  destination/retention binding needed strengthening.

M2 implementation closure:

- **ACCEPT WITH REPAIR:** Fable/Opus integration report and Sonnet receipts were
  complete enough to audit, but not completion evidence by themselves.
- Codex reproduced 95/95 tests and clean typecheck, then independently ran the
  two omitted proof slices: 9 refusal-receipt tests and 3 source-marker tests.
- **ACCEPT:** all module-owned refusal paths attach valid receipts; empty
  `sources` is rejected while `NOT_APPLICABLE` is accepted.
- **ACCEPT AND REPAIR:** exported refusal-error constructors could receive an
  invalid receipt from JavaScript or a cast caller. Commit `23e8574` adds
  runtime validation in both constructors and two RED→GREEN regressions.
- Final local evidence: 97/97 focused tests, clean typecheck and diff check.

M3A local closure:

- **ACCEPT:** commit `0dfb15d` adds a read-only explicit-directory inspector
  and pair comparator. It never reads or changes a live state resolver.
- Strict inspection rejects malformed rows, duplicate event IDs, orphan or
  duplicate task creation, duplicate snapshot IDs, and snapshot/ledger drift.
- Comparison separates exact ledger bytes from semantic snapshot equality;
  harmless JSON formatting differences do not become false migration failures.
- Command evidence: 9/9 M3A tests; 87/87 M3A + exec-graph + state-root tests;
  clean typecheck and diff check.
- Read-only inspection of current state accepted exactly 96 events, 4 goals,
  and 10 tasks. Ledger and snapshot SHA-256 match the preserved baseline.
- **Still open:** full state-machine sequence legality and all-store migration
  remain later integrity/M3 packages. No copy or activation occurred.
- **ACCEPT AND REPAIR:** later Fable review found that an empty ledger plus an
  empty snapshot could pass strict inspection. Commit `28c8f79` adds observed
  RED→GREEN coverage and rejects zero-event ledgers with `ledger_empty`.
- Final repair evidence: 10/10 focused tests, 104/104 shadow/exec-graph/state-
  root tests, clean typecheck and diff check. Current 96-event source still
  inspects with preserved ledger and snapshot SHA-256.

Fable routing closure:

- Provider safeguard banner means broad classifier fallback, not that Fable or
  ATLAS is dangerous.
- Claude JSONL proved the hook read stale Opus after a fresh
  `/model claude-fable-5` command and forgot earlier fallback context.
- Global hook now recognizes model commands, keeps a fallback-contaminated
  thread on Opus, and labels its token-efficient protocol delivery as
  `compiled-safe-summary`. Raw protocol body is not injected because its own
  sensitive-adjacent vocabulary can trigger the classifier.

## Next execution order

1. **Done:** roadmap and revised Cost Router specification.
2. **Done:** state-root resolver repair, absolute-path contract, inventory
   correction, CWD-invariance proof.
3. **Done:** durable goal records, exclusive premium owner, goal/retry/slice
   ceilings, and async handles.
4. **Done:** fresh-process restart, duplicate-owner rejection, exact-once
   scheduled-resume claim, local expiry/unknown handling.
5. **Done:** objective classifier, error table, provider-bound privacy checker,
   fake-provider integration, refusal receipts, and runtime receipt invariant.
6. **Done:** strict read-only exec-graph inspection and pair comparison,
   including fail-closed rejection of empty authoritative input.
7. **Now:** isolated synthetic copy/replay and rollback receipt; no physical
   move or live-root activation. Receipt follows executed rollback only.
8. **CEO cutover gate:** only after rollback proof.
9. **Live research broker:** one provider at a time, public synthetic prompts.
10. **Research swarm:** only after `READY_FOR_RESEARCH`.

## CEO decisions

No CEO action is needed now. Safe reversible working defaults are active:
4 local slices, 2 external research jobs, 1 active premium owner,
1 T3 escalation per task, and 0 metered API spend.

Needed later:

- physical cutover;
- login/MFA/CAPTCHA when a live provider gate requires it;
- any paid API activation;
- privacy exception to a weaker destination class;
- secret rotation, deployment, scheduler/Railway changes, deletion, or move.

## Canonical documents

- Forward plan: [`ATLAS-MASTER-PLAN.md`](ATLAS-MASTER-PLAN.md)
- Cost Router contract:
  [`../superpowers/specs/2026-07-30-atlas-cost-router-design.md`](../superpowers/specs/2026-07-30-atlas-cost-router-design.md)
- Resume truth:
  `C:\Projects\VOLAURA\memory\atlas\CURRENT-COMPACT.md`
- Cross-instance journal:
  `C:\Projects\VOLAURA\memory\atlas\codex-loop.md`
- Seat protocol: [`FABLE-PROTOCOL.md`](FABLE-PROTOCOL.md)

## Resume rule

Read this file, then `CURRENT-COMPACT.md`. Work only on the first non-green
milestone. Never infer approval for a later milestone from approval of an
earlier one.
