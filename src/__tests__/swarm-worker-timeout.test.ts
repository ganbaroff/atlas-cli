import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

let generateDelayMs = 0;

vi.mock('@mastra/core/agent', () => ({
  Agent: vi.fn().mockImplementation(() => ({
    generate: vi.fn(
      () =>
        new Promise((resolve) => {
          setTimeout(() => resolve({ text: 'mock output with sufficient content' }), generateDelayMs);
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
  buildArtifact: vi.fn((a: unknown) => ({ ...(a as object), secretScan: { clean: true, findings: [] } })),
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

describe('swarm — per-worker timeout (ATLAS_SWARM_WORKER_TIMEOUT_MS)', () => {
  let priorTimeout: string | undefined;

  beforeEach(() => {
    priorTimeout = process.env.ATLAS_SWARM_WORKER_TIMEOUT_MS;
    process.env.ATLAS_SWARM_WORKER_TIMEOUT_MS = '40';
    process.env.ATLAS_SWARM_JUDGE_TIMEOUT_MS = '5000';
    generateDelayMs = 0;
  });

  afterEach(() => {
    if (priorTimeout === undefined) delete process.env.ATLAS_SWARM_WORKER_TIMEOUT_MS;
    else process.env.ATLAS_SWARM_WORKER_TIMEOUT_MS = priorTimeout;
    delete process.env.ATLAS_SWARM_JUDGE_TIMEOUT_MS;
    generateDelayMs = 0;
  });

  it('a worker whose provider hangs past the timeout resolves to a worker_timeout error, not a hang', async () => {
    generateDelayMs = 5_000;
    const { runSwarmDetailed } = await import('../swarm.js');

    const t0 = Date.now();
    const detail = await runSwarmDetailed('mock task — hanging provider');
    const elapsed = Date.now() - t0;

    expect(elapsed).toBeLessThan(2_000);
    expect(detail.results.length).toBeGreaterThan(0);
    const respondersOk = detail.results.filter((r) => !r.error).length;
    expect(respondersOk).toBe(0);

    for (const r of detail.results) {
      expect(r.error).toMatch(/^worker_timeout_\d+ms$/);
      expect(r.output).toBe('');
    }
  });

  it('control: a worker whose provider resolves fast returns a normal, non-error result', async () => {
    generateDelayMs = 5;
    const { runSwarmDetailed } = await import('../swarm.js');

    const detail = await runSwarmDetailed('mock task — healthy fast provider');
    expect(detail.results.length).toBeGreaterThan(0);
    for (const r of detail.results) {
      expect(r.error).toBeUndefined();
      expect(r.output).toContain('mock output');
    }
    const respondersOk = detail.results.filter((r) => !r.error).length;
    expect(respondersOk).toBe(detail.results.length);
  });
});
