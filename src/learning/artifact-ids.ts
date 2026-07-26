/**
 * Deterministic learning projection IDs — keyed by idempotencyKey so stale
 * workers cannot duplicate side effects after lease takeover.
 */

import { createHash } from 'node:crypto';

function digest(prefix: string, idempotencyKey: string, kind: string): string {
  return createHash('sha256').update(`${prefix}:${idempotencyKey}:${kind}`).digest('hex').slice(0, 16);
}

export function deterministicDecisionId(idempotencyKey: string): string {
  return `dec_${digest('decision', idempotencyKey, 'decide')}`;
}

export function deterministicGoalId(idempotencyKey: string): string {
  return `gol_${digest('goal', idempotencyKey, 'decide')}`;
}

export function deterministicEvidenceClaimId(idempotencyKey: string, kind: 'decide' | 'outcome'): string {
  return `clm_${digest('evidence', idempotencyKey, kind)}`;
}

export function deterministicSpendCorrelationId(idempotencyKey: string, kind: 'decide' | 'outcome'): string {
  return digest('spend', idempotencyKey, kind);
}
