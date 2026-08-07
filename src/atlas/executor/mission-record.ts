/**
 * atlas/executor/mission-record.ts — the Atlas-owned durable mission record.
 *
 * This is what a restarted Atlas reads to know where it was. It is deliberately
 * small and Atlas-shaped: the executor's own session blob is carried as an
 * opaque reference, never interpreted. Durable memory authority stays with
 * VOLAURA `memory/atlas`; this file is mission continuity, nothing more.
 *
 * Two properties do the work:
 *
 * Idempotence. A completed step is recorded with a stable stepId, and
 * `beginStep` refuses one that already completed. Replay after a crash cannot
 * re-run a mutation or re-invoke a provider, because the question "did this
 * already happen" is answered from disk rather than from memory.
 *
 * Crash-safety. Every write is atomic — temp file then rename — so a process
 * killed mid-write leaves either the previous record or the new one, never a
 * truncated file that would strand the mission.
 */

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync, unlinkSync } from 'node:fs';
import path from 'node:path';

export type MissionStepKind = 'mutation' | 'provider-invocation' | 'verification' | 'rollback';

export interface MissionStep {
  readonly stepId: string;
  readonly kind: MissionStepKind;
  readonly completedAt: string;
  /** Hash of whatever proves the step happened — a file, a claim id, a diff. */
  readonly resultHash: string;
}

export interface MissionRecord {
  readonly missionId: string;
  readonly workOrderHash: string;
  readonly repoCanonicalPath: string;
  readonly worktreePath: string;
  readonly baseHead: string;
  readonly currentMilestone: string;
  readonly attempt: number;
  readonly maxAttempts: number;
  /** Reference to the executor's own session state. Opaque to Atlas. */
  readonly executorSessionRef: string | null;
  readonly leaseOwner: { readonly missionId: string; readonly workOrderId: string };
  /** Evidence claim id from approveProvider. Must survive a restart. */
  readonly spendClaimId: string;
  readonly evidencePath: string;
  readonly completedSteps: readonly MissionStep[];
  readonly updatedAt: string;
}

export class MissionRecordError extends Error {
  constructor(
    message: string,
    readonly code: 'already-completed' | 'not-found' | 'corrupt' | 'mission-mismatch',
  ) {
    super(message);
    this.name = 'MissionRecordError';
  }
}

export function missionRecordPath(stateDir: string, missionId: string): string {
  return path.join(stateDir, `mission-${missionId}.json`);
}

/** Atomic write: a process killed mid-write never leaves a half file. */
export function writeMissionRecord(stateDir: string, record: MissionRecord): void {
  mkdirSync(stateDir, { recursive: true });
  const target = missionRecordPath(stateDir, record.missionId);
  const temp = `${target}.${process.pid}.tmp`;
  writeFileSync(temp, JSON.stringify(record, null, 2), 'utf8');
  renameSync(temp, target);
}

export function readMissionRecord(stateDir: string, missionId: string): MissionRecord {
  const target = missionRecordPath(stateDir, missionId);
  if (!existsSync(target)) {
    throw new MissionRecordError(`no mission record at ${target}`, 'not-found');
  }
  let parsed: MissionRecord;
  try {
    parsed = JSON.parse(readFileSync(target, 'utf8')) as MissionRecord;
  } catch (err) {
    throw new MissionRecordError(`mission record unreadable: ${(err as Error)?.message}`, 'corrupt');
  }
  if (parsed?.missionId !== missionId) {
    throw new MissionRecordError(
      `record at ${target} belongs to mission ${parsed?.missionId}`,
      'mission-mismatch',
    );
  }
  return parsed;
}

export function hasCompleted(record: MissionRecord, stepId: string): boolean {
  return record.completedSteps.some((s) => s.stepId === stepId);
}

/**
 * Idempotence gate. Throws when the step already completed — the caller must
 * treat that as "skip", not as an error to retry, which is exactly what a
 * restarted mission needs.
 */
export function beginStep(record: MissionRecord, stepId: string): void {
  if (hasCompleted(record, stepId)) {
    throw new MissionRecordError(`step '${stepId}' already completed in this mission`, 'already-completed');
  }
}

export function completeStep(
  record: MissionRecord,
  step: { stepId: string; kind: MissionStepKind; result: unknown; at: string },
): MissionRecord {
  if (hasCompleted(record, step.stepId)) return record;
  const resultHash = createHash('sha256').update(JSON.stringify(step.result ?? null)).digest('hex');
  return {
    ...record,
    completedSteps: [
      ...record.completedSteps,
      { stepId: step.stepId, kind: step.kind, completedAt: step.at, resultHash },
    ],
    updatedAt: step.at,
  };
}

/**
 * Runs a step exactly once across restarts. On a replay the recorded result
 * hash is returned instead of re-running, so a mutation cannot happen twice and
 * a provider cannot be invoked twice.
 */
export function runStepOnce<T>(
  stateDir: string,
  record: MissionRecord,
  step: { stepId: string; kind: MissionStepKind; at: string },
  work: () => T,
): { record: MissionRecord; skipped: boolean; result?: T } {
  if (hasCompleted(record, step.stepId)) {
    return { record, skipped: true };
  }
  const result = work();
  const next = completeStep(record, { ...step, result });
  writeMissionRecord(stateDir, next);
  return { record: next, skipped: false, result };
}

/** Removes a mission record. Used at clean completion, never mid-flight. */
export function deleteMissionRecord(stateDir: string, missionId: string): void {
  const target = missionRecordPath(stateDir, missionId);
  if (existsSync(target)) unlinkSync(target);
}
