/**
 * Atlas Swarm — parallel agent orchestrator via child_process.fork().
 *
 * Lead decomposes task → forks N workers (real Node.js processes) →
 * each worker boots own Mastra Agent with assigned provider →
 * results collected via IPC → lead synthesizes final answer.
 */

import { createAtlasAgent } from './agent.js';
import type { ProviderName } from './model-router.js';
import { validateCompletion } from './gates/verify-before-done.js';
import { PERSPECTIVES } from './atlas/perspectives.js';
import { logSwarmRun } from './atlas/swarm-logger.js';
import { dedupFindings } from './atlas/dedup.js';
import { controlAllowsModelCalls, describeControlBlock } from './atlas/control-plane.js';

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
  const agent = await createAtlasAgent('JUDGE', 'operator');
  const res = await agent.generate(
    `Decompose this task into 2-5 independent parallel subtasks.
Return ONLY a JSON array. Each element: {"id": number, "description": "...", "provider": "nvidia"|"openai"|"openrouter"|"ollama"}
Spread providers for load diversity. Match complexity to provider capability.
Task: ${task}`,
  );
  const match = res.text.match(/\[[\s\S]*\]/);
  if (!match) throw new Error('Lead failed to produce subtask JSON');
  return JSON.parse(match[0]) as Subtask[];
}

/** Run a single perspective in-process (no fork — API calls are I/O-bound, not CPU). */
async function runWorker(subtask: Subtask): Promise<WorkerResult> {
  const t0 = Date.now();
  try {
    const agent = await createAtlasAgent('WORKER', 'operator');
    const res = await agent.generate(subtask.description);
    const jidoka = validateCompletion(res.text);
    const output = jidoka.passed ? res.text : `${res.text}\n\n[WORKER JIDOKA: ${jidoka.violation}]`;
    return { id: subtask.id, output, provider: subtask.provider ?? 'auto', durationMs: Date.now() - t0 };
  } catch (err) {
    return {
      id: subtask.id, output: '', provider: subtask.provider ?? 'auto',
      durationMs: Date.now() - t0, error: err instanceof Error ? err.message.slice(0, 200) : String(err),
    };
  }
}

/** Lead synthesizes worker outputs into coherent answer. */
async function synthesize(task: string, results: WorkerResult[]): Promise<string> {
  const agent = await createAtlasAgent('JUDGE', 'operator');
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
  if (!controlAllowsModelCalls()) {
    throw new Error(describeControlBlock());
  }

  console.log('[swarm] Assigning perspectives...');
  const subtasks = useCustomDecompose
    ? await decomposeCustom(task)
    : decomposeWithPerspectives(task);
  console.log(`[swarm] Spawning ${subtasks.length} workers...`);
  for (const st of subtasks) console.log(`  #${st.id} [${st.perspective ?? st.provider ?? '?'}] ${st.description.slice(0, 80)}`);

  const t0 = Date.now();
  const results = await Promise.all(
    subtasks.map((st) => runWorker(st)),
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
