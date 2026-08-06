/**
 * spend-durable.test.ts — P1-B wave 1: restart-durable atomic spend ledger.
 *
 * All state lives under a per-test temp directory passed explicitly as
 * `rootDir` — no env stubbing, no shared process state, no network. Restart
 * is simulated two ways: (a) directly re-reading from a fresh `rootDir`
 * path with `vi.resetModules()` + re-import, proving no module-level cache
 * masks a real restart, and (b) simply calling the pure `getDailyTotal()`
 * reader again, since the store never caches in memory by design.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import {
  reserve,
  commit,
  release,
  markPendingReconciliation,
  getDailyTotal,
  verifyRecordIntegrity,
  computeAccountingDay,
  resolveDayFilePath,
  SpendStateCorruptError,
  SpendStateRootUnavailableError,
  SpendValidationError,
  runSpendPreflight,
  type ReserveInput,
} from '../atlas/spend/index.js';
import {
  hmacSigner,
  hmacVerifier,
  signWorkOrder,
  type WorkOrder,
} from '../atlas/work-order/index.js';

const TEST_KEY = 'test-fake-spend-preflight-key-not-real-do-not-use';
const signer = hmacSigner(TEST_KEY);
const verifier = hmacVerifier(TEST_KEY);

function baseWorkOrder(overrides: Partial<WorkOrder> = {}): WorkOrder {
  const now = Date.now();
  return {
    workOrderId: 'wo_spend-test',
    goalId: 'goal-p1b-wave1',
    taskId: 'task-spend-durable',
    issuerIdentity: 'atlas-planner',
    executorIdentity: 'atlas-executor',
    repoCanonicalPath: 'C:/repo/ANUS',
    baseBranch: 'codex/p1b-spend-cap',
    baseHead: 'c92a570',
    worktreePath: 'C:/repo/ANUS/.worktrees/p1b-spend-cap',
    issuedAt: new Date(now).toISOString(),
    expiresAt: new Date(now + 60 * 60 * 1000).toISOString(),
    nonce: 'nonce-spend-test',
    allowedPaths: [],
    forbiddenPaths: [],
    forbiddenActions: [],
    allowedCommandClasses: ['nvidia', 'anthropic'],
    maxAttempts: 5,
    maxWallClockMs: 20 * 60 * 1000,
    expectedTests: ['src/__tests__/spend-durable.test.ts'],
    evidenceRequirements: ['exit-code'],
    rollbackMethod: 'none',
    ...overrides,
  };
}

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'atlas-spend-durable-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function baseReserveInput(overrides: Partial<ReserveInput> = {}): ReserveInput {
  return {
    requestId: 'req-1',
    now: new Date('2026-08-06T10:00:00.000Z'),
    ianaTimezone: 'UTC',
    projectOrMissionId: 'atlas',
    workOrderId: 'wo_spend-test',
    provider: 'anthropic',
    model: 'claude-sonnet',
    currency: 'USD',
    estimatedCostMinor: 500,
    dailyCapMinor: 1000,
    sourceReceiptHash: 'sha256:test-source',
    rootDir: dir,
    ...overrides,
  };
}

describe('spend ledger — reservation basics', () => {
  it('1. first reservation under cap succeeds', async () => {
    const result = await reserve(baseReserveInput());
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('unreachable');
    expect(result.record.status).toBe('RESERVED');
    expect(result.record.reservedMinor).toBe(500);
    expect(result.idempotent).toBe(false);
    expect(verifyRecordIntegrity(result.record)).toBe(true);
  });

  it('6. same requestId cannot reserve twice (idempotent, first amount wins)', async () => {
    const first = await reserve(baseReserveInput({ estimatedCostMinor: 200 }));
    const second = await reserve(baseReserveInput({ estimatedCostMinor: 999 }));
    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    if (!first.ok || !second.ok) throw new Error('unreachable');
    expect(second.idempotent).toBe(true);
    expect(second.record.reservedMinor).toBe(200); // NOT 999 — first call wins
    const total = getDailyTotal('2026-08-06', 'UTC', dir);
    expect(total.dailyTotalMinor).toBe(200); // not double-reserved
    expect(total.recordCount).toBe(1);
  });

  it('8. unused reservation released correctly', async () => {
    await reserve(baseReserveInput({ estimatedCostMinor: 300 }));
    const released = await release({ requestId: 'req-1', now: baseReserveInput().now, ianaTimezone: 'UTC', rootDir: dir });
    expect(released.ok).toBe(true);
    if (!released.ok) throw new Error('unreachable');
    expect(released.record.status).toBe('RELEASED');
    expect(released.record.releasedMinor).toBe(300);
    const total = getDailyTotal('2026-08-06', 'UTC', dir);
    expect(total.dailyTotalMinor).toBe(0); // released funds do not count against the cap
  });
});

describe('spend ledger — commit', () => {
  it('7. same requestId cannot commit twice (idempotent, first actual amount wins)', async () => {
    await reserve(baseReserveInput({ estimatedCostMinor: 500 }));
    const first = await commit({ requestId: 'req-1', actualMinor: 420, now: baseReserveInput().now, ianaTimezone: 'UTC', rootDir: dir });
    const second = await commit({ requestId: 'req-1', actualMinor: 999, now: baseReserveInput().now, ianaTimezone: 'UTC', rootDir: dir });
    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    if (!first.ok || !second.ok) throw new Error('unreachable');
    expect(second.idempotent).toBe(true);
    expect(second.record.committedMinor).toBe(420); // NOT 999 — no double charge
    const total = getDailyTotal('2026-08-06', 'UTC', dir);
    expect(total.dailyTotalMinor).toBe(420);
  });

  it('9. charged failed request stays counted (commit reflects real cost even on logical failure)', async () => {
    await reserve(baseReserveInput({ requestId: 'req-failed', estimatedCostMinor: 500 }));
    // Simulate: the logical task failed, but the provider had already billed 350 minor units.
    const result = await commit({ requestId: 'req-failed', actualMinor: 350, now: baseReserveInput().now, ianaTimezone: 'UTC', rootDir: dir });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('unreachable');
    expect(result.record.status).toBe('COMMITTED');
    const total = getDailyTotal('2026-08-06', 'UTC', dir);
    expect(total.dailyTotalMinor).toBe(350); // stays counted, not silently dropped
  });

  it('21. free-provider zero-cost path recorded honestly (receipt exists, cost 0)', async () => {
    const reserved = await reserve(baseReserveInput({ requestId: 'req-free', provider: 'nvidia', estimatedCostMinor: 0 }));
    expect(reserved.ok).toBe(true);
    if (!reserved.ok) throw new Error('unreachable');
    expect(reserved.record.reservedMinor).toBe(0);
    const committed = await commit({ requestId: 'req-free', actualMinor: 0, now: baseReserveInput().now, ianaTimezone: 'UTC', rootDir: dir });
    expect(committed.ok).toBe(true);
    if (!committed.ok) throw new Error('unreachable');
    expect(committed.record.status).toBe('COMMITTED');
    expect(committed.record.committedMinor).toBe(0);
    expect(committed.record.currency).toBe('USD');
    expect(verifyRecordIntegrity(committed.record)).toBe(true);
    // A receipt genuinely exists on disk for the free call — not silently skipped.
    const total = getDailyTotal('2026-08-06', 'UTC', dir);
    expect(total.recordCount).toBe(1);
  });
});

describe('spend ledger — restart durability', () => {
  it('3. reservation survives process restart (re-instantiate store from disk)', async () => {
    await reserve(baseReserveInput({ estimatedCostMinor: 640 }));

    vi.resetModules();
    const fresh = await import('../atlas/spend/index.js');
    const total = fresh.getDailyTotal('2026-08-06', 'UTC', dir);
    expect(total.dailyTotalMinor).toBe(640);
    expect(total.recordCount).toBe(1);
  });

  it('4. committed cost survives restart', async () => {
    await reserve(baseReserveInput({ estimatedCostMinor: 500 }));
    await commit({ requestId: 'req-1', actualMinor: 275, now: baseReserveInput().now, ianaTimezone: 'UTC', rootDir: dir });

    vi.resetModules();
    const fresh = await import('../atlas/spend/index.js');
    const total = fresh.getDailyTotal('2026-08-06', 'UTC', dir);
    expect(total.dailyTotalMinor).toBe(275);
  });

  it('5. restart does not reset the daily total across multiple records', async () => {
    await reserve(baseReserveInput({ requestId: 'req-a', estimatedCostMinor: 100 }));
    await commit({ requestId: 'req-a', actualMinor: 100, now: baseReserveInput().now, ianaTimezone: 'UTC', rootDir: dir });
    await reserve(baseReserveInput({ requestId: 'req-b', estimatedCostMinor: 200 }));

    vi.resetModules();
    const fresh = await import('../atlas/spend/index.js');
    const beforeRestart = 100 /* committed req-a */ + 200 /* reserved req-b */;
    const total = fresh.getDailyTotal('2026-08-06', 'UTC', dir);
    expect(total.dailyTotalMinor).toBe(beforeRestart);
    expect(total.recordCount).toBe(2);
  });
});

describe('spend ledger — fail-closed on untrustworthy state', () => {
  it('10. corrupted state rejects paid calls (never assumes zero spent)', async () => {
    const filePath = resolveDayFilePath('2026-08-06', dir);
    mkdirSync(dir, { recursive: true });
    writeFileSync(filePath, '{ this is not valid json', 'utf8');

    await expect(reserve(baseReserveInput({ provider: 'anthropic', estimatedCostMinor: 100 })))
      .rejects.toBeInstanceOf(SpendStateCorruptError);
  });

  it('10b. corrupted state rejects paid calls through the preflight gate — provider never invoked', async () => {
    const filePath = resolveDayFilePath('2026-08-06', dir);
    mkdirSync(dir, { recursive: true });
    writeFileSync(filePath, JSON.stringify({ schemaVersion: 1, accountingDay: '2026-08-06', ianaTimezone: 'UTC', dailyCapMinor: 1000, records: { bogus: 'not-a-record' } }), 'utf8');

    const order = baseWorkOrder();
    const signed = signWorkOrder(order, signer);
    let invocationCount = 0;

    const verdict = await runSpendPreflight({
      signedWorkOrder: signed,
      scopeContext: {
        verifier,
        executorIdentity: order.executorIdentity,
        repoCanonicalPath: order.repoCanonicalPath,
        baseHead: order.baseHead,
        attemptNumber: 1,
        elapsedWallClockMs: 0,
      },
      requestId: 'req-corrupt',
      projectOrMissionId: 'atlas',
      provider: 'anthropic',
      model: 'claude-sonnet',
      currency: 'USD',
      estimatedCostMinor: 100,
      dailyCapMinor: 1000,
      now: new Date('2026-08-06T10:00:00.000Z'),
      ianaTimezone: 'UTC',
      sourceReceiptHash: 'sha256:test',
      invokeProvider: async () => {
        invocationCount += 1;
        return { result: 'should never happen', actualCostMinor: 100 };
      },
      rootDir: dir,
    });

    expect(verdict.ok).toBe(false);
    if (verdict.ok) throw new Error('unreachable');
    expect(verdict.reason).toBe('state_unavailable');
    expect(invocationCount).toBe(0);
  });

  it('11. missing/unwritable state root rejects paid calls (does not silently fall back)', async () => {
    // rootDir points at a FILE, not a directory — mkdir underneath it must fail,
    // simulating a truly broken/inaccessible state root rather than "day one".
    const brokenRoot = join(dir, 'not-a-directory');
    writeFileSync(brokenRoot, 'i am a file, not a directory', 'utf8');

    await expect(reserve(baseReserveInput({ rootDir: join(brokenRoot, 'nested'), estimatedCostMinor: 50 })))
      .rejects.toBeInstanceOf(SpendStateRootUnavailableError);
  });

  it('11b. an empty but VALID root bootstraps day one instead of refusing (the documented safe-bootstrap rule)', async () => {
    const freshDir = join(dir, 'never-touched-before');
    const result = await reserve(baseReserveInput({ rootDir: freshDir, estimatedCostMinor: 50 }));
    expect(result.ok).toBe(true);
  });
});

describe('spend ledger — cap enforcement and concurrency', () => {
  it('2. reservation exceeding cap rejected BEFORE any provider invocation', async () => {
    const order = baseWorkOrder();
    const signed = signWorkOrder(order, signer);
    let invocationCount = 0;

    const verdict = await runSpendPreflight({
      signedWorkOrder: signed,
      scopeContext: {
        verifier,
        executorIdentity: order.executorIdentity,
        repoCanonicalPath: order.repoCanonicalPath,
        baseHead: order.baseHead,
        attemptNumber: 1,
        elapsedWallClockMs: 0,
      },
      requestId: 'req-over-cap',
      projectOrMissionId: 'atlas',
      provider: 'anthropic',
      model: 'claude-sonnet',
      currency: 'USD',
      estimatedCostMinor: 2000,
      dailyCapMinor: 1000,
      now: new Date('2026-08-06T10:00:00.000Z'),
      ianaTimezone: 'UTC',
      sourceReceiptHash: 'sha256:test',
      invokeProvider: async () => {
        invocationCount += 1;
        return { result: 'should never happen', actualCostMinor: 2000 };
      },
      rootDir: dir,
    });

    expect(verdict.ok).toBe(false);
    if (verdict.ok) throw new Error('unreachable');
    expect(verdict.reason).toBe('cap_exceeded');
    expect(invocationCount).toBe(0); // the whole point: rejected BEFORE the call
  });

  it('12. concurrent reservation attempts cannot exceed the cap (interleaving proof)', async () => {
    const now = new Date('2026-08-06T10:00:00.000Z');
    const attempts = [0, 1, 2, 3, 4].map((i) =>
      reserve(baseReserveInput({ requestId: `req-concurrent-${i}`, estimatedCostMinor: 300, dailyCapMinor: 1000 })),
    );
    const results = await Promise.all(attempts);

    const accepted = results.filter((r) => r.ok);
    const rejected = results.filter((r) => !r.ok);
    const acceptedTotal = accepted.reduce((sum, r) => sum + (r.ok ? r.record.reservedMinor : 0), 0);

    expect(acceptedTotal).toBeLessThanOrEqual(1000);
    expect(acceptedTotal).toBe(900); // exactly 3 of 5 at 300 each fit under 1000
    expect(accepted.length).toBe(3);
    expect(rejected.length).toBe(2);

    const total = getDailyTotal('2026-08-06', 'UTC', dir);
    expect(total.dailyTotalMinor).toBe(acceptedTotal);
    expect(total.dailyTotalMinor).toBeLessThanOrEqual(1000);
  });
});

describe('spend ledger — accounting day / timezone', () => {
  it('13. day rollover uses the injected clock + IANA timezone, not host-local time', () => {
    // 2026-08-06T21:30:00Z is 2026-08-07 in Asia/Baku (UTC+4) but still 2026-08-06 in America/New_York (UTC-4).
    const instant = new Date('2026-08-06T21:30:00.000Z');
    expect(computeAccountingDay(instant, 'Asia/Baku')).toBe('2026-08-07');
    expect(computeAccountingDay(instant, 'America/New_York')).toBe('2026-08-06');
  });

  it('13b. reservations in different timezones land in different day files', async () => {
    const instant = new Date('2026-08-06T21:30:00.000Z');
    const baku = await reserve(baseReserveInput({ requestId: 'req-baku', now: instant, ianaTimezone: 'Asia/Baku', estimatedCostMinor: 100 }));
    const ny = await reserve(baseReserveInput({ requestId: 'req-ny', now: instant, ianaTimezone: 'America/New_York', estimatedCostMinor: 100 }));
    expect(baku.ok).toBe(true);
    expect(ny.ok).toBe(true);
    expect(getDailyTotal('2026-08-07', 'Asia/Baku', dir).dailyTotalMinor).toBe(100);
    expect(getDailyTotal('2026-08-06', 'America/New_York', dir).dailyTotalMinor).toBe(100);
  });

  it('14. midnight restart does not lose previous-day evidence', async () => {
    const beforeMidnight = new Date('2026-08-06T23:58:00.000Z');
    const afterMidnight = new Date('2026-08-07T00:02:00.000Z');

    const reserved = await reserve(baseReserveInput({
      requestId: 'req-midnight', now: beforeMidnight, ianaTimezone: 'UTC', estimatedCostMinor: 400,
    }));
    expect(reserved.ok).toBe(true);

    // Simulate restart.
    vi.resetModules();
    const fresh = await import('../atlas/spend/index.js');

    // Commit arrives after local midnight — must still resolve against 2026-08-06's record.
    const committed = await fresh.commit({
      requestId: 'req-midnight', actualMinor: 400, now: afterMidnight, ianaTimezone: 'UTC', rootDir: dir,
    });
    expect(committed.ok).toBe(true);

    const prevDayTotal = fresh.getDailyTotal('2026-08-06', 'UTC', dir);
    const nextDayTotal = fresh.getDailyTotal('2026-08-07', 'UTC', dir);
    expect(prevDayTotal.dailyTotalMinor).toBe(400); // evidence preserved on the day it was reserved
    expect(nextDayTotal.dailyTotalMinor).toBe(0); // not misattributed to the new day
  });
});

describe('spend ledger — pending reconciliation', () => {
  it('an interrupted reservation can be marked PENDING_RECONCILIATION and still counts against the cap', async () => {
    await reserve(baseReserveInput({ estimatedCostMinor: 500 }));
    const marked = await markPendingReconciliation({
      requestId: 'req-1', reason: 'process died mid-call (test)', now: baseReserveInput().now, ianaTimezone: 'UTC', rootDir: dir,
    });
    expect(marked.ok).toBe(true);
    if (!marked.ok) throw new Error('unreachable');
    expect(marked.record.status).toBe('PENDING_RECONCILIATION');
    const total = getDailyTotal('2026-08-06', 'UTC', dir);
    expect(total.dailyTotalMinor).toBe(500); // never silently vanishes
  });
});

describe('spend ledger — money rule: no floating point in the money path', () => {
  it('rejects non-integer minor-unit amounts outright', async () => {
    await expect(reserve(baseReserveInput({ estimatedCostMinor: 10.5 })))
      .rejects.toBeInstanceOf(SpendValidationError);
  });

  it('repeated cent-level commits sum exactly, with no float drift', async () => {
    // Classic float trap: 0.1 + 0.2 !== 0.3 in IEEE754. In integer minor units it must be exact.
    for (let i = 0; i < 3; i += 1) {
      await reserve(baseReserveInput({ requestId: `req-cents-${i}`, estimatedCostMinor: 10, dailyCapMinor: 100 }));
      await commit({ requestId: `req-cents-${i}`, actualMinor: 10, now: baseReserveInput().now, ianaTimezone: 'UTC', rootDir: dir });
    }
    const total = getDailyTotal('2026-08-06', 'UTC', dir);
    expect(total.dailyTotalMinor).toBe(30);
    expect(Number.isInteger(total.dailyTotalMinor)).toBe(true);
  });
});
