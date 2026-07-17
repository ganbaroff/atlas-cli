# ADR-0006: Hand Contract V0 — Hands are descriptive-only, `verifyAndTransition` is the sole setter of hand-owned final state

- **Status:** ACCEPTED
- **Date:** 2026-07-17
- **Deciders:** Atlas (implementation), CEO (Yusif Ganbarov), External CTO (authority-boundary review)

## Context

ADR-0001 gave `src/exec-graph` one machine execution authority for task
state. Mission 2 adds **controlled delegation** on top of that authority:
a task can be handed to a named execution target (a "Hand" — e.g. a
foreground CEO-supervised coding session, or a free read-only local
inspection agent), and that delegation needs to resolve to a final state
(`verified`/`rejected`) based on falsifiable evidence, not on the
delegate's own narrative.

This is a genuinely new authority question ADR-0001 doesn't answer: *when
a task is delegated, who is allowed to say it succeeded, and by what
proof?* Getting this wrong reopens exactly the fragmentation ADR-0001
exists to close — a delegated task whose "done" status can be set by more
than one path, or set without independently-checkable evidence, is a
second task authority in practice even if `state/exec-graph/` is still the
only file on disk.

An adversarial review of the first implementation cut found a concrete
instance of this: `src/hands/exec-graph-adapter.ts` correctly refused to
let anything but `verifyAndTransition()` resolve a hand-owned task to
`verified`/`rejected` — but the generic exec-graph primitives it wraps
(`moveTask()`, `reassignOwner()` in `src/exec-graph/api.ts`) were still
directly callable through the plain `atlas task move`/`task reassign` CLI
path, with no awareness that the target task was hand-owned. A specialized
safe wrapper does not close an unsafe generic primitive underneath it —
the guard has to live in the primitive itself, or it is trivially
bypassable via any other caller of that primitive.

## Decision

- **Hands are descriptive-only.** A `HandSpec` (`src/hands/registry.ts`)
  describes what a delegation target is allowed to do — capabilities,
  trust level, allowed/disallowed actions, timeout, abort/escalation
  policy. It is config, read at delegation and verify time; it is never
  itself task state and it never becomes stale relative to a task's real
  status because it never tracks task status at all.
- **Delegation state is exec-graph — no second store.** Assigning,
  submitting evidence for, and resolving a delegation are exec-graph
  `Task` transitions like any other (`planned` → `delegated` →
  `in-progress` → `evidence-submitted` → `verified`/`rejected`), with
  `owner` set to `hand:<handId>`. `src/hands/*` persists nothing of its
  own under `state/`.
- **`verifyAndTransition()` (`src/hands/exec-graph-adapter.ts`) is the sole
  setter of a hand-owned task's final state**, enforced at two layers:
  1. Within `src/hands/`: only `verifyAndTransition()` calls `moveTask()`
     with `to: 'verified' | 'rejected'`. `assignHand()`/`submitReceipt()`
     move a task forward but never resolve it; `abortHandTask()` moves a
     stuck task sideways to `blocked`, also never resolving it.
  2. **Inside `src/exec-graph/api.ts` itself** — `moveTask()` throws
     `HandAuthorityError` if `to` is `'verified'`/`'rejected'`, the target
     task's `owner` starts with `hand:`, and the call did not set the
     internal `_viaHandAdapter` capability flag; `reassignOwner()` throws
     the same error if `newOwner` starts with `hand:` without that flag.
     Only `src/hands/exec-graph-adapter.ts` ever sets `_viaHandAdapter`.
     This is the direct fix for the adversarial-review finding above: the
     boundary is enforced where the primitive actually lives, not only in
     the one caller that was supposed to be well-behaved.
- **The verifier is deterministic — no LLM, no network.**
  `src/hands/verifier.ts`'s `verify(receipt)` checks a receipt against
  real filesystem/git state through a fixed rule set per receipt kind
  (`file-exists`, `file-contains`, `commit-exists`,
  `command-output-match` against an allowlisted read-only command); a
  `narrative`-kind receipt (no independently checkable evidence) is always
  rejected. This keeps "does this receipt hold up" reproducible and
  free — no token cost, no model-availability dependency, no prompt-
  injection surface in the verification path itself.
- **Receipts are secret-guarded before ledger persistence.**
  `exec-graph-adapter.ts`'s `assertReceiptHasNoSecrets()` scans every
  free-text field of a `Receipt` against a fixed secret-shape pattern set
  and throws `ReceiptSecretError` BEFORE `submitReceipt()` writes anything
  — required because `state/exec-graph/ledger.jsonl` is append-only
  (ADR-0003): a secret that reaches it is permanent, so the guard must be
  pre-write.
- **A deterministic, risk-gated refuter provides a second opinion.**
  `src/hands/refuter.ts`'s `runRefuter()` re-runs `verify()` independently
  for any non-`'low'` `DelegationRiskClass` (per `src/hands/risk.ts`'s
  `needsRefuter()`) and requires agreement with the primary verdict before
  a `verified` result is accepted. Risk is classified deterministically by
  `risk.ts`'s `classifyRisk()` — a fixed keyword rule over the task's
  title and the assigned hand's `allowedActions` — re-derived at verify
  time rather than cached, since V0 does not persist a `DelegationBrief`
  as new state (that would itself be a second store, rejected below).

## Alternatives considered

1. **Let a Hand write exec-graph state directly (its own `moveTask` call,
   no adapter).** Rejected: reintroduces exactly the multi-write-path
   fragmentation ADR-0001 closes — any Hand implementation could then
   claim `verified` without going through a single, auditable verification
   step, and the guarantee "verified means evidence checked" becomes a
   convention again instead of a structural fact.
2. **LLM-judge verifier (a model reads the receipt/evidence and decides
   verified/rejected).** Rejected for V0: reintroduces token cost, model
   availability as a dependency of the delegation-control layer, and a
   prompt-injection surface directly in the path that decides whether a
   task counts as done. A deterministic, falsifiable-evidence check is a
   strictly narrower but strictly more auditable guarantee — every
   `verified` has a reproducible reason string, not a judgment call. Not
   ruled out permanently: a future ADR could add an LLM-judge as an
   *additional*, clearly-labeled signal alongside the deterministic
   verifier, but it must never replace it as the sole check.
3. **A second delegation-state store (e.g. a `state/hands/` directory or
   an in-memory `DelegationBrief` registry keyed by taskId).** Rejected:
   this is the same fragmentation risk ADR-0001/ADR-0002 already fought —
   two places to check "is this delegation really done," with the
   possibility of drift between them. Re-deriving riskClass at verify time
   from already-canonical data (the task's own title + the hand's static
   registry entry) avoids needing this store at all.
4. **Enforce the hand-authority boundary only inside
   `src/hands/exec-graph-adapter.ts`, trusting that nothing else calls
   `exec-graph/api.ts`'s primitives on a hand-owned task.** Rejected — this
   is the exact gap the adversarial review found: `atlas task move`/`task
   reassign` are legitimate, pre-existing, generic CLI commands with no
   reason to know about hand ownership unless taught to. "Don't call the
   unsafe path" is a convention, not a guarantee; `HandAuthorityError` in
   `exec-graph/api.ts` makes it a guarantee.

## Consequences

- **Positive:** a hand-owned task's final state has exactly one causal
  path, enforced at the primitive level — `atlas hand verify` (or any
  future caller of `verifyAndTransition()`), and nothing else, on any
  hand-owned task, ever.
- **Positive:** verification is free, fast, and reproducible — no model
  call, no network dependency, same input always produces the same
  verdict and reason string.
- **Positive:** a secret can never enter the append-only ledger via a
  receipt — checked before the first write, not cleaned up after.
- **Negative / cost:** the CLI's generic `task move`/`task reassign`
  commands now carry hand-awareness (`HandAuthorityError`) they didn't
  need before delegation existed — a small but real coupling between
  exec-graph's core transition layer and the Hand Contract concept layered
  on top of it. Judged worth it: the alternative (trusting every future
  caller to route hand-owned tasks correctly by convention) is the exact
  failure mode this ADR exists to close.
- **Accepted V0 limit, not fixed here:** `classifyRisk()`'s keyword rules
  can be avoided by an objective worded to dodge the matched terms,
  letting a delegation classify `'low'` and skip the refuter regardless of
  what the task actually does once delegated. Documented in
  `docs/architecture/ATLAS-ARCHITECTURE.md`'s LEARN section as a known,
  accepted gap — closing it would require semantic (not lexical)
  objective evaluation, reintroducing the "no LLM in the verification
  path" tradeoff alternative #2 above rejects for V0.

## Rollback or supersession

Rollback: disable the `hand` CLI subcommand group in `src/cli.ts` (a
single command-group removal); no task is left in an inconsistent state,
because every hand-owned task is still a perfectly ordinary exec-graph
`Task` — it just stays wherever its last transition left it (most likely
`delegated`/`evidence-submitted`) and a human can move it forward via the
existing generic `atlas task move` once its `owner` is manually
reassigned off `hand:*` (an intentionally rare, explicit CEO/Atlas action,
not a code path this ADR adds). `HandAuthorityError`'s presence in
`exec-graph/api.ts` can stay even if the `hand` CLI group is removed — it
only ever fires for a `hand:`-owned task, which would then never be
created again.

Supersession: a future ADR may add hands beyond the two in V0's registry
(`src/hands/registry.ts`'s module doc notes this explicitly), add an
LLM-judge as an additional signal, or close the risk-classifier gap noted
above. Any such change must preserve "Hands are descriptive-only" and
"`verifyAndTransition()` is the sole setter of hand-owned final state,"
or must explicitly supersede this ADR.

## Links

- `src/hands/README.md` — module contract (authority model, module map,
  failure behavior, security, tests).
- `src/hands/registry.ts`, `contract.ts`, `risk.ts`, `verifier.ts`,
  `refuter.ts`, `exec-graph-adapter.ts` — implementation.
- `src/exec-graph/api.ts` — `HandAuthorityError`, the `_viaHandAdapter`
  capability flag on `moveTask()`/`reassignOwner()`.
- `docs/runbooks/hand-delegation.md` — exact operational commands.
- `docs/architecture/ATLAS-ARCHITECTURE.md` — Hand Contract layer in the
  component/authority maps + LEARN lessons.
- ADR-0001 (one task authority: exec-graph) — the authority this ADR
  delegates *through*, never around.
- ADR-0002 (VOLAURA intent vs ANUS execution state) — unaffected; Hand
  Contract V0 adds no VOLAURA-side state.
- ADR-0003 (append-only ledger + snapshot) — the reason receipts must be
  secret-guarded pre-write.
- `src/__tests__/hands.test.ts` — structural exec-graph-import boundary,
  `HandAuthorityError` regression (describe block 16), secret-guard
  regression (block 17).
