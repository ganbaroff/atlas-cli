/**
 * Atlas Swarm — parallel agent orchestrator via child_process.fork().
 *
 * Lead decomposes task → forks N workers (real Node.js processes) →
 * each worker boots own Mastra Agent with assigned provider →
 * results collected via IPC → lead synthesizes final answer.
 */

import { createAtlasAgentWithRoute, recordAgentSpend } from './agent.js';
import type { ProviderName } from './model-router.js';
import { validateCompletion } from './gates/verify-before-done.js';
import { PERSPECTIVES } from './atlas/perspectives.js';
import { logSwarmRun } from './atlas/swarm-logger.js';
import { dedupFindings } from './atlas/dedup.js';
import { controlAllowsModelCalls, describeControlBlock } from './atlas/control-plane.js';
import { isPaused } from './atlas/spend-policy.js';

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
  const { agent, route } = await createAtlasAgentWithRoute('JUDGE', 'operator');
  const res = await agent.generate(
    `Decompose this task into 2-5 independent parallel subtasks.
Return ONLY a JSON array. Each element: {"id": number, "description": "...", "provider": "nvidia"|"openai"|"openrouter"|"ollama"}
Spread providers for load diversity. Match complexity to provider capability.
Task: ${task}`,
  );
  recordAgentSpend(res, route, 'swarm');
  const match = res.text.match(/\[[\s\S]*\]/);
  if (!match) throw new Error('Lead failed to produce subtask JSON');
  return JSON.parse(match[0]) as Subtask[];
}

/** Default per-worker wall-clock bound; override via ATLAS_SWARM_WORKER_TIMEOUT_MS. */
function workerTimeoutMs(): number {
  const raw = process.env.ATLAS_SWARM_WORKER_TIMEOUT_MS;
  if (raw) { const n = parseInt(raw, 10); if (Number.isFinite(n) && n > 0) return n; }
  return 60_000;
}

type RaceOutcome<T> =
  | { kind: 'resolved'; value: T }
  | { kind: 'timeout' }
  | { kind: 'rejected'; error: unknown };

/**
 * Race a promise against a wall-clock bound without leaking the timer.
 * The pending timer is always cleared once the promise settles (resolved or
 * rejected); a rejection is surfaced as its own outcome (not swallowed) so
 * the caller can still route real provider errors through its own catch.
 */
function withTimeout<T>(p: Promise<T>, ms: number): Promise<RaceOutcome<T>> {
  return new Promise((resolve) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      resolve({ kind: 'timeout' });
    }, ms);
    p.then(
      (value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve({ kind: 'resolved', value });
      },
      (error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve({ kind: 'rejected', error });
      },
    );
  });
}

/** Run a single perspective in-process (no fork — API calls are I/O-bound, not CPU). */
async function runWorker(subtask: Subtask): Promise<WorkerResult> {
  const t0 = Date.now();
  try {
    const { agent, route } = await createAtlasAgentWithRoute('WORKER', 'operator');
    const ms = workerTimeoutMs();
    const outcome = await withTimeout(agent.generate(subtask.description), ms);
    if (outcome.kind === 'timeout') {
      // Bounded hang: never counts as ok — same shape as a provider error, empty output.
      // route already resolved (createAtlasAgentWithRoute returned above) — report the
      // real provider that hung, not the perspective's declared label.
      return {
        id: subtask.id, output: '', provider: route.provider,
        durationMs: Date.now() - t0, error: `worker_timeout_${ms}ms`,
      };
    }
    if (outcome.kind === 'rejected') {
      // Genuine provider error — hand off to the existing catch-block handling below.
      throw outcome.error;
    }
    const res = outcome.value;
    recordAgentSpend(res, route, 'swarm');
    const jidoka = validateCompletion(res.text);
    const output = jidoka.passed ? res.text : `${res.text}\n\n[WORKER JIDOKA: ${jidoka.violation}]`;
    // Report the real routed provider (route.provider), not subtask.provider — the
    // latter is only the perspective's declared label from perspectives.json and can
    // lie (e.g. say "anthropic" when the router actually ran nvidia).
    return { id: subtask.id, output, provider: route.provider, durationMs: Date.now() - t0 };
  } catch (err) {
    // `route` is NOT in scope here — createAtlasAgentWithRoute may have thrown before
    // ever returning a route, so there is no real routed provider to report. Fall back
    // to the perspective's declared label as a best-effort guess (may be dishonest,
    // but it's the only information available when routing itself failed).
    return {
      id: subtask.id, output: '', provider: subtask.provider ?? 'auto',
      durationMs: Date.now() - t0, error: err instanceof Error ? err.message.slice(0, 200) : String(err),
    };
  }
}

/** Lead synthesizes worker outputs into coherent answer. */
async function synthesize(task: string, results: WorkerResult[]): Promise<string> {
  const { agent, route } = await createAtlasAgentWithRoute('JUDGE', 'operator');
  const body = results
    .map((r) => `### Subtask ${r.id} [${r.provider}, ${r.durationMs}ms]${r.error ? ` ERROR: ${r.error}` : ''}\n${r.output}`)
    .join('\n\n');
  const res = await agent.generate(
    `Original task: ${task}\n\nWorker results:\n${body}\n\nSynthesize one coherent answer. Include key findings from each worker.`,
  );
  recordAgentSpend(res, route, 'swarm');
  return res.text;
}

export interface SwarmRunDetail {
  subtasks: Subtask[];
  results: WorkerResult[];
  synthesis: string;
  durationMs: number;
  jidokaViolation: string | null;
}

/** Main entry: perspectives analyze in parallel → synthesize. Returns the full run detail. */
export async function runSwarmDetailed(task: string, useCustomDecompose = false): Promise<SwarmRunDetail> {
  if (isPaused()) {
    console.warn('[swarm] refused: ATLAS_PAUSE=1 (kill switch active)');
    throw new Error('Swarm refused: ATLAS_PAUSE=1 is set. Unset ATLAS_PAUSE to resume autonomy.');
  }
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

  return { subtasks, results, synthesis: final, durationMs: elapsed, jidokaViolation };
}

/** Main entry: perspectives analyze in parallel → synthesize. Returns just the synthesis text. */
export async function runSwarm(task: string, useCustomDecompose = false): Promise<string> {
  return (await runSwarmDetailed(task, useCustomDecompose)).synthesis;
}
