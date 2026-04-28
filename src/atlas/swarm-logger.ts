/**
 * Swarm run logger — persists every swarm execution to disk as JSON.
 * Enables post-hoc analysis and CEO review of what perspectives found.
 */

import { writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { WorkerResult, Subtask } from '../swarm.js';

export interface SwarmRunLog {
  ts: string;
  task: string;
  subtasks: Subtask[];
  results: WorkerResult[];
  synthesis: string;
  durationMs: number;
  jidokaViolation: string | null;
}

function swarmLogsDir(): string {
  const root = process.env.MEMORY_ROOT ??
    (process.platform === 'win32'
      ? 'C:\\Projects\\VOLAURA'
      : resolve(process.env.HOME ?? '~', 'Projects', 'VOLAURA'));
  return join(root, 'memory', 'atlas', 'swarm-runs');
}

async function ensureDir(): Promise<void> {
  const dir = swarmLogsDir();
  if (!existsSync(dir)) await mkdir(dir, { recursive: true });
}

/** Persist a swarm run to JSON file. Returns the file path. */
export async function logSwarmRun(log: SwarmRunLog): Promise<string> {
  await ensureDir();
  const safe = log.ts.replace(/[:.]/g, '-').slice(0, 19);
  const fp = join(swarmLogsDir(), `${safe}.json`);
  await writeFile(fp, JSON.stringify(log, null, 2), 'utf-8');
  return fp;
}
