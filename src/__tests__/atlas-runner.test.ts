/**
 * atlas-runner.test.ts — tests for the L2 local-node runner.
 *
 * ALL via injected fakes — zero network, zero subprocess, zero Supabase.
 */

import { describe, it, expect, vi } from 'vitest';
import { runnerTick, runRunnerLoop, type RunnerDeps, type RunnerTickResult } from '../atlas/atlas-runner.js';

// ── Helpers ────────────────────────────────────────────────────────────

function makeDeps(overrides: Partial<RunnerDeps> = {}): RunnerDeps {
  return {
    claim: vi.fn().mockResolvedValue(null),
    complete: vi.fn().mockResolvedValue(undefined),
    fail: vi.fn().mockResolvedValue(undefined),
    runLocal: vi.fn().mockResolvedValue({ output: 'ok', exitCode: 0 }),
    isPaused: vi.fn().mockReturnValue(false),
    workerId: 'test-worker-1',
    ...overrides,
  };
}

function fakeCommand(command: string, id = 'cmd-1') {
  return { id, command, payload: null, chat_id: 123, priority: 0 };
}

// ── Tests ──────────────────────────────────────────────────────────────

describe('runnerTick', () => {
  it('returns idle when claim returns null', async () => {
    const deps = makeDeps({ claim: vi.fn().mockResolvedValue(null) });
    const result = await runnerTick(deps);

    expect(result.status).toBe('idle');
    expect(deps.complete).not.toHaveBeenCalled();
    expect(deps.fail).not.toHaveBeenCalled();
  });

  it('returns paused without claiming when isPaused is true', async () => {
    const deps = makeDeps({ isPaused: vi.fn().mockReturnValue(true) });
    const result = await runnerTick(deps);

    expect(result.status).toBe('paused');
    expect(deps.claim).not.toHaveBeenCalled();
    expect(deps.complete).not.toHaveBeenCalled();
    expect(deps.fail).not.toHaveBeenCalled();
  });

  it('happy path: claim → runLocal → complete', async () => {
    const deps = makeDeps({
      claim: vi.fn().mockResolvedValue(fakeCommand('check disk space')),
      runLocal: vi.fn().mockResolvedValue({ output: '50GB free', exitCode: 0 }),
    });
    const result = await runnerTick(deps);

    expect(result.status).toBe('completed');
    expect(result).toHaveProperty('commandId', 'cmd-1');
    expect(result).toHaveProperty('output', '50GB free');
    expect(deps.complete).toHaveBeenCalledWith('cmd-1', '50GB free');
    expect(deps.fail).not.toHaveBeenCalled();
  });

  it('red-line: refuses a command with irreversible keywords, never calls runLocal', async () => {
    // Russian money transfer command — should trip the 'money' red-line
    const deps = makeDeps({
      claim: vi.fn().mockResolvedValue(fakeCommand('переведи деньги 500 долларов на счет X')),
    });
    const result = await runnerTick(deps);

    expect(result.status).toBe('refused');
    expect(result).toHaveProperty('reason');
    expect((result as { reason: string }).reason).toContain('needs-approval');
    expect(deps.runLocal).not.toHaveBeenCalled();
    expect(deps.fail).toHaveBeenCalledWith('cmd-1', expect.stringContaining('needs-approval'));
  });

  it('red-line: refuses English destructive command (delete all)', async () => {
    const deps = makeDeps({
      claim: vi.fn().mockResolvedValue(fakeCommand('delete all files in prod')),
    });
    const result = await runnerTick(deps);

    expect(result.status).toBe('refused');
    expect(deps.runLocal).not.toHaveBeenCalled();
    expect(deps.fail).toHaveBeenCalled();
  });

  it('runLocal throws → fail is called, loop does not crash', async () => {
    const deps = makeDeps({
      claim: vi.fn().mockResolvedValue(fakeCommand('some task')),
      runLocal: vi.fn().mockRejectedValue(new Error('spawn failed')),
    });
    const result = await runnerTick(deps);

    expect(result.status).toBe('failed');
    expect(result).toHaveProperty('error');
    expect((result as { error: string }).error).toContain('spawn failed');
    expect(deps.fail).toHaveBeenCalledWith('cmd-1', expect.stringContaining('spawn failed'));

    // Verify a second tick still works (loop doesn't crash)
    const deps2 = makeDeps({
      claim: vi.fn().mockResolvedValue(null),
    });
    const result2 = await runnerTick(deps2);
    expect(result2.status).toBe('idle');
  });

  it('non-zero exit code → fail is called', async () => {
    const deps = makeDeps({
      claim: vi.fn().mockResolvedValue(fakeCommand('bad command')),
      runLocal: vi.fn().mockResolvedValue({ output: 'error output', exitCode: 1 }),
    });
    const result = await runnerTick(deps);

    expect(result.status).toBe('failed');
    expect(deps.fail).toHaveBeenCalledWith('cmd-1', expect.stringContaining('exit 1'));
    expect(deps.complete).not.toHaveBeenCalled();
  });
});

describe('runRunnerLoop', () => {
  it('calls tick exactly maxTicks times and returns', async () => {
    const ticks: RunnerTickResult[] = [];
    let callCount = 0;
    const deps = makeDeps({
      claim: vi.fn().mockImplementation(async () => {
        callCount++;
        return fakeCommand(`task ${callCount}`, `cmd-${callCount}`);
      }),
      runLocal: vi.fn().mockResolvedValue({ output: 'done', exitCode: 0 }),
    });

    await runRunnerLoop(deps, {
      maxTicks: 3,
      tickIntervalMs: 1, // fast for tests
      onTick: (r) => ticks.push(r),
    });

    expect(ticks).toHaveLength(3);
    expect(ticks.every((t) => t.status === 'completed')).toBe(true);
    expect(deps.claim).toHaveBeenCalledTimes(3);
  });
});
