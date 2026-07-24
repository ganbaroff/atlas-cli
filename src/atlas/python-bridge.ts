/**
 * Bridge to VOLAURA Python swarm — subprocess-based, fail-closed for MVP.
 *
 * Protocol: Python must emit a JSON line on stdout:
 *   {"bridge":"atlas-swarm","runId":"<uuid>","proposals":[...]}
 * Stale proposals.json on disk is NEVER trusted without matching stdout runId.
 */

import { execFile } from 'node:child_process';
import { readFile, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { getVolauraRoot } from './path-util.js';

const VOLAURA_ROOT = getVolauraRoot();
const PROPOSALS_PATH = join(VOLAURA_ROOT, 'memory', 'swarm', 'proposals.json');
const SHARED_BUS = join(VOLAURA_ROOT, 'memory', 'shared-bus');

export type BridgeStatus =
  | 'OK'
  | 'EXPERIMENTAL_BRIDGE_DISABLED'
  | 'STDOUT_PROTOCOL_MISMATCH'
  | 'STALE_PROPOSALS_REJECTED'
  | 'PYTHON_NOT_FOUND'
  | 'EXEC_FAILED';

export interface SwarmResult {
  success: boolean;
  proposals: unknown[];
  error?: string;
  source: 'python' | 'typescript';
  bridgeStatus: BridgeStatus;
  runId?: string;
}

export interface StdoutProtocol {
  bridge: string;
  runId: string;
  proposals: unknown[];
}

export function isPythonSwarmAvailable(): boolean {
  return existsSync(join(VOLAURA_ROOT, 'packages', 'swarm', 'autonomous_run.py'));
}

/** Parse stdout for atlas-swarm JSON protocol line. */
export function parseStdoutProtocol(stdout: string): StdoutProtocol | null {
  for (const line of stdout.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('{')) continue;
    try {
      const parsed = JSON.parse(trimmed) as Record<string, unknown>;
      if (parsed['bridge'] !== 'atlas-swarm') continue;
      if (typeof parsed['runId'] !== 'string' || !parsed['runId']) continue;
      const proposals = Array.isArray(parsed['proposals']) ? parsed['proposals'] : [];
      return { bridge: 'atlas-swarm', runId: parsed['runId'], proposals };
    } catch {
      continue;
    }
  }
  return null;
}

/** Reject proposals.json if mtime predates this run or runId mismatch. */
export async function validateProposalsFile(
  runId: string,
  runStartedMs: number,
): Promise<{ ok: boolean; proposals: unknown[]; reason?: string }> {
  if (!existsSync(PROPOSALS_PATH)) {
    return { ok: false, proposals: [], reason: 'proposals.json missing' };
  }
  try {
    const st = await stat(PROPOSALS_PATH);
    if (st.mtimeMs < runStartedMs - 1000) {
      return { ok: false, proposals: [], reason: 'stale_proposals_mtime' };
    }
    const raw = await readFile(PROPOSALS_PATH, 'utf-8');
    const data = JSON.parse(raw) as Record<string, unknown>;
    if (data['runId'] && data['runId'] !== runId) {
      return { ok: false, proposals: [], reason: 'runId_mismatch' };
    }
    const proposals = Array.isArray(data) ? data : (data['proposals'] as unknown[]) ?? [];
    return { ok: true, proposals };
  } catch (err) {
    return {
      ok: false,
      proposals: [],
      reason: `proposals read failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

export async function callPythonSwarm(
  task: string,
  mode = 'coordinator',
  timeoutMs = 120_000,
): Promise<SwarmResult> {
  if (!isPythonSwarmAvailable()) {
    return {
      success: false,
      proposals: [],
      error: 'VOLAURA Python swarm not found — EXPERIMENTAL_BRIDGE_DISABLED',
      source: 'python',
      bridgeStatus: 'EXPERIMENTAL_BRIDGE_DISABLED',
    };
  }

  const args = ['-m', 'packages.swarm.autonomous_run', `--mode=${mode}`, `--task=${task}`];
  const executables = ['python3', 'python', 'py'];
  const runStartedMs = Date.now();

  const tryExec = (index: number): Promise<SwarmResult> => {
    const cmd = executables[index];
    if (!cmd) {
      return Promise.resolve({
        success: false,
        proposals: [],
        error: `Python executable not found (tried ${executables.join(', ')})`,
        source: 'python',
        bridgeStatus: 'PYTHON_NOT_FOUND',
      });
    }

    return new Promise((resolve) => {
      let stdoutBuf = '';
      const child = execFile(
        cmd,
        args,
        {
          cwd: VOLAURA_ROOT,
          timeout: timeoutMs,
          env: { ...process.env, PYTHONPATH: VOLAURA_ROOT },
          maxBuffer: 10 * 1024 * 1024,
        },
        async (error) => {
          if (error) {
            if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
              resolve(tryExec(index + 1));
              return;
            }
            resolve({
              success: false,
              proposals: [],
              error: error.message,
              source: 'python',
              bridgeStatus: 'EXEC_FAILED',
            });
            return;
          }

          const protocol = parseStdoutProtocol(stdoutBuf);
          if (!protocol) {
            resolve({
              success: false,
              proposals: [],
              error: 'stdout protocol mismatch — expected {"bridge":"atlas-swarm","runId":"...","proposals":[]}',
              source: 'python',
              bridgeStatus: 'STDOUT_PROTOCOL_MISMATCH',
            });
            return;
          }

          const fileCheck = await validateProposalsFile(protocol.runId, runStartedMs);
          const proposals = protocol.proposals.length > 0 ? protocol.proposals : fileCheck.proposals;

          if (protocol.proposals.length === 0 && !fileCheck.ok) {
            resolve({
              success: false,
              proposals: [],
              error: `stale proposals rejected: ${fileCheck.reason}`,
              source: 'python',
              bridgeStatus: 'STALE_PROPOSALS_REJECTED',
              runId: protocol.runId,
            });
            return;
          }

          resolve({
            success: true,
            proposals,
            source: 'python',
            bridgeStatus: 'OK',
            runId: protocol.runId,
          });
        },
      );

      child.stdout?.on('data', (d: Buffer) => {
        stdoutBuf += d.toString();
        process.stdout.write(`[py] ${d}`);
      });
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
