/**
 * A/B eval harness — baseline single call vs research swarm on deterministic fixtures.
 */

import type { EvalReport, EvalVerdict, ResearchSwarmStatus } from './types.js';
import { stableFixtureHash } from './lifecycle.js';

export interface EvalFixture {
  id: string;
  task: string;
  minProvidersForResearch: number;
}

export const EVAL_FIXTURES: EvalFixture[] = [
  {
    id: 'evidence-gate-audit',
    task: 'Pilot audit only. For a 100 USDT spot-only dry-run trading research system, identify the single highest-value evidence gate before any live trading. Separate verified facts, inference, and unknowns. Do not execute tools or propose changing risk limits.',
    minProvidersForResearch: 2,
  },
  {
    id: 'schema-review',
    task: 'Review a JSON API schema for missing required fields on error responses. List only concrete gaps — no code changes.',
    minProvidersForResearch: 2,
  },
];

export function verdictFromStatus(
  status: ResearchSwarmStatus,
  providerCount: number,
  minProviders: number,
): EvalVerdict {
  if (status === 'SUCCESS') return 'READY_FOR_RESEARCH';
  if (status === 'LIMITED_DIVERSITY' && providerCount >= minProviders) return 'RESEARCH_ONLY';
  return 'KEEP_DISABLED';
}

export function buildEvalReport(input: {
  fixtureId: string;
  baselineMs: number;
  swarmMs: number;
  baselineTokens?: number;
  swarmTokens?: number;
  swarmStatus: ResearchSwarmStatus;
  providerCount: number;
  minProviders: number;
}): EvalReport {
  const verdict = verdictFromStatus(input.swarmStatus, input.providerCount, input.minProviders);
  const rationale =
    verdict === 'READY_FOR_RESEARCH'
      ? 'Swarm achieved strong consensus with sufficient provider diversity.'
      : verdict === 'RESEARCH_ONLY'
        ? 'Swarm produced limited diversity — usable for research but not production consensus.'
        : `Swarm status ${input.swarmStatus} with ${input.providerCount} providers — not proven vs baseline.`;

  return {
    fixtureId: input.fixtureId,
    baselineMs: input.baselineMs,
    swarmMs: input.swarmMs,
    baselineTokens: input.baselineTokens ?? 0,
    swarmTokens: input.swarmTokens ?? 0,
    swarmStatus: input.swarmStatus,
    verdict,
    rationale,
  };
}

export function getFixture(id: string): EvalFixture | undefined {
  return EVAL_FIXTURES.find((f) => f.id === id);
}

export function fixtureFingerprint(fixture: EvalFixture): string {
  return stableFixtureHash(fixture.task);
}
