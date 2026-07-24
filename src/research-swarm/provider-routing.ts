/**
 * Per-worker provider routing without mutating process.env.
 */

import { routeModel, type ProviderName, type RouteResult } from '../model-router.js';
import { enforceSpendPolicy, isPaidProvider, paidAllowed } from '../atlas/spend-policy.js';
import type { ProviderPreference } from './types.js';

export class ProviderRoutingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ProviderRoutingError';
  }
}

export function assertProviderAllowed(provider: ProviderName, caller: string): void {
  if (isPaidProvider(provider) && !paidAllowed()) {
    throw new ProviderRoutingError(
      `Provider '${provider}' requires ATLAS_ALLOW_PAID=1 (caller=${caller})`,
    );
  }
  enforceSpendPolicy(provider, caller);
}

/** Route a worker to its declared provider without touching ATLAS_PREFERRED_PROVIDER. */
export function routeWorkerProvider(
  pref: ProviderPreference,
  role: 'WORKER' | 'JUDGE' = 'WORKER',
): RouteResult {
  const excludeProviders: ProviderName[] = ['anthropic'];
  const preferredProvider = pref.required ?? pref.preferred;

  if (preferredProvider) {
    assertProviderAllowed(preferredProvider, 'research-swarm-worker');
  }

  const route = routeModel({
    role,
    preferredProvider: pref.required ?? pref.preferred,
    ignoreEnvPreference: true,
    excludeProviders,
  });

  if (pref.required && route.provider !== pref.required) {
    throw new ProviderRoutingError(
      `Required provider '${pref.required}' unavailable; routed '${route.provider}' instead`,
    );
  }

  return route;
}

export function routeJudgeProvider(): RouteResult {
  const route = routeModel({ role: 'JUDGE', excludeProviders: ['anthropic'], ignoreEnvPreference: true });
  assertProviderAllowed(route.provider, 'research-swarm-judge');
  return route;
}
