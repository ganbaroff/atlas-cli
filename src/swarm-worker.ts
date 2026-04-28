/**
 * Swarm worker — runs as forked child process.
 * Reads ATLAS_SUBTASK from env, boots Mastra Agent with assigned provider, executes, sends result via IPC.
 */

import { createAtlasAgent } from './agent.js';
import type { Subtask, WorkerResult } from './swarm.js';
import type { ProviderName } from './model-router.js';

const raw = process.env['ATLAS_SUBTASK'];
if (!raw) { process.exit(1); }

if (typeof process.send !== 'function') {
  console.error('FATAL: swarm-worker must be launched via fork(), not directly');
  process.exit(1);
}

const subtask: Subtask = JSON.parse(raw);
const t0 = Date.now();

// Override model router to prefer assigned provider
if (subtask.provider) {
  process.env['ATLAS_PREFERRED_PROVIDER'] = subtask.provider;
}

try {
  const agent = await createAtlasAgent('WORKER');
  const res = await agent.generate(subtask.description);

  const jidoka = (await import('./gates/verify-before-done.js')).validateCompletion(res.text);
  const output = jidoka.passed ? res.text : `${res.text}\n\n[WORKER JIDOKA: ${jidoka.violation}]`;

  const result: WorkerResult = {
    id: subtask.id,
    output,
    provider: subtask.provider ?? 'auto',
    durationMs: Date.now() - t0,
  };

  process.send(result);
  process.exit(0);
} catch (err) {
  const result: WorkerResult = {
    id: subtask.id,
    output: '',
    provider: subtask.provider ?? 'auto',
    durationMs: Date.now() - t0,
    error: err instanceof Error ? err.message : String(err),
  };
  process.send(result);
  process.exit(1);
}
