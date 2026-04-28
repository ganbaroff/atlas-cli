import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('node:fs/promises', () => ({
  writeFile: vi.fn().mockResolvedValue(undefined),
  mkdir: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('node:fs', () => ({
  existsSync: vi.fn().mockReturnValue(false),
}));

describe('swarm-logger', () => {
  beforeEach(() => {
    vi.stubEnv('MEMORY_ROOT', '/tmp/atlas-test-vault');
  });

  it('logSwarmRun returns file path', async () => {
    const { logSwarmRun } = await import('../atlas/swarm-logger.js');
    const fp = await logSwarmRun({
      ts: '2026-04-27T01:00:00.000Z',
      task: 'test task',
      subtasks: [{ id: 0, description: 'sub1' }],
      results: [{ id: 0, output: 'result', provider: 'cerebras', durationMs: 100 }],
      synthesis: 'final answer',
      durationMs: 500,
      jidokaViolation: null,
    });
    expect(fp).toContain('2026-04-27');
    expect(fp).toContain('.json');
  });

  it('logSwarmRun calls writeFile with JSON content', async () => {
    const fsp = await import('node:fs/promises');
    const { logSwarmRun } = await import('../atlas/swarm-logger.js');
    await logSwarmRun({
      ts: '2026-04-27T02:00:00.000Z',
      task: 'another task',
      subtasks: [],
      results: [],
      synthesis: 'empty',
      durationMs: 0,
      jidokaViolation: null,
    });
    expect(fsp.writeFile).toHaveBeenCalled();
  });
});
