/**
 * Bridge to VOLAURA Python swarm — subprocess-based.
 * Calls `python -m packages.swarm.autonomous_run --mode=coordinator --task="..."`
 * Reads results from filesystem (proposals.json), not stdout.
 * Fallback: atlas-cli runs its own 5-perspective TypeScript swarm.
 */

import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { getVolauraRoot } from './path-util.js';

const VOLAURA_ROOT = getVolauraRoot();

const PROPOSALS_PATH = join(VOLAURA_ROOT, 'memory', 'swarm', 'proposals.json');
const SHARED_BUS = join(VOLAURA_ROOT, 'memory', 'shared-bus');

export interface SwarmResult {
  success: boolean;
  proposals: unknown[];
  error?: string;
  source: 'python' | 'typescript-fallback';
}

export function isPythonSwarmAvailable(): boolean {
  return existsSync(join(VOLAURA_ROOT, 'packages', 'swarm', 'autonomous_run.py'));
}

export async function callPythonSwarm(task: string, mode = 'coordinator', timeoutMs = 120_000): Promise<SwarmResult> {
  if (!isPythonSwarmAvailable()) {
    return { success: false, proposals: [], error: 'VOLAURA Python swarm not found', source: 'python' };
  }

  const args = ['-m', 'packages.swarm.autonomous_run', `--mode=${mode}`, `--task=${task}`];
  const executables = ['python3', 'python', 'py'];

  const tryExec = (index: number): Promise<SwarmResult> => {
    const cmd = executables[index];
    if (!cmd) {
      const msg = `Python executable not found in PATH (tried ${executables.join(', ')})`;
      console.warn(`[python-bridge] ${msg}`);
      return Promise.resolve({
        success: false,
        proposals: [],
        error: msg,
        source: 'python',
      });
    }

    return new Promise((resolve) => {
      const child = execFile(cmd, args, {
        cwd: VOLAURA_ROOT,
        timeout: timeoutMs,
        env: { ...process.env, PYTHONPATH: VOLAURA_ROOT },
        maxBuffer: 10 * 1024 * 1024,
      }, async (error) => {
        if (error) {
          if ((error as any).code === 'ENOENT') {
            console.warn(`[python-bridge] ${cmd} not found in PATH, trying fallback...`);
            resolve(tryExec(index + 1));
            return;
          }
          console.error(`[python-bridge] ${cmd} error: ${error.message}`);
          resolve({ success: false, proposals: [], error: error.message, source: 'python' });
          return;
        }

        try {
          const raw = await readFile(PROPOSALS_PATH, 'utf-8');
          const data = JSON.parse(raw);
          const proposals = Array.isArray(data) ? data : data.proposals ?? [];
          resolve({ success: true, proposals, source: 'python' });
        } catch (readErr) {
          resolve({ success: false, proposals: [], error: `proposals.json read failed: ${readErr}`, source: 'python' });
        }
      });

      child.stdout?.on('data', (d: Buffer) => process.stdout.write(`[py] ${d}`));
      child.stderr?.on('data', (d: Buffer) => process.stderr.write(`[py-err] ${d}`));
    });
  };

  return tryExec(0);
}

export async function writeSharedBusRequest(requestId: string, payload: Record<string, unknown>): Promise<string> {
  const { writeFile } = await import('node:fs/promises');
  const { mkdirSync } = await import('node:fs');
  const dir = join(SHARED_BUS, 'requests');
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const fp = join(dir, `${requestId}.json`);
  await writeFile(fp, JSON.stringify({ ts: new Date().toISOString(), ...payload }, null, 2), 'utf-8');
  return fp;
}

export async function readSharedBusResponse(requestId: string): Promise<Record<string, unknown> | null> {
  const fp = join(SHARED_BUS, 'responses', `${requestId}.json`);
  if (!existsSync(fp)) return null;
  const raw = await readFile(fp, 'utf-8');
  return JSON.parse(raw) as Record<string, unknown>;
}

export async function loadHiveProfiles(): Promise<Record<string, unknown>[]> {
  const hiveDir = join(process.env['HOME'] ?? process.env['USERPROFILE'] ?? '~', '.swarm', 'hive', 'profiles');
  if (!existsSync(hiveDir)) return [];
  const { readdir } = await import('node:fs/promises');
  const files = await readdir(hiveDir);
  const profiles: Record<string, unknown>[] = [];
  for (const f of files) {
    if (!f.endsWith('.json')) continue;
    try {
      const raw = await readFile(join(hiveDir, f), 'utf-8');
      profiles.push(JSON.parse(raw) as Record<string, unknown>);
    } catch { /* skip corrupted */ }
  }
  return profiles;
}
