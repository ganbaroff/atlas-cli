import { describe, it, expect, vi, beforeEach } from 'vitest';

let generateDelayMs = 0;

vi.mock('@mastra/core/agent', () => ({
  Agent: vi.fn().mockImplementation(() => ({
    generate: vi.fn(
      () =>
        new Promise((resolve) => {
          setTimeout(
            () => resolve({ text: 'mock worker output with enough content for validation' }),
            generateDelayMs,
          );
        }),
    ),
  })),
}));

vi.mock('../research-swarm/provider-routing.js', () => ({
  routeWorkerProvider: vi.fn(() => ({
    provider: 'nvidia',
    modelId: 'mock-model',
    model: {},
    costTier: 0,
  })),
  routeJudgeProvider: vi.fn(() => ({
    provider: 'nvidia',
    modelId: 'mock-judge',
    model: {},
    costTier: 0,
  })),
  ProviderRoutingError: class extends Error { name = 'ProviderRoutingError'; },
}));

vi.mock('../atlas/brain-planner.js', () => ({
  buildAtlasBrainPlan: vi.fn(async () => ({ systemPrompt: 'mock' })),
}));

vi.mock('../agent.js', () => ({
  recordAgentSpend: vi.fn(),
}));

vi.mock('../research-swarm/memory-state.js', () => ({
  probeMemoryState: vi.fn(async () => 'LOCAL_ONLY'),
}));

vi.mock('../research-swarm/artifact.js', () => ({
  buildArtifact: vi.fn((a: unknown) => a),
  exitCodeForStatus: vi.fn((s: string) => (s === 'SUCCESS' ? 0 : 1)),
  newRunId: vi.fn(() => 'test-run'),
  taskHash: vi.fn(() => 'hash'),
  writeArtifact: vi.fn(async () => '/tmp/mock-artifact.json'),
}));

vi.mock('../atlas/swarm-logger.js', () => ({
  logSwarmRun: vi.fn(async () => '/tmp/mock-swarm-run-log.json'),
}));

vi.mock('../atlas/control-plane.js', () => ({
  controlAllowsModelCalls: vi.fn(() => true),
  describeControlBlock: vi.fn(() => 'Control blocked (mocked).'),
}));

vi.mock('../atlas/spend-policy.js', () => ({
  isPaused: vi.fn(() => false),
}));

describe('swarm — runSwarmDetailed / runSwarm (fully mocked, no network)', () => {
  beforeEach(() => {
    generateDelayMs = 5;
    process.env.ATLAS_SWARM_WORKER_TIMEOUT_MS = '5000';
    process.env.ATLAS_SWARM_JUDGE_TIMEOUT_MS = '5000';
  });

  it('runSwarmDetailed returns subtasks[], results[], string synthesis, numeric durationMs, and jidokaViolation (string|null)', async () => {
    const { runSwarmDetailed } = await import('../swarm.js');
    const detail = await runSwarmDetailed('mock task for detailed run');

    expect(Array.isArray(detail.subtasks)).toBe(true);
    expect(detail.subtasks.length).toBeGreaterThan(0);
    expect(Array.isArray(detail.results)).toBe(true);
    expect(detail.results.length).toBe(detail.subtasks.length);
    expect(typeof detail.synthesis).toBe('string');
    expect(detail.synthesis.length).toBeGreaterThan(0);
    expect(typeof detail.durationMs).toBe('number');
    expect(Number.isFinite(detail.durationMs)).toBe(true);
    expect(detail.jidokaViolation === null || typeof detail.jidokaViolation === 'string').toBe(true);
  });

  it('runSwarm returns synthesis string', async () => {
    const { runSwarm, runSwarmDetailed } = await import('../swarm.js');
    const detail = await runSwarmDetailed('regression task', false);
    const synthesis = await runSwarm('regression task', false);
    expect(typeof synthesis).toBe('string');
    expect(synthesis).toBe(detail.synthesis);
  });

  it('WorkerResult.provider reports actual routed provider (nvidia from mock)', async () => {
    const { runSwarmDetailed } = await import('../swarm.js');
    const detail = await runSwarmDetailed('mock task — honest provider check');
    for (const r of detail.results) {
      expect(r.provider).toBe('nvidia');
    }
  });
});
