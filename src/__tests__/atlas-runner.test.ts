/**
 * atlas-runner.test.ts — tests for the L2 local-node runner.
 *
 * ALL via injected fakes — zero network, zero subprocess, zero Supabase.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHmac } from 'node:crypto';
import { runnerTick, runRunnerLoop, describeRunnerLiveness, _resetNoKeyWarning, type RunnerDeps, type RunnerTickResult } from '../atlas/atlas-runner.js';
import { createNonceLedger } from '../atlas/queue-auth.js';
import {
  deriveQueueOperationId,
  markStarted,
  prepareOperation,
  executeOnce,
} from '../atlas/effect-journal.js';

// ── Classifier kill-switch for runner tests ──────────────────────────
// Runner tests test the runner, not the LLM classifier. Disable the
// classifier via the documented kill-switch so no network calls are
// attempted. The classifier has its own dedicated test file.
let savedLLMEnv: string | undefined;
let journalRoot: string | undefined;
beforeEach(() => {
  savedLLMEnv = process.env['ATLAS_REDLINE_LLM'];
  process.env['ATLAS_REDLINE_LLM'] = '0';
  journalRoot = mkdtempSync(join(tmpdir(), 'atlas-runner-journal-'));
});
afterEach(() => {
  if (savedLLMEnv === undefined) delete process.env['ATLAS_REDLINE_LLM'];
  else process.env['ATLAS_REDLINE_LLM'] = savedLLMEnv;
  if (journalRoot) rmSync(journalRoot, { recursive: true, force: true });
  journalRoot = undefined;
});

// ── Helpers ────────────────────────────────────────────────────────────

function makeDeps(overrides: Partial<RunnerDeps> = {}): RunnerDeps {
  return {
    claim: vi.fn().mockResolvedValue(null),
    complete: vi.fn().mockResolvedValue(undefined),
    fail: vi.fn().mockResolvedValue(undefined),
    runLocal: vi.fn().mockResolvedValue({ output: 'ok', exitCode: 0 }),
    isPaused: vi.fn().mockReturnValue(false),
    workerId: 'test-worker-1',
    effectJournalRoot: journalRoot,
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

// ── C-wire integration: Cyrillic root coverage reaches the runner gate ──

describe('runnerTick — C-wire gap phrasings blocked by the gate', () => {
  it('gap 1 [credentials]: "покажи пароли от сервера" — refused, runLocal never called', async () => {
    const deps = makeDeps({
      claim: vi.fn().mockResolvedValue(fakeCommand('покажи пароли от сервера')),
    });
    const result = await runnerTick(deps);
    expect(result.status).toBe('refused');
    expect(deps.runLocal).not.toHaveBeenCalled();
  });

  it('gap 2 [payment]: "переведите деньги на счет" — refused, runLocal never called', async () => {
    const deps = makeDeps({
      claim: vi.fn().mockResolvedValue(fakeCommand('переведите деньги на счет')),
    });
    const result = await runnerTick(deps);
    expect(result.status).toBe('refused');
    expect(deps.runLocal).not.toHaveBeenCalled();
  });

  it('gap 3 [prod-database]: "примени миграцию на продакшне" — refused, runLocal never called', async () => {
    const deps = makeDeps({
      claim: vi.fn().mockResolvedValue(fakeCommand('примени миграцию на продакшне')),
    });
    const result = await runnerTick(deps);
    expect(result.status).toBe('refused');
    expect(deps.runLocal).not.toHaveBeenCalled();
  });

  it('gap 4 [merge]: "влей ветку в мейн" — refused, runLocal never called', async () => {
    const deps = makeDeps({
      claim: vi.fn().mockResolvedValue(fakeCommand('влей ветку в мейн')),
    });
    const result = await runnerTick(deps);
    expect(result.status).toBe('refused');
    expect(deps.runLocal).not.toHaveBeenCalled();
  });

  it('gap 5 [deletion]: "удалите все файлы" — refused, runLocal never called', async () => {
    const deps = makeDeps({
      claim: vi.fn().mockResolvedValue(fakeCommand('удалите все файлы')),
    });
    const result = await runnerTick(deps);
    expect(result.status).toBe('refused');
    expect(deps.runLocal).not.toHaveBeenCalled();
  });
});

describe('runnerTick — benign Russian commands still pass (C-wire regression)', () => {
  it('passes "проверь статус сервера" (status check) — completed', async () => {
    const deps = makeDeps({
      claim: vi.fn().mockResolvedValue(fakeCommand('проверь статус сервера')),
      runLocal: vi.fn().mockResolvedValue({ output: 'server ok', exitCode: 0 }),
    });
    const result = await runnerTick(deps);
    expect(result.status).toBe('completed');
    expect(deps.runLocal).toHaveBeenCalled();
  });

  it('passes "прочитай файл конфигурации" (file read) — completed', async () => {
    const deps = makeDeps({
      claim: vi.fn().mockResolvedValue(fakeCommand('прочитай файл конфигурации')),
      runLocal: vi.fn().mockResolvedValue({ output: 'config contents', exitCode: 0 }),
    });
    const result = await runnerTick(deps);
    expect(result.status).toBe('completed');
    expect(deps.runLocal).toHaveBeenCalled();
  });
});

describe('describeRunnerLiveness', () => {
  const lease = {
    instanceId: 'i-1',
    pid: 1234,
    startedAt: '2026-07-27T14:00:00.000Z',
    heartbeatAt: '2026-07-27T14:05:00.000Z',
    runner: { kind: 'runner' as const },
  };

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

  // Defect 2 (found live 2026-07-28): this field used to be computed from
  // the READER's env. It now comes from the lease holder's own
  // declaration — see runner-liveness-lease.test.ts for the end-to-end
  // proof that a reader without the key still gets the truth.
  it('takes authEnforcement from the lease holder declaration', () => {
    const declared = {
      ...lease,
      runner: { kind: 'runner' as const, authEnforcement: 'on' as const },
    };
    const now = Date.parse('2026-07-27T14:05:10.000Z');
    expect(describeRunnerLiveness(declared, now, () => true, 60_000).authEnforcement).toBe('on');
  });

  it('reports occupied without runner fields for a fresh non-runner lease', () => {
    const { runner: _runner, ...nonRunnerLease } = lease;
    const now = Date.parse('2026-07-27T14:05:10.000Z');
    const report = describeRunnerLiveness(nonRunnerLease, now, () => true, 60_000);
    expect(report.status).toBe('occupied');
    expect(report.authEnforcement).toBeUndefined();
    expect(report.build).toBeUndefined();
  });

  it('still reports a declaration for a runner that has gone stale', () => {
    const declared = {
      ...lease,
      runner: { kind: 'runner' as const, authEnforcement: 'off' as const },
    };
    const now = Date.parse('2026-07-27T14:06:05.000Z'); // past the TTL
    const result = describeRunnerLiveness(declared, now, () => true, 60_000);
    expect(result.status).toBe('stale');
    expect(result.authEnforcement).toBe('off');
  });
});

// ── Wave D: work-order authenticity gate in runnerTick ──────────────────

const WAVE_D_TEST_KEY = 'test-fake-key-not-real-do-not-use';

function signForTest(command: string, chatId: number, overrides: Partial<{
  ts: string; nonce: string; sig: string;
}> = {}): { sig: string; ts: string; nonce: string } {
  const ts = overrides.ts ?? new Date().toISOString();
  const nonce = overrides.nonce ?? `nonce-${Math.random().toString(36).slice(2)}`;
  const canonical = JSON.stringify({ command, chat_id: chatId, ts, nonce });
  const sig = overrides.sig ?? createHmac('sha256', WAVE_D_TEST_KEY).update(canonical).digest('hex');
  return { sig, ts, nonce };
}

function fakeSignedCommand(command: string, id = 'cmd-s1', chatId = 123, payloadOverrides: Partial<{
  ts: string; nonce: string; sig: string;
}> = {}) {
  const signed = signForTest(command, chatId, payloadOverrides);
  return { id, command, payload: signed, chat_id: chatId, priority: 0 };
}

describe('runnerTick — Wave D: authenticity gate (key set)', () => {
  let tempDir: string;
  let authJournalRoot: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'runner-auth-test-'));
    authJournalRoot = mkdtempSync(join(tmpdir(), 'runner-auth-journal-'));
    _resetNoKeyWarning();
  });
  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
    rmSync(authJournalRoot, { recursive: true, force: true });
  });

  function makeAuthDeps(overrides: Partial<RunnerDeps> = {}): RunnerDeps {
    return {
      claim: vi.fn().mockResolvedValue(null),
      complete: vi.fn().mockResolvedValue(undefined),
      fail: vi.fn().mockResolvedValue(undefined),
      runLocal: vi.fn().mockResolvedValue({ output: 'ok', exitCode: 0 }),
      isPaused: vi.fn().mockReturnValue(false),
      workerId: 'test-worker-auth',
      getSigningKey: () => WAVE_D_TEST_KEY,
      nonceLedger: createNonceLedger(tempDir),
      effectJournalRoot: authJournalRoot,
      ...overrides,
    };
  }

  it('correctly signed fresh row passes to the red-line stage and completes', async () => {
    const cmd = fakeSignedCommand('check disk space');
    const deps = makeAuthDeps({
      claim: vi.fn().mockResolvedValue(cmd),
      runLocal: vi.fn().mockResolvedValue({ output: '50GB free', exitCode: 0 }),
    });
    const result = await runnerTick(deps);

    expect(result.status).toBe('completed');
    expect(deps.runLocal).toHaveBeenCalled();
    expect(deps.complete).toHaveBeenCalled();
  });

  it('unsigned row => refused with reason auth-failed: unsigned', async () => {
    const cmd = { id: 'cmd-u1', command: 'check disk', payload: {}, chat_id: 123, priority: 0 };
    const deps = makeAuthDeps({
      claim: vi.fn().mockResolvedValue(cmd),
    });
    const result = await runnerTick(deps);

    expect(result.status).toBe('refused');
    expect((result as any).reason).toContain('auth-failed: unsigned');
    expect(deps.runLocal).not.toHaveBeenCalled();
    expect(deps.fail).toHaveBeenCalledWith('cmd-u1', expect.stringContaining('auth-failed: unsigned'));
  });

  it('tampered command (sig mismatch) => refused with reason auth-failed: sig-mismatch', async () => {
    // Sign for 'check disk' but claim arrives with 'rm -rf /'
    const signed = signForTest('check disk', 123);
    const cmd = { id: 'cmd-t1', command: 'rm -rf /', payload: signed, chat_id: 123, priority: 0 };
    const deps = makeAuthDeps({
      claim: vi.fn().mockResolvedValue(cmd),
    });
    const result = await runnerTick(deps);

    expect(result.status).toBe('refused');
    expect((result as any).reason).toContain('auth-failed: sig-mismatch');
    expect(deps.runLocal).not.toHaveBeenCalled();
  });

  it('ts older than 24h => refused with reason auth-failed: expired', async () => {
    const oldTs = new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString();
    const cmd = fakeSignedCommand('check disk', 'cmd-e1', 123, { ts: oldTs });
    const deps = makeAuthDeps({
      claim: vi.fn().mockResolvedValue(cmd),
    });
    const result = await runnerTick(deps);

    expect(result.status).toBe('refused');
    expect((result as any).reason).toContain('auth-failed: expired');
    expect(deps.runLocal).not.toHaveBeenCalled();
  });

  it('repeated nonce => refused on the second claim with reason auth-failed: nonce-reuse', async () => {
    const fixedNonce = 'nonce-replay-test';
    const ledger = createNonceLedger(tempDir);

    // First claim: should pass
    const cmd1 = fakeSignedCommand('check disk', 'cmd-r1', 123, { nonce: fixedNonce });
    const deps1 = makeAuthDeps({
      claim: vi.fn().mockResolvedValue(cmd1),
      nonceLedger: ledger,
    });
    const result1 = await runnerTick(deps1);
    expect(result1.status).toBe('completed');

    // Second claim with same nonce: should be refused
    const cmd2 = fakeSignedCommand('check disk', 'cmd-r2', 123, { nonce: fixedNonce });
    const deps2 = makeAuthDeps({
      claim: vi.fn().mockResolvedValue(cmd2),
      nonceLedger: ledger,
    });
    const result2 = await runnerTick(deps2);

    expect(result2.status).toBe('refused');
    expect((result2 as any).reason).toContain('auth-failed: nonce-reuse');
    expect(deps2.runLocal).not.toHaveBeenCalled();
  });
});

describe('runnerTick — Wave D: no-key compat mode', () => {
  beforeEach(() => {
    _resetNoKeyWarning();
  });

  it('unsigned row is accepted (compat mode) when key is not set', async () => {
    const cmd = { id: 'cmd-c1', command: 'check disk space', payload: null, chat_id: 123, priority: 0 };
    const deps = makeDeps({
      claim: vi.fn().mockResolvedValue(cmd),
      runLocal: vi.fn().mockResolvedValue({ output: 'ok', exitCode: 0 }),
      getSigningKey: () => undefined,
    } as any);
    const result = await runnerTick(deps);

    expect(result.status).toBe('completed');
    expect(deps.runLocal).toHaveBeenCalled();
  });

  it('once-per-boot warning fires when key is not set', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const cmd = { id: 'cmd-w1', command: 'check status', payload: null, chat_id: 123, priority: 0 };
      const deps = makeDeps({
        claim: vi.fn().mockResolvedValue(cmd),
        runLocal: vi.fn().mockResolvedValue({ output: 'ok', exitCode: 0 }),
        getSigningKey: () => undefined,
      } as any);

      // First tick — warning fires
      await runnerTick(deps);
      const authWarnings = warnSpy.mock.calls.filter(
        (c) => typeof c[0] === 'string' && c[0].includes('ATLAS_QUEUE_SIGNING_KEY not set'),
      );
      expect(authWarnings.length).toBe(1);

      // Second tick — warning does NOT repeat
      const cmd2 = { id: 'cmd-w2', command: 'check again', payload: null, chat_id: 123, priority: 0 };
      const deps2 = makeDeps({
        claim: vi.fn().mockResolvedValue(cmd2),
        runLocal: vi.fn().mockResolvedValue({ output: 'ok', exitCode: 0 }),
        getSigningKey: () => undefined,
      } as any);
      await runnerTick(deps2);

      const authWarnings2 = warnSpy.mock.calls.filter(
        (c) => typeof c[0] === 'string' && c[0].includes('ATLAS_QUEUE_SIGNING_KEY not set'),
      );
      expect(authWarnings2.length).toBe(1); // still 1, not 2
    } finally {
      warnSpy.mockRestore();
    }
  });
});

describe('runnerTick effect-journal gates', () => {
  it('refuses automatic replay when a prior started row is outcome_unknown', async () => {
    const opId = deriveQueueOperationId('cmd-ambiguous');
    prepareOperation(opId, {
      identity: { kind: 'queue-command', commandId: 'cmd-ambiguous' },
      rootDir: journalRoot,
    });
    markStarted(opId, { rootDir: journalRoot });

    const deps = makeDeps({
      claim: vi.fn().mockResolvedValue(fakeCommand('check disk space', 'cmd-ambiguous')),
    });
    const result = await runnerTick(deps);

    expect(result.status).toBe('refused');
    expect((result as { reason: string }).reason).toContain('outcome_unknown');
    expect(deps.runLocal).not.toHaveBeenCalled();
    expect(deps.fail).toHaveBeenCalledWith(
      'cmd-ambiguous',
      expect.stringContaining('outcome_unknown'),
    );
  });

  it('resumes a terminal receipt without repeating runLocal', async () => {
    const opId = deriveQueueOperationId('cmd-resume');
    await executeOnce(
      opId,
      { kind: 'queue-command', commandId: 'cmd-resume' },
      async () => ({ output: 'already-ran', exitCode: 0 }),
      { rootDir: journalRoot },
    );

    const deps = makeDeps({
      claim: vi.fn().mockResolvedValue(fakeCommand('check disk space', 'cmd-resume')),
    });
    const result = await runnerTick(deps);

    expect(result.status).toBe('completed');
    expect((result as { output: string }).output).toBe('already-ran');
    expect(deps.runLocal).not.toHaveBeenCalled();
    expect(deps.complete).toHaveBeenCalledWith('cmd-resume', 'already-ran');
  });
});
