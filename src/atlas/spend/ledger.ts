/**
 * atlas/spend/ledger.ts — the spend ledger transaction API (P1-B wave 1).
 *
 * reserve() / commit() / release() / markPendingReconciliation() are all
 * IDEMPOTENT by requestId: replaying the same call after a crash, retry, or
 * duplicate delivery never double-reserves or double-charges. Every
 * mutating call takes the day file's lock (store.ts's withLedgerLock) for
 * its full read-modify-write, so concurrent callers serialize instead of
 * racing past the cap (see money-invariants tests for the interleaving
 * proof).
 *
 * Day lookup for commit/release/markPendingReconciliation: a reservation's
 * accountingDay is not re-derived from "now" (a reservation created at
 * 23:59 and committed at 00:01 the next day must resolve against the SAME
 * day file it was reserved in, or the commit would silently vanish into an
 * empty new-day file). These calls therefore check `now`'s accounting day
 * first, then the immediately preceding day, and stop there — Work Orders
 * bound maxWallClockMs, so a reservation legitimately alive more than one
 * calendar day old is already a policy violation elsewhere, not a case this
 * ledger needs to search further back for.
 */

import { createHash } from 'node:crypto';
import { assertWritable } from '../readonly-guard.js';
import { computeAccountingDay, previousAccountingDay } from './accounting-day.js';
import {
  loadOrBootstrapDayFile,
  peekDayFile,
  withLedgerLock,
  writeDayFileAtomically,
  resolveDayFilePath,
} from './store.js';
import {
  SPEND_SCHEMA_VERSION,
  SpendValidationError,
  assertIntegerMinor,
  type SpendDayFile,
  type SpendRecord,
  type SpendStatus,
} from './types.js';

const REQUEST_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;

function assertRequestId(requestId: string): void {
  if (!REQUEST_ID_PATTERN.test(requestId)) {
    throw new SpendValidationError(`unsafe requestId: ${JSON.stringify(requestId)}`);
  }
}

/** Canonical, deterministic hash of a record's own content (every field except integrityHash itself). Self-integrity check — not a chain like evidence/ledger.ts, since spend records are keyed/mutated in place rather than append-only. */
function computeIntegrityHash(record: Omit<SpendRecord, 'integrityHash'>): string {
  const keys = Object.keys(record).sort();
  const canonical = keys.map((k) => `${k}=${JSON.stringify((record as Record<string, unknown>)[k])}`).join('|');
  return createHash('sha256').update(canonical).digest('hex');
}

function sealRecord(record: Omit<SpendRecord, 'integrityHash'>): SpendRecord {
  return { ...record, integrityHash: computeIntegrityHash(record) };
}

/** True only when a record's own integrityHash matches its content — corruption/tamper evidence at the single-record level. */
export function verifyRecordIntegrity(record: SpendRecord): boolean {
  const { integrityHash, ...rest } = record;
  return computeIntegrityHash(rest) === integrityHash;
}

function computeDailyTotalMinor(records: Readonly<Record<string, SpendRecord>>): number {
  let total = 0;
  for (const record of Object.values(records)) {
    if (record.status === 'COMMITTED') total += record.committedMinor;
    else if (record.status === 'RESERVED' || record.status === 'PENDING_RECONCILIATION') total += record.reservedMinor;
    // RELEASED and REJECTED contribute 0 — funds returned / never taken.
  }
  return total;
}

export interface ReserveInput {
  requestId: string;
  now: Date;
  ianaTimezone: string;
  projectOrMissionId: string;
  workOrderId: string;
  provider: string;
  model: string;
  currency: string;
  estimatedCostMinor: number;
  dailyCapMinor: number;
  sourceReceiptHash: string;
  rootDir?: string;
}

export type ReserveResult =
  | { ok: true; record: SpendRecord; idempotent: boolean }
  | { ok: false; reason: 'cap_exceeded'; record: SpendRecord };

/**
 * Reserve `estimatedCostMinor` against today's cap BEFORE any provider call
 * is made. Rejects (without mutating totals) when the reservation would
 * push the day's committed+reserved total over dailyCapMinor. Idempotent:
 * a second reserve() with the same requestId returns the original record
 * unchanged, regardless of what arguments the second call passes.
 */
export async function reserve(input: ReserveInput): Promise<ReserveResult> {
  assertWritable('spend.reserve');
  assertRequestId(input.requestId);
  assertIntegerMinor(input.estimatedCostMinor, 'estimatedCostMinor');
  assertIntegerMinor(input.dailyCapMinor, 'dailyCapMinor');
  if (input.dailyCapMinor <= 0) {
    throw new SpendValidationError('dailyCapMinor must be a positive integer');
  }

  const accountingDay = computeAccountingDay(input.now, input.ianaTimezone);
  const filePath = resolveDayFilePath(accountingDay, input.rootDir);

  return withLedgerLock(filePath, () => {
    const dayFile = loadOrBootstrapDayFile(accountingDay, input.ianaTimezone, input.dailyCapMinor, input.rootDir);

    const existing = dayFile.records[input.requestId];
    if (existing) {
      return { ok: true, record: existing, idempotent: true } as const;
    }

    const currentTotal = computeDailyTotalMinor(dayFile.records);
    const wouldBe = currentTotal + input.estimatedCostMinor;
    const timestamp = input.now.toISOString();

    if (wouldBe > input.dailyCapMinor) {
      const rejected = sealRecord({
        schemaVersion: SPEND_SCHEMA_VERSION,
        requestId: input.requestId,
        accountingDay,
        ianaTimezone: input.ianaTimezone,
        projectOrMissionId: input.projectOrMissionId,
        workOrderId: input.workOrderId,
        provider: input.provider,
        model: input.model,
        currency: input.currency,
        estimatedCostMinor: input.estimatedCostMinor,
        reservedMinor: 0,
        committedMinor: 0,
        releasedMinor: 0,
        timestamp,
        sourceReceiptHash: input.sourceReceiptHash,
        status: 'REJECTED' as SpendStatus,
        dailyTotalMinor: currentTotal,
        dailyCapMinor: input.dailyCapMinor,
      });
      const nextDayFile: SpendDayFile = {
        ...dayFile,
        dailyCapMinor: input.dailyCapMinor,
        records: { ...dayFile.records, [input.requestId]: rejected },
      };
      writeDayFileAtomically(nextDayFile, input.rootDir);
      return { ok: false, reason: 'cap_exceeded', record: rejected } as const;
    }

    const reserved = sealRecord({
      schemaVersion: SPEND_SCHEMA_VERSION,
      requestId: input.requestId,
      accountingDay,
      ianaTimezone: input.ianaTimezone,
      projectOrMissionId: input.projectOrMissionId,
      workOrderId: input.workOrderId,
      provider: input.provider,
      model: input.model,
      currency: input.currency,
      estimatedCostMinor: input.estimatedCostMinor,
      reservedMinor: input.estimatedCostMinor,
      committedMinor: 0,
      releasedMinor: 0,
      timestamp,
      sourceReceiptHash: input.sourceReceiptHash,
      status: 'RESERVED' as SpendStatus,
      dailyTotalMinor: wouldBe,
      dailyCapMinor: input.dailyCapMinor,
    });
    const nextDayFile: SpendDayFile = {
      ...dayFile,
      dailyCapMinor: input.dailyCapMinor,
      records: { ...dayFile.records, [input.requestId]: reserved },
    };
    writeDayFileAtomically(nextDayFile, input.rootDir);
    return { ok: true, record: reserved, idempotent: false } as const;
  });
}

interface LocatedRecord {
  accountingDay: string;
  filePath: string;
  dayFile: SpendDayFile;
  record: SpendRecord;
}

/** Locate a record by requestId, checking `now`'s accounting day then the immediately preceding one. Does not take the lock — callers that mutate must re-check inside their own locked section. */
function locateRecord(requestId: string, now: Date, ianaTimezone: string, rootDir?: string): LocatedRecord | undefined {
  const today = computeAccountingDay(now, ianaTimezone);
  for (const day of [today, previousAccountingDay(today)]) {
    const dayFile = peekDayFile(day, ianaTimezone, rootDir);
    const record = dayFile.records[requestId];
    if (record) {
      return { accountingDay: day, filePath: resolveDayFilePath(day, rootDir), dayFile, record };
    }
  }
  return undefined;
}

export interface CommitInput {
  requestId: string;
  actualMinor: number;
  now: Date;
  ianaTimezone?: string;
  rootDir?: string;
}

export type CommitResult =
  | { ok: true; record: SpendRecord; idempotent: boolean }
  | { ok: false; reason: 'not_found' }
  | { ok: false; reason: 'invalid_state'; record: SpendRecord };

/** Commit the actual cost of a reservation. Idempotent: committing the same requestId twice returns the ORIGINAL committed record (the actualMinor of the first call wins) rather than double-charging or overwriting with a different amount. */
export async function commit(input: CommitInput): Promise<CommitResult> {
  assertWritable('spend.commit');
  assertRequestId(input.requestId);
  assertIntegerMinor(input.actualMinor, 'actualMinor');
  const ianaTimezone = input.ianaTimezone ?? 'UTC';

  const located = locateRecord(input.requestId, input.now, ianaTimezone, input.rootDir);
  if (!located) return { ok: false, reason: 'not_found' };

  return withLedgerLock(located.filePath, () => {
    const dayFile = loadOrBootstrapDayFile(located.accountingDay, ianaTimezone, located.dayFile.dailyCapMinor, input.rootDir);
    const current = dayFile.records[input.requestId];
    if (!current) return { ok: false, reason: 'not_found' } as const;

    if (current.status === 'COMMITTED') {
      return { ok: true, record: current, idempotent: true } as const;
    }
    if (current.status !== 'RESERVED' && current.status !== 'PENDING_RECONCILIATION') {
      return { ok: false, reason: 'invalid_state', record: current } as const;
    }

    const otherTotal = computeDailyTotalMinor(
      Object.fromEntries(Object.entries(dayFile.records).filter(([id]) => id !== input.requestId)),
    );
    const timestamp = input.now.toISOString();
    // Strip the prior integrityHash before re-sealing — leaving it in would
    // leak a stale hash value into the NEW hash's own input, making the
    // record fail verifyRecordIntegrity() the moment it is read back.
    const { integrityHash: _priorHash, ...currentWithoutHash } = current;
    const committed = sealRecord({
      ...currentWithoutHash,
      committedMinor: input.actualMinor,
      reservedMinor: current.reservedMinor,
      timestamp,
      status: 'COMMITTED' as SpendStatus,
      dailyTotalMinor: otherTotal + input.actualMinor,
    });
    const nextDayFile: SpendDayFile = { ...dayFile, records: { ...dayFile.records, [input.requestId]: committed } };
    writeDayFileAtomically(nextDayFile, input.rootDir);
    return { ok: true, record: committed, idempotent: false } as const;
  });
}

export interface ReleaseInput {
  requestId: string;
  now: Date;
  ianaTimezone?: string;
  rootDir?: string;
}

export type ReleaseResult =
  | { ok: true; record: SpendRecord; idempotent: boolean }
  | { ok: false; reason: 'not_found' }
  | { ok: false; reason: 'invalid_state'; record: SpendRecord };

/** Release an unused reservation (provider was never actually called, or it failed before any cost was incurred). Idempotent. */
export async function release(input: ReleaseInput): Promise<ReleaseResult> {
  assertWritable('spend.release');
  assertRequestId(input.requestId);
  const ianaTimezone = input.ianaTimezone ?? 'UTC';

  const located = locateRecord(input.requestId, input.now, ianaTimezone, input.rootDir);
  if (!located) return { ok: false, reason: 'not_found' };

  return withLedgerLock(located.filePath, () => {
    const dayFile = loadOrBootstrapDayFile(located.accountingDay, ianaTimezone, located.dayFile.dailyCapMinor, input.rootDir);
    const current = dayFile.records[input.requestId];
    if (!current) return { ok: false, reason: 'not_found' } as const;

    if (current.status === 'RELEASED') {
      return { ok: true, record: current, idempotent: true } as const;
    }
    if (current.status !== 'RESERVED' && current.status !== 'PENDING_RECONCILIATION') {
      return { ok: false, reason: 'invalid_state', record: current } as const;
    }

    const otherTotal = computeDailyTotalMinor(
      Object.fromEntries(Object.entries(dayFile.records).filter(([id]) => id !== input.requestId)),
    );
    const timestamp = input.now.toISOString();
    const { integrityHash: _priorHash, ...currentWithoutHash } = current;
    const released = sealRecord({
      ...currentWithoutHash,
      releasedMinor: current.reservedMinor,
      timestamp,
      status: 'RELEASED' as SpendStatus,
      dailyTotalMinor: otherTotal,
    });
    const nextDayFile: SpendDayFile = { ...dayFile, records: { ...dayFile.records, [input.requestId]: released } };
    writeDayFileAtomically(nextDayFile, input.rootDir);
    return { ok: true, record: released, idempotent: false } as const;
  });
}

export interface MarkPendingReconciliationInput {
  requestId: string;
  reason: string;
  now: Date;
  ianaTimezone?: string;
  rootDir?: string;
}

export type MarkPendingReconciliationResult =
  | { ok: true; record: SpendRecord; idempotent: boolean }
  | { ok: false; reason: 'not_found' }
  | { ok: false; reason: 'invalid_state'; record: SpendRecord };

/** Flip an in-flight reservation whose outcome is unknown (process died mid-call, ambiguous provider error, etc) to PENDING_RECONCILIATION. The reservedMinor amount stays counted against the cap (worst case) until an operator resolves it via commit()/release(). Never called automatically on a plain read — explicit only, see P1-B report residual risks. */
export async function markPendingReconciliation(
  input: MarkPendingReconciliationInput,
): Promise<MarkPendingReconciliationResult> {
  assertWritable('spend.markPendingReconciliation');
  assertRequestId(input.requestId);
  if (!input.reason.trim()) throw new SpendValidationError('markPendingReconciliation requires a non-empty reason');
  const ianaTimezone = input.ianaTimezone ?? 'UTC';

  const located = locateRecord(input.requestId, input.now, ianaTimezone, input.rootDir);
  if (!located) return { ok: false, reason: 'not_found' };

  return withLedgerLock(located.filePath, () => {
    const dayFile = loadOrBootstrapDayFile(located.accountingDay, ianaTimezone, located.dayFile.dailyCapMinor, input.rootDir);
    const current = dayFile.records[input.requestId];
    if (!current) return { ok: false, reason: 'not_found' } as const;

    if (current.status === 'PENDING_RECONCILIATION') {
      return { ok: true, record: current, idempotent: true } as const;
    }
    if (current.status !== 'RESERVED') {
      return { ok: false, reason: 'invalid_state', record: current } as const;
    }

    const timestamp = input.now.toISOString();
    const { integrityHash: _priorHash, ...currentWithoutHash } = current;
    const pending = sealRecord({
      ...currentWithoutHash,
      timestamp,
      status: 'PENDING_RECONCILIATION' as SpendStatus,
    });
    const nextDayFile: SpendDayFile = { ...dayFile, records: { ...dayFile.records, [input.requestId]: pending } };
    writeDayFileAtomically(nextDayFile, input.rootDir);
    return { ok: true, record: pending, idempotent: false } as const;
  });
}

export interface DailyTotalSnapshot {
  accountingDay: string;
  dailyTotalMinor: number;
  dailyCapMinor: number;
  recordCount: number;
}

/** Pure read of one accounting day's live total — re-reads from disk every call, so it reflects the true post-restart state, never a cached in-memory figure. */
export function getDailyTotal(accountingDay: string, ianaTimezone = 'UTC', rootDir?: string): DailyTotalSnapshot {
  const dayFile = peekDayFile(accountingDay, ianaTimezone, rootDir);
  return {
    accountingDay,
    dailyTotalMinor: computeDailyTotalMinor(dayFile.records),
    dailyCapMinor: dayFile.dailyCapMinor,
    recordCount: Object.keys(dayFile.records).length,
  };
}
