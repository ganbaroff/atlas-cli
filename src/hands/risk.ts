/**
 * hands/risk.ts — Hand Contract V0: deterministic risk classification.
 *
 * WHAT THIS IS: a pure keyword classifier — NO LLM, NO network, NO exec-graph
 * import. Same "deterministic-only" posture as ./verifier.ts: if risk can't
 * be told apart by a fixed rule, it defaults to the SAFER (more scrutiny)
 * bucket, never to 'low'.
 *
 * Rule order (first match wins): data-mutation -> security -> production ->
 * low. 'high-blast-radius' is not produced by this classifier — it's a
 * manually-assignable DelegationRiskClass value (e.g. a CEO override) that
 * ./refuter.ts's needsRefuter() still treats as non-low.
 */

import type { DelegationRiskClass } from './contract.js';

const DATA_MUTATION_RE = /write|mutat|delete|deploy|migrat/i;
const SECURITY_RE = /secret|credential|token|\.env|auth|rls/i;
const PRODUCTION_RE = /prod|production|live|cloud/i;

export interface RiskClassificationInput {
  objective: string;
  allowedActions: readonly string[];
}

/** Deterministic keyword rules over objective + allowedActions. Never throws, never calls out. */
export function classifyRisk(input: RiskClassificationInput): DelegationRiskClass {
  const haystack = [input.objective, ...input.allowedActions].join(' ');
  if (DATA_MUTATION_RE.test(haystack)) return 'data-mutation';
  if (SECURITY_RE.test(haystack)) return 'security';
  if (PRODUCTION_RE.test(haystack)) return 'production';
  return 'low';
}

/** Every riskClass except 'low' requires the refuter's independent second check. */
export function needsRefuter(riskClass: DelegationRiskClass): boolean {
  return riskClass !== 'low';
}
