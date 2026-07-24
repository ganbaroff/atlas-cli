import { describe, it, expect } from 'vitest';
import { buildClaimsFromWorkers, buildJudgePrompt } from '../../research-swarm/synthesis.js';
import type { WorkerEvidence } from '../../research-swarm/types.js';

describe('research-swarm synthesis', () => {
  it('buildClaimsFromWorkers dedupes and captures dissent', () => {
    const workers: WorkerEvidence[] = [
      {
        id: 0, actualProvider: 'nvidia', actualModelId: 'm', modelFamily: 'llama',
        status: 'ok', output: 'Risk gate must verify exchange connectivity before live.', durationMs: 100,
      },
      {
        id: 1, actualProvider: 'groq', actualModelId: 'm', modelFamily: 'llama',
        status: 'ok', output: 'Risk gate must verify exchange connectivity before live trading.', durationMs: 100,
      },
      {
        id: 2, actualProvider: 'nvidia', actualModelId: 'm', modelFamily: 'llama',
        status: 'timeout', output: '', durationMs: 45000, error: 'worker_timeout_45000ms',
      },
    ];
    const { claims, dissent } = buildClaimsFromWorkers(workers);
    expect(claims.length).toBeGreaterThan(0);
    expect(dissent.length).toBe(1);
    expect(dissent[0]?.dissent).toBe(true);
  });

  it('buildJudgePrompt includes deduped claims and forbids inventing evidence', () => {
    const workers: WorkerEvidence[] = [{
      id: 0, actualProvider: 'nvidia', actualModelId: 'm', modelFamily: 'llama',
      status: 'ok', output: 'Evidence gate: paper trade reconciliation.', durationMs: 50,
    }];
    const { claims, dissent } = buildClaimsFromWorkers(workers);
    const prompt = buildJudgePrompt({ task: 'audit task', workers, judgeTimeoutMs: 1000 }, claims, dissent);
    expect(prompt).toContain('do NOT recommend actions');
    expect(prompt).toContain('Deduped unique claims');
    expect(prompt).toContain('Evidence gate');
  });
});
