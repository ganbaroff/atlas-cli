/**
 * exec-graph/api.ts — thin façade over ledger.ts + transitions.ts.
 *
 * This is the ONE surface CLI commands (src/cli.ts) and any future in-process
 * caller should use — nothing outside exec-graph/ should import ledger.ts or
 * transitions.ts directly for write paths, so this file is where the
 * "single machine execution authority" boundary is actually enforced in
 * code, not just in a doc comment.
 *
 * A NOTE ON moveTask() AND EVIDENCE: taskSchema's invariant is "a task
 * resting in verified/closed must have >=1 evidence ENTRY" (task.evidence),
 * which is a separate field from a Transition's evidenceRefs (pointers cited
 * on the move itself). To make the CLI's `task move <id> verified --evidence
 * <ref>` usable end-to-end without a separate evidence-add step, moveTask()
 * here promotes any --evidence refs supplied on the move into real
 * Evidence entries on the task (via addEvidence()) BEFORE attempting the
 * transition, so the same refs the caller is citing on the transition also
 * satisfy the task-level invariant. Evidence can still be added earlier/
 * separately via addEvidence() directly — this is additive, not the only path.
 */

import { randomUUID } from 'node:crypto';
import {
  type Goal,
  type Task,
  type Evidence,
  type SourceKind,
  type SourceRef,
  type RiskClass,
  type TaskStatus,
  goalSchema,
  taskSchema,
  TASK_STATUSES,
} from './contracts.js';
import { appendEvent, readGraph } from './ledger.js';
import { applyTransition, type ApplyTransitionOptions } from './transitions.js';

function nowIso(): string {
  return new Date().toISOString();
}

function newGoalId(): string {
  return `gol_${randomUUID().replace(/-/g, '')}`;
}

function newTaskId(): string {
  return `tsk_${randomUUID().replace(/-/g, '')}`;
}

// ── Goals ────────────────────────────────────────────────────────────────

export interface CreateGoalInput {
  title: string;
  source?: SourceRef;
  actor?: string;
  ts?: string;
}

export function createGoal(input: CreateGoalInput): Goal {
  const ts = input.ts ?? nowIso();
  const actor = input.actor ?? 'atlas';
  const goal = goalSchema.parse({
    id: newGoalId(),
    title: input.title,
    source: input.source ?? { kind: 'exec-graph', ref: 'cli' },
    status: 'open',
    createdAt: ts,
  });
  appendEvent({ kind: 'goal-created', ts, actor, payload: { goal } });
  return goal;
}

// ── Tasks: create / import ──────────────────────────────────────────────

export interface CreateTaskInput {
  goalId: string;
  title: string;
  owner?: string;
  riskClass?: RiskClass;
  source?: SourceRef;
  /** Explicit override. If omitted, derived as `${source.kind}:${source.ref}`. */
  idempotencyKey?: string;
  actor?: string;
  ts?: string;
}

export interface CreateTaskResult {
  task: Task;
  /** false when this call deduped against a pre-existing task with the same idempotencyKey. */
  created: boolean;
}

function deriveIdempotencyKey(source: SourceRef): string {
  return `${source.kind}:${source.ref}`;
}

export function createTask(input: CreateTaskInput): CreateTaskResult {
  const ts = input.ts ?? nowIso();
  const actor = input.actor ?? 'atlas';
  const source = input.source ?? { kind: 'exec-graph' as SourceKind, ref: 'cli' };
  const idempotencyKey = input.idempotencyKey ?? deriveIdempotencyKey(source);

  const task = taskSchema.parse({
    id: newTaskId(),
    goalId: input.goalId,
    title: input.title,
    source,
    owner: input.owner ?? 'atlas',
    status: 'proposed',
    riskClass: input.riskClass ?? 'low',
    idempotencyKey,
    evidence: [],
    createdAt: ts,
    transitions: [{ from: null, to: 'proposed', ts, actor, note: 'created' }],
  });

  const result = appendEvent({ kind: 'task-created', ts, actor, payload: { task } });
  if (result.deduped) {
    const existing = readGraph().tasks[result.taskId as string];
    return { task: existing, created: false };
  }
  return { task, created: true };
}

export interface ImportTaskInput {
  goalId: string;
  title: string;
  sourceKind: SourceKind;
  sourceRef: string;
  owner?: string;
  riskClass?: RiskClass;
  actor?: string;
  ts?: string;
}

/**
 * Import a task from a legacy source. idempotencyKey is ALWAYS derived as
 * `${sourceKind}:${sourceRef}` (never caller-overridable here) — this is the
 * reconciliation guarantee: importing the same legacy ref twice can never
 * create a second active task, by construction, not by caller discipline.
 */
export function importTask(input: ImportTaskInput): CreateTaskResult {
  return createTask({
    goalId: input.goalId,
    title: input.title,
    owner: input.owner,
    riskClass: input.riskClass,
    source: { kind: input.sourceKind, ref: input.sourceRef },
    idempotencyKey: `${input.sourceKind}:${input.sourceRef}`,
    actor: input.actor,
    ts: input.ts,
  });
}

// ── Tasks: move / evidence ──────────────────────────────────────────────

export interface MoveTaskInput extends Omit<ApplyTransitionOptions, 'ts'> {
  taskId: string;
  to: TaskStatus;
  ts?: string;
}

export function moveTask(input: MoveTaskInput): Task {
  const graph = readGraph();
  let task = graph.tasks[input.taskId];
  if (!task) {
    throw new Error(`exec-graph: unknown task ${input.taskId}`);
  }
  const ts = input.ts ?? nowIso();

  // See module doc: evidenceRefs supplied on a move are also recorded as
  // Evidence entries on the task itself, so a move straight into
  // 'evidence-submitted'/'verified' can satisfy the task-level "must have
  // >=1 evidence entry" invariant using the same refs already cited.
  if (input.evidenceRefs && input.evidenceRefs.length > 0) {
    for (const ref of input.evidenceRefs) {
      task = addEvidence({ taskId: task.id, evidence: { ref, kind: 'other' }, actor: input.actor, ts });
    }
  }

  const nextTask = applyTransition(task, input.to, {
    actor: input.actor,
    ts,
    evidenceRefs: input.evidenceRefs,
    note: input.note,
  });

  const newTransition = nextTask.transitions[nextTask.transitions.length - 1];
  appendEvent({ kind: 'transition', ts, actor: input.actor, payload: { taskId: task.id, transition: newTransition } });
  return nextTask;
}

// Re-export so callers of moveTask don't need a second import for `to`'s type.
export type { TaskStatus } from './contracts.js';

/** Thrown by reassignOwner() for an unknown task id or empty newOwner/actor/reason. */
export class ExecGraphOwnerReassignError extends Error {}

export interface ReassignOwnerOptions {
  actor: string;
  reason: string;
  ts?: string;
}

/**
 * Owner-reassignment primitive (does NOT touch status — see ledger.ts's
 * 'owner-reassigned' fold case). This is also the primitive delegation will
 * reuse later for `owner: atlas -> owner: hand:<id>`, so it's built as a
 * standalone, append-only, actor/reason-audited move rather than a one-off.
 */
export function reassignOwner(taskId: string, newOwner: string, opts: ReassignOwnerOptions): Task {
  const { actor, reason } = opts;
  if (!newOwner || !newOwner.trim()) {
    throw new ExecGraphOwnerReassignError('newOwner is required and must be non-empty');
  }
  if (!actor || !actor.trim()) {
    throw new ExecGraphOwnerReassignError('actor is required and must be non-empty');
  }
  if (!reason || !reason.trim()) {
    throw new ExecGraphOwnerReassignError('reason is required and must be non-empty');
  }

  const graph = readGraph();
  const task = graph.tasks[taskId];
  if (!task) {
    throw new ExecGraphOwnerReassignError(`exec-graph: unknown task ${taskId}`);
  }

  const ts = opts.ts ?? nowIso();
  const from = task.owner;

  appendEvent({
    kind: 'owner-reassigned',
    ts,
    actor,
    payload: { taskId, from, to: newOwner, actor, reason, ts },
  });

  return { ...task, owner: newOwner };
}

export interface AddEvidenceInput {
  taskId: string;
  evidence: Evidence;
  actor?: string;
  ts?: string;
}

export function addEvidence(input: AddEvidenceInput): Task {
  const graph = readGraph();
  const task = graph.tasks[input.taskId];
  if (!task) {
    throw new Error(`exec-graph: unknown task ${input.taskId}`);
  }
  const ts = input.ts ?? nowIso();
  const actor = input.actor ?? 'atlas';
  appendEvent({ kind: 'evidence-added', ts, actor, payload: { taskId: task.id, evidence: input.evidence } });
  return { ...task, evidence: [...task.evidence, input.evidence] };
}

// ── Reads ────────────────────────────────────────────────────────────────

export function getTask(id: string): Task | undefined {
  return readGraph().tasks[id];
}

export interface ListTasksFilter {
  status?: TaskStatus;
  goalId?: string;
  owner?: string;
}

export function listTasks(filter: ListTasksFilter = {}): Task[] {
  return Object.values(readGraph().tasks).filter((t) =>
    (filter.status === undefined || t.status === filter.status)
    && (filter.goalId === undefined || t.goalId === filter.goalId)
    && (filter.owner === undefined || t.owner === filter.owner));
}

const WAITING_STATUSES: readonly TaskStatus[] = ['escalated', 'blocked', 'evidence-submitted'];

export interface StatusSummary {
  counts: Record<TaskStatus, number>;
  /** Tasks in escalated/blocked/evidence-submitted — "waiting on decision/verification". */
  waiting: Task[];
}

export function statusSummary(): StatusSummary {
  const tasks = Object.values(readGraph().tasks);
  const counts = Object.fromEntries(TASK_STATUSES.map((s) => [s, 0])) as Record<TaskStatus, number>;
  for (const t of tasks) counts[t.status] += 1;
  const waiting = tasks.filter((t) => WAITING_STATUSES.includes(t.status));
  return { counts, waiting };
}
