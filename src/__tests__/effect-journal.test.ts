/**
 * M3D Task 3 — shared durable effect journal.
 *
 * Crash windows (design M3D-C):
 *   - before started → later execution allowed
 *   - after started, before terminal receipt → outcome_unknown, no auto replay
 *   - after receipt, before queue/graph close → resume consumes receipt, no repeat
 *
 * Tests never touch live state/ — every case uses mkdtempSync.
 */

import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

import {
  decideReplay,
  decideStaleClaim,
  deriveQueueOperationId,
  deriveTaskEffectOperationId,
  executeOnce,
  loadOperation,
  markStarted,
  prepareOperation,
} from '../atlas/effect-journal.js';

const tempRoots: string[] = [];

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'atlas-effect-journal-'));
  tempRoots.push(root);
  return root;
}

afterEach(() => {
  while (tempRoots.length > 0) {
    const root = tempRoots.pop();
    if (root) rmSync(root, { recursive: true, force: true });
  }
});

function runCrashChild(
  mode: 'crash-before-effect' | 'crash-after-start' | 'crash-after-receipt',
  rootDir: string,
  operationId: string,
): { status: number | null; stdout: string; stderr: string } {
  const childPath = join(
    process.cwd(),
    'src',
    '__tests__',
    'fixtures',
    'effect-journal-crash-child.ts',
  );
  const result = spawnSync(
    process.execPath,
    ['--import', 'tsx', childPath, mode, rootDir, operationId],
    {
      encoding: 'utf8',
      env: { ...process.env, ATLAS_STATE_ROOT: rootDir },
      timeout: 30_000,
    },
  );
  return {
    status: result.status,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
  };
}

describe('effect-journal operation identity', () => {
  it('derives a stable queue operation id from the durable command id', () => {
    expect(deriveQueueOperationId('cmd-abc-123')).toBe(
      deriveQueueOperationId('cmd-abc-123'),
    );
    expect(deriveQueueOperationId('cmd-abc-123')).not.toBe(
      deriveQueueOperationId('cmd-other'),
    );
  });

  it('derives a stable task-effect operation id from task + effect key', () => {
    const a = deriveTaskEffectOperationId('task-1', 'browser:nav:https://example.com');
    const b = deriveTaskEffectOperationId('task-1', 'browser:nav:https://example.com');
    const c = deriveTaskEffectOperationId('task-1', 'browser:click:#submit');
    expect(a).toBe(b);
    expect(a).not.toBe(c);
  });
});

describe('effect-journal crash windows (in-process)', () => {
  it('allows one later execution after crash before started', async () => {
    const root = tempRoot();
    const opId = deriveQueueOperationId('cmd-before');
    prepareOperation(opId, {
      identity: { kind: 'queue-command', commandId: 'cmd-before' },
      rootDir: root,
    });

    const decision = decideReplay(opId, { rootDir: root });
    expect(decision.action).toBe('execute');

    let runs = 0;
    const first = await executeOnce(
      opId,
      { kind: 'queue-command', commandId: 'cmd-before' },
      async () => {
        runs += 1;
        return { output: 'once' };
      },
      { rootDir: root },
    );
    expect(first.outcome).toBe('executed');
    expect(runs).toBe(1);

    const second = await executeOnce(
      opId,
      { kind: 'queue-command', commandId: 'cmd-before' },
      async () => {
        runs += 1;
        return { output: 'again' };
      },
      { rootDir: root },
    );
    expect(second.outcome).toBe('resumed');
    expect(runs).toBe(1);
    expect(second.result).toEqual({ output: 'once' });
  });

  it('refuses automatic replay after started without a terminal receipt', async () => {
    const root = tempRoot();
    const opId = deriveQueueOperationId('cmd-started');
    prepareOperation(opId, {
      identity: { kind: 'queue-command', commandId: 'cmd-started' },
      rootDir: root,
    });
    markStarted(opId, { rootDir: root });

    const decision = decideReplay(opId, { rootDir: root });
    expect(decision.action).toBe('block');
    if (decision.action === 'block') {
      expect(decision.code).toBe('outcome_unknown');
    }

    const record = loadOperation(opId, { rootDir: root });
    expect(record?.status).toBe('outcome_unknown');

    let runs = 0;
    await expect(
      executeOnce(
        opId,
        { kind: 'queue-command', commandId: 'cmd-started' },
        async () => {
          runs += 1;
          return { output: 'should-not-run' };
        },
        { rootDir: root },
      ),
    ).rejects.toMatchObject({ code: 'outcome_unknown' });
    expect(runs).toBe(0);
  });

  it('flushes started before invoking the effect', async () => {
    const root = tempRoot();
    const opId = deriveQueueOperationId('cmd-flush-order');
    let sawStartedOnDisk = false;

    await executeOnce(
      opId,
      { kind: 'queue-command', commandId: 'cmd-flush-order' },
      async () => {
        const mid = loadOperation(opId, { rootDir: root });
        sawStartedOnDisk = mid?.status === 'started';
        return { output: 'ok' };
      },
      { rootDir: root },
    );

    expect(sawStartedOnDisk).toBe(true);
    expect(loadOperation(opId, { rootDir: root })?.status).toBe('succeeded');
  });

  it('resumes from an existing terminal receipt without repeating the effect', async () => {
    const root = tempRoot();
    const opId = deriveQueueOperationId('cmd-receipt');
    let runs = 0;

    await executeOnce(
      opId,
      { kind: 'queue-command', commandId: 'cmd-receipt' },
      async () => {
        runs += 1;
        return { output: 'terminal' };
      },
      { rootDir: root },
    );

    const resumed = await executeOnce(
      opId,
      { kind: 'queue-command', commandId: 'cmd-receipt' },
      async () => {
        runs += 1;
        return { output: 'repeat' };
      },
      { rootDir: root },
    );

    expect(runs).toBe(1);
    expect(resumed.outcome).toBe('resumed');
    expect(resumed.result).toEqual({ output: 'terminal' });
  });
});

describe('effect-journal stale queue claim consultation', () => {
  it('allows reclaim when no journal row exists', () => {
    const root = tempRoot();
    const decision = decideStaleClaim('cmd-fresh', { rootDir: root });
    expect(decision.action).toBe('execute');
  });

  it('blocks reclaim when the journal is outcome_unknown', () => {
    const root = tempRoot();
    const opId = deriveQueueOperationId('cmd-ambiguous');
    prepareOperation(opId, {
      identity: { kind: 'queue-command', commandId: 'cmd-ambiguous' },
      rootDir: root,
    });
    markStarted(opId, { rootDir: root });
    // Reading decideReplay promotes started → outcome_unknown.
    decideReplay(opId, { rootDir: root });

    const decision = decideStaleClaim('cmd-ambiguous', { rootDir: root });
    expect(decision.action).toBe('block');
    if (decision.action === 'block') {
      expect(decision.code).toBe('outcome_unknown');
    }
  });

  it('resumes a terminal receipt on stale reclaim without re-execution', async () => {
    const root = tempRoot();
    const opId = deriveQueueOperationId('cmd-done');
    await executeOnce(
      opId,
      { kind: 'queue-command', commandId: 'cmd-done' },
      async () => ({ output: 'already-done' }),
      { rootDir: root },
    );

    const decision = decideStaleClaim('cmd-done', { rootDir: root });
    expect(decision.action).toBe('resume');
    if (decision.action === 'resume') {
      expect(decision.receipt).toEqual({ output: 'already-done' });
    }
  });
});

describe('effect-journal child-process crash fixtures', () => {
  it('crash-before-effect leaves a prepared/missing window that may execute once', () => {
    const root = tempRoot();
    const opId = deriveQueueOperationId('child-before');
    const child = runCrashChild('crash-before-effect', root, opId);
    expect(child.status).not.toBe(0);

    const decision = decideReplay(opId, { rootDir: root });
    expect(decision.action).toBe('execute');
  });

  it('crash-after-start yields outcome_unknown with zero automatic re-execution', async () => {
    const root = tempRoot();
    const opId = deriveQueueOperationId('child-started');
    const child = runCrashChild('crash-after-start', root, opId);
    expect(child.status).not.toBe(0);

    const decision = decideReplay(opId, { rootDir: root });
    expect(decision.action).toBe('block');
    if (decision.action === 'block') {
      expect(decision.code).toBe('outcome_unknown');
    }

    let runs = 0;
    await expect(
      executeOnce(
        opId,
        { kind: 'queue-command', commandId: 'child-started' },
        async () => {
          runs += 1;
          return { output: 'nope' };
        },
        { rootDir: root },
      ),
    ).rejects.toMatchObject({ code: 'outcome_unknown' });
    expect(runs).toBe(0);
  });

  it('crash-after-receipt resumes the durable receipt without repeating the effect', async () => {
    const root = tempRoot();
    const opId = deriveQueueOperationId('child-receipt');
    const child = runCrashChild('crash-after-receipt', root, opId);
    expect(child.status).not.toBe(0);

    // Child should have flushed a succeeded receipt before dying.
    const onDisk = loadOperation(opId, { rootDir: root });
    expect(onDisk?.status).toBe('succeeded');

    let runs = 0;
    const resumed = await executeOnce(
      opId,
      { kind: 'queue-command', commandId: 'child-receipt' },
      async () => {
        runs += 1;
        return { output: 'repeat' };
      },
      { rootDir: root },
    );
    expect(runs).toBe(0);
    expect(resumed.outcome).toBe('resumed');
    expect(resumed.result).toEqual({ output: 'child-receipt-ok' });
  });
});

describe('effect-journal store residency', () => {
  it('writes operation records under the effect-journal store directory', async () => {
    const root = tempRoot();
    const opId = deriveQueueOperationId('cmd-path');
    await executeOnce(
      opId,
      { kind: 'queue-command', commandId: 'cmd-path' },
      async () => ({ output: 'path' }),
      { rootDir: root },
    );

    // rootDir option is the store directory itself (same contract as cost-router).
    const opsDir = join(root, 'ops');
    expect(existsSync(opsDir)).toBe(true);
    const files = readdirSync(opsDir).filter((name) => name.endsWith('.json'));
    expect(files.length).toBe(1);
    const body = JSON.parse(readFileSync(join(opsDir, files[0]!), 'utf8'));
    expect(body.operationId).toBe(opId);
    expect(body.status).toBe('succeeded');
  });
});

// Keep pathToFileURL imported so the fixture child can reuse the same
// resolution style if tests expand to dynamic import probes.
void pathToFileURL;
