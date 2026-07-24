/**
 * Perspective provider config audit — registry + availability, no static overrides.
 */

import type { Perspective } from '../atlas/perspectives.js';
import {
  isKnownProvider,
  isProviderConfigured,
  listAvailableWorkerProviders,
  providerSupportsWorkerRole,
  type ProviderName,
} from '../model-router.js';
import { isPaidProvider, paidAllowed } from '../atlas/spend-policy.js';
import type { WorkerPhaseStatus } from './types.js';

export type PerspectiveConfigIssueCode =
  | 'unknown_provider'
  | 'not_worker_role'
  | 'paid_blocked'
  | 'unavailable';

export interface PerspectiveConfigIssue {
  perspective: string;
  provider: string;
  code: PerspectiveConfigIssueCode;
  message: string;
}

export interface PerspectiveConfigAudit {
  issues: PerspectiveConfigIssue[];
  availableWorkerProviders: ProviderName[];
  declaredCount: number;
  routableDeclaredCount: number;
}

export function auditPerspectiveConfig(perspectives: Perspective[]): PerspectiveConfigAudit {
  const availableWorkerProviders = listAvailableWorkerProviders();
  const issues: PerspectiveConfigIssue[] = [];
  let routableDeclaredCount = 0;

  for (const p of perspectives) {
    if (!p.provider) continue;
    const declared = p.provider;
    if (!isKnownProvider(declared)) {
      issues.push({
        perspective: p.name,
        provider: declared,
        code: 'unknown_provider',
        message: `'${declared}' is not in the model registry (e.g. cerebras is unsupported)`,
      });
      continue;
    }
    if (!providerSupportsWorkerRole(declared)) {
      issues.push({
        perspective: p.name,
        provider: declared,
        code: 'not_worker_role',
        message: `'${declared}' has no WORKER role in registry`,
      });
      continue;
    }
    if (isPaidProvider(declared) && !paidAllowed()) {
      issues.push({
        perspective: p.name,
        provider: declared,
        code: 'paid_blocked',
        message: `'${declared}' requires ATLAS_ALLOW_PAID=1`,
      });
      continue;
    }
    if (!isProviderConfigured(declared)) {
      issues.push({
        perspective: p.name,
        provider: declared,
        code: 'unavailable',
        message: `'${declared}' is in registry but not configured/available on this machine`,
      });
      continue;
    }
    routableDeclaredCount += 1;
  }

  return {
    issues,
    availableWorkerProviders,
    declaredCount: perspectives.filter((p) => p.provider).length,
    routableDeclaredCount,
  };
}

export type DeclaredProviderPreflight =
  | { ok: true }
  | { ok: false; status: WorkerPhaseStatus; error: string };

/** Per-worker gate before routeModel — never silently remap unknown providers. */
export function validateDeclaredWorkerProvider(declared?: string): DeclaredProviderPreflight {
  if (!declared) return { ok: true };
  if (!isKnownProvider(declared)) {
    return { ok: false, status: 'routing_error', error: `unknown_provider:${declared}` };
  }
  if (!providerSupportsWorkerRole(declared)) {
    return { ok: false, status: 'routing_error', error: `provider_not_worker_role:${declared}` };
  }
  if (isPaidProvider(declared) && !paidAllowed()) {
    return {
      ok: false,
      status: 'blocked',
      error: `Provider '${declared}' requires ATLAS_ALLOW_PAID=1 (caller=research-swarm-worker)`,
    };
  }
  if (!isProviderConfigured(declared)) {
    return { ok: false, status: 'routing_error', error: `provider_unavailable:${declared}` };
  }
  return { ok: true };
}

export { listAvailableWorkerProviders as listConfiguredWorkerProviders };
