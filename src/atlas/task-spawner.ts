/**
 * Task spawner — runs Claude Code as subprocess from Telegram.
 * Phase B of Atlas Orchestrator v2.
 *
 * CEO sends "/task check prod health" → spawns `claude -p "..."` →
 * collects output → sends back to Telegram.
 */

import { spawn } from 'node:child_process';
import { writeFileSync, mkdirSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ANUS_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

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
      env: { ...process.env },
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
