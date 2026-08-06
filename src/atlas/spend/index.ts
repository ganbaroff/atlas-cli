/**
 * atlas/spend/index.ts — public surface of the restart-durable spend ledger
 * (P1-B wave 1).
 */

export {
  SPEND_SCHEMA_VERSION,
  SPEND_STATUSES,
  spendRecordSchema,
  spendDayFileSchema,
  SpendStateCorruptError,
  SpendStateRootUnavailableError,
  SpendValidationError,
  assertIntegerMinor,
} from './types.js';
export type { SpendStatus, SpendRecord, SpendDayFile } from './types.js';

export { computeAccountingDay, previousAccountingDay, InvalidTimezoneError } from './accounting-day.js';

export {
  resolveSpendLedgerDir,
  resolveDayFilePath,
} from './store.js';

export {
  reserve,
  commit,
  release,
  markPendingReconciliation,
  getDailyTotal,
  verifyRecordIntegrity,
} from './ledger.js';
export type {
  ReserveInput,
  ReserveResult,
  CommitInput,
  CommitResult,
  ReleaseInput,
  ReleaseResult,
  MarkPendingReconciliationInput,
  MarkPendingReconciliationResult,
  DailyTotalSnapshot,
} from './ledger.js';

export { runSpendPreflight } from './preflight.js';
export type {
  ProviderPort,
  ProviderInvocationOutcome,
  SpendPreflightInput,
  SpendPreflightVerdict,
} from './preflight.js';

export {
  CEO_OVERRIDE_SIGNATURE_ALGORITHM,
  CEO_AUTHORITY_PREFIX,
  CEO_OVERRIDE_CLOCK_SKEW_TOLERANCE_MS,
  CeoOverrideSigningUnavailableError,
  canonicalizeCeoOverride,
  signCeoOverride,
  checkCeoOverrideSignature,
  resolveEffectiveDailyCapMinor,
} from './override.js';
export type {
  CeoOverrideScope,
  CeoOverride,
  CeoOverrideIntegrity,
  SignedCeoOverride,
  CeoOverrideSignatureCheck,
  CeoOverrideRejectReason,
  ResolveEffectiveDailyCapInput,
  ResolveEffectiveDailyCapResult,
} from './override.js';
