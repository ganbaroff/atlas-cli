/**
 * Atlas Swarm — parallel agent orchestrator.
 *
 * Delegates to research-swarm lifecycle for honest provider diversity,
 * bounded execution, structured evidence, and fail-closed status handling.
 */

import { logSwarmRun } from './atlas/swarm-logger.js';
import { runResearchSwarm, runResearchSwarmLegacyDetail } from './research-swarm/lifecycle.js';
import type { ProviderName } from './model-router.js';

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

export interface SwarmRunDetail {
  subtasks: Subtask[];
  results: WorkerResult[];
  synthesis: string;
  durationMs: number;
  jidokaViolation: string | null;
}

/** Main entry: perspectives analyze in parallel → synthesize. Returns the full run detail. */
export async function runSwarmDetailed(task: string, useCustomDecompose = false): Promise<SwarmRunDetail> {
  if (useCustomDecompose) {
    console.warn('[swarm] custom decompose not supported in research-swarm MVP — using perspectives');
  }

  const detail = await runResearchSwarmLegacyDetail(task);

  // Legacy swarm-logger for backward compat (also writes structured artifact)
  try {
    const logPath = await logSwarmRun({
      ts: new Date().toISOString(),
      task,
      subtasks: detail.subtasks,
      results: detail.results,
      synthesis: detail.synthesis,
      durationMs: detail.durationMs,
      jidokaViolation: detail.jidokaViolation,
      status: detail.status,
      exitReason: detail.exitReason,
      runId: detail.runId,
    });
    console.log(`[swarm] Run logged: ${logPath}`);
  } catch (err) {
    console.warn(`[swarm] Failed to persist run log: ${err instanceof Error ? err.message : err}`);
  }

  return detail;
}

/** Main entry: perspectives analyze in parallel → synthesize. Returns just the synthesis text. */
export async function runSwarm(task: string, useCustomDecompose = false): Promise<string> {
  if (useCustomDecompose) {
    console.warn('[swarm] custom decompose not supported in research-swarm MVP — using perspectives');
  }
  const result = await runResearchSwarm(task);
  return result.synthesis;
}

/** Full research swarm result with artifact and exit code. */
export { runResearchSwarm } from './research-swarm/lifecycle.js';
export type { ResearchSwarmResult } from './research-swarm/types.js';
