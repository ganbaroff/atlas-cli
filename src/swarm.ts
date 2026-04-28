/**
 * Atlas Swarm — parallel agent orchestrator via child_process.fork().
 *
 * Lead decomposes task → forks N workers (real Node.js processes) →
 * each worker boots own Mastra Agent with assigned provider →
 * results collected via IPC → lead synthesizes final answer.
 */

import { fork, type ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { createAtlasAgent } from './agent.js';
import type { ProviderName } from './model-router.js';
import { validateCompletion } from './gates/verify-before-done.js';
import { PERSPECTIVES } from './atlas/perspectives.js';
import { logSwarmRun } from './atlas/swarm-logger.js';
import { dedupFindings } from './atlas/dedup.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

export interface Subtask {
  id: number;
  description: string;
  provider?: ProviderName;
  perspective?: string;
}

export interface WorkerResult {
  id: number;
  output: string;
  provider: string;
  durationMs: number;
  error?: string;
}

/** Decompose task into perspective-based subtasks. Each perspective analyzes from its angle. */
function decomposeWithPerspectives(task: string): Subtask[] {
  return PERSPECTIVES.map((p, i) => ({
    id: i,
    description: `${p.instruction}\n\nAnalyze this task from your perspective:\n${task}`,
    perspective: p.name,
    provider: p.provider as ProviderName | undefined,
  }));
}

/** Lead agent decomposes into custom subtasks (fallback for non-standard tasks). */
async function decomposeCustom(task: string): Promise<Subtask[]> {
  const agent = await createAtlasAgent('JUDGE');
  const res = await agent.generate(
    `Decompose this task into 2-5 independent parallel subtasks.
Return ONLY a JSON array. Each element: {"id": number, "description": "...", "provider": "cerebras"|"nvidia"|"openai"|"openrouter"|"anthropic"|"ollama"}
Spread providers for load diversity. Match complexity to provider capability.
Task: ${task}`,
  );
  const match = res.text.match(/\[[\s\S]*\]/);
  if (!match) throw new Error('Lead failed to produce subtask JSON');
  return JSON.parse(match[0]) as Subtask[];
}

/** Fork a worker process for one subtask. Communicates via IPC. */
function spawnWorker(subtask: Subtask, env: NodeJS.ProcessEnv): Promise<WorkerResult> {
  return new Promise((resolve) => {
    const child: ChildProcess = fork(join(__dirname, 'swarm-worker.js'), [], {
      env: { ...env, ATLAS_SUBTASK: JSON.stringify(subtask) },
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    });

    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      resolve({ id: subtask.id, output: '', provider: subtask.provider ?? '?', durationMs: 60_000, error: 'timeout' });
    }, 60_000);

    child.on('message', (msg: WorkerResult) => {
      clearTimeout(timer);
      resolve(msg);
      child.kill();
    });

    child.on('error', (err) => {
      clearTimeout(timer);
      resolve({ id: subtask.id, output: '', provider: subtask.provider ?? '?', durationMs: 0, error: err.message });
    });

    child.on('exit', (code) => {
      clearTimeout(timer);
      if (code !== 0 && code !== null) {
        resolve({ id: subtask.id, output: '', provider: subtask.provider ?? '?', durationMs: 0, error: `exit code ${code}` });
      }
    });
  });
}

/** Lead synthesizes worker outputs into coherent answer. */
async function synthesize(task: string, results: WorkerResult[]): Promise<string> {
  const agent = await createAtlasAgent('JUDGE');
  const body = results
    .map((r) => `### Subtask ${r.id} [${r.provider}, ${r.durationMs}ms]${r.error ? ` ERROR: ${r.error}` : ''}\n${r.output}`)
    .join('\n\n');
  const res = await agent.generate(
    `Original task: ${task}\n\nWorker results:\n${body}\n\nSynthesize one coherent answer. Include key findings from each worker.`,
  );
  return res.text;
}

/** Main entry: perspectives analyze in parallel → synthesize. */
export async function runSwarm(task: string, useCustomDecompose = false): Promise<string> {
  console.log('[swarm] Assigning perspectives...');
  const subtasks = useCustomDecompose
    ? await decomposeCustom(task)
    : decomposeWithPerspectives(task);
  console.log(`[swarm] Spawning ${subtasks.length} workers...`);
  for (const st of subtasks) console.log(`  #${st.id} [${st.perspective ?? st.provider ?? '?'}] ${st.description.slice(0, 80)}`);

  const t0 = Date.now();
  const results = await Promise.all(
    subtasks.map((st) => spawnWorker(st, process.env as NodeJS.ProcessEnv)),
  );
  const elapsed = Date.now() - t0;

  const ok = results.filter((r) => !r.error).length;
  console.log(`[swarm] ${ok}/${results.length} succeeded in ${elapsed}ms. Synthesizing...`);
  for (const r of results) {
    const perspective = subtasks.find(s => s.id === r.id)?.perspective ?? '?';
    console.log(`  [${perspective}] provider=${r.provider} ${r.durationMs}ms ${r.error ? `ERROR: ${r.error}` : 'OK'}`);
  }

  // Dedup before synthesis — Cloudflare multi-reviewer pattern
  const outputs = results.filter(r => !r.error && r.output).map(r => r.output);
  if (outputs.length > 1) {
    const dedup = dedupFindings(outputs);
    if (dedup.duplicatesRemoved > 0) {
      console.log(`[swarm] Dedup: removed ${dedup.duplicatesRemoved}/${dedup.totalInput} duplicate claims`);
    }
  }

  let final = await synthesize(task, results);

  const check = validateCompletion(final);
  const jidokaViolation = check.passed ? null : (check.violation ?? 'unknown');
  if (!check.passed) {
    console.warn(`[swarm] Jidoka violation: ${check.violation}`);
    final += '\n\n[JIDOKA: unverified completion claim detected]';
  }

  // Persist swarm run log
  try {
    const logPath = await logSwarmRun({
      ts: new Date().toISOString(),
      task,
      subtasks,
      results,
      synthesis: final,
      durationMs: elapsed,
      jidokaViolation,
    });
    console.log(`[swarm] Run logged: ${logPath}`);
  } catch (err) {
    console.warn(`[swarm] Failed to persist run log: ${err instanceof Error ? err.message : err}`);
  }

  return final;
}
