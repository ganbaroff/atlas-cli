/**
 * atlas/spend/types.ts — durable spend record binding (P1-B wave 1).
 *
 * MONEY RULE: every amount field is an integer number of minor currency
 * units (cents for USD, etc). No field here is ever a float dollar amount.
 * See money-invariants.test.ts for the runtime assertion this type-level
 * contract backs.
 */

import { z } from 'zod';

/**
 * Schema history:
 *  - v1 (original P1-B wave 1): RESERVED/COMMITTED/RELEASED/REJECTED/
 *    PENDING_RECONCILIATION, no invocation-claim fields.
 *  - v2 (P1-B provider-invocation-idempotency repair, 2026-08-06): adds the
 *    INVOCATION_STARTED status plus invocationClaimedAt/invocationClaimToken/
 *    committedResult. `spendRecordSchema`/`spendDayFileSchema` accept EITHER
 *    version so a pre-existing v1 day file can still be read without
 *    crashing (see store.ts's fail-closed rule — corrupt is corrupt, but an
 *    old-but-valid v1 shape is not corrupt). Any record a ledger mutation
 *    touches is re-sealed at the CURRENT version (SPEND_SCHEMA_VERSION).
 */
export const SPEND_SCHEMA_VERSION = 2 as const;
const LEGACY_SPEND_SCHEMA_VERSION_V1 = 1 as const;

export const SPEND_STATUSES = [
  'RESERVED',
  'INVOCATION_STARTED',
  'COMMITTED',
  'RELEASED',
  'REJECTED',
  'PENDING_RECONCILIATION',
] as const;
export type SpendStatus = (typeof SPEND_STATUSES)[number];

const accountingDaySchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'accountingDay must be YYYY-MM-DD');
const minorAmountSchema = z.number().int().nonnegative();
const requestIdSchema = z.string().trim().min(1).max(256);
const schemaVersionSchema = z.union([z.literal(LEGACY_SPEND_SCHEMA_VERSION_V1), z.literal(SPEND_SCHEMA_VERSION)]);

/**
 * One durable spend record — the unit of state this ledger persists. A
 * record is created RESERVED, optionally moves through INVOCATION_STARTED
 * (the provider-invocation claim — see ledger.ts's claimProviderInvocation),
 * then transitions exactly once to a terminal status (COMMITTED, RELEASED,
 * REJECTED) or to PENDING_RECONCILIATION when the outcome of an in-flight
 * reservation/invocation could not be determined (e.g. the process died
 * between claiming the invocation and committing/releasing).
 */
export const spendRecordSchema = z.object({
  schemaVersion: schemaVersionSchema,
  requestId: requestIdSchema,
  accountingDay: accountingDaySchema,
  ianaTimezone: z.string().trim().min(1),
  projectOrMissionId: z.string().trim().min(1),
  workOrderId: z.string().trim().min(1),
  provider: z.string().trim().min(1),
  model: z.string().trim().min(1),
  currency: z.string().trim().min(1).max(8),
  estimatedCostMinor: minorAmountSchema,
  reservedMinor: minorAmountSchema,
  committedMinor: minorAmountSchema,
  releasedMinor: minorAmountSchema,
  timestamp: z.string().datetime(),
  sourceReceiptHash: z.string().trim().min(1),
  status: z.enum(SPEND_STATUSES),
  /** Running daily total (committed + at-risk reserved) AT THE TIME this record was written. Audit snapshot, not authoritative — see getDailyTotal() for the live figure. */
  dailyTotalMinor: minorAmountSchema,
  /** Cap in effect at the time this record was written. Audit snapshot — see day-file dailyCapMinor for the current value. */
  dailyCapMinor: z.number().int().positive(),
  /** ISO timestamp of the moment the invocation right was atomically claimed (RESERVED -> INVOCATION_STARTED). Absent on v1 records and on records that never left RESERVED. */
  invocationClaimedAt: z.string().datetime().optional(),
  /** Identifies the process/attempt that holds (or held) the invocation claim — audit trail only, NEVER itself the authority. The persisted `status` field is the sole authority for whether a provider call is permitted. */
  invocationClaimToken: z.string().trim().min(1).max(256).optional(),
  /** The provider's result payload as of COMMITTED, stored so a replay of an already-committed requestId can return the original result WITHOUT re-invoking the provider. Must be JSON-serializable. Absent on v1 records, on non-COMMITTED records, and on any commit() call that did not supply `resultForReplay`. */
  committedResult: z.unknown().optional(),
  /** sha256 over every other field, canonicalized — tamper/corruption evidence for this one record. */
  integrityHash: z.string().regex(/^[a-f0-9]{64}$/),
}).strict();

export type SpendRecord = z.infer<typeof spendRecordSchema>;

/** One accounting day's durable ledger file: every record ever written for that day, keyed by requestId. */
export const spendDayFileSchema = z.object({
  schemaVersion: schemaVersionSchema,
  accountingDay: accountingDaySchema,
  ianaTimezone: z.string().trim().min(1),
  /** Most recently observed cap — informational; each reserve() call supplies the cap it enforces against, this field just reflects the latest one for audit/debugging. */
  dailyCapMinor: z.number().int().positive(),
  records: z.record(requestIdSchema, spendRecordSchema),
}).strict();

export type SpendDayFile = z.infer<typeof spendDayFileSchema>;

export class SpendStateCorruptError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SpendStateCorruptError';
  }
}

export class SpendStateRootUnavailableError extends Error {
  constructor(message: string, readonly cause?: unknown) {
    super(message);
    this.name = 'SpendStateRootUnavailableError';
  }
}

export class SpendValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SpendValidationError';
  }
}

/** Throws SpendValidationError unless `value` is a safe non-negative integer minor-unit amount. */
export function assertIntegerMinor(value: number, label: string): void {
  if (!Number.isInteger(value) || value < 0 || !Number.isSafeInteger(value)) {
    throw new SpendValidationError(`${label} must be a non-negative safe integer (minor units), got ${JSON.stringify(value)}`);
  }
}
