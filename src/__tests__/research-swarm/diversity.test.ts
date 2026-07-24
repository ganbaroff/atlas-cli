import { describe, it, expect } from 'vitest';
import { evaluateDiversity, deriveStatusFromDiversity } from '../../research-swarm/diversity.js';
import type { WorkerEvidence } from '../../research-swarm/types.js';

function okWorker(id: number, provider: string, family: string): WorkerEvidence {
  return {
    id,
    actualProvider: provider,
    actualModelId: 'mock',
    modelFamily: family,
    status: 'ok',
    output: `finding from worker ${id}`,
    durationMs: 100,
  };
}

describe('research-swarm diversity', () => {
  it('LIMITED_DIVERSITY requires 2+ successful providers', () => {
    const workers = [okWorker(0, 'nvidia', 'llama'), okWorker(1, 'groq', 'llama')];
    const div = evaluateDiversity(workers);
    expect(div.meetsLimitedDiversity).toBe(true);
    expect(div.meetsStrongConsensus).toBe(false);
    expect(div.providerCount).toBe(2);
  });

  it('STRONG_CONSENSUS requires 3+ model families', () => {
    const workers = [
      okWorker(0, 'nvidia', 'llama'),
      okWorker(1, 'gemini', 'gemini'),
      okWorker(2, 'groq', 'llama'),
    ];
    workers[2]!.modelFamily = 'qwen';
    const div = evaluateDiversity(workers);
    expect(div.familyCount).toBe(3);
    expect(div.meetsStrongConsensus).toBe(true);
  });

  it('single provider yields MULTIMODEL_UNAVAILABLE path', () => {
    const workers = [okWorker(0, 'nvidia', 'llama')];
    const div = evaluateDiversity(workers);
    expect(div.meetsLimitedDiversity).toBe(false);
    const { status } = deriveStatusFromDiversity(1, div, true);
    expect(status).toBe('MULTIMODEL_UNAVAILABLE');
  });

  it('failed workers excluded from diversity counts', () => {
    const workers = [
      okWorker(0, 'nvidia', 'llama'),
      { ...okWorker(1, 'groq', 'llama'), status: 'timeout' as const, output: '' },
    ];
    const div = evaluateDiversity(workers);
    expect(div.providerCount).toBe(1);
  });
});
