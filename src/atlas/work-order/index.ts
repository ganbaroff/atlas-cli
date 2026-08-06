/**
 * atlas/work-order/index.ts — public surface of the signed Work Order
 * envelope module (P1-A wave 1).
 *
 * This module only defines and validates the envelope itself: types, HMAC
 * signing/verification, durable replay protection, and the deterministic
 * validation gate. CLI wiring, courier/exec-graph integration, and the
 * handoff doc are explicitly out of scope for wave 1 (wave 2).
 */

export type {
  WorkOrder,
  SignedWorkOrder,
  WorkOrderIntegrity,
  WorkOrderValidationFailureReason,
  WorkOrderValidationVerdict,
} from './types.js';
export { WORK_ORDER_SIGNATURE_ALGORITHM } from './types.js';

export type {
  WorkOrderSigner,
  WorkOrderVerifier,
  WorkOrderSignatureCheck,
} from './sign.js';
export {
  WorkOrderSigningUnavailableError,
  canonicalizeWorkOrder,
  hmacSigner,
  hmacVerifier,
  getWorkOrderSigningKey,
  resolveWorkOrderSigner,
  resolveWorkOrderVerifier,
  signWorkOrder,
  checkWorkOrderSignature,
  verifyWorkOrderSignature,
} from './sign.js';

export type {
  WorkOrderReplayReason,
  WorkOrderReplayResult,
  WorkOrderReplayStore,
} from './replay.js';
export {
  createWorkOrderReplayStore,
  resolveWorkOrderReplayDir,
  createProductionWorkOrderReplayStore,
} from './replay.js';

export type {
  WorkOrderScopeCheckContext,
  WorkOrderValidationContext,
} from './validate.js';
export {
  CLOCK_SKEW_TOLERANCE_MS,
  checkWorkOrderScope,
  claimWorkOrder,
  validateWorkOrder,
} from './validate.js';

export type {
  RepoWriterLease,
  RepoWriterLeaseOwner,
  RepoWriterLeaseProcessIdentity,
  RepoWriterLeaseStaleRecoveryEvidence,
  RepoWriterLeaseRefusalReason,
  RepoWriterLeaseAcquireResult,
  RepoWriterLeaseReleaseResult,
  RepoWriterLeaseRecoveryResult,
  AcquireRepoWriterLeaseOptions,
  HeartbeatRepoWriterLeaseOptions,
  ReleaseRepoWriterLeaseOptions,
  RecoverStaleRepoWriterLeaseOptions,
} from './repo-writer-lock.js';
export {
  PROCESS_BOOT_TOKEN,
  REPO_WRITER_LEASE_DEFAULT_TTL_MS,
  canonicalizeRepoPath,
  resolveRepoWriterLeaseRootDir,
  acquireRepoWriterLease,
  heartbeatRepoWriterLease,
  releaseRepoWriterLease,
  recoverStaleRepoWriterLease,
  getRepoWriterLeaseInfo,
  clearRepoWriterLeaseForTests,
} from './repo-writer-lock.js';

export type {
  ExecutorGateFailureReason,
  ExecutorGateVerdict,
  ExecutorGateRequest,
} from './executor-gate.js';
export { runExecutorGate } from './executor-gate.js';
