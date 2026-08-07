/**
 * atlas/executor/mission-runner.ts — the deterministic loop around an executor.
 *
 * Atlas decides whether a mission passed. The executor's own report is an
 * input, never the verdict: acceptance is re-derived from the worktree on disk
 * and from a real test run, so an executor that claims success without doing
 * the work is rejected exactly like one that admits failure.
 *
 * Repair is bounded to ONE cycle by construction, not by convention. The loop
 * has no `while`: attempt, verify, at most one repair, verify, stop. A second
 * failure is an honest REJECT — there is no code path that tries a third time.
 */

import type { ExecutorAdapter, ExecutorRunContext, ExecutorRunResult } from './adapter.js';

export type MissionVerdict = 'VERIFIED' | 'REJECT';

/** One acceptance condition Atlas checks itself. */
export interface AcceptanceCheck {
  readonly id: string;
  /** Shown to the executor ONLY inside a repair instruction, never up front. */
  readonly repairHint: string;
  /** Re-derived from disk. Must not consult the executor's output. */
  run(): Promise<{ ok: boolean; detail: string }> | { ok: boolean; detail: string };
}

export interface MissionAttemptRecord {
  readonly attempt: number;
  readonly executorStatus: ExecutorRunResult['status'];
  readonly toolCallsRequested: number;
  readonly toolCallsRefused: number;
  readonly failedChecks: readonly { id: string; detail: string }[];
  readonly repairInstruction?: string;
}

export interface MissionOutcome {
  readonly verdict: MissionVerdict;
  readonly attempts: readonly MissionAttemptRecord[];
  readonly repairCycles: number;
  readonly failedChecks: readonly { id: string; detail: string }[];
  readonly rejectReason?: string;
}

export const MAX_REPAIR_CYCLES = 1;

async function evaluate(checks: readonly AcceptanceCheck[]) {
  const failed: { id: string; detail: string }[] = [];
  for (const check of checks) {
    const result = await check.run();
    if (!result.ok) failed.push({ id: check.id, detail: result.detail });
  }
  return failed;
}

/**
 * Builds the single repair instruction. It names only the checks that actually
 * failed — a repair that restates the whole mission is not bounded, and lets an
 * executor quietly redo work Atlas already accepted.
 */
export function buildRepairInstruction(
  checks: readonly AcceptanceCheck[],
  failed: readonly { id: string; detail: string }[],
): string {
  const hints = failed.map((f) => {
    const hint = checks.find((c) => c.id === f.id)?.repairHint ?? f.id;
    return `- ${f.id}: ${hint} (observed: ${f.detail})`;
  });
  return (
    'Your previous attempt did not satisfy every acceptance condition. ' +
    'Atlas verified the worktree itself; these conditions are still unmet:\n' +
    `${hints.join('\n')}\n` +
    'Fix ONLY these. Do not revert or redo work that already passed. ' +
    'Then run the test again and report the exit code you actually observed. ' +
    'This is the only repair attempt — a second failure ends the mission.'
  );
}

/**
 * Runs one mission with at most one bounded repair.
 *
 * `runAttempt` is injected so the caller owns lease, broker and provider
 * lifecycle: the runner decides verdicts, not resources.
 */
export async function runMissionWithBoundedRepair(input: {
  readonly adapter: ExecutorAdapter;
  readonly context: ExecutorRunContext;
  readonly checks: readonly AcceptanceCheck[];
  /** Invoked per attempt with the instruction for that attempt. */
  readonly runAttempt: (instruction: string, attempt: number) => Promise<ExecutorRunResult>;
}): Promise<MissionOutcome> {
  const attempts: MissionAttemptRecord[] = [];

  const first = await input.runAttempt(input.context.instruction, 1);
  let failed = await evaluate(input.checks);

  if (failed.length === 0) {
    attempts.push({
      attempt: 1,
      executorStatus: first.status,
      toolCallsRequested: first.toolCallsRequested,
      toolCallsRefused: first.toolCallsRefused,
      failedChecks: [],
    });
    return { verdict: 'VERIFIED', attempts, repairCycles: 0, failedChecks: [] };
  }

  const repairInstruction = buildRepairInstruction(input.checks, failed);
  attempts.push({
    attempt: 1,
    executorStatus: first.status,
    toolCallsRequested: first.toolCallsRequested,
    toolCallsRefused: first.toolCallsRefused,
    failedChecks: failed,
    repairInstruction,
  });

  // The one and only repair. No loop — a third attempt is unrepresentable.
  const second = await input.runAttempt(repairInstruction, 2);
  failed = await evaluate(input.checks);

  attempts.push({
    attempt: 2,
    executorStatus: second.status,
    toolCallsRequested: second.toolCallsRequested,
    toolCallsRefused: second.toolCallsRefused,
    failedChecks: failed,
  });

  if (failed.length === 0) {
    return { verdict: 'VERIFIED', attempts, repairCycles: 1, failedChecks: [] };
  }

  return {
    verdict: 'REJECT',
    attempts,
    repairCycles: 1,
    failedChecks: failed,
    rejectReason: `acceptance still unmet after ${MAX_REPAIR_CYCLES} repair: ${failed
      .map((f) => f.id)
      .join(', ')}`,
  };
}
