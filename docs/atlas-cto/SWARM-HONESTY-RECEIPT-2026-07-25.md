# Swarm Honesty Receipt — Sprint C
_Date: 2026-07-25 · Verdict: PASS (fixture-backed)_

## Goal
Research swarm respects M6 provider health — dead providers not assigned; healthy providers proceed. No new providers added.

## Wiring (confirmed)
```
research-swarm/lifecycle.ts → runWorkerBounded()
  → routeWorkerProvider() [provider-routing.ts]
    → assertProviderAllowed() → isProviderHealthyForRouting()
    → routeModel() [model-router.ts] — also excludes dead providers
```

## Tests added
- `src/__tests__/research-swarm/provider-routing.test.ts`
  - `M6 honesty: dead preferred provider is not assignable to swarm worker`
  - `M6 honesty: healthy provider proceeds for swarm worker`
  - `M6 honesty: judge route never assigns a dead provider`

## Existing coverage (unchanged)
- `src/__tests__/m6-provider-health.test.ts` — dead provider excluded from routeModel
- `src/research-swarm/provider-routing.ts` — assertProviderAllowed fail-closed

## Verdict
**RESEARCH_ONLY_LIMITED** maintained. Swarm path is M6-health-aware; no provider zoo chase.

## Verify
```
npx vitest run src/__tests__/research-swarm/provider-routing.test.ts
npx vitest run src/__tests__/m6-provider-health.test.ts
```
