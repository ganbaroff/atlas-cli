import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { commitCommand, intakeCommand, runCommand } from '../swarm-exec/commands.js';
import { getTask, moveTask } from '../exec-graph/api.js';
import { assignHand } from '../hands/exec-graph-adapter.js';
import { readDraft } from '../swarm-exec/intake.js';
import type { SwarmRunDetail } from '../swarm.js';

const NOW = '2026-07-18T00:00:00.000Z';

describe('swarm-exec/commands.ts — full intake -> commit -> run chain (isolated tmp dirs)', () => {
  let execDir: string;
  let draftDir: string;
  let bundleDir: string;
  let priorExecDir: string | undefined;

  beforeEach(() => {
    execDir = mkdtempSync(join(tmpdir(), 'atlas-cmd-exec-'));
    draftDir = mkdtempSync(join(tmpdir(), 'atlas-cmd-drafts-'));
    bundleDir = mkdtempSync(join(tmpdir(), 'atlas-cmd-bundles-'));
    priorExecDir = process.env.ATLAS_EXEC_GRAPH_DIR;
    process.env.ATLAS_EXEC_GRAPH_DIR = execDir;
  });

  afterEach(() => {
    if (priorExecDir === undefined) delete process.env.ATLAS_EXEC_GRAPH_DIR;
    else process.env.ATLAS_EXEC_GRAPH_DIR = priorExecDir;
    for (const dir of [execDir, draftDir, bundleDir]) {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        /* ignore */
      }
    }
  });

  /** Deterministic SwarmRunDetail from a fixed set of WorkerResults — no real LLM call. */
  function detailWith(results: SwarmRunDetail['results']): SwarmRunDetail {
    const subtasks = results.map((r) => ({ id: r.id, description: 'analyze from a perspective', perspective: `perspective-${r.id}` }));
    return {
      subtasks,
      results,
      synthesis: 'synthesized findings across all perspectives',
      durationMs: 999,
      jidokaViolation: null,
    };
  }

  const OK_RESULTS: SwarmRunDetail['results'] = [
    { id: 0, output: 'finding A', provider: 'nvidia', durationMs: 100 },
    { id: 1, output: 'finding B', provider: 'openai', durationMs: 120 },
    { id: 2, output: 'finding C', provider: 'openrouter', durationMs: 90 },
    { id: 3, output: '', provider: 'ollama', durationMs: 50, error: '500 internal error' },
  ];

  it('intakeCommand writes a draft and returns a draftId readable back via readDraft', () => {
    const result = intakeCommand('investigate the flaky swarm-exec test suite', { rootDir: draftDir });

    expect(result.draftId).toMatch(/^dft_[0-9a-f]{16}$/);
    expect(result.draftPath).toContain(result.draftId);
    expect(result.draft.objective).toBe('investigate the flaky swarm-exec test suite');

    const readBack = readDraft(result.draftId, { rootDir: draftDir });
    expect(readBack).toEqual(result.draft);
  });

  it('commitCommand with no goal creates a goal + a task whose title === draft.objective', () => {
    const { draftId, draft } = intakeCommand('review the completion-policy edge cases', { rootDir: draftDir });

    const result = commitCommand(draftId, { actor: 'atlas' }, { rootDir: draftDir });

    expect(result.created).toBe(true);
    expect(result.goalId).toMatch(/^gol_/);
    expect(result.taskId).toMatch(/^tsk_/);

    const task = getTask(result.taskId);
    expect(task).toBeDefined();
    expect(task?.title).toBe(draft.objective);
    expect(task?.goalId).toBe(result.goalId);
  });

  it('runCommand walks a freshly-committed task to delegated + runs the swarm -> verified', async () => {
    const { draftId } = intakeCommand('audit the swarm run bundle writer', { rootDir: draftDir });
    const { taskId } = commitCommand(draftId, { actor: 'atlas' }, { rootDir: draftDir });

    expect(getTask(taskId)?.status).toBe('proposed');
    expect(getTask(taskId)?.owner).toBe('atlas');

    const runId = `${taskId}-fixed-verified`;
    const result = await runCommand(taskId, {
      actor: 'atlas',
      runSwarm: async () => detailWith(OK_RESULTS),
      controlAllows: () => true,
      runId,
      bundleRootDir: bundleDir,
      now: () => NOW,
    });

    expect(result.status).toBe('verified');
    expect(result.runId).toBe(runId);
    expect(getTask(taskId)?.status).toBe('verified');
    expect(getTask(taskId)?.owner).toBe('hand:swarm-local');
  });

  it('runCommand skips re-assignment when the task is already delegated to swarm-local', async () => {
    const { draftId } = intakeCommand('a task pre-delegated outside runCommand', { rootDir: draftDir });
    const { taskId } = commitCommand(draftId, { actor: 'atlas' }, { rootDir: draftDir });

    // Walk + assign directly (bypassing runCommand) so the task is already
    // owner=hand:swarm-local / status=delegated BEFORE runCommand ever sees it.
    moveTask({ taskId, to: 'accepted', actor: 'atlas' });
    moveTask({ taskId, to: 'planned', actor: 'atlas' });
    assignHand(taskId, 'swarm-local', { actor: 'atlas', unattended: false });
    expect(getTask(taskId)?.owner).toBe('hand:swarm-local');
    expect(getTask(taskId)?.status).toBe('delegated');

    const runId = `${taskId}-pre-delegated`;
    const result = await runCommand(taskId, {
      actor: 'atlas',
      runSwarm: async () => detailWith(OK_RESULTS),
      controlAllows: () => true,
      runId,
      bundleRootDir: bundleDir,
      now: () => NOW,
    });

    // No IllegalTransitionError from re-walking proposed->accepted (task was
    // never touched by runCommand's own walk) — it went straight to the run.
    expect(result.status).toBe('verified');
    expect(getTask(taskId)?.status).toBe('verified');
  });

  it('runCommand with controlAllows:()=>false -> status blocked, task blocked', async () => {
    const { draftId } = intakeCommand('a task that will be control-blocked', { rootDir: draftDir });
    const { taskId } = commitCommand(draftId, { actor: 'atlas' }, { rootDir: draftDir });

    const result = await runCommand(taskId, {
      actor: 'atlas',
      runSwarm: async () => {
        throw new Error('must never be called when control is not active');
      },
      controlAllows: () => false,
      bundleRootDir: bundleDir,
      now: () => NOW,
    });

    expect(result.status).toBe('blocked');
    expect(getTask(taskId)?.status).toBe('blocked');
  });

  it('runCommand on an unknown taskId throws', async () => {
    await expect(runCommand('tsk_doesnotexist', { bundleRootDir: bundleDir })).rejects.toThrow(/unknown task/);
  });
});
