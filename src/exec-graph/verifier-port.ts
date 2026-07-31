/**
 * exec-graph/verifier-port.ts — privileged move/reassign for the verifier path ONLY.
 *
 * This module provides moveTaskAsVerifier() and reassignOwnerAsVerifier():
 * the ONLY code paths that can transition a task to 'verified'/'rejected' or
 * assign 'hand:' ownership. The public api.ts surface (moveTask, reassignOwner)
 * ALWAYS rejects these operations — there is no boolean escape hatch.
 *
 * IMPORT RESTRICTION: only src/hands/exec-graph-adapter.ts may import this
 * module. Goal-runner, CLI, and all other callers use api.ts's public surface.
 * Structural tests enforce this boundary (see goal-runner.test.ts).
 *
 * TRANSACTION NOTE: each function below is a single withExecGraphMutation()
 * call (ledger.ts). Evidence-promotion events are built inline instead of
 * calling api.ts's addEvidence() — the lock is not reentrant, so calling
 * another withExecGraphMutation()-based function from inside a transaction
 * would deadlock.
 */

import { withExecGraphMutation } from './ledger.js';
import { applyTransition } from './transitions.js';
import type { Evidence, NewLedgerEvent, Task, TaskStatus } from './contracts.js';

function nowIso(): string {
  return new Date().toISOString();
}

// ── Privileged move (verified/rejected allowed) ─────────────────────────

export interface MoveTaskVerifierInput {
  taskId: string;
  to: TaskStatus;
  actor: string;
  ts?: string;
  evidenceRefs?: string[];
  note?: string;
}

/**
 * Move a task to any status including 'verified'/'rejected'. This is the
 * verifier-only capability port — it bypasses the HandAuthorityError guard
 * in api.ts's moveTask() because it IS the verifier path.
 *
 * Logic is identical to api.ts's moveTask minus the authority guard.
 */
export function moveTaskAsVerifier(input: MoveTaskVerifierInput): Task {
  const ts = input.ts ?? nowIso();

  const { value: nextTask } = withExecGraphMutation((snapshot) => {
    let task = snapshot.tasks[input.taskId];
    if (!task) {
      throw new Error(`exec-graph: unknown task ${input.taskId}`);
    }

    const events: NewLedgerEvent[] = [];

    // Same evidence-promotion logic as api.ts's moveTask: evidenceRefs on
    // the move become real Evidence entries, satisfying task-level invariants.
    if (input.evidenceRefs && input.evidenceRefs.length > 0) {
      for (const ref of input.evidenceRefs) {
        const evidence: Evidence = { ref, kind: 'other' };
        events.push({ kind: 'evidence-added', ts, actor: input.actor, payload: { taskId: task.id, evidence } });
        task = { ...task, evidence: [...task.evidence, evidence] };
      }
    }

    const nextTask = applyTransition(task, input.to, {
      actor: input.actor,
      ts,
      evidenceRefs: input.evidenceRefs,
      note: input.note,
    });

    const newTransition = nextTask.transitions[nextTask.transitions.length - 1];
    events.push({ kind: 'transition', ts, actor: input.actor, payload: { taskId: task.id, transition: newTransition } });

    return { events, value: nextTask };
  });

  return nextTask;
}

// ── Privileged reassign (hand: prefix allowed) ──────────────────────────

export interface ReassignOwnerVerifierOpts {
  actor: string;
  reason: string;
  ts?: string;
}

/**
 * Reassign a task's owner, including 'hand:' prefixed owners. This is the
 * verifier-only capability port — it bypasses the HandAuthorityError guard
 * in api.ts's reassignOwner() because it IS the hand-assignment path.
 *
 * Logic is identical to api.ts's reassignOwner minus the authority guard.
 */
export function reassignOwnerAsVerifier(taskId: string, newOwner: string, opts: ReassignOwnerVerifierOpts): Task {
  const { actor, reason } = opts;
  if (!newOwner || !newOwner.trim()) {
    throw new Error('newOwner is required and must be non-empty');
  }
  if (!actor || !actor.trim()) {
    throw new Error('actor is required and must be non-empty');
  }
  if (!reason || !reason.trim()) {
    throw new Error('reason is required and must be non-empty');
  }

  const ts = opts.ts ?? nowIso();

  const { value: nextTask } = withExecGraphMutation((snapshot) => {
    const task = snapshot.tasks[taskId];
    if (!task) {
      throw new Error(`exec-graph: unknown task ${taskId}`);
    }
    const from = task.owner;
    const nextTask: Task = { ...task, owner: newOwner };
    const events: NewLedgerEvent[] = [
      { kind: 'owner-reassigned', ts, actor, payload: { taskId, from, to: newOwner, actor, reason, ts } },
    ];
    return { events, value: nextTask };
  });

  return nextTask;
}
