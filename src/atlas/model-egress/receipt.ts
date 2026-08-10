/**
 * atlas/model-egress/receipt.ts — C5A-2 egress decision receipts.
 *
 * Same discipline as model-broker/receipt.ts, and for the same reason: one
 * typed claim per decision through the EXISTING evidence ledger, never a second
 * evidence system.
 *
 * HARD RULE, stricter here than on the broker side because this module runs in
 * the only process that holds provider auth: the claim payload carries ONLY
 * EgressDecision's own named fields. projectEgressReceipt() is the single
 * allow-list projection and must never spread an arbitrary object. The auth
 * token, `Authorization`, request `messages`, upstream response bodies and
 * `process.env` must never reach this module at all.
 */

import { randomUUID } from 'node:crypto';
import { appendClaim } from '../../evidence/ledger.js';
import type { EgressDecision } from './types.js';

export function projectEgressReceipt(decision: EgressDecision): Record<string, unknown> {
  return {
    kind: 'model-egress-decision',
    decision: decision.decision,
    reason: decision.reason ?? null,
    egressRequestId: decision.egressRequestId,
    providerId: decision.providerId,
    tier: decision.tier,
    model: decision.model,
    status: decision.status,
    latencyMs: decision.latencyMs,
    tokensCharged: decision.tokensCharged,
    requestsRemaining: decision.requestsRemaining,
    tokensRemaining: decision.tokensRemaining,
  };
}

function makeReceiptClaimId(): string {
  return `clm_modelegress-${randomUUID().replace(/-/g, '').slice(0, 20)}`;
}

/** Appends one immutable receipt claim for this decision. Never logs or echoes it anywhere else. */
export function recordEgressDecision(decision: EgressDecision): void {
  appendClaim({
    claimId: makeReceiptClaimId(),
    claim: JSON.stringify(projectEgressReceipt(decision)),
    type: 'narrative',
    path: `model-egress://${decision.providerId ?? 'unresolved'}/${decision.egressRequestId}`,
    confidence: 0,
    source: 'model-egress',
    sourceRef: decision.egressRequestId,
    ts: new Date().toISOString(),
  });
}
