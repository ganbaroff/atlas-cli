import { describe, it, expect, vi, afterEach } from 'vitest';
import { readTimeoutConfig, withTimeoutOutcome, remainingMs } from '../../research-swarm/timeouts.js';

describe('research-swarm timeouts', () => {
  afterEach(() => {
    delete process.env.ATLAS_SWARM_WORKER_TIMEOUT_MS;
    delete process.env.ATLAS_SWARM_JUDGE_TIMEOUT_MS;
    delete process.env.ATLAS_SWARM_GLOBAL_TIMEOUT_MS;
    delete process.env.ATLAS_SWARM_ROUTING_TIMEOUT_MS;
  });

  it('readTimeoutConfig uses env overrides', () => {
    process.env.ATLAS_SWARM_WORKER_TIMEOUT_MS = '30000';
    process.env.ATLAS_SWARM_JUDGE_TIMEOUT_MS = '20000';
    const cfg = readTimeoutConfig();
    expect(cfg.workerMs).toBe(30000);
    expect(cfg.judgeMs).toBe(20000);
  });

  it('withTimeoutOutcome resolves fast promises', async () => {
    const outcome = await withTimeoutOutcome(Promise.resolve(42), 1000);
    expect(outcome.kind).toBe('resolved');
    if (outcome.kind === 'resolved') expect(outcome.value).toBe(42);
  });

  it('withTimeoutOutcome times out slow promises', async () => {
    const slow = new Promise((r) => setTimeout(() => r('late'), 500));
    const outcome = await withTimeoutOutcome(slow, 30);
    expect(outcome.kind).toBe('timeout');
  });

  it('withTimeoutOutcome surfaces rejections', async () => {
    const failing = Promise.reject(new Error('boom'));
    const outcome = await withTimeoutOutcome(failing, 1000);
    expect(outcome.kind).toBe('rejected');
  });

  it('remainingMs returns non-negative value', () => {
    expect(remainingMs(Date.now() + 5000)).toBeGreaterThan(0);
    expect(remainingMs(Date.now() - 1000)).toBe(0);
  });
});
