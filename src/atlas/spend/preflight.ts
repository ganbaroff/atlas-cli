/**
 * atlas/spend/preflight.ts — the pre-call spend gate (P1-B wave 1).
 *
 * The one place a caller should go through before spending money on a
 * provider call: (1) authenticate the Work Order authorizing this call, (2)
 * check the provider is actually allowed by that order, (3) atomically
 * reserve the estimated cost against today's cap, and ONLY THEN (4) invoke
 * the provider. The provider is an injected port (`invokeProvider`) so
 * tests can assert it was never called when the gate refuses — no real
 * network call is possible from inside this module.
 *
 * Work Order integration reuses atlas/work-order/validate.ts's
 * checkWorkOrderScope() directly rather than re-implementing envelope
 * verification. Deliberately uses checkWorkOrderScope (the PURE,
 * REPEATABLE check), not claimWorkOrder/validateWorkOrder — a single Work
 * Order authorizes many provider calls across its lifetime, so nonce
 * consumption stays a separate one-shot acceptance step owned by whatever
 * claimed the task; preflight only re-proves scope on every call, exactly
 * like executor-gate.ts does for file/command actions. The provider name is
 * checked against the order's `allowedCommandClasses` (there is no
 * provider-specific field on WorkOrder — commandClass is the closest
 * existing concept and this module does not widen the type to add one).
 */

import {
  checkWorkOrderScope,
  type SignedWorkOrder,
  type WorkOrderScopeCheckContext,
  type WorkOrderValidationFailureReason,
} from '../work-order/index.js';
import { reserve, commit, markPendingReconciliation, type ReserveInput } from './ledger.js';
import { SpendStateCorruptError, SpendStateRootUnavailableError, type SpendRecord } from './types.js';

export interface ProviderInvocationOutcome {
  result: unknown;
  /** Actual cost of this call, in integer minor units, as reported by the provider adapter. */
  actualCostMinor: number;
}

export type ProviderPort = () => Promise<ProviderInvocationOutcome>;

export interface SpendPreflightInput {
  signedWorkOrder: SignedWorkOrder;
  /** Everything checkWorkOrderScope needs except commandClass, which this module fixes to `provider`. */
  scopeContext: Omit<WorkOrderScopeCheckContext, 'commandClass'>;
  requestId: string;
  projectOrMissionId: string;
  provider: string;
  model: string;
  currency: string;
  estimatedCostMinor: number;
  dailyCapMinor: number;
  now: Date;
  ianaTimezone: string;
  sourceReceiptHash: string;
  invokeProvider: ProviderPort;
  rootDir?: string;
}

export type SpendPreflightVerdict =
  | { ok: true; result: unknown; record: SpendRecord }
  | { ok: false; reason: 'work_order_scope_denied'; workOrderReason: WorkOrderValidationFailureReason }
  | { ok: false; reason: 'cap_exceeded'; record: SpendRecord }
  | { ok: false; reason: 'state_unavailable'; detail: string }
  | { ok: false; reason: 'provider_invocation_failed'; error: unknown; record: SpendRecord };

/**
 * Run the full pre-call gate. `invokeProvider` is called AT MOST ONCE, and
 * only after a successful reservation — callers proving "rejected before
 * any provider invocation" should assert their injected port's call count
 * is unchanged after an `ok: false` verdict with reason !== undefined from
 * provider_invocation_failed.
 */
export async function runSpendPreflight(input: SpendPreflightInput): Promise<SpendPreflightVerdict> {
  const scopeVerdict = checkWorkOrderScope(input.signedWorkOrder, {
    ...input.scopeContext,
    commandClass: input.provider,
  });
  if (!scopeVerdict.ok) {
    return { ok: false, reason: 'work_order_scope_denied', workOrderReason: scopeVerdict.reason };
  }

  const reserveInput: ReserveInput = {
    requestId: input.requestId,
    now: input.now,
    ianaTimezone: input.ianaTimezone,
    projectOrMissionId: input.projectOrMissionId,
    workOrderId: input.signedWorkOrder.workOrderId,
    provider: input.provider,
    model: input.model,
    currency: input.currency,
    estimatedCostMinor: input.estimatedCostMinor,
    dailyCapMinor: input.dailyCapMinor,
    sourceReceiptHash: input.sourceReceiptHash,
    rootDir: input.rootDir,
  };

  let reserveResult;
  try {
    reserveResult = await reserve(reserveInput);
  } catch (error) {
    if (error instanceof SpendStateCorruptError || error instanceof SpendStateRootUnavailableError) {
      return { ok: false, reason: 'state_unavailable', detail: error.message };
    }
    throw error;
  }

  if (!reserveResult.ok) {
    return { ok: false, reason: 'cap_exceeded', record: reserveResult.record };
  }

  // Reservation succeeded (or was already reserved idempotently) — the
  // provider may now be invoked. Never reached above this line.
  try {
    const outcome = await input.invokeProvider();
    const committed = await commit({
      requestId: input.requestId,
      actualMinor: outcome.actualCostMinor,
      now: input.now,
      ianaTimezone: input.ianaTimezone,
      rootDir: input.rootDir,
    });
    if (!committed.ok) {
      // Reservation existed but was in an unexpected state (e.g. already
      // released by a concurrent caller) — surface as state_unavailable
      // rather than silently discarding the provider result.
      return { ok: false, reason: 'state_unavailable', detail: `commit failed: ${committed.reason}` };
    }
    return { ok: true, result: outcome.result, record: committed.record };
  } catch (error) {
    // Ambiguous outcome — we do not know whether the provider actually
    // billed anything. Never silently release funds that might have been
    // spent: mark PENDING_RECONCILIATION so the reservation stays counted
    // against the cap until an operator/caller resolves it explicitly.
    const pending = await markPendingReconciliation({
      requestId: input.requestId,
      reason: `provider invocation threw: ${error instanceof Error ? error.message : String(error)}`,
      now: input.now,
      ianaTimezone: input.ianaTimezone,
      rootDir: input.rootDir,
    });
    const record = pending.ok ? pending.record : reserveResult.record;
    return { ok: false, reason: 'provider_invocation_failed', error, record };
  }
}
