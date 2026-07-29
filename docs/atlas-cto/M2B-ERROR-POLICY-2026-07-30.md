# M2B — Error bucketing and availability policy

2026-07-30. Extends M1 (`src/atlas/cost-router-state.ts`) and M2A
(`src/atlas/cost-router-classify.ts`). No parallel module, no second durable
record, no duplicate error type: all M2B code lives inside
`cost-router-classify.ts` and reuses M1's existing `retryLedger` /
`recordRetryEvent` for durable retry counting instead of inventing a second
counter.

## The four buckets

`classifyFailure(failure: FailureInput): ErrorBucket` is a single PURE
function. It takes an objective, caller-declared description of one failed
attempt (`isDenial` / `isTransportFailure` / `isAsyncExpired` — stated by the
provider adapter, never inferred from free text) and returns exactly one of:

| Bucket | Meaning | Retry rule |
|---|---|---|
| `denial` | Policy, permission, seat, capability, or invariant refusal | Zero retries. Never retried, never failed over. |
| `transport` | Network/timeout/5xx | At most one retry of the same provider, then at most one failover to a non-premium provider. Never a premium provider, never a third attempt on any single provider. |
| `async-expired` | An async job handle whose expiry has passed | Resolves failed with zero provider calls. |
| `unknown` | Anything not confidently matched | Treated exactly as `denial` (fail closed) — zero retries. This is deliberate: the default must not be lenient. |

The bucket alone decides behaviour in `runRoutedAttempt`; nothing else
(error message text, provider identity, etc.) is consulted.

## Provider tiers

`ProviderTier = 'free' | 'cheap' | 'premium'` is an explicit closed set
carried on every `ProviderCandidate`. `selectFailoverProvider` filters out
`premium` unconditionally — including when it is the *only* candidate, in
which case it returns `undefined` and `runRoutedAttempt` refuses the
failover rather than taking it. "Never fail over to premium" is therefore
checkable in code (a filter predicate + a test), not a convention callers
are trusted to honour.

## Structural fix: availability check is unavoidable

The M2A independent review left a caveat: nothing stopped a caller from
taking a bare `classifyRoute()` result and acting on it directly, skipping
`checkRouteAvailability`.

Fix: `AvailableRoute` is `RouteMatch` branded with
`ROUTE_AVAILABILITY_CHECKED`, a `unique symbol` declared and used only
inside `cost-router-classify.ts` — never exported. `resolveRoute` is the
only function in the module that can construct one, because it is the only
function with access to the symbol. Every consumer that spends a provider
attempt (`runRoutedAttempt`) requires `AvailableRoute` as its `route`
parameter and calls `assertRouteAvailabilityChecked` as its first line.

This is enforced twice:
- **Compile time**: `classifyRoute`'s return type (`RouteMatch`) is not
  assignable to `AvailableRoute`, so passing an unchecked match to
  `runRoutedAttempt` is a type error.
- **Runtime**: a caller that bypasses the compiler with
  `... as unknown as AvailableRoute` still produces an object with no
  `ROUTE_AVAILABILITY_CHECKED` key, so `assertRouteAvailabilityChecked`
  throws `RouteRefusalError('availability_not_checked')` before any
  provider call. Proven by the "unreachable unsafe path" test below —
  `attempt` is asserted never called.

`classifyRoute` itself stays exported (M2A's existing tests classify raw
input directly and must keep working); what changed is that nothing which
*acts* on a route can consume its output without going through
`resolveRoute` first.

## Acceptance results

- `npx tsc --noEmit` — clean, no errors.
- `npx vitest run src/__tests__/cost-router-error-policy.test.ts src/__tests__/cost-router-classify.test.ts src/__tests__/cost-router-state.test.ts` — **54 passed, 0 failed** (46 pre-existing + 8 new; the pre-existing 46 did not regress).
- `git status --short` — only `src/atlas/cost-router-classify.ts` and the new
  `src/__tests__/cost-router-error-policy.test.ts` changed by this work;
  pre-existing dirty entries (`docs/atlas-cto/FABLE-PROTOCOL.md`,
  `state/exec-graph/*`, `state/evidence/`,
  `docs/atlas-cto/VOLAURA-LEARNING-ENGINE-HANDOFF-2026-07-25.md`) untouched.
- Commit 1 (code + tests): `8f692a5`.

## Status

Closures above are provisional pending independent audit.
