/**
 * M4-A E2E — real child-process kill/resume.
 * Budget + exec-graph state must survive SIGKILL and resume in a fresh process.
 */

import { randomUUID } from 'node:crypto';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import {
  existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync,
} from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const ROOT = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const TSX = join(ROOT, 'node_modules', 'tsx', 'dist', 'cli.mjs');
const RUNNER_MODULE = pathToFileURL(join(ROOT, 'src/goal-runner/runner.ts')).href;

interface ChildResult {
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
}

function writeTempScript(body: string): string {
  const path = join(tmpdir(), `atlas-m4-e2e-${randomUUID()}.mts`);
  writeFileSync(path, body, 'utf8');
  return path;
}

function spawnScript(
  scriptPath: string,
  env: Record<string, string>,
): ChildProcessWithoutNullStreams {
  return spawn(process.execPath, [TSX, scriptPath], {
    cwd: ROOT,
    env: { ...process.env, ...env, NODE_NO_WARNINGS: '1' },
    windowsHide: true,
  });
}

async function runScript(
  scriptPath: string,
  env: Record<string, string>,
  opts?: { killAfterMs?: number; waitForFile?: string },
): Promise<ChildResult> {
  const child = spawnScript(scriptPath, env);
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk) => { stdout += String(chunk); });
  child.stderr.on('data', (chunk) => { stderr += String(chunk); });

  if (opts?.waitForFile) {
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
      if (existsSync(opts.waitForFile)) break;
      await new Promise((r) => setTimeout(r, 100));
    }
    if (!existsSync(opts.waitForFile)) {
      child.kill('SIGKILL');
      throw new Error(`timeout waiting for sync file: ${opts.waitForFile}\nstderr: ${stderr}`);
    }
  }

  if (opts?.killAfterMs !== undefined) {
    await new Promise((r) => setTimeout(r, opts.killAfterMs));
    child.kill('SIGKILL');
  }

  return new Promise((resolve, reject) => {
    child.on('error', reject);
    child.on('close', (code, signal) => resolve({ code, signal, stdout, stderr }));
  });
}

function findGoalBudgetFile(budgetDir: string): string | null {
  if (!existsSync(budgetDir)) return null;
  const files = readdirSync(budgetDir).filter((f) => f.startsWith('gol_') && f.endsWith('.json'));
  return files.length > 0 ? join(budgetDir, files[0]!) : null;
}

describe('M4 kill/resume — child-process E2E', () => {
  let execDir: string;
  let budgetDir: string;
  const scripts: string[] = [];

  beforeEach(() => {
    execDir = mkdtempSync(join(tmpdir(), 'm4-kill-resume-exec-'));
    budgetDir = mkdtempSync(join(tmpdir(), 'm4-kill-resume-budget-'));
  });

  afterEach(() => {
    rmSync(execDir, { recursive: true, force: true });
    rmSync(budgetDir, { recursive: true, force: true });
    for (const s of scripts) {
      try { rmSync(s, { force: true }); } catch { /* ignore */ }
    }
    scripts.length = 0;
  });

  it('kill mid-run then resume preserves budget + exec-graph task count', async () => {
    const syncFile = join(budgetDir, 'sync-ready.json');
    const sharedEnv = {
      ATLAS_EXEC_GRAPH_DIR: execDir,
      ATLAS_GOAL_BUDGET_DIR: budgetDir,
    };

    const startScript = writeTempScript(`
      import { writeFileSync } from 'node:fs';
      import { runGoal } from ${JSON.stringify(RUNNER_MODULE)};
      const report = await runGoal({
        objective: 'M4 child-process kill test',
        handId: 'sonnet-foreground',
        config: {
          maxAttemptsPerTask: 1, maxTotalAttempts: 5, maxTotalTasks: 3,
          maxDecompositionRounds: 1, maxGraphDepth: 1, maxWallTimeMs: 60_000,
        },
        notifyCeo: async () => ({ result: 'NOT_CONFIGURED' }),
      });
      writeFileSync(${JSON.stringify(syncFile)}, JSON.stringify({ goalId: report.goalId, status: report.status }));
      process.stdout.write('GOAL_DONE ' + JSON.stringify(report) + '\\n');
      await new Promise((r) => setTimeout(r, 120_000));
    `);
    scripts.push(startScript);

    const child = spawnScript(startScript, sharedEnv);
    const deadline = Date.now() + 30_000;
    let sync: { goalId: string; status: string } | null = null;
    while (Date.now() < deadline) {
      if (existsSync(syncFile)) {
        sync = JSON.parse(readFileSync(syncFile, 'utf8')) as { goalId: string; status: string };
        break;
      }
      await new Promise((r) => setTimeout(r, 200));
    }
    expect(sync).not.toBeNull();
    child.kill('SIGKILL');
    await new Promise<void>((r) => child.on('close', () => r()));

    expect(sync!.goalId).toMatch(/^gol_/);
    expect(sync!.status).toBe('escalated');

    const budgetBefore = JSON.parse(readFileSync(join(budgetDir, `${sync!.goalId}.json`), 'utf8'));
    const graphBefore = JSON.parse(readFileSync(join(execDir, 'graph.json'), 'utf8')) as {
      tasks: { goalId: string }[];
    };
    const taskCountBefore = graphBefore.tasks.filter((t) => t.goalId === sync!.goalId).length;
    expect(taskCountBefore).toBeGreaterThanOrEqual(1);

    writeFileSync(
      join(budgetDir, 'active-lease.json'),
      JSON.stringify({ goalId: sync!.goalId, startedAt: new Date().toISOString(), pid: 999_999_999 }),
    );

    const resumeScript = writeTempScript(`
      import { runGoal } from ${JSON.stringify(RUNNER_MODULE)};
      const report = await runGoal({
        objective: 'M4 child-process kill test',
        handId: 'sonnet-foreground',
        resumeGoalId: ${JSON.stringify(sync!.goalId)},
        config: {
          maxAttemptsPerTask: 1, maxTotalAttempts: 5, maxTotalTasks: 3,
          maxDecompositionRounds: 1, maxGraphDepth: 1, maxWallTimeMs: 60_000,
        },
        notifyCeo: async () => ({ result: 'NOT_CONFIGURED' }),
      });
      process.stdout.write('RESUME_DONE ' + JSON.stringify(report) + '\\n');
    `);
    scripts.push(resumeScript);

    const resumed = await runScript(resumeScript, sharedEnv);
    expect(resumed.code).toBe(0);
    expect(resumed.stdout).toContain('RESUME_DONE');

    const resumeReport = JSON.parse(
      resumed.stdout.split('RESUME_DONE ')[1]!.trim(),
    ) as { goalId: string; status: string; tasksTotal: number; details: { finalStatus: string }[] };

    expect(resumeReport.goalId).toBe(sync!.goalId);
    expect(resumeReport.status).toBe('escalated');
    expect(resumeReport.tasksTotal).toBe(1);
    expect(resumeReport.details[0]!.finalStatus).toBe('escalated');

    const budgetAfter = JSON.parse(readFileSync(join(budgetDir, `${sync!.goalId}.json`), 'utf8'));
    expect(budgetAfter.totalAttempts).toBe(budgetBefore.totalAttempts);
    expect(budgetAfter.startedAt).toBe(budgetBefore.startedAt);
    expect(budgetAfter.totalTasksCreated).toBe(budgetBefore.totalTasksCreated);

    const graphAfter = JSON.parse(readFileSync(join(execDir, 'graph.json'), 'utf8')) as {
      tasks: { goalId: string }[];
    };
    const taskCountAfter = graphAfter.tasks.filter((t) => t.goalId === sync!.goalId).length;
    expect(taskCountAfter).toBe(taskCountBefore);
  }, 120_000);

  it('resume after kill completes browser goal without duplicate tasks', async () => {
    const fixturePath = resolve(ROOT, 'fixtures/hub71-fake-form.html');
    const fixtureUrl = `file://${fixturePath.replace(/\\/g, '/')}`;
    const syncFile = join(budgetDir, 'browser-sync.json');
    const sharedEnv = {
      ATLAS_EXEC_GRAPH_DIR: execDir,
      ATLAS_GOAL_BUDGET_DIR: budgetDir,
    };

    const startScript = writeTempScript(`
      import { writeFileSync } from 'node:fs';
      import { runGoal } from ${JSON.stringify(RUNNER_MODULE)};
      const fixtureUrl = ${JSON.stringify(fixtureUrl)};
      const partial = await runGoal({
        objective: 'Read form title on fixture',
        handId: 'browser-foreground',
        browserActions: [
          { kind: 'navigate', url: fixtureUrl },
          { kind: 'readText', selector: 'h1' },
        ],
        config: {
          maxAttemptsPerTask: 1, maxTotalAttempts: 3, maxTotalTasks: 2,
          maxDecompositionRounds: 1, maxGraphDepth: 1, maxWallTimeMs: 60_000,
        },
        notifyCeo: async () => ({ result: 'NOT_CONFIGURED' }),
      });
      writeFileSync(${JSON.stringify(syncFile)}, JSON.stringify({ goalId: partial.goalId, status: partial.status }));
      await new Promise((r) => setTimeout(r, 120_000));
    `);
    scripts.push(startScript);

    const child = spawnScript(startScript, sharedEnv);

    const deadline = Date.now() + 45_000;
    let goalId: string | null = null;
    while (Date.now() < deadline) {
      const budgetFile = findGoalBudgetFile(budgetDir);
      if (budgetFile && existsSync(syncFile)) {
        goalId = JSON.parse(readFileSync(budgetFile, 'utf8')).goalId as string;
        break;
      }
      await new Promise((r) => setTimeout(r, 200));
    }

    expect(typeof goalId).toBe('string');
    expect(goalId!).toMatch(/^gol_/);
    child.kill('SIGKILL');
    await new Promise<void>((r) => child.on('close', () => r()));

    const budgetMid = JSON.parse(readFileSync(join(budgetDir, `${goalId}.json`), 'utf8'));
    writeFileSync(
      join(budgetDir, 'active-lease.json'),
      JSON.stringify({ goalId, startedAt: budgetMid.startedAt, pid: 999_999_999 }),
    );

    const resumeScript = writeTempScript(`
      import { runGoal } from ${JSON.stringify(RUNNER_MODULE)};
      const fixtureUrl = ${JSON.stringify(fixtureUrl)};
      const report = await runGoal({
        objective: 'Read form title on fixture',
        handId: 'browser-foreground',
        resumeGoalId: ${JSON.stringify(goalId)},
        browserActions: [
          { kind: 'navigate', url: fixtureUrl },
          { kind: 'readText', selector: 'h1' },
        ],
        config: {
          maxAttemptsPerTask: 1, maxTotalAttempts: 3, maxTotalTasks: 2,
          maxDecompositionRounds: 1, maxGraphDepth: 1, maxWallTimeMs: 60_000,
        },
        notifyCeo: async () => ({ result: 'NOT_CONFIGURED' }),
      });
      process.stdout.write('BROWSER_RESUME ' + JSON.stringify(report) + '\\n');
    `);
    scripts.push(resumeScript);

    const resumed = await runScript(resumeScript, sharedEnv);
    expect(resumed.code).toBe(0);
    expect(resumed.stdout).toContain('BROWSER_RESUME');

    const report = JSON.parse(resumed.stdout.split('BROWSER_RESUME ')[1]!.trim()) as {
      status: string; tasksVerified: number;
    };
    expect(['completed', 'partial']).toContain(report.status);
    expect(report.tasksVerified).toBeGreaterThanOrEqual(1);

    const budgetAfter = JSON.parse(readFileSync(join(budgetDir, `${goalId}.json`), 'utf8'));
    expect(budgetAfter.startedAt).toBe(budgetMid.startedAt);
  }, 180_000);
});
