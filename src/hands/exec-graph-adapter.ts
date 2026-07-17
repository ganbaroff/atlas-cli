/**
 * hands/exec-graph-adapter.ts — Hand Contract V0: the ONLY bridge into exec-graph.
 *
 * AUTHORITY BOUNDARY (this is the whole point of this file): exec-graph
 * (src/exec-graph/*) stays the ONE machine execution authority. A Hand never
 * writes exec-graph state directly — every write path here goes through
 * exec-graph/api.js's existing moveTask() / addEvidence() / reassignOwner(),
 * the same primitives the CLI's `goal`/`task`/`graph` commands already use.
 * Nothing in ./registry.ts, ./contract.ts, ./risk.ts, ./verifier.ts, or
 * ./refuter.ts imports exec-graph/api.js — this module is the only one that
 * does (see src/__tests__/hands.test.ts's structural test, which asserts
 * exactly that by reading the source of each file).
 *
 * verifyAndTransition() is THE ONLY place a delegated task's FINAL state
 * (verified/rejected) is set. assignHand()/submitReceipt() move a task
 * forward (delegated, evidence-submitted) but never resolve it; abortHandTask
 * moves a stuck task sideways to 'blocked', also never resolving it.
 *
 * RISK CLASSIFICATION AT VERIFY TIME: V0 does not persist a DelegationBrief
 * as new exec-graph state (that would be a second queue — forbidden). A
 * task's riskClass for refuter-triggering purposes is instead RE-DERIVED at
 * verifyAndTransition() time from the task's own title (as `objective`) and
 * the assigned hand's registry allowedActions (as `allowedActions`) — both
 * already-canonical, already-durable data (exec-graph's Task + hands'
 * static REGISTRY). See ./registry.ts's module doc for why this makes
 * 'sonnet-foreground' delegations always at least 'data-mutation' risk.
 */

import type { Task, Evidence, TaskStatus } from '../exec-graph/contracts.js';
import { getTask, moveTask, addEvidence, reassignOwner } from '../exec-graph/api.js';
import { getHand, type HandSpec } from './registry.js';
import { classifyRisk } from './risk.js';
import { runRefuter, type RefuterResult } from './refuter.js';
import { verify } from './verifier.js';
import { receiptSchema, receiptHash, type Receipt } from './contract.js';

export class HandsAdapterError extends Error {}

/** assignHand() denied by autonomy/allowlist context, or an existing active delegation. */
export class HandContextError extends HandsAdapterError {}

/** Unknown task, illegal call for the task's current status, or malformed receipt evidence. */
export class HandAdapterError extends HandsAdapterError {}

const HAND_OWNER_PREFIX = 'hand:';

// ── Context gate ─────────────────────────────────────────────────────────

export interface HandContext {
  /** True when the caller is running unattended (no human foreground session watching). */
  unattended?: boolean;
  /** Actions this delegation would need the hand to perform. Omit to skip the allowlist check. */
  actions?: string[];
}

/**
 * Throws HandContextError if:
 *  - unattended is true AND the hand's autonomy is 'foreground-only'
 *    (a Claude/CEO-supervised hand may never run unattended), OR
 *  - any requested action is outside the hand's allowedActions.
 * Never mutates anything — pure gate.
 */
export function assertHandAllowedInContext(hand: HandSpec, ctx: HandContext): void {
  if (ctx.unattended && hand.autonomy === 'foreground-only') {
    throw new HandContextError(
      `hands: '${hand.handId}' is foreground-only and cannot be assigned in an unattended context`,
    );
  }
  if (ctx.actions) {
    const disallowed = ctx.actions.filter((action) => !hand.allowedActions.includes(action));
    if (disallowed.length > 0) {
      throw new HandContextError(
        `hands: '${hand.handId}' does not allow action(s): ${disallowed.join(', ')}`,
      );
    }
  }
}

function isActiveHandOwner(task: Task): boolean {
  return task.owner.startsWith(HAND_OWNER_PREFIX) && (task.status === 'delegated' || task.status === 'in-progress');
}

// ── Assign ───────────────────────────────────────────────────────────────

export interface AssignHandOptions {
  actor: string;
  unattended?: boolean;
}

/**
 * Assign `handId` to `taskId`: validates the hand exists and is allowed in
 * this context, rejects if the task already has an active delegated hand,
 * else moves the task -> 'delegated' and reassigns owner -> `hand:<handId>`.
 */
export function assignHand(taskId: string, handId: string, opts: AssignHandOptions): Task {
  const hand = getHand(handId);
  assertHandAllowedInContext(hand, { unattended: opts.unattended ?? false });

  const task = getTask(taskId);
  if (!task) {
    throw new HandAdapterError(`hands: unknown task ${taskId}`);
  }
  if (isActiveHandOwner(task)) {
    throw new HandContextError(
      `hands: task ${taskId} already has an active delegated hand (owner=${task.owner}, status=${task.status})`,
    );
  }

  moveTask({ taskId, to: 'delegated', actor: opts.actor, note: `assigned to hand:${handId}` });
  return reassignOwner(taskId, `${HAND_OWNER_PREFIX}${handId}`, {
    actor: opts.actor,
    reason: `assigned to hand ${handId}`,
  });
}

// ── Submit receipt ───────────────────────────────────────────────────────

function findLatestReceiptEvidence(task: Task): Evidence | undefined {
  for (let i = task.evidence.length - 1; i >= 0; i--) {
    if (task.evidence[i].kind === 'tool-receipt') return task.evidence[i];
  }
  return undefined;
}

function parseReceiptFromEvidenceNote(evidence: Evidence): Receipt {
  if (!evidence.note) {
    throw new HandAdapterError('hands: receipt evidence is missing its note payload');
  }
  let raw: unknown;
  try {
    raw = JSON.parse(evidence.note);
  } catch (err) {
    throw new HandAdapterError(
      `hands: receipt evidence note is not valid JSON: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  return receiptSchema.parse(raw);
}

/**
 * Record a Receipt as evidence and move the task forward to
 * 'evidence-submitted'. Idempotent by receiptHash(): resubmitting an
 * identical receipt is a no-op (returns the current task unchanged, no
 * second evidence entry, no second transition).
 *
 * NEVER sets 'verified'/'rejected' — only verifyAndTransition() does that.
 */
export function submitReceipt(taskId: string, receiptInput: unknown): Task {
  const receipt = receiptSchema.parse(receiptInput);

  const task = getTask(taskId);
  if (!task) {
    throw new HandAdapterError(`hands: unknown task ${taskId}`);
  }

  const hash = receiptHash(receipt);
  const alreadySubmitted = task.evidence.some((e) => e.kind === 'tool-receipt' && e.ref === hash);
  if (alreadySubmitted) {
    return task;
  }

  let current = task;
  if (current.status === 'delegated') {
    current = moveTask({
      taskId,
      to: 'in-progress',
      actor: receipt.submittedBy,
      note: 'receipt submission requires in-progress',
    });
  }

  addEvidence({
    taskId,
    evidence: { ref: hash, kind: 'tool-receipt', note: JSON.stringify(receipt) },
    actor: receipt.submittedBy,
  });

  return moveTask({
    taskId,
    to: 'evidence-submitted',
    actor: receipt.submittedBy,
    evidenceRefs: [hash],
    note: `receipt kind=${receipt.kind}`,
  });
}

// ── Abort (timeout / interrupt path — never resolves the task) ────────────

export interface AbortHandTaskOptions {
  actor: string;
  reason: string;
}

/**
 * Move a stuck delegated/in-progress task sideways to 'blocked'. This is the
 * timeout/abort path: it NEVER sets 'verified' — a hand that stops
 * responding must never be read as having succeeded.
 */
export function abortHandTask(taskId: string, opts: AbortHandTaskOptions): Task {
  const task = getTask(taskId);
  if (!task) {
    throw new HandAdapterError(`hands: unknown task ${taskId}`);
  }
  if (task.status !== 'delegated' && task.status !== 'in-progress') {
    throw new HandAdapterError(
      `hands: abortHandTask requires status 'delegated' or 'in-progress' (task ${taskId} is '${task.status}')`,
    );
  }
  return moveTask({ taskId, to: 'blocked', actor: opts.actor, note: `hand task aborted: ${opts.reason}` });
}

// ── Verify + transition (the ONLY place final state is set) ───────────────

export interface VerifyAndTransitionOptions {
  actor: string;
}

export interface VerifyAndTransitionResult {
  finalStatus: TaskStatus;
  verdict: {
    verified: boolean;
    reason: string;
    refuter: RefuterResult;
  };
}

function deriveHandAllowedActions(task: Task): string[] {
  if (!task.owner.startsWith(HAND_OWNER_PREFIX)) return [];
  const handId = task.owner.slice(HAND_OWNER_PREFIX.length);
  try {
    return getHand(handId).allowedActions;
  } catch {
    return [];
  }
}

/**
 * Load the latest submitted receipt evidence, run the deterministic
 * verifier (+ refuter when risk warrants), and set the task's FINAL state:
 * 'verified' if the primary verdict is true AND (the refuter didn't trigger
 * OR it agreed), else 'rejected' with a machine-readable reason. This is the
 * ONLY function in this module (or anywhere in src/hands/) that transitions
 * a task to 'verified' or 'rejected'.
 */
export function verifyAndTransition(taskId: string, opts: VerifyAndTransitionOptions): VerifyAndTransitionResult {
  const task = getTask(taskId);
  if (!task) {
    throw new HandAdapterError(`hands: unknown task ${taskId}`);
  }
  if (task.status !== 'evidence-submitted') {
    throw new HandAdapterError(
      `hands: verifyAndTransition requires status 'evidence-submitted' (task ${taskId} is '${task.status}') — `
      + 'a rejected/verified/closed task needs fresh evidence via submitReceipt(), not a re-verify',
    );
  }

  const receiptEvidence = findLatestReceiptEvidence(task);
  if (!receiptEvidence) {
    const moved = moveTask({ taskId, to: 'rejected', actor: opts.actor, note: 'no receipt evidence found to verify' });
    return {
      finalStatus: moved.status,
      verdict: {
        verified: false,
        reason: 'no receipt evidence found to verify',
        refuter: { triggered: false, passed: true, reason: 'not evaluated — no receipt' },
      },
    };
  }

  const receipt = parseReceiptFromEvidenceNote(receiptEvidence);
  const primary = verify(receipt);

  const riskClass = classifyRisk({ objective: task.title, allowedActions: deriveHandAllowedActions(task) });
  const refuterResult = runRefuter({ riskClass }, receipt, primary.verified);

  const finalVerified = primary.verified && (!refuterResult.triggered || refuterResult.passed);

  if (finalVerified) {
    const moved = moveTask({
      taskId,
      to: 'verified',
      actor: opts.actor,
      evidenceRefs: [receiptEvidence.ref],
      note: `verified: ${primary.reason}`,
    });
    return { finalStatus: moved.status, verdict: { verified: true, reason: primary.reason, refuter: refuterResult } };
  }

  const rejectionReason = !primary.verified ? primary.reason : `refuter disagreement: ${refuterResult.reason}`;
  const moved = moveTask({ taskId, to: 'rejected', actor: opts.actor, note: `rejected: ${rejectionReason}` });
  return { finalStatus: moved.status, verdict: { verified: false, reason: rejectionReason, refuter: refuterResult } };
}
