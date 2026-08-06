/**
 * atlas/work-order/types.ts — the signed Work Order envelope (P1-A wave 1).
 *
 * A Work Order is an authorization envelope BENEATH exec-graph authority: it
 * proves a specific executor is allowed to touch a specific worktree, at a
 * specific base HEAD, within specific path/action/command bounds, for a
 * bounded number of attempts and a bounded wall-clock budget. It is not a
 * second task graph, planner, memory, or verifier — exec-graph remains the
 * one task authority; a Work Order only fences what an already-claimed task
 * may do.
 *
 * Types only here (per the wave-1 envelope) — see sign.ts (signing and
 * verification), replay.ts (durable one-time-use protection), validate.ts
 * (the deterministic verdict gate that ties all of it together).
 *
 * Illegal states kept unrepresentable at the type level: every field is
 * `readonly` (a WorkOrder is a value, not a mutable record), the integrity
 * block only exists on SignedWorkOrder (an unsigned envelope cannot be
 * mistaken for a signed one at compile time), and the signature algorithm is
 * a single literal (there is exactly one supported algorithm — widening it
 * to a general string would let a caller silently claim an unimplemented
 * one).
 */

export const WORK_ORDER_SIGNATURE_ALGORITHM = 'HMAC-SHA256' as const;

/**
 * The Work Order envelope. Every field here is part of the signed payload
 * (see sign.ts's canonicalizeWorkOrder) — nothing on this type is optional
 * or mutable after issuance.
 */
export interface WorkOrder {
  readonly workOrderId: string;
  readonly goalId: string;
  readonly taskId: string;
  readonly issuerIdentity: string;
  readonly executorIdentity: string;
  readonly repoCanonicalPath: string;
  readonly baseBranch: string;
  readonly baseHead: string;
  readonly worktreePath: string;
  /** ISO-8601 instant. */
  readonly issuedAt: string;
  /** ISO-8601 instant. */
  readonly expiresAt: string;
  readonly nonce: string;
  /** Glob patterns (see validate.ts's minimal matcher) a claimed action's path must match at least one of. */
  readonly allowedPaths: readonly string[];
  /** Glob patterns that always lose to allowedPaths — a forbidden match is refused even inside scope. */
  readonly forbiddenPaths: readonly string[];
  readonly forbiddenActions: readonly string[];
  readonly allowedCommandClasses: readonly string[];
  readonly maxAttempts: number;
  readonly maxWallClockMs: number;
  readonly expectedTests: readonly string[];
  readonly evidenceRequirements: readonly string[];
  readonly rollbackMethod: string;
}

export interface WorkOrderIntegrity {
  readonly algorithm: typeof WORK_ORDER_SIGNATURE_ALGORITHM;
  readonly signature: string;
}

/** A WorkOrder plus its signature. sign.ts freezes this at construction. */
export interface SignedWorkOrder extends WorkOrder {
  readonly integrity: WorkOrderIntegrity;
}

/** One machine-readable refusal code per validate.ts failure class. */
export type WorkOrderValidationFailureReason =
  | 'signature_missing'
  | 'signature_invalid'
  | 'expired'
  | 'future_dated'
  | 'nonce_replayed'
  | 'work_order_id_replayed'
  | 'wrong_executor_identity'
  | 'wrong_repository'
  | 'base_head_mismatch'
  | 'path_out_of_scope'
  | 'path_forbidden'
  | 'action_forbidden'
  | 'command_class_forbidden'
  | 'attempts_exhausted'
  | 'wall_clock_exhausted';

export type WorkOrderValidationVerdict =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: WorkOrderValidationFailureReason };
