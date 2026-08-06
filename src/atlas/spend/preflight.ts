/**
 * atlas/spend/preflight.ts — the pre-call spend gate (P1-B wave 1;
 * provider-invocation idempotency added P1-B repair 2026-08-06).
 *
 * The one place a caller should go through before spending money on a
 * provider call: (1) authenticate the Work Order authorizing this call, (2)
 * check the provider is actually allowed by that order, (3) atomically
 * reserve the estimated cost against today's cap, (4) atomically CLAIM the
 * invocation right (ledger.ts's claimProviderInvocation — durable
 * RESERVED -> INVOCATION_STARTED compare-and-set), and ONLY THEN (5) invoke
 * the provider. The provider is an injected port (`invokeProvider`) so
 * tests can assert it was never called when the gate refuses — no real
 * network call is possible from inside this module.
 *
 * Step 3 (reserve) alone is NOT sufficient to guard the provider call: a
 * replayed/duplicate/retried call can find an EXISTING reservation (reserve()
 * returns `idempotent: true`) whose record may already be COMMITTED,
 * INVOCATION_STARTED (another caller mid-flight), or PENDING_RECONCILIATION
 * — none of which permit a second provider invocation. Step 4 is the
 * authority that decides this, by durable record status alone, never by
 * `idempotent` or any in-memory signal.
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
import {
  reserve,
  commit,
  markPendingReconciliation,
  claimProviderInvocation,
  type ReserveInput,
} from './ledger.js';
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
  /** `idempotentReplay: true` means the provider was NOT invoked by this call — the result is the durably stored COMMITTED result from an earlier, real invocation. */
  | { ok: true; result: unknown; record: SpendRecord; idempotentReplay: boolean }
  | { ok: false; reason: 'work_order_scope_denied'; workOrderReason: WorkOrderValidationFailureReason }
  | { ok: false; reason: 'cap_exceeded'; record: SpendRecord }
  | { ok: false; reason: 'state_unavailable'; detail: string }
  /** Another caller (this process or a different one) is currently mid-invocation for this exact requestId. Refused — never a second invocation. */
  | { ok: false; reason: 'invocation_in_progress'; record: SpendRecord }
  /** A prior invocation attempt's outcome is unresolved (crash/uncertain). No automatic retry — an operator/caller must resolve it explicitly (commit/release) before this requestId can proceed. */
  | { ok: false; reason: 'pending_reconciliation'; record: SpendRecord }
  /** requestId already resolved to RELEASED or REJECTED — terminal. Recycling the SAME requestId is refused; a new attempt needs a NEW requestId. */
  | { ok: false; reason: 'terminal_request_id'; record: SpendRecord }
  /** The stored record failed its own integrity check — deterministic refusal, never treated as a valid claim or replay. */
  | { ok: false; reason: 'integrity_violation'; record: SpendRecord }
  | { ok: false; reason: 'provider_invocation_failed'; error: unknown; record: SpendRecord };

/**
 * Run the full pre-call gate. `invokeProvider` is called AT MOST ONCE per
 * requestId, EVER — across retries, restarts, and concurrent duplicate
 * callers — and only after this call has durably claimed the sole
 * invocation right for that requestId (ledger.ts's
 * claimProviderInvocation). Callers proving "rejected/replayed before any
 * provider invocation" should assert their injected port's call count is
 * unchanged after any `ok: false` verdict, and unchanged again after an
 * `ok: true` verdict with `idempotentReplay: true`.
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

  // A reservation now durably exists (fresh or an idempotent replay of an
  // earlier one) — but that alone NEVER authorizes a provider call. The
  // existing record could already be COMMITTED, INVOCATION_STARTED (another
  // caller mid-flight), PENDING_RECONCILIATION, or terminal. The durable
  // invocation claim below is the SOLE authority for what happens next —
  // never `reserveResult.idempotent`, never any in-memory signal.
  let claimResult;
  try {
    claimResult = await claimProviderInvocation({
      requestId: input.requestId,
      now: input.now,
      ianaTimezone: input.ianaTimezone,
      rootDir: input.rootDir,
    });
  } catch (error) {
    if (error instanceof SpendStateCorruptError || error instanceof SpendStateRootUnavailableError) {
      return { ok: false, reason: 'state_unavailable', detail: error.message };
    }
    throw error;
  }

  if (!claimResult.ok) {
    if (claimResult.reason === 'not_found') {
      // Unreachable in practice — reserve() just created/confirmed this
      // exact record under the same lock family. Fail closed rather than
      // silently falling through to a provider call.
      return { ok: false, reason: 'state_unavailable', detail: `invocation claim: record vanished for requestId ${input.requestId}` };
    }
    const reason = claimResult.reason === 'terminal' ? 'terminal_request_id' : claimResult.reason;
    return { ok: false, reason, record: claimResult.record };
  }

  if (claimResult.outcome === 'replay') {
    // requestId is already COMMITTED — an idempotent replay. The provider is
    // NEVER invoked again; the durably stored result is returned as-is.
    return { ok: true, result: claimResult.record.committedResult, record: claimResult.record, idempotentReplay: true };
  }

  // claimResult.outcome === 'claimed' — this call, and only this call, holds
  // the invocation right for this requestId. Invoke the provider exactly
  // once.
  try {
    const outcome = await input.invokeProvider();
    const committed = await commit({
      requestId: input.requestId,
      actualMinor: outcome.actualCostMinor,
      now: input.now,
      ianaTimezone: input.ianaTimezone,
      rootDir: input.rootDir,
      resultForReplay: outcome.result,
    });
    if (!committed.ok) {
      // Reservation existed but was in an unexpected state (e.g. already
      // released by a concurrent caller) — surface as state_unavailable
      // rather than silently discarding the provider result.
      return { ok: false, reason: 'state_unavailable', detail: `commit failed: ${committed.reason}` };
    }
    return { ok: true, result: outcome.result, record: committed.record, idempotentReplay: false };
  } catch (error) {
    // Ambiguous outcome — we do not know whether the provider actually
    // billed anything. Never silently release funds that might have been
    // spent, and never silently erase the invocation-started evidence: mark
    // PENDING_RECONCILIATION so the reservation stays counted against the
    // cap until an operator/caller resolves it explicitly.
    const pending = await markPendingReconciliation({
      requestId: input.requestId,
      reason: `provider invocation threw: ${error instanceof Error ? error.message : String(error)}`,
      now: input.now,
      ianaTimezone: input.ianaTimezone,
      rootDir: input.rootDir,
    });
    const record = pending.ok ? pending.record : claimResult.record;
    return { ok: false, reason: 'provider_invocation_failed', error, record };
  }
}
