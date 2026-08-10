/**
 * atlas/model-broker/receipt.ts — C5A broker decision receipts.
 *
 * Appends one typed claim per BrokerDecision through the EXISTING M8
 * evidence ledger (evidence/ledger.ts's appendClaim + claim.ts's typed
 * claim schema) — no second evidence system. Same pattern
 * work-order/executor-gate.ts's emitRejectEvidence already uses: a
 * 'narrative' claim carrying a JSON-stringified payload in `claim`.
 *
 * HARD RULE: the claim payload carries ONLY BrokerDecision's own named
 * fields. projectReceipt() is the single allow-list projection — the ONLY
 * place allowed to read a BrokerDecision's fields for this purpose — and it
 * must never spread an arbitrary object into the claim. Headers,
 * `Authorization`, cookies, prompt/`messages`, upstream response bodies and
 * `process.env` must never reach this module, let alone the ledger.
 */

import { randomUUID } from 'node:crypto';
import { appendClaim } from '../../evidence/ledger.js';
import type { BrokerDecision } from './types.js';

/**
 * Allow-list projection: builds the receipt payload from BrokerDecision's
 * own named fields only. Never spreads `decision` — every field is named
 * explicitly so an accidental extra property on the input object can never
 * leak into the ledger.
 */
export function projectReceipt(decision: BrokerDecision): Record<string, unknown> {
  return {
    kind: 'model-broker-decision',
    decision: decision.decision,
    reason: decision.reason ?? null,
    brokerRequestId: decision.brokerRequestId,
    workOrderId: decision.workOrderId,
    workOrderHash: decision.workOrderHash,
    provider: decision.provider,
    model: decision.model,
    upstreamClass: decision.upstreamClass,
    status: decision.status,
    latencyMs: decision.latencyMs,
  };
}

function makeReceiptClaimId(): string {
  return `clm_modelbroker-${randomUUID().replace(/-/g, '').slice(0, 20)}`;
}

/** Appends one immutable receipt claim for this decision. Never logs or echoes it anywhere else. */
export function recordBrokerDecision(decision: BrokerDecision): void {
  appendClaim({
    claimId: makeReceiptClaimId(),
    claim: JSON.stringify(projectReceipt(decision)),
    type: 'narrative',
    path: `model-broker://${decision.workOrderId ?? decision.brokerRequestId}`,
    confidence: 0,
    source: 'model-broker',
    sourceRef: decision.brokerRequestId,
    ts: new Date().toISOString(),
  });
}
