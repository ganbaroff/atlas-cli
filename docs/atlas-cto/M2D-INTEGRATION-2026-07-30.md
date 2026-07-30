# M2D — Cost Router fake-provider end-to-end integration (2026-07-30)

Extends the M2A/M2B/M2C Cost Router (`src/atlas/cost-router-classify.ts`,
`src/atlas/cost-router-state.ts`, `src/atlas/cost-router-test-seam.ts`) with
one thing: an end-to-end proof, against in-repo fake providers, that the
trusted entry point (`runTrustedRoutedAttempt`) produces a complete receipt
on every terminal outcome. No new module, no second durable record, no
duplicate error type, no change to the seam boundary.

## Fake provider set

`src/__tests__/fixtures/cost-router-fake-providers.ts` — test-only by
location (`src/__tests__/fixtures/`), plain in-repo implementations, no
network client, no new dependency. One `ProviderCandidate` (declared
`providerId` + `tier`) and one `ProviderClass` (declared
`identityBearing`/`retentionTerm`/`canActBeyondBrief`) per route, plus a
second T2-class fake used only as a failover target:

| Fake | Route | Tier | Class |
| --- | --- | --- | --- |
| `FAKE_T0_DETERMINISTIC_TOOL` | T0 | free | identity: no, retention: none, agentic: no |
| `FAKE_T1_RESEARCH_PROVIDER` | T1 | cheap | identity: no, retention: session, agentic: no |
| `FAKE_T2_LOCAL_WORKER` | T2 | free | identity: no, retention: none, agentic: no |
| `FAKE_T2_FAILOVER_WORKER` | T2 (failover only) | cheap | identity: no, retention: none, agentic: no |
| `FAKE_T3_PREMIUM_REASONING` | T3 | premium | identity: yes, retention: bounded, agentic: no |

Each fake's behaviour (`fakeDeterministicToolAttempt`, `fakeResearchAttempt`,
`fakeLocalWorkerAttempt`, `fakePremiumReasoningAttempt`, `fakeDenialAttempt`,
`fakeUnknownFailureAttempt`, `fakeTransportFailureAttempt`) is a plain
function matching `ProviderAttemptResult`, wired in only as the `attempt`
callback and `currentProvider`/`failoverCandidates` of
`runTrustedRoutedAttempt` — the same, unmodified, only supported entry point
that spends a provider call. Their classes reach the router only through
`withTrustedTables()` (`cost-router-test-seam.ts`), the existing seam,
exactly like every other cost-router test file.

## Receipt shape (nine required fields, defined once)

`CostRouterReceipt` in `cost-router-state.ts`:

1. `provider` — id of the destination actually used, or `NOT_APPLICABLE`.
2. `elapsedMs` — wall-clock milliseconds for the attempt (always applicable).
3. `sources` — research sources returned by the provider, or `NOT_APPLICABLE`.
4. `retries` — `{ transportRetries, providerFailovers }`, always applicable.
5. `privacyDecision` — how the M2C clearance gate resolved (`'cleared'` /
   `'exception_applied:<approvedBy>'`), or `NOT_APPLICABLE`.
6. `costClass` — declared tier of the destination actually used, or
   `NOT_APPLICABLE`.
7. `verifierStatus` — always `NOT_APPLICABLE` in M2D: the deterministic
   verifier is a separate module M2D does not wire in.
8. `blocker` — human-readable reason the outcome was not a clean success, or
   `NOT_APPLICABLE` on success.
9. `nextAction` — always populated, even on success (`'deliver result to
   caller'`).

Enforcement is two-layered:

- **Static**: `CostRouterReceipt` is a plain interface with no optional
  fields, so a literal missing any field is a TypeScript compile error.
  `sources` is typed `readonly string[] | NotApplicable` explicitly (not
  `z.infer`) so it matches `ProviderAttemptResult['sources']` without an
  assignability mismatch against zod's mutable-array inference.
- **Runtime**: `assertCostRouterReceipt()` parses every receipt against
  `costRouterReceiptSchema` (`.strict()`, non-empty-string checks via
  `z.string().min(1)` on every string-typed field) and throws
  `GoalRouterStateError('cost_router_receipt_invalid')` on an
  empty-but-present field (e.g. `provider: ''`). `NOT_APPLICABLE` is a
  distinct literal (`'not-applicable'`) so a genuinely inapplicable field
  never collides with an accidentally-empty one.

`executeRoutedAttempt()` in `cost-router-classify.ts` builds and asserts a
receipt at every return point (first-attempt success, first-attempt
denial/unknown, same-provider retry success, retry-exhausted-no-failover,
failover success/failure, async-expired short-circuit) via a local
`buildReceipt()` helper, and attaches it as `RoutedAttemptResult.receipt` —
an additive required field; no existing field of `RoutedAttemptResult`
changed shape or meaning.

## End-to-end proofs (`src/__tests__/cost-router-m2d-integration.test.ts`)

- One task per route (T0/T1/T2/T3) completes through
  `runTrustedRoutedAttempt` and yields a fully populated receipt — T1's
  receipt carries the fake research provider's two-source list; the other
  three carry `sources: NOT_APPLICABLE`.
- Async long-research path: `acquirePremiumOwner` → `registerAsyncResearchHandle`
  ("start the job") → `releasePremiumOwner` → `claimScheduledAsyncResume`
  ("resume exactly once" — a second claim at the same due time is rejected
  with `async_resume_already_claimed`) → `runTrustedRoutedAttempt` against the
  T1 fake proves the resume produced the result (receipt sources populated).
  A second, separate handle proves an expired handle resolves
  `claimScheduledAsyncResume` to `async_expired`/`'expired'`, and a
  `runTrustedRoutedAttempt({ isAsyncExpired: true, ... })` call against it
  makes zero calls to `attempt` and returns a receipt with
  `provider: NOT_APPLICABLE`, `providerCalls: 0`.
- Denial from a fake provider: exactly one attempt, zero retries, receipt
  `blocker: 'provider denial'`.
- Transport failure: one same-provider retry, then one failover to the
  non-premium `FAKE_T2_FAILOVER_WORKER` (a premium candidate offered in the
  same list is never called); receipt records `retries: {1,1}` and
  `provider`/`costClass` of the destination actually used.
- Unknown/unclassified failure: bucketed and handled identically to denial —
  one attempt, zero retries.
- Weaker-class destination: `FAKE_T3_PREMIUM_REASONING`'s declared class is
  strictly weaker than the T2 fake's required class, so the attempt is
  refused end-to-end (`destination_class_too_weak`, zero attempts) without an
  exception; with a correctly signed `ATLAS_CLEARANCE_SIGNING_KEY` operator
  exception naming that same class as permitted, the identical attempt
  succeeds and is recorded on the durable `clearanceLedger`, and the receipt
  names `privacyDecision: 'exception_applied:yusif'`.
- **Zero network**: `globalThis.fetch` is spied and made to throw in
  `beforeEach`, and `afterEach` asserts it was never called — enforced once
  per test, across every test in the file, rather than assumed.

## Acceptance results

- `npx tsc --noEmit` → `TypeScript: No errors found`.
- `npx vitest run` over all six cost-router test files (state, classify,
  error-policy, clearance, seam-boundary, plus the new M2D integration file)
  → **83 passed, 0 failed** (baseline 73 unchanged + 10 new in
  `cost-router-m2d-integration.test.ts`).
- `git status --short` shows only the four M2D files (2 modified, 2 new)
  plus the pre-existing dirty entries already present before this work
  (`docs/atlas-cto/FABLE-PROTOCOL.md`, `state/exec-graph/graph.json`,
  `state/exec-graph/ledger.jsonl`, an untracked handoff doc, and
  `state/evidence/`) — none of which this task touched.

## Provisional

These closures (fake-provider coverage, receipt shape, and the proofs above)
are provisional pending independent audit.

## Refutation and repair (2026-07-30, same day): refusals produced no receipt

Independent review reproduced live that the "complete receipt on every
terminal outcome" claim above was false for exactly the outcomes that most
need one: **refusals**. `buildReceipt`/`assertCostRouterReceipt` sat inside
`executeRoutedAttempt`, and every refusal threw *before* reaching it —
`checkRouteAvailability`'s `route_disabled`, `assertRouteAvailabilityChecked`'s
`availability_not_checked`, `assertDestinationClearance`'s
`destination_class_unknown`/`destination_class_too_weak`, the clearance
signature verification's five reasons
(`exception_unsigned`/`exception_signature_mismatch`/
`exception_signature_expired`/`exception_signature_replayed`/
`exception_signing_key_not_configured`), and — thrown even earlier, from
`resolveRoute`, before a route existed at all — `classifyRoute`'s
`unclassifiable` and `t3_trigger_missing`. Live proof: every thrown error had
`.receipt === undefined`. A second, independent gap: `sources` was typed
`z.array(z.string().min(1))` with no floor on the array itself, so an empty
array (`[]`) plausibly satisfied the schema despite the field's contract
being "populated sources, or the explicit `NOT_APPLICABLE` marker — never an
empty value with no marker."

### What changed

- `RouteRefusalError` and `ClearanceRefusalError` (`cost-router-classify.ts`)
  each gained a mandatory constructor parameter, `receipt: CostRouterReceipt`
  — not optional, so a call site that forgets to build one is a compile
  error, not a runtime gap.
- A new shared `buildRefusalReceipt()` helper builds that receipt through the
  *same* `assertCostRouterReceipt()` the success path already used — no
  second, laxer validator. Fields the caller does not pass (`provider`,
  `sources`, `privacyDecision`, `costClass`) default to `NOT_APPLICABLE`;
  `retries` is always `{ transportRetries: 0, providerFailovers: 0 }` (true
  for every refusal — no attempt was ever made); `verifierStatus` is always
  `NOT_APPLICABLE` (unchanged from the success path's own convention).
  `elapsedMs` is a genuine `Date.now()` delta measured from function entry to
  throw (near-zero for the pure checks, accurate for the ones nested inside
  `executeRoutedAttempt`) — never a fabricated value, and the schema requires
  a real non-negative number here rather than accepting a not-applicable
  marker.
- Every throw site in the module now builds and attaches a receipt this way:
  `classifyRoute` (`unclassifiable`, `t3_trigger_missing`),
  `checkRouteAvailability` (`route_disabled`),
  `assertRouteAvailabilityChecked` (`availability_not_checked`),
  `assertDestinationClearance` (`destination_class_unknown`,
  `destination_class_too_weak`), the clearance-signature verification inside
  `executeRoutedAttempt` (all five `exception_*` reasons), and
  `acquireT3RouteOwner`'s own `unclassifiable` refusal when a resolved route
  is not T3.
- On every refusal receipt, `blocker` is `"<reason>: <human-readable
  message>"` — the reason code itself is embedded in the blocker text, so a
  reader (or a test) can confirm which refusal produced a given receipt
  without inspecting the thrown error separately — and `nextAction` is a
  concrete, refusal-specific next step (e.g. `t3_trigger_missing` →
  "supply one of the mandatory T3 triggers on the task before retrying";
  `exception_signing_key_not_configured` → "configure
  ATLAS_CLEARANCE_SIGNING_KEY before permitting any cross-class clearance
  exception"). Neither field is ever empty.
- Tightening: `costRouterReceiptSchema.sources` is now
  `z.union([z.array(z.string().min(1)).min(1), notApplicableSchema])` —
  `.min(1)` on the array itself, not just its elements — so `sources: []`
  now fails `assertCostRouterReceipt`; a route with no sources must carry
  `NOT_APPLICABLE`.

### Proof

- `src/__tests__/cost-router-classify.test.ts`: new describe block asserts
  `route_disabled`, `unclassifiable`, and `t3_trigger_missing` each throw an
  error carrying a receipt that passes `assertCostRouterReceipt`, with
  non-empty `blocker`/`nextAction` and `blocker` naming the reason; the two
  pre-route reasons additionally assert `provider`/`sources` are
  `NOT_APPLICABLE`.
- `src/__tests__/cost-router-error-policy.test.ts`: new test on the existing
  forged-route fixture asserts `availability_not_checked` carries the same.
- `src/__tests__/cost-router-clearance.test.ts`: new describe block covers
  `destination_class_too_weak`, `exception_unsigned`,
  `exception_signature_mismatch`, `exception_signature_replayed`, and
  `exception_signing_key_not_configured`, reusing the file's existing
  operator-exception fixtures and trusted-table setup.
- `src/__tests__/cost-router-state.test.ts`: new describe block asserts
  `assertCostRouterReceipt` rejects `sources: []`, accepts
  `NOT_APPLICABLE`, and accepts a genuinely populated array.
- `npx tsc --noEmit` → `TypeScript: No errors found`.
- `npx vitest run` over all six cost-router test files → **95 passed, 0
  failed** (baseline 83 unchanged + 12 new: 3 in `cost-router-classify.test.ts`,
  1 in `cost-router-error-policy.test.ts`, 5 in `cost-router-clearance.test.ts`,
  3 in `cost-router-state.test.ts`). `cost-router-seam-boundary.test.ts`'s
  import-boundary test still passes unchanged.
- The doc's claim above ("produces a complete receipt on every terminal
  outcome") was not reworded to fit the old behaviour — the code was fixed
  to match it.

## Codex SOL closure (2026-07-30)

Source and seat: Fable local integrator on `claude-opus-5`, Sonnet code worker,
and a separate Sonnet verifier. Their receipts were treated as untrusted review
input and checked against the local branch.

Disposition:

- **ACCEPT:** Codex reproduced the claimed 95/95 six-file suite and clean
  `npx tsc --noEmit`.
- **ACCEPT:** the two proof slices not executed by the last Sonnet verifier
  were run independently: 9 refusal-receipt tests and 3 `sources` marker tests.
- **ACCEPT WITH REPAIR:** a JavaScript or cast caller could construct either
  exported refusal error with `receipt === undefined`; TypeScript alone did not
  enforce the runtime invariant.
- Commit `23e8574` calls `assertCostRouterReceipt()` in both constructors and
  adds one RED→GREEN regression per class.

Final command evidence at `23e8574`:

- six focused files: **97 passed, 0 failed**;
- `npx tsc --noEmit`: exit 0;
- `git diff --check`: clean;
- no network/provider/browser call, push, merge, deployment, scheduler change,
  state migration, or physical move.

Final verdict: **ACCEPT M2D; M2 Safe Runtime and Router is complete locally.**
