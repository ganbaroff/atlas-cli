/**
 * Chief-of-Staff drift detectors — PURE signal functions over
 * already-gathered OBSERVATIONS. Read/write nothing; not an authority.
 * "Drift is not failure" — each finding states a deterministic criterion +
 * reason. Observations (git/heartbeat/graph-verify) may raise a signal but
 * never mutate graph state.
 */

import type { TaskStatus } from '../../exec-graph/contracts.js';

export type DriftKind = 'unpushed-commits' | 'graph-verify-failed' | 'stale-heartbeat' | 'stuck-task';
/** 'drift' = real divergence; 'stale' = a signal aged past threshold; 'unknown' = could not observe. */
export type DriftSeverity = 'drift' | 'stale' | 'unknown';

export interface DriftFinding {
  kind: DriftKind;
  severity: DriftSeverity;
  sourceAuthority: string;        // 'git' | 'exec-graph' | 'heartbeat-file'
  ref?: string;                   // branch / taskId / file path, when applicable
  reason: string;                 // deterministic, documented — WHY this is shown
  evidenceFreshness: string;      // e.g. '2.0h' | 'now' | 'UNKNOWN'
}

export interface DriftThresholds {
  heartbeatStaleHours?: number;   // default 24
  stuckTaskHours?: number;        // default 48
}

export interface DriftInputs {
  /** git ahead/behind vs origin. null = could not observe -> an 'unknown' finding. */
  git?: { branch: string; aheadRemote: number; behindRemote: number } | null;
  /** null OR ageHours null = could not observe -> 'unknown'. */
  heartbeat?: { ageHours: number | null } | null;
  /** result of `graph verify` ok flag. null = could not observe -> 'unknown'. */
  graphVerifyOk?: boolean | null;
  /** non-terminal tasks with how long they've sat. Only those over threshold become findings. */
  stuckTasks?: Array<{ taskId: string; status: TaskStatus; ageHours: number }>;
  thresholds?: DriftThresholds;
}

const DEFAULT_HEARTBEAT_STALE_HOURS = 24;
const DEFAULT_STUCK_TASK_HOURS = 48;

/** Render hours with one decimal (matches facts.ts's Math.round(h*10)/10 style, e.g. '2.0h'). */
function fmtHours(hours: number): string {
  return `${(Math.round(hours * 10) / 10).toFixed(1)}h`;
}

function detectUnpushedCommits(git: DriftInputs['git']): DriftFinding[] {
  if (git === null || git === undefined) {
    return [{
      kind: 'unpushed-commits',
      severity: 'unknown',
      sourceAuthority: 'git',
      reason: 'could not read git ahead/behind vs origin',
      evidenceFreshness: 'UNKNOWN',
    }];
  }
  if (git.aheadRemote > 0) {
    return [{
      kind: 'unpushed-commits',
      severity: 'drift',
      sourceAuthority: 'git',
      ref: git.branch,
      reason: `local is ${git.aheadRemote} commit(s) ahead of origin — unpushed`,
      evidenceFreshness: 'now',
    }];
  }
  return [];
}

function detectGraphVerifyFailed(graphVerifyOk: DriftInputs['graphVerifyOk']): DriftFinding[] {
  if (graphVerifyOk === null || graphVerifyOk === undefined) {
    return [{
      kind: 'graph-verify-failed',
      severity: 'unknown',
      sourceAuthority: 'exec-graph',
      reason: 'could not run graph verify',
      evidenceFreshness: 'UNKNOWN',
    }];
  }
  if (graphVerifyOk === false) {
    return [{
      kind: 'graph-verify-failed',
      severity: 'drift',
      sourceAuthority: 'exec-graph',
      reason: 'graph verify failed — on-disk snapshot diverges from the ledger rebuild',
      evidenceFreshness: 'now',
    }];
  }
  return [];
}

function detectStaleHeartbeat(heartbeat: DriftInputs['heartbeat'], staleHours: number): DriftFinding[] {
  if (heartbeat == null || heartbeat.ageHours == null) {
    return [{
      kind: 'stale-heartbeat',
      severity: 'unknown',
      sourceAuthority: 'heartbeat-file',
      reason: 'could not read heartbeat freshness',
      evidenceFreshness: 'UNKNOWN',
    }];
  }
  if (heartbeat.ageHours > staleHours) {
    return [{
      kind: 'stale-heartbeat',
      severity: 'stale',
      sourceAuthority: 'heartbeat-file',
      reason: `heartbeat ${fmtHours(heartbeat.ageHours)} old (> ${fmtHours(staleHours)} threshold)`,
      evidenceFreshness: fmtHours(heartbeat.ageHours),
    }];
  }
  return [];
}

function detectStuckTasks(stuckTasks: DriftInputs['stuckTasks'], stuckHours: number): DriftFinding[] {
  const findings: DriftFinding[] = [];
  for (const task of stuckTasks ?? []) {
    if (task.ageHours > stuckHours) {
      findings.push({
        kind: 'stuck-task',
        severity: 'drift',
        sourceAuthority: 'exec-graph',
        ref: task.taskId,
        reason: `task in '${task.status}' for ${fmtHours(task.ageHours)} with no progress (> ${fmtHours(stuckHours)})`,
        evidenceFreshness: fmtHours(task.ageHours),
      });
    }
  }
  return findings;
}

/**
 * Detect drift across the four Chief-of-Staff categories from already-gathered
 * observations. PURE: no fs/network/child_process, no Date/Math.random access,
 * never mutates inputs, never throws. Deterministic — same inputs always
 * produce the same output array in the same fixed order: unpushed-commits,
 * graph-verify-failed, stale-heartbeat, stuck-task (one finding per stuck task,
 * input order preserved).
 */
export function detectDrift(inputs: DriftInputs): DriftFinding[] {
  const heartbeatStaleHours = inputs.thresholds?.heartbeatStaleHours ?? DEFAULT_HEARTBEAT_STALE_HOURS;
  const stuckTaskHours = inputs.thresholds?.stuckTaskHours ?? DEFAULT_STUCK_TASK_HOURS;

  return [
    ...detectUnpushedCommits(inputs.git),
    ...detectGraphVerifyFailed(inputs.graphVerifyOk),
    ...detectStaleHeartbeat(inputs.heartbeat, heartbeatStaleHours),
    ...detectStuckTasks(inputs.stuckTasks, stuckTaskHours),
  ];
}
