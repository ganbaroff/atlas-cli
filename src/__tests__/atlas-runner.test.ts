/**
 * atlas-runner.test.ts — tests for the L2 local-node runner.
 *
 * ALL via injected fakes — zero network, zero subprocess, zero Supabase.
 */

import { describe, it, expect, vi } from 'vitest';
import { runnerTick, runRunnerLoop, describeRunnerLiveness, type RunnerDeps, type RunnerTickResult } from '../atlas/atlas-runner.js';

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

  it('regression: malformed claimed row (non-string command) fails cleanly, never crashes, never reaches red-line scanner', async () => {
    // Live 2026-07-27: a claimed row with a non-string .command crashed the
    // whole runner process (unguarded .toLowerCase() downstream). External
    // Supabase data is not a TypeScript-shape guarantee.
    const deps = makeDeps({
      claim: vi.fn().mockResolvedValue({ id: 'cmd-bad', command: undefined, payload: null, chat_id: 1, priority: 0 }),
    });
    const result = await runnerTick(deps);

    expect(result.status).toBe('failed');
    expect(deps.runLocal).not.toHaveBeenCalled();
    expect(deps.fail).toHaveBeenCalledWith('cmd-bad', expect.stringContaining('malformed'));
  });

  it('regression: null exit code (task-spawner blocked/paused/timeout signal) is NEVER treated as success', async () => {
    // task-spawner's runTask() returns exitCode:null for emergency pause,
    // control-block, "another task already running", AND a signal-killed
    // timeout — none of these mean the work completed. A race is possible
    // where runnerTick's own isPaused() gate passes but pause flips on
    // before runLocal actually runs; this must still never report success.
    const deps = makeDeps({
      claim: vi.fn().mockResolvedValue(fakeCommand('do something')),
      runLocal: vi.fn().mockResolvedValue({
        output: 'Emergency pause active: ATLAS_PAUSE=1',
        exitCode: null,
      }),
    });
    const result = await runnerTick(deps);

    expect(result.status).toBe('failed');
    expect(deps.complete).not.toHaveBeenCalled();
    expect(deps.fail).toHaveBeenCalledWith(
      'cmd-1',
      expect.stringContaining('Emergency pause active'),
    );
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

describe('describeRunnerLiveness', () => {
  const lease = { instanceId: 'i-1', pid: 1234, startedAt: '2026-07-27T14:00:00.000Z', heartbeatAt: '2026-07-27T14:05:00.000Z' };

  it('reports not-started when no lease file exists', () => {
    const result = describeRunnerLiveness(null, Date.parse('2026-07-27T14:05:10.000Z'), () => true);
    expect(result.status).toBe('not-started');
  });

  it('reports running when the process is alive and heartbeat is fresh', () => {
    const now = Date.parse('2026-07-27T14:05:10.000Z'); // 10s after last heartbeat
    const result = describeRunnerLiveness(lease, now, () => true, 60_000);
    expect(result.status).toBe('running');
    expect(result.pid).toBe(1234);
  });

  it('reports stale when the heartbeat is older than the TTL, even if the pid still exists', () => {
    const now = Date.parse('2026-07-27T14:06:05.000Z'); // 65s after last heartbeat, TTL=60s
    const result = describeRunnerLiveness(lease, now, () => true, 60_000);
    expect(result.status).toBe('stale');
  });

  it('reports stale when the pid no longer exists, even with a fresh heartbeat timestamp', () => {
    const now = Date.parse('2026-07-27T14:05:10.000Z');
    const result = describeRunnerLiveness(lease, now, () => false, 60_000);
    expect(result.status).toBe('stale');
  });
});
