import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { runTask } from '../atlas/task-spawner.js';
import * as spendPolicy from '../atlas/spend-policy.js';
import * as controlPlane from '../atlas/control-plane.js';

vi.mock('node:child_process', () => ({ spawn: vi.fn() }));

describe('task-spawner safety checks', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.mocked(spawn).mockClear();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('blocks execution when isPaused() is true', async () => {
    vi.spyOn(spendPolicy, 'isPaused').mockReturnValue(true);
    vi.spyOn(controlPlane, 'controlAllowsModelCalls').mockReturnValue(true);

    const result = await runTask('test task');
    expect(result.id).toBe('blocked');
    expect(result.output).toContain('ATLAS_PAUSE=1');
  });

  it('blocks execution when controlAllowsModelCalls() is false', async () => {
    vi.spyOn(spendPolicy, 'isPaused').mockReturnValue(false);
    vi.spyOn(controlPlane, 'controlAllowsModelCalls').mockReturnValue(false);
    vi.spyOn(controlPlane, 'describeControlBlock').mockReturnValue('Control paused. Use /resume.');

    const result = await runTask('test task');
    expect(result.id).toBe('blocked');
    expect(result.output).toBe('Control paused. Use /resume.');
  });

  it('refuses a missing activation manifest before spawning a subprocess', () => {
    const root = mkdtempSync(join(tmpdir(), 'atlas-task-results-root-'));
    const priorRoot = process.env.ATLAS_STATE_ROOT;
    const priorRequired = process.env.ATLAS_STATE_ROOT_REQUIRED;
    process.env.ATLAS_STATE_ROOT = root;
    process.env.ATLAS_STATE_ROOT_REQUIRED = '1';
    vi.spyOn(spendPolicy, 'isPaused').mockReturnValue(false);
    vi.spyOn(controlPlane, 'controlAllowsModelCalls').mockReturnValue(true);

    try {
      expect(() => runTask('must not spawn')).toThrow(/activation_manifest_missing/);
      expect(spawn).not.toHaveBeenCalled();
    } finally {
      if (priorRoot === undefined) delete process.env.ATLAS_STATE_ROOT;
      else process.env.ATLAS_STATE_ROOT = priorRoot;
      if (priorRequired === undefined) delete process.env.ATLAS_STATE_ROOT_REQUIRED;
      else process.env.ATLAS_STATE_ROOT_REQUIRED = priorRequired;
      rmSync(root, { recursive: true, force: true });
    }
  });
});
