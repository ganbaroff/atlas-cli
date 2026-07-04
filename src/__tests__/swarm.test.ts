import { describe, it, expect, vi } from 'vitest';
import type { Subtask, WorkerResult } from '../swarm.js';

describe('swarm', () => {
  it('runSwarm is exported as a function', async () => {
    const { runSwarm } = await import('../swarm.js');
    expect(typeof runSwarm).toBe('function');
  });

  it('Subtask shape is valid (type-level sanity)', () => {
    const sub: Subtask = { id: 1, description: 'test task', provider: 'nvidia' };
    expect(sub.id).toBe(1);
    expect(sub.description).toBe('test task');
    const result: WorkerResult = { id: 1, output: 'ok', provider: 'nvidia', durationMs: 42 };
    expect(result.output).toBe('ok');
  });

  it.skipIf(!process.env['NVIDIA_API_KEY'])('runSwarm returns non-empty string', async () => {
    const { runSwarm } = await import('../swarm.js');
    const out = await runSwarm('What is 1+1?');
    expect(typeof out).toBe('string');
    expect(out.length).toBeGreaterThan(0);
  }, 120_000);
});
