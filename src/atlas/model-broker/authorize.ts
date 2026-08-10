/**
 * atlas/model-broker/authorize.ts — C5A model-call authorization.
 *
 * Reuses two existing primitives unchanged rather than inventing a second
 * authorization system:
 *  - work-order/sign.ts's checkWorkOrderSignature (HMAC-SHA256 verify,
 *    fail-closed) — see checkModelWorkOrderSignature below for why a
 *    narrow, explained cast is needed to apply it to ModelWorkOrder.
 *  - work-order/replay.ts's WorkOrderReplayStore.consumeIfFresh — the same
 *    durable one-shot (id, nonce) claim gate repo Work Orders use.
 * runExecutorGate (work-order/executor-gate.ts) is deliberately NOT reused
 * here — it checks repo HEAD/worktree reality and a RepoWriterLease, none
 * of which apply to a model call; only the signature + replay primitives
 * it itself is built from are reused, plus a model-scope check on top.
 *
 * Ordering discipline mirrors work-order/executor-gate.ts exactly: every
 * check that does NOT mutate state runs first (signature, shape, provider,
 * model, operation); the one-shot replay claim runs LAST, only once every
 * other check has already passed, so a request that would be denied for an
 * unrelated reason never burns the envelope's single accept token.
 */

import { checkWorkOrderSignature, type WorkOrderVerifier } from '../work-order/sign.js';
import type { SignedWorkOrder } from '../work-order/types.js';
import type { WorkOrderReplayStore } from '../work-order/replay.js';
import { hashPayload } from '../../evidence/ledger.js';
import type { BrokerConfig, BrokerDecision, BrokerDenyReason, ModelWorkOrder } from './types.js';

/** authorizeModelRequest's result before server.ts fills in the two HTTP-layer fields (status, latencyMs). */
export type AuthorizationOutcome = Omit<BrokerDecision, 'status' | 'latencyMs'>;

export interface AuthorizeModelRequestInput {
  /** Raw `x-atlas-work-order` header value (base64-encoded JSON ModelWorkOrder), or undefined if absent. */
  readonly authorizationHeader: string | undefined;
  /** Parsed JSON request body — must carry a `model` field that also matches the authorized model. */
  readonly requestBody: unknown;
  readonly config: BrokerConfig;
  readonly replayStore: WorkOrderReplayStore;
  /** Correlation id for this HTTP request (from `x-atlas-request-id`, or server-generated). */
  readonly brokerRequestId: string;
  /** Injectable for tests; undefined defers to checkWorkOrderSignature's own env-key-backed default (fails closed when unset). */
  readonly verifier?: WorkOrderVerifier;
  /** Raw `x-atlas-request-id` header value, read separately from brokerRequestId (which may be server-generated) — C5A-R3 binds this to the signed envelope's own requestId. */
  readonly liveRequestId: string | undefined;
  /** Injectable clock for expiry evaluation (C5A-R2); defaults to Date.now. No sleeps anywhere. */
  readonly now?: () => number;
}

/** ISO-8601 instant with an explicit UTC designator or numeric offset — never a locale-formatted string. */
const ISO_8601_WITH_OFFSET = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

/**
 * ModelWorkOrder does not — and should not — extend work-order/types.ts's
 * WorkOrder: it authorizes one upstream model call, not a repo mutation, so
 * it carries none of WorkOrder's repo-specific fields. sign.ts's
 * checkWorkOrderSignature is nonetheless directly reusable: internally it
 * only destructures off `integrity` and canonicalizes whatever fields
 * remain via a sorted-key JSON stringify (sign.ts's canonicalizeWorkOrder /
 * stableStringify), which is content-agnostic — it works over any plain
 * object carrying an `integrity: WorkOrderIntegrity` field, not only a
 * WorkOrder. The cast below crosses that static type boundary WITHOUT
 * reimplementing or weakening the HMAC verification itself.
 */
function checkModelWorkOrderSignature(order: ModelWorkOrder, verifier: WorkOrderVerifier | undefined) {
  return checkWorkOrderSignature(order as unknown as SignedWorkOrder, verifier);
}

/** Decode+parse the base64-JSON envelope; returns null on ANY malformed input (never throws). */
function parseModelWorkOrderEnvelope(headerValue: string): ModelWorkOrder | null {
  let json: unknown;
  try {
    const raw = Buffer.from(headerValue, 'base64').toString('utf8');
    json = JSON.parse(raw);
  } catch {
    return null;
  }
  if (json === null || typeof json !== 'object' || Array.isArray(json)) return null;
  const o = json as Record<string, unknown>;
  const integrity = o.integrity;
  const integrityValid = (
    integrity !== null
    && typeof integrity === 'object'
    && !Array.isArray(integrity)
    && isNonEmptyString((integrity as Record<string, unknown>).algorithm)
    && isNonEmptyString((integrity as Record<string, unknown>).signature)
  );
  if (
    !isNonEmptyString(o.workOrderId)
    || !isNonEmptyString(o.nonce)
    || !isNonEmptyString(o.issuedAt)
    || !isNonEmptyString(o.expiresAt)
    || !isNonEmptyString(o.provider)
    || !isNonEmptyString(o.model)
    || !isNonEmptyString(o.operation)
    || !isNonEmptyString(o.requestId)
    || !integrityValid
  ) {
    return null;
  }
  return {
    workOrderId: o.workOrderId,
    nonce: o.nonce,
    issuedAt: o.issuedAt,
    expiresAt: o.expiresAt,
    provider: o.provider,
    model: o.model,
    operation: o.operation as ModelWorkOrder['operation'],
    requestId: o.requestId,
    integrity: integrity as ModelWorkOrder['integrity'],
  };
}

function extractBodyModel(requestBody: unknown): string | undefined {
  if (requestBody === null || typeof requestBody !== 'object' || Array.isArray(requestBody)) return undefined;
  const model = (requestBody as Record<string, unknown>).model;
  return typeof model === 'string' ? model : undefined;
}

/** Pure and deterministic given the same replay-store state — the only I/O is the injected replay store's own read/write. */
export function authorizeModelRequest(input: AuthorizeModelRequestInput): AuthorizationOutcome {
  const deny = (reason: BrokerDenyReason, order?: ModelWorkOrder | null): AuthorizationOutcome => ({
    decision: 'DENY',
    reason,
    brokerRequestId: input.brokerRequestId,
    workOrderId: order?.workOrderId ?? null,
    workOrderHash: order ? hashPayload(order) : null,
    provider: order?.provider ?? null,
    model: order?.model ?? null,
    upstreamClass: 'local_mock',
  });

  if (!isNonEmptyString(input.authorizationHeader)) {
    return deny('missing_authorization');
  }

  const order = parseModelWorkOrderEnvelope(input.authorizationHeader);
  if (!order) {
    return deny('malformed_authorization');
  }

  const signatureCheck = checkModelWorkOrderSignature(order, input.verifier);
  if (signatureCheck !== 'valid') {
    return deny('invalid_signature', order);
  }

  // C5A-R2: expiresAt is signature-covered but must also be evaluated against
  // the clock. A missing/empty expiresAt is already rejected upstream by
  // parseModelWorkOrderEnvelope as malformed_authorization — this only
  // handles a syntactically-present value that is stale or unparseable.
  if (!ISO_8601_WITH_OFFSET.test(order.expiresAt)) {
    return deny('expiry_malformed', order);
  }
  const expiryMs = Date.parse(order.expiresAt);
  if (!Number.isFinite(expiryMs)) {
    return deny('expiry_malformed', order);
  }
  const nowMs = (input.now ?? Date.now)();
  if (nowMs >= expiryMs) {
    return deny('expired', order);
  }

  // C5A-R3: the envelope's own requestId is signed but was never previously
  // bound to the live request — compare it against the raw header only,
  // never against anything taken from the JSON body.
  const liveRequestId = input.liveRequestId?.trim();
  if (!liveRequestId) {
    return deny('missing_request_id', order);
  }
  if (liveRequestId !== order.requestId) {
    return deny('request_id_mismatch', order);
  }

  if (order.provider !== input.config.approvedProvider) {
    return deny('provider_mismatch', order);
  }

  const bodyModel = extractBodyModel(input.requestBody);
  if (order.model !== input.config.approvedModel || bodyModel !== input.config.approvedModel) {
    return deny('model_mismatch', order);
  }

  if (order.operation !== 'chat.completions') {
    return deny('unknown_operation', order);
  }

  // One-shot claim — deliberately LAST (see module header + executor-gate.ts's identical discipline).
  const replay = input.replayStore.consumeIfFresh(order.workOrderId, order.nonce);
  if (!replay.ok) {
    return deny('replayed', order);
  }

  return {
    decision: 'ALLOW',
    brokerRequestId: input.brokerRequestId,
    workOrderId: order.workOrderId,
    workOrderHash: hashPayload(order),
    provider: order.provider,
    model: order.model,
    upstreamClass: 'local_mock',
  };
}
