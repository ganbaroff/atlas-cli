/**
 * Lifecycle binding — map Core Spine stages onto existing exec-graph TaskStatus.
 * Does NOT create a second task engine.
 */
import type { TaskStatus } from '../exec-graph/contracts.js';
import { TASK_STATUSES } from '../exec-graph/contracts.js';

/** Semantic stages for the developer-agent loop (docs/contracts). */
export type SpineStage =
  | 'proposed'
  | 'authorized'
  | 'isolated'
  | 'executing'
  | 'evidence_submitted'
  | 'independently_verified'
  | 'rejected'
  | 'closed'
  | 'rolled_back';

/**
 * Smallest mapping onto the existing 11-state machine.
 * rolled_back → rejected (then may return to proposed via existing edges).
 */
export const SPINE_STAGE_TO_TASK_STATUS: Readonly<Record<SpineStage, TaskStatus>> = Object.freeze({
  proposed: 'proposed',
  authorized: 'accepted',
  isolated: 'planned',
  executing: 'in-progress',
  evidence_submitted: 'evidence-submitted',
  independently_verified: 'verified',
  rejected: 'rejected',
  closed: 'closed',
  rolled_back: 'rejected',
});

export function mapSpineStageToTaskStatus(stage: SpineStage): TaskStatus {
  return SPINE_STAGE_TO_TASK_STATUS[stage];
}

export function assertSpineStageRepresentable(stage: SpineStage): void {
  const status = SPINE_STAGE_TO_TASK_STATUS[stage];
  if (!TASK_STATUSES.includes(status)) {
    throw new Error(`spine stage '${stage}' maps to unknown task status '${status}'`);
  }
}
