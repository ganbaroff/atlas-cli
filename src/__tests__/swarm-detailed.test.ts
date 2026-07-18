import { describe, it, expect, vi } from 'vitest';

// Isolated from swarm.test.ts on purpose: that file leaves runSwarm's real network path
// alone (gated behind it.skipIf(!process.env.NVIDIA_API_KEY)). Here we fully mock every
// swarm.ts dependency that would otherwise make a real model call or touch the real
// memory-root filesystem, so runSwarmDetailed()/runSwarm() can be exercised deterministically
// with NO real network/LLM call and no writes outside the mock.

vi.mock('../agent.js', () => ({
  createAtlasAgentWithRoute: vi.fn(async () => ({
    agent: {
      generate: vi.fn(async () => ({ text: 'mock synthesis output' })),
    },
    route: { provider: 'nvidia', modelId: 'mock-model' },
  })),
  recordAgentSpend: vi.fn(),
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

  it('runSwarm still returns the synthesis string — same value as runSwarmDetailed(...).synthesis under the same mock', async () => {
    const { runSwarm, runSwarmDetailed } = await import('../swarm.js');

    const detail = await runSwarmDetailed('regression task', false);
    const synthesis = await runSwarm('regression task', false);

    expect(typeof synthesis).toBe('string');
    expect(synthesis).toBe(detail.synthesis);
  });
});
