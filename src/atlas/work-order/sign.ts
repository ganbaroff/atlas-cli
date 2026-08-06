/**
 * atlas/work-order/sign.ts — HMAC-SHA256 signing/verification for Work Orders.
 *
 * Reuse survey (P1-A wave 1, 2026-08-06): ANUS has no generic signer /
 * secret-broker abstraction. The only local HMAC signing primitive is
 * atlas/queue-auth.ts, and it is hard-coded to the queue-row shape
 * ({command, chat_id}) — it cannot be imported directly for the Work Order
 * shape. Per the wave-1 hard rule, this module is Node's built-in
 * node:crypto HMAC-SHA256 (no new dependency) with a key resolved through
 * the SAME env-name convention queue-auth.ts uses: queue-auth.ts reads
 * ATLAS_QUEUE_SIGNING_KEY (name only — value is operator-set, never in
 * code/tests/logs/reports); this module reads ATLAS_WORK_ORDER_SIGNING_KEY
 * the same way. No bypass variable, no "unsigned OK" mode.
 *
 * Canonicalization: a stable (sorted-key) JSON serialization of every
 * WorkOrder field. `integrity` is never part of the canonical payload — it
 * is derived FROM the canonical payload, never included in it.
 *
 * Fail-closed contract:
 *   - signWorkOrder() THROWS when no signer is available. Unlike
 *     queue-auth.ts's signPayload() (which may legitimately return an
 *     unsigned row), a Work Order is meaningless without a valid signature,
 *     so there is no "return unsigned" path here at all.
 *   - checkWorkOrderSignature() / verifyWorkOrderSignature() return a closed
 *     ('missing' / false) verdict — never "trusted" — when no verifier/key
 *     is available. "Cannot prove" and "not signed" collapse to the same
 *     closed verdict.
 *   - No function in this module ever logs, throws, or serializes the
 *     signing key itself. Only the derived signature (a public value once
 *     attached to a specific envelope) is ever handled here.
 */

import { createHmac, timingSafeEqual } from 'node:crypto';
import type { SignedWorkOrder, WorkOrder } from './types.js';
import { WORK_ORDER_SIGNATURE_ALGORITHM } from './types.js';

export type WorkOrderSigner = (canonicalPayload: string) => string;
export type WorkOrderVerifier = (canonicalPayload: string, signature: string) => boolean;

export class WorkOrderSigningUnavailableError extends Error {
  constructor() {
    super('work-order: refusing to sign — no signing key/signer available');
    this.name = 'WorkOrderSigningUnavailableError';
  }
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((entry) => stableStringify(entry)).join(',')}]`;
  }
  if (value !== null && typeof value === 'object') {
    const keys = Object.keys(value as Record<string, unknown>).sort();
    const body = keys
      .map((key) => `${JSON.stringify(key)}:${stableStringify((value as Record<string, unknown>)[key])}`)
      .join(',');
    return `{${body}}`;
  }
  return JSON.stringify(value);
}

/** Canonicalize every WorkOrder field (never `integrity`) into one stable string. */
export function canonicalizeWorkOrder(order: WorkOrder): string {
  return stableStringify(order);
}

export function hmacSigner(key: string): WorkOrderSigner {
  return (canonicalPayload) => createHmac('sha256', key).update(canonicalPayload).digest('hex');
}

export function hmacVerifier(key: string): WorkOrderVerifier {
  return (canonicalPayload, signature) => {
    const expected = createHmac('sha256', key).update(canonicalPayload).digest('hex');
    const expectedBuf = Buffer.from(expected, 'hex');
    let signatureBuf: Buffer;
    try {
      signatureBuf = Buffer.from(signature, 'hex');
    } catch {
      return false;
    }
    if (expectedBuf.length !== signatureBuf.length) return false;
    return timingSafeEqual(expectedBuf, signatureBuf);
  };
}

/** Default accessor — reads from env only. Injectable for testing (mirrors queue-auth.ts's getSigningKey). */
export function getWorkOrderSigningKey(): string | undefined {
  return process.env['ATLAS_WORK_ORDER_SIGNING_KEY'] || undefined;
}

export function resolveWorkOrderSigner(
  key: string | undefined = getWorkOrderSigningKey(),
): WorkOrderSigner | undefined {
  return key ? hmacSigner(key) : undefined;
}

export function resolveWorkOrderVerifier(
  key: string | undefined = getWorkOrderSigningKey(),
): WorkOrderVerifier | undefined {
  return key ? hmacVerifier(key) : undefined;
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const key of Object.keys(value as Record<string, unknown>)) {
      deepFreeze((value as Record<string, unknown>)[key]);
    }
    Object.freeze(value);
  }
  return value;
}

/**
 * Sign a WorkOrder. Throws WorkOrderSigningUnavailableError when no signer
 * is available (fail closed — see module header). The returned envelope is
 * deep-frozen, including nested arrays shared by reference with `order`; a
 * WorkOrder passed here should be treated as immutable from that point on.
 */
export function signWorkOrder(
  order: WorkOrder,
  signer: WorkOrderSigner | undefined = resolveWorkOrderSigner(),
): SignedWorkOrder {
  if (!signer) throw new WorkOrderSigningUnavailableError();
  const canonicalPayload = canonicalizeWorkOrder(order);
  const signature = signer(canonicalPayload);
  const signed: SignedWorkOrder = {
    ...order,
    integrity: { algorithm: WORK_ORDER_SIGNATURE_ALGORITHM, signature },
  };
  return deepFreeze(signed);
}

export type WorkOrderSignatureCheck = 'valid' | 'missing' | 'invalid';

/**
 * Check a signed order's signature without deciding anything else about it.
 * Returns 'missing' both when the envelope carries no usable integrity
 * block AND when no verifier/key is available — see the fail-closed
 * contract in the module header.
 */
export function checkWorkOrderSignature(
  signed: SignedWorkOrder,
  verifier: WorkOrderVerifier | undefined = resolveWorkOrderVerifier(),
): WorkOrderSignatureCheck {
  const integrity = signed.integrity;
  if (
    !integrity ||
    integrity.algorithm !== WORK_ORDER_SIGNATURE_ALGORITHM ||
    typeof integrity.signature !== 'string' ||
    integrity.signature.length === 0
  ) {
    return 'missing';
  }
  if (!verifier) return 'missing';

  const { integrity: _integrity, ...rest } = signed;
  const canonicalPayload = canonicalizeWorkOrder(rest as WorkOrder);
  try {
    return verifier(canonicalPayload, integrity.signature) ? 'valid' : 'invalid';
  } catch {
    return 'invalid';
  }
}

export function verifyWorkOrderSignature(
  signed: SignedWorkOrder,
  verifier: WorkOrderVerifier | undefined = resolveWorkOrderVerifier(),
): boolean {
  return checkWorkOrderSignature(signed, verifier) === 'valid';
}
