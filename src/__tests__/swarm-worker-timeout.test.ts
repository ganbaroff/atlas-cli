import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Verifies the bounded per-worker timeout added to runWorker() in src/swarm.ts:
// a slow/hanging provider must resolve to a fast `worker_timeout_<ms>ms` error
// result instead of blocking runSwarmDetailed()'s Promise.all(...) forever.
//
// Fully mocked (no network), same './agent.js' mock shape as swarm-detailed.test.ts,
// but with a controllable generate() delay so we can drive both the "hangs past the
// timeout" and "resolves well within the timeout" cases from the same mock.

let generateDelayMs = 0;

// Only WORKER-role calls (runWorker's agent.generate) are delayed by generateDelayMs.
// JUDGE-role calls (synthesize's agent.generate) always resolve immediately, so the
// per-worker timeout under test is isolated from the (intentionally un-bounded)
// synthesis step and the test stays fast regardless of generateDelayMs.
vi.mock('../agent.js', () => ({
  createAtlasAgentWithRoute: vi.fn(async (role: string) => ({
    agent: {
      generate: vi.fn(
        () =>
          new Promise((resolve) => {
            const delay = role === 'WORKER' ? generateDelayMs : 0;
            setTimeout(() => resolve({ text: 'mock output' }), delay);
          }),
      ),
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

describe('swarm — per-worker timeout (ATLAS_SWARM_WORKER_TIMEOUT_MS)', () => {
  let priorTimeout: string | undefined;

  beforeEach(() => {
    priorTimeout = process.env.ATLAS_SWARM_WORKER_TIMEOUT_MS;
    process.env.ATLAS_SWARM_WORKER_TIMEOUT_MS = '40';
    generateDelayMs = 0;
  });

  afterEach(() => {
    if (priorTimeout === undefined) delete process.env.ATLAS_SWARM_WORKER_TIMEOUT_MS;
    else process.env.ATLAS_SWARM_WORKER_TIMEOUT_MS = priorTimeout;
    generateDelayMs = 0;
  });

  it('a worker whose provider hangs past the timeout resolves to a worker_timeout error, not a hang', async () => {
    generateDelayMs = 5_000; // way past the 40ms bound — must never be awaited in full
    const { runSwarmDetailed } = await import('../swarm.js');

    const t0 = Date.now();
    const detail = await runSwarmDetailed('mock task — hanging provider');
    const elapsed = Date.now() - t0;

    // Promptness: the whole run (workers + synthesis, all hung the same way) must
    // complete in a small multiple of the 40ms bound, not anywhere near the 5s delay.
    expect(elapsed).toBeLessThan(2_000);

    expect(detail.results.length).toBeGreaterThan(0);
    const respondersOk = detail.results.filter((r) => !r.error).length;
    expect(respondersOk).toBe(0);

    for (const r of detail.results) {
      expect(r.error).toMatch(/^worker_timeout_\d+ms$/);
      expect(r.output).toBe('');
    }
  });

  it('control: a worker whose provider resolves fast (well under the timeout) returns a normal, non-error result', async () => {
    generateDelayMs = 5; // far under the 40ms bound
    const { runSwarmDetailed } = await import('../swarm.js');

    const detail = await runSwarmDetailed('mock task — healthy fast provider');

    expect(detail.results.length).toBeGreaterThan(0);
    for (const r of detail.results) {
      expect(r.error).toBeUndefined();
      expect(r.output).toBe('mock output');
    }
    const respondersOk = detail.results.filter((r) => !r.error).length;
    expect(respondersOk).toBe(detail.results.length);
  });
});
