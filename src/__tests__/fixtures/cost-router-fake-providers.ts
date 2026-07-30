/**
 * M2D: in-repo fake providers for end-to-end Cost Router integration tests.
 *
 * Plain, deterministic, offline implementations only — no network client, no
 * new dependency. Each fake declares its own tier (`ProviderCandidate.tier`)
 * and its own class (`ProviderClass`, M2C), covering the four routes:
 *
 *   - FAKE_T0_DETERMINISTIC_TOOL — a deterministic tool for T0.
 *   - FAKE_T1_RESEARCH_PROVIDER  — a sanitized-brief research provider for T1.
 *   - FAKE_T2_LOCAL_WORKER       — a bounded local worker for T2.
 *   - FAKE_T3_PREMIUM_REASONING  — a premium reasoning provider for T3.
 *
 * `FAKE_T2_FAILOVER_WORKER` is a second, weaker-tier T2-class fake used only
 * as a failover target in the transport-retry-then-failover proof.
 *
 * These are only ever exercised through `runTrustedRoutedAttempt` (the
 * existing trusted entry point) as the `currentProvider`/`failoverCandidates`
 * plus an `attempt` callback built from the functions below — never called
 * directly by production code, and this file lives under
 * `src/__tests__/fixtures/`, so it is test-only by construction.
 */

import type {
  ProviderAttemptResult,
  ProviderCandidate,
} from '../../atlas/cost-router-classify.js';
import type { ProviderClass } from '../../atlas/cost-router-state.js';

export const FAKE_T0_DETERMINISTIC_TOOL: ProviderCandidate = Object.freeze({
  providerId: 'fake-t0-deterministic-tool',
  tier: 'free',
});

export const FAKE_T1_RESEARCH_PROVIDER: ProviderCandidate = Object.freeze({
  providerId: 'fake-t1-research-provider',
  tier: 'cheap',
});

export const FAKE_T2_LOCAL_WORKER: ProviderCandidate = Object.freeze({
  providerId: 'fake-t2-local-worker',
  tier: 'free',
});

export const FAKE_T2_FAILOVER_WORKER: ProviderCandidate = Object.freeze({
  providerId: 'fake-t2-failover-worker',
  tier: 'cheap',
});

export const FAKE_T3_PREMIUM_REASONING: ProviderCandidate = Object.freeze({
  providerId: 'fake-t3-premium-reasoning',
  tier: 'premium',
});

/** Declared class per fake provider (M2C). Objective, fixed fields — never inferred. */
export const FAKE_PROVIDER_CLASS_TABLE: Readonly<Record<string, ProviderClass>> = Object.freeze({
  [FAKE_T0_DETERMINISTIC_TOOL.providerId]: Object.freeze({
    identityBearing: false,
    retentionTerm: 'none',
    canActBeyondBrief: false,
  }),
  [FAKE_T1_RESEARCH_PROVIDER.providerId]: Object.freeze({
    identityBearing: false,
    retentionTerm: 'session',
    canActBeyondBrief: false,
  }),
  [FAKE_T2_LOCAL_WORKER.providerId]: Object.freeze({
    identityBearing: false,
    retentionTerm: 'none',
    canActBeyondBrief: false,
  }),
  [FAKE_T2_FAILOVER_WORKER.providerId]: Object.freeze({
    identityBearing: false,
    retentionTerm: 'none',
    canActBeyondBrief: false,
  }),
  [FAKE_T3_PREMIUM_REASONING.providerId]: Object.freeze({
    identityBearing: true,
    retentionTerm: 'bounded',
    canActBeyondBrief: false,
  }),
});

/** Deterministic T0 tool: always succeeds, carries no sources. */
export function fakeDeterministicToolAttempt(): ProviderAttemptResult {
  return { ok: true };
}

/** Sanitized-brief research provider (T1): succeeds with a fixed, deterministic source list. */
export function fakeResearchAttempt(): ProviderAttemptResult {
  return {
    ok: true,
    sources: ['https://fake-source.example/one', 'https://fake-source.example/two'],
  };
}

/** Bounded local worker (T2): succeeds, carries no sources. */
export function fakeLocalWorkerAttempt(): ProviderAttemptResult {
  return { ok: true };
}

/** Premium reasoning provider (T3): succeeds, carries no sources. */
export function fakePremiumReasoningAttempt(): ProviderAttemptResult {
  return { ok: true };
}

/** Denies once — simulates a policy/permission/seat/capability refusal. */
export function fakeDenialAttempt(): ProviderAttemptResult {
  return { ok: false, failure: { isDenial: true } };
}

/** Fails with a failure the closed-set bucket predicates do not match. */
export function fakeUnknownFailureAttempt(): ProviderAttemptResult {
  return { ok: false, failure: {} };
}

/** Always fails with a transport error — used as one half of a two-provider attempt map. */
export function fakeTransportFailureAttempt(): ProviderAttemptResult {
  return { ok: false, failure: { isTransportFailure: true } };
}
