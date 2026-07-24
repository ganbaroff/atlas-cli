import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

let generateDelayMs = 0;
let generateImpl: (prompt: string) => Promise<{ text: string }>;

vi.mock('@mastra/core/agent', () => ({
  Agent: vi.fn().mockImplementation(() => ({
    generate: vi.fn((prompt: string) => generateImpl(prompt)),
  })),
}));

vi.mock('../../research-swarm/provider-routing.js', () => ({
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

vi.mock('../../atlas/brain-planner.js', () => ({
  buildAtlasBrainPlan: vi.fn(async () => ({ systemPrompt: 'mock prompt' })),
}));

vi.mock('../../agent.js', () => ({
  recordAgentSpend: vi.fn(),
}));

vi.mock('../../research-swarm/memory-state.js', () => ({
  probeMemoryState: vi.fn(async () => 'LOCAL_ONLY'),
}));

vi.mock('../../research-swarm/artifact.js', () => ({
  buildArtifact: vi.fn((a: unknown) => ({ ...(a as object), secretScan: { clean: true, findings: [] } })),
  exitCodeForStatus: vi.fn((s: string) => (s === 'SUCCESS' ? 0 : 1)),
  newRunId: vi.fn(() => 'test-run-id-1234'),
  taskHash: vi.fn(() => 'abcd1234'),
  writeArtifact: vi.fn(async () => '/tmp/test-artifact.json'),
}));

vi.mock('../../atlas/control-plane.js', () => ({
  controlAllowsModelCalls: vi.fn(() => true),
  describeControlBlock: vi.fn(() => 'blocked'),
}));

vi.mock('../../atlas/spend-policy.js', () => ({
  isPaused: vi.fn(() => false),
  isPaidProvider: vi.fn(() => false),
  paidAllowed: vi.fn(() => false),
}));

vi.mock('../../research-swarm/perspective-config.js', () => ({
  auditPerspectiveConfig: vi.fn(() => ({
    issues: [],
    availableWorkerProviders: ['nvidia'],
    declaredCount: 0,
    routableDeclaredCount: 0,
  })),
  validateDeclaredWorkerProvider: vi.fn(() => ({ ok: true })),
}));

describe('research-swarm lifecycle', () => {
  beforeEach(() => {
    generateDelayMs = 0;
    generateImpl = () =>
      new Promise((resolve) => {
        setTimeout(() => resolve({ text: 'mock worker output with enough content for jidoka' }), generateDelayMs);
      });
    process.env.ATLAS_SWARM_WORKER_TIMEOUT_MS = '50';
    process.env.ATLAS_SWARM_JUDGE_TIMEOUT_MS = '50';
    process.env.ATLAS_SWARM_GLOBAL_TIMEOUT_MS = '30000';
  });

  afterEach(() => {
    delete process.env.ATLAS_SWARM_WORKER_TIMEOUT_MS;
    delete process.env.ATLAS_SWARM_JUDGE_TIMEOUT_MS;
    delete process.env.ATLAS_SWARM_GLOBAL_TIMEOUT_MS;
  });

  it('all workers timeout → TIMEOUT status, non-zero exit, no SUCCESS', async () => {
    generateDelayMs = 5000;
    const { runResearchSwarm } = await import('../../research-swarm/lifecycle.js');
    const t0 = Date.now();
    const result = await runResearchSwarm('timeout test task');
    expect(Date.now() - t0).toBeLessThan(5000);
    expect(result.artifact.status).toBe('TIMEOUT');
    expect(result.exitCode).not.toBe(0);
    expect(result.artifact.workers.every((w) => w.status === 'timeout')).toBe(true);
  });

  it('successful workers → non-empty synthesis and artifact', async () => {
    generateDelayMs = 5;
    const { runResearchSwarm } = await import('../../research-swarm/lifecycle.js');
    const result = await runResearchSwarm('healthy task');
    expect(result.synthesis.length).toBeGreaterThan(0);
    expect(result.artifact.workers.some((w) => w.status === 'ok')).toBe(true);
  });
});
