/**
 * hands/exec-graph-adapter.ts — Hand Contract V0: the ONLY bridge into exec-graph.
 *
 * Purpose: the delegation-control layer over exec-graph — assign a Hand to
 * a task, accept a submitted receipt, and (the one load-bearing function)
 * verify that receipt and set the task's final state. Everything else in
 * src/hands/ (registry, contract, risk, verifier, refuter) is a pure
 * function or static config this module orchestrates; none of them touch
 * exec-graph state directly.
 *
 * Authority boundary (this is the whole point of this file): exec-graph
 * (src/exec-graph/*) stays the ONE machine execution authority. A Hand
 * never writes exec-graph state directly — every write path here goes
 * through exec-graph/api.js's existing `moveTask()` / `addEvidence()` /
 * `reassignOwner()`, the same primitives the CLI's `goal`/`task`/`graph`
 * commands already use. Nothing in ./registry.ts, ./contract.ts, ./risk.ts,
 * ./verifier.ts, or ./refuter.ts imports exec-graph/api.js — this module is
 * the only one that does (see src/__tests__/hands.test.ts's structural
 * test, which asserts exactly that by reading the source of each file).
 * `verifyAndTransition()` is THE ONLY place a delegated task's FINAL state
 * (verified/rejected) is set — enforced not just here but in
 * exec-graph/api.ts's `moveTask()` itself via an internal
 * `_viaHandAdapter` capability flag (see ADR-0006): a hand-owned task
 * cannot reach verified/rejected through the plain `task move` CLI/API path
 * at all, closing the sibling-CLI bypass an adversarial review found in V0's
 * first cut.
 *
 * Inputs/outputs: `assignHand(taskId, handId, opts) -> Task` (throws
 * HandContextError/HandAdapterError); `submitReceipt(taskId, receiptInput)
 * -> Task` (throws ReceiptSecretError/ReceiptTaskMismatchError/
 * HandAdapterError; idempotent by receiptHash — a duplicate submission is a
 * no-op); `abortHandTask(taskId, opts) -> Task`; `verifyAndTransition(taskId,
 * opts) -> VerifyAndTransitionResult`. All four operate on exec-graph task
 * ids and return the resulting `Task` (or verdict) — no other shape.
 *
 * State read/written: reads/writes `state/exec-graph/` exclusively through
 * exec-graph/api.js's exported functions (`getTask`, `moveTask`,
 * `addEvidence`, `reassignOwner`) — never touches `ledger.jsonl` /
 * `graph.json` directly. Writes no other state anywhere.
 *
 * Failure behavior: every public function throws a typed `HandsAdapterError`
 * subclass on an illegal call (unknown task, wrong status for the
 * operation, unknown/disallowed hand, secret-shaped receipt, taskId
 * mismatch) — never silently no-ops except the documented
 * receiptHash-idempotency case in `submitReceipt()`. `abortHandTask()` only
 * ever moves a task to 'blocked', never to 'verified' — a hand that stops
 * responding must never be read as having succeeded.
 *
 * Security: receipts are secret-scanned (`assertReceiptHasNoSecrets()`,
 * SECRET_SHAPE_PATTERNS) BEFORE `submitReceipt()` persists anything —
 * append-only means a leaked secret in the ledger is permanent, so the
 * guard must run pre-write, not post-hoc. RISK CLASSIFICATION AT VERIFY
 * TIME: V0 does not persist a DelegationBrief as new exec-graph state (that
 * would be a second queue — forbidden). A task's riskClass for
 * refuter-triggering purposes is instead RE-DERIVED at
 * `verifyAndTransition()` time from the task's own title (as `objective`)
 * and the assigned hand's registry `allowedActions` (as `allowedActions`)
 * — both already-canonical, already-durable data (exec-graph's Task +
 * hands' static REGISTRY). See ./registry.ts's module doc for why this
 * makes 'sonnet-foreground' delegations always at least 'data-mutation'
 * risk.
 *
 * Tests: src/__tests__/hands.test.ts — full assign/submit/verify/abort
 * lifecycle, idempotent resubmission, describe block 6 (structural
 * exec-graph-import boundary), block 10 (refuter triggering per
 * riskClass), block 16 (HandAuthorityError — the sibling-CLI-bypass
 * regression), block 17 (secret-guard regression, receipts never reach the
 * verifier or ledger with secret-shaped content).
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

/** submitReceipt() refused a receipt whose free-text fields contain secret-shaped content. */
export class ReceiptSecretError extends HandsAdapterError {}

/** submitReceipt() refused a receipt whose taskId does not match the task it was submitted to. */
export class ReceiptTaskMismatchError extends HandsAdapterError {}

const HAND_OWNER_PREFIX = 'hand:';

// ── Secret-shaped content guard (receipt free-text fields never carry a secret) ──

/**
 * Small, deterministic pattern set for "this looks like a live credential",
 * not a general secret scanner — cheap, fast, no false-negative tolerance
 * for the common shapes (OpenAI-style sk-, GitHub PAT, AWS access key, PEM
 * private key header, Slack token, generic key=value/bearer, Telegram bot
 * token). A match means REJECT the receipt outright — a secret that reached
 * a receipt means the hand already mishandled it; scrubbing would hide that.
 */
const SECRET_SHAPE_PATTERNS: readonly RegExp[] = [
  /sk-[A-Za-z0-9]{16,}/,
  /ghp_[A-Za-z0-9]{20,}/,
  /AKIA[0-9A-Z]{16}/,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /xox[baprs]-[A-Za-z0-9-]+/,
  /(api[_-]?key|password|secret|token|bearer)\s*[:=]\s*\S{8,}/i,
  /\d{8,10}:[A-Za-z0-9_-]{30,}/,
];

function containsSecretShape(value: string): boolean {
  return SECRET_SHAPE_PATTERNS.some((re) => re.test(value));
}

/**
 * Scans every free-text field a Receipt carries. Throws ReceiptSecretError
 * on the first match — called BEFORE submitReceipt() persists anything
 * (evidence entry or transition), so a secret-shaped receipt never touches
 * the ledger.
 */
function assertReceiptHasNoSecrets(receipt: Receipt): void {
  const fields: (string | undefined)[] = [
    receipt.claimedResult,
    receipt.expectedSubstring,
    receipt.command,
    receipt.ref,
    ...(receipt.artifacts ?? []),
  ];
  for (const field of fields) {
    if (field && containsSecretShape(field)) {
      throw new ReceiptSecretError(
        'receipt rejected: contains secret-shaped content; secrets must never enter the ledger',
      );
    }
  }
}

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
    _viaHandAdapter: true,
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

  if (receipt.taskId !== taskId) {
    throw new ReceiptTaskMismatchError(
      `hands: receipt.taskId (${receipt.taskId}) does not match the task it is being submitted to (${taskId})`,
    );
  }
  assertReceiptHasNoSecrets(receipt);

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
    const moved = moveTask({
      taskId,
      to: 'rejected',
      actor: opts.actor,
      note: 'no receipt evidence found to verify',
      _viaHandAdapter: true,
    });
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
      _viaHandAdapter: true,
    });
    return { finalStatus: moved.status, verdict: { verified: true, reason: primary.reason, refuter: refuterResult } };
  }

  const rejectionReason = !primary.verified ? primary.reason : `refuter disagreement: ${refuterResult.reason}`;
  const moved = moveTask({
    taskId,
    to: 'rejected',
    actor: opts.actor,
    note: `rejected: ${rejectionReason}`,
    _viaHandAdapter: true,
  });
  return { finalStatus: moved.status, verdict: { verified: false, reason: rejectionReason, refuter: refuterResult } };
}
