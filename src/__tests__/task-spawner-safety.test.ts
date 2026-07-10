import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { runTask } from '../atlas/task-spawner.js';
import * as spendPolicy from '../atlas/spend-policy.js';
import * as controlPlane from '../atlas/control-plane.js';

describe('task-spawner safety checks', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
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
});
