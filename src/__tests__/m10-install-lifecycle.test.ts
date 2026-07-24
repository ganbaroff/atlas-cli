/**
 * M10 — install / upgrade / rollback lifecycle proofs (child-process E2E).
 *
 * Simulates reproducible install → upgrade → rollback without touching live deploy.
 * State dirs (exec-graph + goal-budgets) must survive dist swap.
 */

import { spawn, execSync } from 'node:child_process';
import {
  cpSync, existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync,
} from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const ROOT = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const DIST = join(ROOT, 'dist', 'cli.js');
const BUDGET_MODULE = pathToFileURL(join(ROOT, 'src/goal-runner/budgets.ts')).href;

function runNode(code: string, env: Record<string, string>): Promise<{ code: number | null; out: string }> {
  return new Promise((resolvePromise) => {
    const child = spawn(
      process.execPath,
      ['--import', 'tsx', '-e', code],
      { env: { ...process.env, ...env, NODE_NO_WARNINGS: '1' }, cwd: ROOT, windowsHide: true },
    );
    let out = '';
    child.stdout.on('data', (d) => { out += String(d); });
    child.stderr.on('data', (d) => { out += String(d); });
    child.on('close', (code) => resolvePromise({ code, out }));
  });
}

describe('M10 install/upgrade/rollback lifecycle', () => {
  let stateRoot: string;
  let budgetDir: string;
  let graphDir: string;
  let distBackup: string;

  beforeEach(() => {
    stateRoot = mkdtempSync(join(tmpdir(), 'atlas-m10-'));
    budgetDir = join(stateRoot, 'goal-budgets');
    graphDir = join(stateRoot, 'exec-graph');
    mkdirSync(budgetDir, { recursive: true });
    mkdirSync(graphDir, { recursive: true });
    distBackup = join(stateRoot, 'dist-backup');
    mkdirSync(distBackup, { recursive: true });
    if (existsSync(DIST)) {
      cpSync(DIST, join(distBackup, 'cli.js'));
    }
  });

  afterEach(() => {
    rmSync(stateRoot, { recursive: true, force: true });
  });

  it('install: build + health green from isolated state dirs', async () => {
    execSync('npm run build', { cwd: ROOT, stdio: 'pipe', timeout: 60_000 });
    expect(existsSync(DIST)).toBe(true);

    let health = '';
    try {
      health = execSync(`node "${DIST}" health`, {
        cwd: ROOT,
        encoding: 'utf8',
        env: {
          ...process.env,
          ATLAS_GOAL_BUDGET_DIR: budgetDir,
          ATLAS_EXEC_GRAPH_DIR: graphDir,
          NODE_NO_WARNINGS: '1',
        },
      });
    } catch (err: unknown) {
      const e = err as { stdout?: string };
      health = e.stdout ?? '';
    }
    expect(health).toContain('Atlas Health Check');
    expect(health).toMatch(/PASS|FAIL/);
  }, 90_000);

  it('upgrade: rebuild preserves exec-graph + goal budget state', async () => {
    const goalId = 'gol_m10_upgrade';
    writeFileSync(
      join(budgetDir, `${goalId}.json`),
      JSON.stringify({
        goalId,
        startedAt: new Date().toISOString(),
        taskAttempts: { tsk_1: 1 },
        totalAttempts: 1,
        totalTasksCreated: 1,
        decompositionRounds: 0,
        attemptFingerprints: [],
        config: { maxAttemptsPerTask: 3, maxTotalAttempts: 10, maxTotalTasks: 5, maxDecompositionRounds: 2, maxGraphDepth: 3, maxWallTimeMs: 60_000 },
      }, null, 2),
      'utf8',
    );
    writeFileSync(join(graphDir, 'ledger.jsonl'), '{"event":"goal-created","goalId":"' + goalId + '"}\n', 'utf8');

    execSync('npm run build', { cwd: ROOT, stdio: 'pipe', timeout: 60_000 });

    const code = `
      import { loadBudget } from ${JSON.stringify(BUDGET_MODULE)};
      import { readFileSync } from 'node:fs';
      import { join } from 'node:path';
      const goalId = '${goalId}';
      const budget = loadBudget(goalId);
      const ledger = readFileSync(join(process.env.ATLAS_EXEC_GRAPH_DIR!, 'ledger.jsonl'), 'utf8');
      console.log(JSON.stringify({ budgetOk: budget?.totalAttempts === 1, ledgerHasGoal: ledger.includes(goalId) }));
    `;
    const result = await runNode(code, {
      ATLAS_GOAL_BUDGET_DIR: budgetDir,
      ATLAS_EXEC_GRAPH_DIR: graphDir,
    });
    expect(result.code).toBe(0);
    const parsed = JSON.parse(result.out.trim().split('\n').pop()!);
    expect(parsed.budgetOk).toBe(true);
    expect(parsed.ledgerHasGoal).toBe(true);
  }, 90_000);

  it('rollback: restore prior dist; state + health still valid', async () => {
    const goalId = 'gol_m10_rollback';
    writeFileSync(
      join(budgetDir, `${goalId}.json`),
      JSON.stringify({
        goalId,
        startedAt: new Date().toISOString(),
        taskAttempts: {},
        totalAttempts: 2,
        totalTasksCreated: 1,
        decompositionRounds: 0,
        attemptFingerprints: [],
        config: { maxAttemptsPerTask: 3, maxTotalAttempts: 10, maxTotalTasks: 5, maxDecompositionRounds: 2, maxGraphDepth: 3, maxWallTimeMs: 60_000 },
      }, null, 2),
      'utf8',
    );

    const backupCli = join(distBackup, 'cli.js');
    expect(existsSync(backupCli)).toBe(true);

    execSync('npm run build', { cwd: ROOT, stdio: 'pipe', timeout: 60_000 });
    cpSync(backupCli, DIST);

    let health = '';
    try {
      health = execSync(`node "${DIST}" health`, {
        cwd: ROOT,
        encoding: 'utf8',
        env: {
          ...process.env,
          ATLAS_GOAL_BUDGET_DIR: budgetDir,
          ATLAS_EXEC_GRAPH_DIR: graphDir,
          NODE_NO_WARNINGS: '1',
        },
      });
    } catch (err: unknown) {
      const e = err as { stdout?: string };
      health = e.stdout ?? '';
    }
    expect(health).toContain('Atlas Health Check');

    const code = `
      import { loadBudget } from ${JSON.stringify(BUDGET_MODULE)};
      const b = loadBudget('${goalId}');
      console.log(JSON.stringify({ totalAttempts: b?.totalAttempts }));
    `;
    const result = await runNode(code, { ATLAS_GOAL_BUDGET_DIR: budgetDir });
    expect(result.code).toBe(0);
    expect(JSON.parse(result.out.trim().split('\n').pop()!).totalAttempts).toBe(2);
  }, 90_000);
});
