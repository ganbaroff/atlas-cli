/**
 * Provider diversity and consensus evaluation — deterministic, no LLM.
 */

import { modelFamily } from './model-family.js';
import type { DiversityReport, WorkerEvidence } from './types.js';

export function evaluateDiversity(workers: WorkerEvidence[]): DiversityReport {
  const okWorkers = workers.filter((w) => w.status === 'ok' && w.output.trim().length > 0);
  const successfulProviders = [...new Set(okWorkers.map((w) => w.actualProvider))];
  const successfulFamilies = [...new Set(
    okWorkers.map((w) => w.modelFamily || modelFamily(w.actualProvider, w.actualModelId)),
  )];

  return {
    successfulProviders,
    successfulFamilies,
    providerCount: successfulProviders.length,
    familyCount: successfulFamilies.length,
    meetsLimitedDiversity: successfulProviders.length >= 2,
    meetsStrongConsensus: successfulFamilies.length >= 3,
  };
}

export function deriveStatusFromDiversity(
  okCount: number,
  diversity: DiversityReport,
  judgeOk: boolean,
): { status: import('./types.js').ResearchSwarmStatus; exitReason: string } {
  if (okCount === 0) {
    return { status: 'PROVIDER_FAILURE', exitReason: 'no_workers_ok' };
  }
  if (!judgeOk) {
    return { status: 'JUDGE_FAILURE', exitReason: 'judge_failed' };
  }
  if (diversity.meetsStrongConsensus) {
    return { status: 'SUCCESS', exitReason: 'strong_consensus' };
  }
  if (diversity.meetsLimitedDiversity) {
    return { status: 'LIMITED_DIVERSITY', exitReason: 'limited_diversity' };
  }
  return { status: 'MULTIMODEL_UNAVAILABLE', exitReason: 'insufficient_provider_diversity' };
}
