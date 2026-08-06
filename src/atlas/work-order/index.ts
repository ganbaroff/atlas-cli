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

export type { WorkOrderValidationContext } from './validate.js';
export {
  CLOCK_SKEW_TOLERANCE_MS,
  validateWorkOrder,
} from './validate.js';
