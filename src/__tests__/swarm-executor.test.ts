import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { runSwarmForTask } from '../swarm-exec/executor.js';
import { createGoal, createTask, moveTask, getTask } from '../exec-graph/api.js';
import { assignHand } from '../hands/exec-graph-adapter.js';
import type { SwarmRunDetail } from '../swarm.js';

const NOW = '2026-07-18T00:00:00.000Z';

describe('swarm-exec/executor.ts (isolated temp exec-graph + bundle dirs per test)', () => {
  let execDir: string;
  let bundleDir: string;
  let priorExecDir: string | undefined;

  beforeEach(() => {
    execDir = mkdtempSync(join(tmpdir(), 'atlas-exec-graph-'));
    bundleDir = mkdtempSync(join(tmpdir(), 'atlas-swarm-bundles-'));
    priorExecDir = process.env.ATLAS_EXEC_GRAPH_DIR;
    process.env.ATLAS_EXEC_GRAPH_DIR = execDir;
  });

  afterEach(() => {
    if (priorExecDir === undefined) delete process.env.ATLAS_EXEC_GRAPH_DIR;
    else process.env.ATLAS_EXEC_GRAPH_DIR = priorExecDir;
    try {
      rmSync(execDir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
    try {
      rmSync(bundleDir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  });

  /** Creates a goal + task, walks it to 'planned', then assigns it to hand:swarm-local -> 'delegated'. */
  function planAndDelegate(title: string): string {
    const goal = createGoal({ title: `goal for ${title}`, actor: 'atlas', ts: NOW });
    const { task } = createTask({
      goalId: goal.id,
      title,
      actor: 'atlas',
      ts: NOW,
      idempotencyKey: `exec-graph:${title}`,
    });
    moveTask({ taskId: task.id, to: 'accepted', actor: 'atlas', ts: NOW });
    moveTask({ taskId: task.id, to: 'planned', actor: 'atlas', ts: NOW });
    assignHand(task.id, 'swarm-local', { actor: 'atlas', unattended: false });
    return task.id;
  }

  /** Builds a deterministic SwarmRunDetail from a fixed set of WorkerResults — no real LLM call. */
  function detailWith(results: SwarmRunDetail['results']): SwarmRunDetail {
    const subtasks = results.map((r) => ({ id: r.id, description: 'analyze from a perspective', perspective: `perspective-${r.id}` }));
    return {
      subtasks,
      results,
      synthesis: 'synthesized findings across all perspectives',
      durationMs: 1234,
      jidokaViolation: null,
    };
  }

  it('VERIFIED: majority of responders ok, no jidoka violation -> task verified, bundle carries SWARM-VERIFIED token', async () => {
    const taskId = planAndDelegate('verified-swarm-task');
    const runId = `${taskId}-fixed-verified`;

    const results: SwarmRunDetail['results'] = [
      { id: 0, output: 'finding A', provider: 'nvidia', durationMs: 100 },
      { id: 1, output: 'finding B', provider: 'openai', durationMs: 120 },
      { id: 2, output: 'finding C', provider: 'openrouter', durationMs: 90 },
      { id: 3, output: '', provider: 'ollama', durationMs: 50, error: '500 internal error' },
    ];
    const detail = detailWith(results);

    const result = await runSwarmForTask(taskId, {
      actor: 'atlas',
      runId,
      bundleRootDir: bundleDir,
      controlAllows: () => true,
      runSwarm: async () => detail,
      now: () => NOW,
    });

    expect(result.status).toBe('verified');
    expect(result.runId).toBe(runId);
    expect(result.bundlePath).not.toBeNull();
    expect(result.completion?.completion).toBe('done');
    expect(getTask(taskId)?.status).toBe('verified');

    const bundleRaw = readFileSync(result.bundlePath as string, 'utf8');
    expect(bundleRaw).toContain(`SWARM-VERIFIED:${runId}`);
  });

  it('REJECTED (honest): most responders fail (401 unauthorized) -> task rejected, bundle carries SWARM-REJECTED, not VERIFIED', async () => {
    const taskId = planAndDelegate('rejected-swarm-task');
    const runId = `${taskId}-fixed-rejected`;

    const results: SwarmRunDetail['results'] = [
      { id: 0, output: '', provider: 'nvidia', durationMs: 80, error: '401 unauthorized' },
      { id: 1, output: '', provider: 'openai', durationMs: 85, error: '401 unauthorized' },
      { id: 2, output: '', provider: 'openrouter', durationMs: 60, error: '401 unauthorized' },
      { id: 3, output: 'lone success', provider: 'ollama', durationMs: 40 },
    ];
    const detail = detailWith(results);

    const result = await runSwarmForTask(taskId, {
      actor: 'atlas',
      runId,
      bundleRootDir: bundleDir,
      controlAllows: () => true,
      runSwarm: async () => detail,
      now: () => NOW,
    });

    expect(result.status).toBe('rejected');
    expect(result.runId).toBe(runId);
    expect(result.completion?.completion).not.toBe('done');
    expect(getTask(taskId)?.status).toBe('rejected');

    const bundleRaw = readFileSync(result.bundlePath as string, 'utf8');
    expect(bundleRaw).toContain(`SWARM-REJECTED:${runId}`);
    expect(bundleRaw).not.toContain(`SWARM-VERIFIED:${runId}`);
  });

  it('BLOCKED by control: controlAllows=false -> task blocked, swarm never called, no bundle written', async () => {
    const taskId = planAndDelegate('blocked-swarm-task');
    let swarmCalled = false;

    const result = await runSwarmForTask(taskId, {
      actor: 'atlas',
      bundleRootDir: bundleDir,
      controlAllows: () => false,
      runSwarm: async () => {
        swarmCalled = true;
        throw new Error('must never be called when control is not active');
      },
      now: () => NOW,
    });

    expect(result.status).toBe('blocked');
    expect(result.bundlePath).toBeNull();
    expect(result.completion).toBeNull();
    expect(result.reason).toBe('control_not_active');
    expect(getTask(taskId)?.status).toBe('blocked');
    expect(swarmCalled).toBe(false);
  });

  it('precondition: runSwarmForTask throws for a task never assigned to swarm-local', async () => {
    const goal = createGoal({ title: 'goal for unassigned-task', actor: 'atlas', ts: NOW });
    const { task } = createTask({
      goalId: goal.id,
      title: 'unassigned-task',
      actor: 'atlas',
      ts: NOW,
      idempotencyKey: 'exec-graph:unassigned-task',
    });
    moveTask({ taskId: task.id, to: 'accepted', actor: 'atlas', ts: NOW });
    moveTask({ taskId: task.id, to: 'planned', actor: 'atlas', ts: NOW });
    // Never assignHand()'d — owner stays 'atlas', status stays 'planned'.

    await expect(runSwarmForTask(task.id, { bundleRootDir: bundleDir })).rejects.toThrow();
    expect(getTask(task.id)?.owner).toBe('atlas');
  });
});
