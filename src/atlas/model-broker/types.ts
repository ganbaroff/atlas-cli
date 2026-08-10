/**
 * atlas/model-broker/types.ts — C5A: types for the local model-call broker.
 *
 * The model broker sits between Hermes and the real upstream model API. It
 * is NOT a second authorization system: authorize.ts reuses the Work Order
 * signature primitive (work-order/sign.ts) and the Work Order replay/nonce
 * store (work-order/replay.ts) that already gate repo mutations, and adds
 * only a model-scope check (provider/model/operation) on top. Repo Work
 * Orders (work-order/types.ts's WorkOrder) authorize filesystem mutations
 * inside a worktree; ModelWorkOrder below authorizes exactly one upstream
 * model call — a different subject, same signing/replay discipline, so it
 * is a distinct envelope shape rather than an abuse of WorkOrder's
 * repo-specific fields (repoCanonicalPath, baseHead, worktreePath, ...)
 * which have no meaning here. See work-order/executor-gate.ts for the
 * mutation-side counterpart this module deliberately does NOT reuse
 * (runExecutorGate checks repo HEAD / writer lease — not applicable to a
 * model call).
 */

import type { WorkOrderIntegrity } from '../work-order/types.js';

/** One machine-readable deny code per authorize.ts / server.ts refusal class. */
export type BrokerDenyReason =
  | 'missing_authorization'
  | 'malformed_authorization'
  | 'invalid_signature'
  | 'expired'
  | 'expiry_malformed'
  | 'missing_request_id'
  | 'request_id_mismatch'
  | 'replayed'
  | 'provider_mismatch'
  | 'model_mismatch'
  | 'unknown_operation'
  | 'upstream_not_loopback'
  | 'upstream_unavailable'
  | 'upstream_bad_response'
  | 'upstream_redirect';

/**
 * The authorization envelope Hermes must present (base64-JSON in the
 * `x-atlas-work-order` header) to place exactly one upstream model call.
 * Carries work-order/sign.ts's own WorkOrderIntegrity shape ({algorithm,
 * signature}) rather than inventing a second signature field — signing and
 * verification are reused unchanged from sign.ts (see authorize.ts).
 */
export interface ModelWorkOrder {
  readonly workOrderId: string;
  readonly nonce: string;
  /** ISO-8601 instant. */
  readonly issuedAt: string;
  /** ISO-8601 instant. */
  readonly expiresAt: string;
  readonly provider: string;
  readonly model: string;
  readonly operation: 'chat.completions';
  readonly requestId: string;
  readonly integrity: WorkOrderIntegrity;
}

/** The one thing this broker ever produces: an ALLOW/DENY verdict plus its receipt metadata. */
export interface BrokerDecision {
  readonly decision: 'ALLOW' | 'DENY';
  readonly reason?: BrokerDenyReason;
  readonly brokerRequestId: string;
  readonly workOrderId: string | null;
  readonly workOrderHash: string | null;
  readonly provider: string | null;
  readonly model: string | null;
  readonly upstreamClass: 'local_mock';
  readonly status: number;
  readonly latencyMs: number;
}

export interface BrokerConfig {
  readonly host: '127.0.0.1' | '::1';
  readonly port: number;
  readonly upstreamUrl: string;
  readonly approvedProvider: string;
  readonly approvedModel: string;
  readonly mode: 'C5A_MOCK_ONLY';
}
