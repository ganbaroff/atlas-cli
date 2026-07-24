import { describe, it, expect } from 'vitest';
import { buildArtifact, exitCodeForStatus, taskHash } from '../../research-swarm/artifact.js';
import { RESEARCH_SWARM_SCHEMA_VERSION } from '../../research-swarm/types.js';

describe('research-swarm artifact', () => {
  it('buildArtifact sets schemaVersion and runs secret scan', () => {
    const artifact = buildArtifact({
      runId: 'run-1',
      taskHash: taskHash('test task'),
      task: 'test task',
      startedAt: '2026-07-24T10:00:00.000Z',
      completedAt: '2026-07-24T10:00:05.000Z',
      durationMs: 5000,
      status: 'SUCCESS',
      exitReason: 'strong_consensus',
      memoryState: 'LOCAL_ONLY',
      workers: [],
      judge: null,
      claims: [],
      dissent: [],
      diversity: {
        successfulProviders: ['nvidia', 'groq'],
        successfulFamilies: ['llama', 'llama', 'gemini'],
        providerCount: 2,
        familyCount: 2,
        meetsLimitedDiversity: true,
        meetsStrongConsensus: false,
      },
      consensus: null,
      synthesis: 'ok synthesis',
      bridgeSource: 'typescript',
    });

    expect(artifact.schemaVersion).toBe(RESEARCH_SWARM_SCHEMA_VERSION);
    expect(artifact.secretScan.clean).toBe(true);
    expect(artifact.taskHash).toHaveLength(16);
  });

  it('exitCodeForStatus returns 0 only for SUCCESS', () => {
    expect(exitCodeForStatus('SUCCESS')).toBe(0);
    expect(exitCodeForStatus('TIMEOUT')).toBe(1);
    expect(exitCodeForStatus('PROVIDER_FAILURE')).toBe(1);
    expect(exitCodeForStatus('LIMITED_DIVERSITY')).toBe(1);
  });

  it('secret scan flags API key patterns without echoing them', () => {
    const artifact = buildArtifact({
      runId: 'run-2',
      taskHash: 'abc',
      task: 'leaked sk-12345678901234567890123456789012 in output',
      startedAt: '2026-07-24T10:00:00.000Z',
      completedAt: '2026-07-24T10:00:01.000Z',
      durationMs: 1000,
      status: 'PROVIDER_FAILURE',
      exitReason: 'no_workers_ok',
      memoryState: 'LOCAL_ONLY',
      workers: [],
      judge: null,
      claims: [],
      dissent: [],
      diversity: {
        successfulProviders: [],
        successfulFamilies: [],
        providerCount: 0,
        familyCount: 0,
        meetsLimitedDiversity: false,
        meetsStrongConsensus: false,
      },
      consensus: null,
      synthesis: '',
      bridgeSource: 'typescript',
    });
    expect(artifact.secretScan.clean).toBe(false);
    expect(artifact.secretScan.findings).toContain('openai_key');
  });
});
