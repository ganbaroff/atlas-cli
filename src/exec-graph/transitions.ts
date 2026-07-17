/**
 * exec-graph/transitions.ts — the 11-state task lifecycle: legal-edge table +
 * a pure state-transition function.
 *
 * LEGAL_TRANSITIONS below is the literal state machine. Two blanket rules
 * layered on top of the explicit table, both taken directly from the EB-0
 * spec:
 *   1. "Any status -> escalated is legal" — every NON-terminal status can
 *      escalate, including 'verified' and 'rejected' (which have no other
 *      listed exits besides 'closed'/'proposed'). This is why VERIFIED_EXTRA
 *      and REJECTED_EXTRA below add 'escalated' on top of their otherwise
 *      narrow edges.
 *   2. "closed = terminal (no exits)" — this is a stated OVERRIDE of rule 1,
 *      not an omission: 'closed' has zero outgoing edges, escalated included.
 *
 * Exiting 'escalated' is further gated by ACTOR, not just by status: only
 * 'ceo' or 'external-cto' may move a task OUT of escalated (an autonomous
 * actor cannot un-escalate its own escalation).
 *
 * applyTransition() is pure — it takes a Task and returns a NEW Task, it
 * never touches the ledger. Callers that need the transition persisted go
 * through exec-graph/api.ts's moveTask(), which calls this and then appends
 * the resulting Transition to the ledger.
 */

import {
  type Task,
  type TaskStatus,
  type Transition,
  taskSchema,
  transitionSchema,
} from './contracts.js';

export class ExecGraphTransitionError extends Error {}

/** `to` is not a legal edge from the task's current status. */
export class IllegalTransitionError extends ExecGraphTransitionError {}

/** Exiting 'escalated' with an actor other than 'ceo'/'external-cto'. */
export class UnauthorizedTransitionError extends ExecGraphTransitionError {}

/** The transition or the resulting task fails schema invariants (e.g. missing evidenceRefs/evidence). */
export class InvalidTransitionError extends ExecGraphTransitionError {}

export const LEGAL_TRANSITIONS: Readonly<Record<TaskStatus, readonly TaskStatus[]>> = Object.freeze({
  proposed: ['accepted', 'rejected', 'escalated'],
  accepted: ['planned', 'escalated'],
  planned: ['delegated', 'in-progress', 'escalated'],
  delegated: ['in-progress', 'blocked', 'escalated'],
  'in-progress': ['blocked', 'evidence-submitted', 'escalated'],
  blocked: ['in-progress', 'rejected', 'escalated'],
  'evidence-submitted': ['verified', 'rejected', 'escalated'],
  // "Any status -> escalated is legal" (rule 1 above) — verified/rejected
  // have no other listed exits, so 'escalated' is the only addition here.
  verified: ['closed', 'escalated'],
  rejected: ['closed', 'proposed', 'escalated'],
  // Exit set is structural here; WHO may take these exits is gated separately
  // below (only 'ceo' / 'external-cto').
  escalated: ['accepted', 'rejected', 'blocked', 'in-progress'],
  // Terminal — explicit override of rule 1: zero exits, including escalated.
  closed: [],
});

const ESCALATION_EXIT_ACTORS = new Set(['ceo', 'external-cto']);

export interface ApplyTransitionOptions {
  actor: string;
  ts: string;
  evidenceRefs?: string[];
  note?: string;
}

/**
 * Pure state transition: validates the edge is legal, validates the actor is
 * authorized (escalated exits only), builds + validates the new Transition,
 * appends it, and validates the resulting Task's cross-field invariants
 * (verified/closed requires evidence). Returns a NEW Task — never mutates
 * the input.
 */
export function applyTransition(task: Task, to: TaskStatus, opts: ApplyTransitionOptions): Task {
  const { actor, ts, evidenceRefs, note } = opts;

  if (!actor || !actor.trim()) {
    throw new InvalidTransitionError('actor is required and must be non-empty');
  }

  const from = task.status;
  const allowed = LEGAL_TRANSITIONS[from] ?? [];
  if (!allowed.includes(to)) {
    throw new IllegalTransitionError(
      `illegal transition '${from}' -> '${to}' for task ${task.id}${from === 'closed' ? ' (closed is terminal)' : ''}`,
    );
  }

  if (from === 'escalated' && !ESCALATION_EXIT_ACTORS.has(actor)) {
    throw new UnauthorizedTransitionError(
      `only 'ceo' or 'external-cto' may transition task ${task.id} out of 'escalated' (got actor='${actor}')`,
    );
  }

  const candidateTransition = { from, to, ts, actor, evidenceRefs, note };
  const parsedTransition = safeParseTransition(candidateTransition);

  const nextTask: Task = {
    ...task,
    status: to,
    transitions: [...task.transitions, parsedTransition],
  };

  return safeParseTask(nextTask);
}

function safeParseTransition(candidate: unknown): Transition {
  const result = transitionSchema.safeParse(candidate);
  if (!result.success) {
    throw new InvalidTransitionError(`invalid transition: ${result.error.issues.map((i) => i.message).join('; ')}`);
  }
  return result.data;
}

function safeParseTask(candidate: unknown): Task {
  const result = taskSchema.safeParse(candidate);
  if (!result.success) {
    throw new InvalidTransitionError(`invalid resulting task: ${result.error.issues.map((i) => i.message).join('; ')}`);
  }
  return result.data;
}
