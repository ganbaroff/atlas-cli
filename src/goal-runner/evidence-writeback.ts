/**
 * M8 product hook — append typed goal-terminal claim to evidence ledger.
 * Fail-open: never blocks goal completion.
 */

import { randomUUID } from 'node:crypto';
import { appendClaim } from '../evidence/ledger.js';
import type { GoalReport } from './types.js';

function makeClaimId(): string {
  return `clm_${randomUUID().replace(/-/g, '').slice(0, 16)}`;
}

/** Append hash-chained narrative claim describing terminal goal status. */
export function writeGoalTerminalClaim(report: GoalReport, handId: string): void {
  try {
    appendClaim({
      claimId: makeClaimId(),
      claim: JSON.stringify({
        kind: 'goal-terminal',
        goalId: report.goalId,
        status: report.status,
        handId,
        tasksTotal: report.tasksTotal,
        tasksVerified: report.tasksVerified,
        tasksFailed: report.tasksFailed,
        tasksEscalated: report.tasksEscalated,
        wallTimeMs: report.wallTimeMs,
      }),
      type: 'narrative',
      path: `goal://${report.goalId}`,
      confidence: 0,
      source: 'goal-runner',
      sourceRef: report.goalId,
      ts: new Date().toISOString(),
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[goal-runner] evidence write-back failed (non-fatal): ${msg}`);
  }
}
