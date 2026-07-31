import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { spawn } from 'node:child_process';
import {
  appendFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { resolveExecGraphDir, ledgerPath, rebuildSnapshot } from '../exec-graph/ledger.js';
import { createGoal, createTask } from '../exec-graph/api.js';

const NOW = '2026-07-30T00:00:00.000Z';

const ROOT = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const TSX_IMPORT = pathToFileURL(join(ROOT, 'node_modules', 'tsx', 'dist', 'loader.mjs')).href;
const API_MODULE = pathToFileURL(join(ROOT, 'src/exec-graph/api.ts')).href;
const LEDGER_MODULE = pathToFileURL(join(ROOT, 'src/exec-graph/ledger.ts')).href;

function writeTempScript(body: string): string {
  const path = join(tmpdir(), `atlas-exec-graph-race-${randomUUID()}.mts`);
  writeFileSync(path, body, 'utf8');
  return path;
}

function spawnRaceScript(scriptPath: string, execGraphDir: string): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(process.execPath, ['--import', TSX_IMPORT, scriptPath], {
      cwd: ROOT,
      env: { ...process.env, ATLAS_EXEC_GRAPH_DIR: execGraphDir, NODE_NO_WARNINGS: '1' },
      windowsHide: true,
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (c) => { stdout += String(c); });
    child.stderr.on('data', (c) => { stderr += String(c); });
    child.on('error', reject);
    child.on('close', (code) => resolvePromise({ code, stdout, stderr }));
  });
}

describe('exec-graph mutation transaction', () => {
  let dir: string;
  let prior: string | undefined;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'atlas-exec-graph-mutation-tx-'));
    prior = process.env.ATLAS_EXEC_GRAPH_DIR;
    process.env.ATLAS_EXEC_GRAPH_DIR = dir;
  });

  afterEach(() => {
    if (prior === undefined) delete process.env.ATLAS_EXEC_GRAPH_DIR;
    else process.env.ATLAS_EXEC_GRAPH_DIR = prior;
    rmSync(dir, { recursive: true, force: true });
  });

  it('(b) malformed ledger bytes cause a diagnostic-only failure, never a mutation', () => {
    mkdirSync(resolveExecGraphDir(), { recursive: true });
    appendFileSync(ledgerPath(), 'not-json-at-all\n', 'utf8');

    expect(() => createGoal({ title: 'should not persist', actor: 'atlas', ts: NOW })).toThrow();

    const raw = readFileSync(ledgerPath(), 'utf8');
    const lines = raw.split(/\r?\n/).filter((l) => l.trim());
    expect(lines).toHaveLength(1); // still just the malformed line — no mutation was appended
  });

  it('(c) ledger append/persistence failure throws — never a swallowed success', () => {
    const blockerFile = join(dir, 'blocker-file');
    writeFileSync(blockerFile, 'x');
    const impossibleDir = join(blockerFile, 'exec-graph'); // parent is a FILE, not a dir
    process.env.ATLAS_EXEC_GRAPH_DIR = impossibleDir;

    expect(() => createGoal({ title: 'g', actor: 'atlas', ts: NOW })).toThrow();
  });

  it('(a)/(d) two OS processes racing the same proposed->accepted transition never both win', async () => {
    const goal = createGoal({ title: 'race goal', actor: 'atlas', ts: NOW });
    const { task } = createTask({ goalId: goal.id, title: 'race task', actor: 'atlas', ts: NOW, idempotencyKey: 'exec-graph:race' });

    const scriptBody = `
      process.env.ATLAS_EXEC_GRAPH_DIR = ${JSON.stringify(dir)};
      import('${API_MODULE}').then(async (api) => {
        try {
          api.moveTask({ taskId: ${JSON.stringify(task.id)}, to: 'accepted', actor: 'atlas', ts: ${JSON.stringify(NOW)} });
          process.stdout.write('OK\\n');
        } catch (err) {
          process.stdout.write('ERR:' + (err && err.message ? err.message : String(err)) + '\\n');
        }
      });
    `;
    const scriptPath = writeTempScript(scriptBody);
    try {
      const [r1, r2] = await Promise.all([
        spawnRaceScript(scriptPath, dir),
        spawnRaceScript(scriptPath, dir),
      ]);
      const outs = [r1.stdout.trim(), r2.stdout.trim()];
      const oks = outs.filter((o) => o === 'OK').length;
      expect(oks).toBe(1); // exactly one racer wins the transition

      const finalTask = rebuildSnapshot().tasks[task.id];
      const acceptedTransitions = finalTask.transitions.filter((t) => t.to === 'accepted');
      expect(acceptedTransitions).toHaveLength(1); // ledger never records the transition twice
    } finally {
      rmSync(scriptPath, { force: true });
    }
  }, 20000);
});
