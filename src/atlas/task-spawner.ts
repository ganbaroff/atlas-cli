/**
 * Task spawner — runs Claude Code as subprocess from Telegram.
 * Phase B of Atlas Orchestrator v2.
 *
 * CEO sends "/task check prod health" → spawns `claude -p "..."` →
 * collects output → sends back to Telegram.
 *
 * TEMPORARY ADAPTER (EB-0, ADR-0004 classification #2 — see
 * docs/adr/0004-legacy-task-source-cutover.md): this is live CEO
 * convenience in the deployed bot, kept running as-is during the exec-graph
 * cutover. Spawned jobs here are ephemeral, CEO-direct executions, NOT
 * exec-graph tasks — there is deliberately no code path from runTask()/
 * this module into src/exec-graph (only that module's own importTask()
 * can create a task from a legacy source, and this module is not wired to
 * call it). Retiring or rerouting this adapter into the graph is Mission 2
 * scope, not this file's.
 */

import { spawn } from 'node:child_process';
import { writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isPaused } from './spend-policy.js';
import { controlAllowsModelCalls, describeControlBlock } from './control-plane.js';

/**
 * Repo-root resolver, same landmark-walk idiom as exec-graph/ledger.ts's
 * resolveExecGraphDir(). A fixed '..', '..' from this module's own location
 * assumed a stable 2-levels-deep src/atlas/ path — true when run from
 * source (tsx), but WRONG when bundled by tsup into a single dist/cli.js
 * sitting one level above repo root's dist/ dir, which over-corrected one
 * directory too far (resolved to the parent of the repo, not the repo).
 * Found live 2026-07-27: atlas-runner's first real tick against the
 * production dist/cli.js failed every task with MODULE_NOT_FOUND because
 * of exactly this. Walk up looking for package.json instead — works
 * identically whether invoked from src/ or from the bundled dist/.
 */
function resolveAnusRoot(): string {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 6; i++) {
    if (existsSync(resolve(dir, 'package.json'))) return dir;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  // Last resort: the old assumption, kept as a fallback rather than a throw.
  return resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
}

const ANUS_ROOT = resolveAnusRoot();

const TASK_DIR = 'C:/Projects/ATLAS/data/task-results';
const MAX_TIMEOUT = 10 * 60 * 1000; // 10 minutes
const MAX_OUTPUT = 3800; // Telegram limit minus overhead

let activeTask: { id: string; process: ReturnType<typeof spawn> } | null = null;

export interface TaskResult {
  id: string;
  description: string;
  output: string;
  exitCode: number | null;
  durationMs: number;
  truncated: boolean;
}

function taskId(): string {
  return `task-${Date.now().toString(36)}`;
}

export function isTaskRunning(): boolean {
  return activeTask !== null;
}

export function runTask(description: string): Promise<TaskResult> {
  if (isPaused()) {
    return Promise.resolve({
      id: 'blocked',
      description,
      output: 'Emergency pause active: ATLAS_PAUSE=1',
      exitCode: null,
      durationMs: 0,
      truncated: false,
    });
  }

  if (!controlAllowsModelCalls()) {
    return Promise.resolve({
      id: 'blocked',
      description,
      output: describeControlBlock(),
      exitCode: null,
      durationMs: 0,
      truncated: false,
    });
  }

  if (activeTask) {
    return Promise.resolve({
      id: 'blocked',
      description,
      output: 'Уже работает другая задача. Дождись завершения.',
      exitCode: null,
      durationMs: 0,
      truncated: false,
    });
  }

  const id = taskId();
  const t0 = Date.now();

  return new Promise((finish) => {
    const chunks: Buffer[] = [];
    const errChunks: Buffer[] = [];

    // Use ANUS CLI (atlas run) which routes through free providers (freellmapi/nvidia),
    // NOT claude CLI which burns Anthropic credits. CEO directive: credits before cash.
    const anusCli = resolve(ANUS_ROOT, 'dist', 'cli.js');
    const proc = spawn('node', [
      anusCli, 'chat',
      '--role', 'WORKER',
    ], {
      cwd: 'C:/Projects/VOLAURA',
      timeout: MAX_TIMEOUT,
      // Tag the subprocess as an AUTONOMY actor: its shell tool then enforces the
      // policy.yaml autonomy whitelist (Phase 1). This is unattended execution with
      // no live CEO turn, so it must not fall through to default-allow shell.
      env: { ...process.env, ATLAS_AGENT_ID: 'autonomy' },
      stdio: ['pipe', 'pipe', 'pipe'],
      shell: false,
    });
    // Send the task as stdin and close — no shell interpolation (auditor: shell:true = injection)
    proc.stdin?.write(description + '\n/quit\n');
    proc.stdin?.end();

    activeTask = { id, process: proc };

    proc.stdout?.on('data', (chunk: Buffer) => chunks.push(chunk));
    proc.stderr?.on('data', (chunk: Buffer) => errChunks.push(chunk));

    const timer = setTimeout(() => {
      proc.kill('SIGTERM');
    }, MAX_TIMEOUT);

    proc.on('close', (code) => {
      clearTimeout(timer);
      activeTask = null;

      const raw = Buffer.concat(chunks).toString('utf-8').trim();
      const stderr = Buffer.concat(errChunks).toString('utf-8').trim();
      const fullOutput = raw || stderr || '(no output)';
      const truncated = fullOutput.length > MAX_OUTPUT;
      const output = truncated ? fullOutput.slice(0, MAX_OUTPUT) + '\n...(truncated)' : fullOutput;
      const durationMs = Date.now() - t0;

      // Persist result
      try {
        mkdirSync(TASK_DIR, { recursive: true });
        writeFileSync(
          join(TASK_DIR, `${id}.json`),
          JSON.stringify({ id, description, output: fullOutput, exitCode: code, durationMs }, null, 2),
        );
      } catch { /* non-fatal */ }

      console.log(`[task] ${id} done in ${durationMs}ms, exit=${code}, output=${fullOutput.length} chars`);

      finish({ id, description, output, exitCode: code, durationMs, truncated });
    });

    proc.on('error', (err) => {
      clearTimeout(timer);
      activeTask = null;
      finish({
        id,
        description,
        output: `spawn error: ${err.message}`,
        exitCode: null,
        durationMs: Date.now() - t0,
        truncated: false,
      });
    });
  });
}
