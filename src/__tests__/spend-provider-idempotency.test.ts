/**
 * spend-provider-idempotency.test.ts — P1-B repair (2026-08-06):
 * provider-invocation idempotency.
 *
 * THE DEFECT: runSpendPreflight() used to invoke the injected provider port
 * unconditionally after any successful reserve() — including a REPLAYED
 * requestId whose reserve() call merely returned an already-COMMITTED
 * record (`idempotent: true`). The ledger itself never double-charged, but
 * a real provider adapter would have received a second real call for one
 * logical requestId.
 *
 * THE FIX: an explicit invocation-claim lifecycle
 * (RESERVED -> INVOCATION_STARTED -> COMMITTED | RELEASED | REJECTED |
 * PENDING_RECONCILIATION) — see atlas/spend/types.ts and
 * atlas/spend/ledger.ts's claimProviderInvocation(). Within one
 * spend-authority namespace, one requestId maps to AT MOST ONE provider
 * invocation, surviving replay, restart, concurrent duplicates, and a crash
 * between claiming the invocation and committing its result.
 *
 * No real provider and no network anywhere in this file — `invokeProvider`
 * is always a local fake (in-process) or a disposable child-process fake
 * (live proof section) that increments a counter / appends to a local
 * evidence file. All state lives under per-test/per-scenario temp
 * directories passed explicitly as `rootDir`.
 */

import {
  afterEach, beforeEach, describe, expect, it, vi,
} from 'vitest';
import {
  copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync,
} from 'node:fs';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  reserve,
  commit,
  release,
  markPendingReconciliation,
  claimProviderInvocation,
  getDailyTotal,
  resolveDayFilePath,
  runSpendPreflight,
  verifyRecordIntegrity,
  type SpendPreflightInput,
} from '../atlas/spend/index.js';
import {
  hmacSigner,
  hmacVerifier,
  signWorkOrder,
  type WorkOrder,
} from '../atlas/work-order/index.js';
import { appendClaim, hashPayload } from '../evidence/ledger.js';

const TEST_KEY = 'test-fake-spend-idempotency-key-not-real-do-not-use';
const signer = hmacSigner(TEST_KEY);
const verifier = hmacVerifier(TEST_KEY);

const WORKTREE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

function baseWorkOrder(overrides: Partial<WorkOrder> = {}): WorkOrder {
  const now = Date.now();
  return {
    workOrderId: 'wo_spend-idem-test',
    goalId: 'goal-p1b-repair',
    taskId: 'task-spend-idempotency',
    issuerIdentity: 'atlas-planner',
    executorIdentity: 'atlas-executor',
    repoCanonicalPath: 'C:/repo/ANUS',
    baseBranch: 'codex/p1b-spend-cap',
    baseHead: '6f07a5d',
    worktreePath: 'C:/repo/ANUS/.worktrees/p1b-spend-cap',
    issuedAt: new Date(now).toISOString(),
    expiresAt: new Date(now + 60 * 60 * 1000).toISOString(),
    nonce: 'nonce-spend-idem-test',
    allowedPaths: [],
    forbiddenPaths: [],
    forbiddenActions: [],
    allowedCommandClasses: ['fake-provider', 'anthropic', 'nvidia'],
    maxAttempts: 5,
    maxWallClockMs: 20 * 60 * 1000,
    expectedTests: ['src/__tests__/spend-provider-idempotency.test.ts'],
    evidenceRequirements: ['exit-code'],
    rollbackMethod: 'none',
    ...overrides,
  };
}

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'atlas-spend-idem-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

interface FakeProvider {
  invoke: () => Promise<{ result: unknown; actualCostMinor: number }>;
  count: () => number;
}

function makeFakeProvider(resultFactory: () => unknown, actualCostMinor: number, opts: { throws?: boolean } = {}): FakeProvider {
  let calls = 0;
  return {
    invoke: async () => {
      calls += 1;
      if (opts.throws) throw new Error('fake provider: simulated failure');
      return { result: resultFactory(), actualCostMinor };
    },
    count: () => calls,
  };
}

function preflightInput(overrides: {
  requestId: string;
  invokeProvider: SpendPreflightInput['invokeProvider'];
  now?: Date;
  estimatedCostMinor?: number;
  dailyCapMinor?: number;
  provider?: string;
  model?: string;
  currency?: string;
  projectOrMissionId?: string;
  sourceReceiptHash?: string;
}): SpendPreflightInput {
  const order = baseWorkOrder();
  const signed = signWorkOrder(order, signer);
  const now = overrides.now ?? new Date('2026-08-06T12:00:00.000Z');
  return {
    signedWorkOrder: signed,
    scopeContext: {
      verifier,
      executorIdentity: order.executorIdentity,
      repoCanonicalPath: order.repoCanonicalPath,
      baseHead: order.baseHead,
      attemptNumber: 1,
      elapsedWallClockMs: 0,
    },
    requestId: overrides.requestId,
    projectOrMissionId: overrides.projectOrMissionId ?? 'atlas',
    provider: overrides.provider ?? 'fake-provider',
    model: overrides.model ?? 'fake-model',
    currency: overrides.currency ?? 'USD',
    estimatedCostMinor: overrides.estimatedCostMinor ?? 500,
    dailyCapMinor: overrides.dailyCapMinor ?? 10_000,
    now,
    ianaTimezone: 'UTC',
    sourceReceiptHash: overrides.sourceReceiptHash ?? `sha256:fake-${overrides.requestId}`,
    invokeProvider: overrides.invokeProvider,
    rootDir: dir,
  };
}

// ── 1-12: the twelve required invariant proofs ─────────────────────────────

describe('spend provider-invocation idempotency', () => {
  it('1. replay of a COMMITTED requestId returns the stored result without invoking the provider again', async () => {
    const provider = makeFakeProvider(() => ({ echoed: 'first-call' }), 35);
    const input = preflightInput({ requestId: 'req-replay-committed', invokeProvider: provider.invoke, estimatedCostMinor: 40 });

    const first = await runSpendPreflight(input);
    expect(first.ok).toBe(true);
    if (!first.ok) throw new Error('unreachable');
    expect(first.idempotentReplay).toBe(false);
    expect(provider.count()).toBe(1);

    const second = await runSpendPreflight(input);
    expect(second.ok).toBe(true);
    if (!second.ok) throw new Error('unreachable');
    expect(second.idempotentReplay).toBe(true);
    expect(second.result).toEqual({ echoed: 'first-call' });
    expect(provider.count()).toBe(1); // UNCHANGED — no second invocation
    expect(second.record.committedMinor).toBe(35);
  });

  it('2. replay after a restart (fresh module instance, no in-memory state) does not invoke the provider', async () => {
    const provider = makeFakeProvider(() => 'restart-result', 20);
    const input = preflightInput({ requestId: 'req-replay-restart', invokeProvider: provider.invoke, estimatedCostMinor: 25 });
    const first = await runSpendPreflight(input);
    expect(first.ok).toBe(true);
    expect(provider.count()).toBe(1);

    vi.resetModules();
    const fresh = await import('../atlas/spend/index.js');
    const second = await fresh.runSpendPreflight({ ...input, invokeProvider: provider.invoke });
    expect(second.ok).toBe(true);
    if (!second.ok) throw new Error('unreachable');
    expect(second.idempotentReplay).toBe(true);
    expect(provider.count()).toBe(1); // still 1 — the fresh module instance has no cache to have lost
  });

  it('3. two concurrent preflight calls for the same requestId cause at most ONE provider invocation', async () => {
    const provider = makeFakeProvider(() => 'concurrent-result', 15);
    const requestId = 'req-concurrent-same-id';
    const inputA = preflightInput({ requestId, invokeProvider: provider.invoke, estimatedCostMinor: 15 });
    const inputB = preflightInput({ requestId, invokeProvider: provider.invoke, estimatedCostMinor: 15 });

    const [a, b] = await Promise.all([runSpendPreflight(inputA), runSpendPreflight(inputB)]);

    expect(provider.count()).toBe(1); // the core invariant, regardless of which call "won"
    const results = [a, b];
    const invokedThisCall = results.filter((r) => r.ok && r.idempotentReplay === false);
    expect(invokedThisCall.length).toBe(1);
    const other = results.find((r) => r !== invokedThisCall[0]);
    if (!other) throw new Error('unreachable');
    if (other.ok) {
      expect(other.idempotentReplay).toBe(true); // saw it already COMMITTED
    } else {
      expect(['invocation_in_progress', 'pending_reconciliation']).toContain(other.reason);
    }

    const total = getDailyTotal('2026-08-06', 'UTC', dir);
    expect(total.dailyTotalMinor).toBe(15); // committed exactly once, never double-added
  });

  it('4. a claim left in INVOCATION_STARTED (simulated crash before commit) is moved to PENDING_RECONCILIATION only by an EXPLICIT reconciliation call, never by the claim itself', async () => {
    const requestId = 'req-crash-mid-invocation';
    const now = new Date('2026-08-06T12:00:00.000Z');
    const reserved = await reserve({
      requestId, now, ianaTimezone: 'UTC', projectOrMissionId: 'atlas', workOrderId: 'wo-crash',
      provider: 'fake-provider', model: 'fake-model', currency: 'USD', estimatedCostMinor: 50,
      dailyCapMinor: 1000, sourceReceiptHash: 'sha256:crash-test', rootDir: dir,
    });
    expect(reserved.ok).toBe(true);

    const claimed = await claimProviderInvocation({ requestId, now, ianaTimezone: 'UTC', rootDir: dir });
    expect(claimed.ok).toBe(true);
    if (!claimed.ok) throw new Error('unreachable');
    expect(claimed.outcome).toBe('claimed');
    expect(claimed.record.status).toBe('INVOCATION_STARTED');

    // SIMULATED CRASH: the process dies here — no provider call, no commit,
    // no release happens automatically. The record stays exactly as written.
    const stillClaimed = await claimProviderInvocation({ requestId, now, ianaTimezone: 'UTC', rootDir: dir });
    expect(stillClaimed.ok).toBe(false);
    if (stillClaimed.ok) throw new Error('unreachable');
    expect(stillClaimed.reason).toBe('invocation_in_progress'); // NOT auto-flipped to PENDING_RECONCILIATION

    // Recovery is an explicit, separate call — never automatic.
    const recovered = await markPendingReconciliation({
      requestId, reason: 'simulated crash: INVOCATION_STARTED observed with no result on recovery', now, ianaTimezone: 'UTC', rootDir: dir,
    });
    expect(recovered.ok).toBe(true);
    if (!recovered.ok) throw new Error('unreachable');
    expect(recovered.record.status).toBe('PENDING_RECONCILIATION');
    expect(verifyRecordIntegrity(recovered.record)).toBe(true);
  });

  it('5. PENDING_RECONCILIATION blocks any automatic retry — a plain preflight attempt refuses without invoking the provider', async () => {
    const requestId = 'req-pending-blocks-retry';
    const now = new Date('2026-08-06T12:00:00.000Z');
    await reserve({ requestId, now, ianaTimezone: 'UTC', projectOrMissionId: 'atlas', workOrderId: 'wo-x', provider: 'fake-provider', model: 'fake-model', currency: 'USD', estimatedCostMinor: 60, dailyCapMinor: 1000, sourceReceiptHash: 'sha256:x', rootDir: dir });
    await claimProviderInvocation({ requestId, now, ianaTimezone: 'UTC', rootDir: dir });
    await markPendingReconciliation({ requestId, reason: 'test setup', now, ianaTimezone: 'UTC', rootDir: dir });

    const provider = makeFakeProvider(() => 'should-never-run', 60);
    const retry = await runSpendPreflight(preflightInput({ requestId, invokeProvider: provider.invoke, estimatedCostMinor: 60, now }));
    expect(retry.ok).toBe(false);
    if (retry.ok) throw new Error('unreachable');
    expect(retry.reason).toBe('pending_reconciliation');
    expect(provider.count()).toBe(0); // NEVER invoked — no automatic retry
  });

  it('6. an unresolved PENDING_RECONCILIATION charge still reduces available headroom against the cap', async () => {
    const requestId = 'req-headroom';
    const now = new Date('2026-08-06T12:00:00.000Z');
    await reserve({ requestId, now, ianaTimezone: 'UTC', projectOrMissionId: 'atlas', workOrderId: 'wo-x', provider: 'fake-provider', model: 'fake-model', currency: 'USD', estimatedCostMinor: 70, dailyCapMinor: 100, sourceReceiptHash: 'sha256:x', rootDir: dir });
    await claimProviderInvocation({ requestId, now, ianaTimezone: 'UTC', rootDir: dir });
    await markPendingReconciliation({ requestId, reason: 'test setup', now, ianaTimezone: 'UTC', rootDir: dir });

    const total = getDailyTotal('2026-08-06', 'UTC', dir);
    expect(total.dailyTotalMinor).toBe(70); // still counted, worst case: assume it WAS charged
    const headroom = total.dailyCapMinor - total.dailyTotalMinor;
    expect(headroom).toBe(30);

    // A second, unrelated request cannot exceed the remaining headroom.
    const secondReserve = await reserve({ requestId: 'req-headroom-2', now, ianaTimezone: 'UTC', projectOrMissionId: 'atlas', workOrderId: 'wo-x', provider: 'fake-provider', model: 'fake-model', currency: 'USD', estimatedCostMinor: 31, dailyCapMinor: 100, sourceReceiptHash: 'sha256:x2', rootDir: dir });
    expect(secondReserve.ok).toBe(false);
    const thirdReserve = await reserve({ requestId: 'req-headroom-3', now, ianaTimezone: 'UTC', projectOrMissionId: 'atlas', workOrderId: 'wo-x', provider: 'fake-provider', model: 'fake-model', currency: 'USD', estimatedCostMinor: 30, dailyCapMinor: 100, sourceReceiptHash: 'sha256:x3', rootDir: dir });
    expect(thirdReserve.ok).toBe(true); // exactly the remaining headroom fits
  });

  it('7. a RELEASED requestId is terminal — it cannot be silently recycled for a new invocation', async () => {
    const requestId = 'req-released-terminal';
    const now = new Date('2026-08-06T12:00:00.000Z');
    await reserve({ requestId, now, ianaTimezone: 'UTC', projectOrMissionId: 'atlas', workOrderId: 'wo-x', provider: 'fake-provider', model: 'fake-model', currency: 'USD', estimatedCostMinor: 10, dailyCapMinor: 1000, sourceReceiptHash: 'sha256:x', rootDir: dir });
    const released = await release({ requestId, now, ianaTimezone: 'UTC', rootDir: dir });
    expect(released.ok).toBe(true);

    const provider = makeFakeProvider(() => 'should-never-run', 10);
    const attempt = await runSpendPreflight(preflightInput({ requestId, invokeProvider: provider.invoke, estimatedCostMinor: 10, now }));
    expect(attempt.ok).toBe(false);
    if (attempt.ok) throw new Error('unreachable');
    expect(attempt.reason).toBe('terminal_request_id');
    expect(provider.count()).toBe(0);
  });

  it('8. a genuinely new requestId invokes the provider normally', async () => {
    const provider = makeFakeProvider(() => 'fresh-result', 12);
    const attempt = await runSpendPreflight(preflightInput({ requestId: 'req-brand-new', invokeProvider: provider.invoke, estimatedCostMinor: 12 }));
    expect(attempt.ok).toBe(true);
    if (!attempt.ok) throw new Error('unreachable');
    expect(attempt.idempotentReplay).toBe(false);
    expect(provider.count()).toBe(1);
    expect(attempt.record.status).toBe('COMMITTED');
  });

  it('9. a tampered stored COMMITTED record is deterministically rejected, never served as a valid replay and never re-triggers an invocation', async () => {
    const provider = makeFakeProvider(() => ({ ok: true }), 25);
    const requestId = 'req-tamper-committed';
    const now = new Date('2026-08-06T12:00:00.000Z');
    const first = await runSpendPreflight(preflightInput({ requestId, invokeProvider: provider.invoke, estimatedCostMinor: 25, now }));
    expect(first.ok).toBe(true);

    // This test's rootDir is already a disposable per-test temp directory
    // (nothing else reads it afterward), so tampering it directly is safe.
    const filePath = resolveDayFilePath('2026-08-06', dir);
    const raw = JSON.parse(readFileSync(filePath, 'utf8')) as { records: Record<string, { committedResult?: unknown }> };
    raw.records[requestId]!.committedResult = { ok: false, tampered: true };
    writeFileSync(filePath, JSON.stringify(raw, null, 2), 'utf8');

    const claim1 = await claimProviderInvocation({ requestId, now, ianaTimezone: 'UTC', rootDir: dir });
    const claim2 = await claimProviderInvocation({ requestId, now, ianaTimezone: 'UTC', rootDir: dir });
    expect(claim1.ok).toBe(false);
    expect(claim2.ok).toBe(false);
    if (claim1.ok || claim2.ok) throw new Error('unreachable');
    expect(claim1.reason).toBe('integrity_violation');
    expect(claim2.reason).toBe('integrity_violation'); // deterministic — same REJECT every time
    expect(provider.count()).toBe(1); // tampering after the fact never triggers a re-invocation
  });

  it('10. requestId identity is immutable post-reservation — a different requestId never resolves to an existing record, and re-reservation cannot change the bound identity', async () => {
    const now = new Date('2026-08-06T12:00:00.000Z');
    await reserve({ requestId: 'req-fixed-identity', now, ianaTimezone: 'UTC', projectOrMissionId: 'atlas', workOrderId: 'wo-original', provider: 'fake-provider', model: 'fake-model', currency: 'USD', estimatedCostMinor: 20, dailyCapMinor: 1000, sourceReceiptHash: 'sha256:original', rootDir: dir });

    // A caller cannot "rename" a reservation onto a different requestId —
    // claiming an unregistered id is simply not_found, never a fallback
    // match onto some other record.
    const claimWrongId = await claimProviderInvocation({ requestId: 'req-different-identity', now, ianaTimezone: 'UTC', rootDir: dir });
    expect(claimWrongId.ok).toBe(false);
    if (claimWrongId.ok) throw new Error('unreachable');
    expect(claimWrongId.reason).toBe('not_found');

    // Re-reserving the SAME requestId with different attributes does not
    // mutate the original bound identity — first call's values win (the
    // pre-existing "first wins" invariant, re-affirmed here because the
    // invocation-claim path now depends on it too).
    const second = await reserve({ requestId: 'req-fixed-identity', now, ianaTimezone: 'UTC', projectOrMissionId: 'atlas', workOrderId: 'wo-DIFFERENT', provider: 'other-provider', model: 'other-model', currency: 'USD', estimatedCostMinor: 999, dailyCapMinor: 1000, sourceReceiptHash: 'sha256:different', rootDir: dir });
    expect(second.ok).toBe(true);
    if (!second.ok) throw new Error('unreachable');
    expect(second.idempotent).toBe(true);
    expect(second.record.workOrderId).toBe('wo-original');
    expect(second.record.provider).toBe('fake-provider');
  });

  it('11. a provider exception moves the record to PENDING_RECONCILIATION — invocation evidence is never silently erased, and no automatic retry follows', async () => {
    const provider = makeFakeProvider(() => 'unused', 0, { throws: true });
    const requestId = 'req-provider-throws';
    const now = new Date('2026-08-06T12:00:00.000Z');
    const attempt = await runSpendPreflight(preflightInput({ requestId, invokeProvider: provider.invoke, estimatedCostMinor: 45, now }));
    expect(attempt.ok).toBe(false);
    if (attempt.ok) throw new Error('unreachable');
    if (attempt.reason !== 'provider_invocation_failed') throw new Error(`unreachable: got reason ${attempt.reason}`);
    expect(attempt.reason).toBe('provider_invocation_failed');
    expect(attempt.record.status).toBe('PENDING_RECONCILIATION');
    expect(provider.count()).toBe(1);

    const total = getDailyTotal('2026-08-06', 'UTC', dir);
    expect(total.dailyTotalMinor).toBe(45); // still counted — never silently released

    const retry = await runSpendPreflight(preflightInput({ requestId, invokeProvider: provider.invoke, estimatedCostMinor: 45, now }));
    expect(retry.ok).toBe(false);
    if (retry.ok) throw new Error('unreachable');
    expect(retry.reason).toBe('pending_reconciliation');
    expect(provider.count()).toBe(1); // unchanged — no automatic retry
  });

  it('12. the free-provider (zero-cost) path still obeys invocation idempotency — a replay never re-invokes just because the cost is $0', async () => {
    const provider = makeFakeProvider(() => 'free-result', 0);
    const requestId = 'req-free-zero-cost';
    const now = new Date('2026-08-06T12:00:00.000Z');
    const input = preflightInput({ requestId, invokeProvider: provider.invoke, provider: 'nvidia', estimatedCostMinor: 0, now });

    const first = await runSpendPreflight(input);
    expect(first.ok).toBe(true);
    if (!first.ok) throw new Error('unreachable');
    expect(first.record.committedMinor).toBe(0);
    expect(provider.count()).toBe(1);

    const second = await runSpendPreflight(input);
    expect(second.ok).toBe(true);
    if (!second.ok) throw new Error('unreachable');
    expect(second.idempotentReplay).toBe(true);
    expect(provider.count()).toBe(1); // still 1 — zero cost is not an excuse to skip the claim
  });
});

// ── FORBIDDEN mechanisms — provably absent (source scan) ───────────────────

describe('provider-invocation idempotency — forbidden escape hatches are provably absent', () => {
  const FORBIDDEN_PATTERNS: RegExp[] = [
    /new\s+Set\s*\(/,             // in-memory Set as the dedup authority
    /alreadyCalled/i,             // caller-provided "already called" flag
    /process\.env/,               // environment bypass
    /invocationCount\s*\+\+/,     // an ad hoc in-memory invocation counter
    /\.has\(\s*requestId\s*\)/i,  // in-memory requestId membership check standing in for the durable record
  ];
  const SCANNED_FILES = [
    'src/atlas/spend/ledger.ts',
    'src/atlas/spend/preflight.ts',
  ];

  it('no in-memory Set, caller-supplied flag, env bypass, or ad hoc counter exists in the invocation-claim path', () => {
    for (const relPath of SCANNED_FILES) {
      const source = readFileSync(join(WORKTREE_ROOT, relPath), 'utf8');
      for (const pattern of FORBIDDEN_PATTERNS) {
        expect(pattern.test(source), `${relPath} must not match ${pattern}`).toBe(false);
      }
    }
  });

  it('preflight.ts claims the invocation right (durable write) strictly BEFORE it ever calls the provider port', () => {
    const source = readFileSync(join(WORKTREE_ROOT, 'src/atlas/spend/preflight.ts'), 'utf8');
    const claimIdx = source.indexOf('claimProviderInvocation({');
    const invokeIdx = source.indexOf('input.invokeProvider()');
    expect(claimIdx).toBeGreaterThan(-1);
    expect(invokeIdx).toBeGreaterThan(-1);
    expect(claimIdx).toBeLessThan(invokeIdx);
  });

  it('ledger.ts never itself calls a provider port — the invocation right it claims is enforced entirely via the durable `status` field, dedup is never deferred until after a provider responds', () => {
    const source = readFileSync(join(WORKTREE_ROOT, 'src/atlas/spend/ledger.ts'), 'utf8');
    expect(source).not.toMatch(/invokeProvider/);
    expect(source).not.toMatch(/fetch\(/);
  });
});

// ── Live repair proof (fake provider, disposable state root, evidence pack) ─

const TSX_CLI = join(WORKTREE_ROOT, 'node_modules', 'tsx', 'dist', 'cli.mjs');

interface ChildProbeResult {
  pid: number;
  reserveOk: boolean;
  claimOk: boolean;
  outcome: string;
  invoked: boolean;
  committedMinor: number | null;
}

/**
 * Spawn a genuinely separate `node` process (via tsx) that runs
 * reserve() -> claimProviderInvocation() -> (commit() iff it won the claim
 * AND mode requests it). This is the SAME real-child-process mechanism the
 * P1-B wave-2 live proof used (readTotalInFreshProcess in
 * spend-override-and-proof.test.ts), extended to exercise the invocation
 * claim rather than just a read. Uses `spawn` (not `spawnSync`) so two
 * children can be started back-to-back and race for real — true OS-level
 * concurrency, not an in-process Promise.all simulation.
 */
function spawnClaimProbe(args: {
  rootDir: string;
  requestId: string;
  mode: 'claim-only' | 'claim-invoke-commit';
  nowIso: string;
  estimatedCostMinor: number;
  dailyCapMinor: number;
  actualCostMinor: number;
  invocationsLogPath: string;
}): { scriptPath: string; done: Promise<ChildProbeResult> } {
  const scriptPath = join(WORKTREE_ROOT, `.tmp-p1b-idem-probe-${randomUUID().slice(0, 8)}.mts`);
  const probeSource = [
    "import { reserve, claimProviderInvocation, commit } from './src/atlas/spend/index.js';",
    "import { appendFileSync } from 'node:fs';",
    'const [, , rootDir, requestId, mode, nowIso, estimatedCostMinorStr, dailyCapMinorStr, actualCostMinorStr, invocationsLogPath] = process.argv;',
    'const now = new Date(nowIso);',
    'const estimatedCostMinor = Number(estimatedCostMinorStr);',
    'const dailyCapMinor = Number(dailyCapMinorStr);',
    'const actualCostMinor = Number(actualCostMinorStr);',
    'const reserveResult = await reserve({ requestId, now, ianaTimezone: "UTC", projectOrMissionId: "p1b-idem-live", workOrderId: "wo-p1b-idem-live", provider: "fake-provider", model: "fake-model", currency: "USD", estimatedCostMinor, dailyCapMinor, sourceReceiptHash: `sha256:fake-${requestId}`, rootDir });',
    'const claim = await claimProviderInvocation({ requestId, now, ianaTimezone: "UTC", rootDir });',
    'let invoked = false;',
    'let committedMinor = null;',
    'if (claim.ok && claim.outcome === "claimed" && mode === "claim-invoke-commit") {',
    '  invoked = true;',
    '  appendFileSync(invocationsLogPath, `${process.pid}:${requestId}\\n`);',
    '  const committed = await commit({ requestId, actualMinor: actualCostMinor, now, ianaTimezone: "UTC", rootDir, resultForReplay: { pid: process.pid, requestId } });',
    '  committedMinor = committed.ok ? committed.record.committedMinor : null;',
    '}',
    'process.stdout.write(JSON.stringify({ pid: process.pid, reserveOk: reserveResult.ok, claimOk: claim.ok, outcome: claim.ok ? claim.outcome : claim.reason, invoked, committedMinor }));',
    '',
  ].join('\n');
  writeFileSync(scriptPath, probeSource, 'utf8');

  const done = new Promise<ChildProbeResult>((resolveP, rejectP) => {
    const child = spawn(
      process.execPath,
      [
        TSX_CLI, scriptPath, args.rootDir, args.requestId, args.mode, args.nowIso,
        String(args.estimatedCostMinor), String(args.dailyCapMinor), String(args.actualCostMinor), args.invocationsLogPath,
      ],
      { cwd: WORKTREE_ROOT, windowsHide: true },
    );
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d: Buffer) => { stdout += d.toString(); });
    child.stderr.on('data', (d: Buffer) => { stderr += d.toString(); });
    child.on('error', rejectP);
    child.on('close', (code) => {
      if (code !== 0) {
        rejectP(new Error(`claim probe child process failed (exit ${code}) for requestId ${args.requestId}: ${stderr}`));
        return;
      }
      try {
        resolveP(JSON.parse(stdout) as ChildProbeResult);
      } catch (error) {
        rejectP(new Error(`claim probe child stdout was not valid JSON: ${stdout}: ${error instanceof Error ? error.message : String(error)}`));
      }
    });
  });

  return { scriptPath, done };
}

describe('P1-B repair — live provider-invocation-idempotency proof', () => {
  it('replay/restart/concurrency/crash/tamper all obey the one-requestId-one-invocation invariant across REAL child processes', async () => {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const evidenceDir = join(homedir(), '.atlas', 'quarantine', 'evidence', `p1b-idem-${stamp}-${randomUUID().slice(0, 8)}`);
    mkdirSync(evidenceDir, { recursive: true });
    const record = (kind: string, detail: Record<string, unknown>): void => {
      appendClaim(
        {
          claimId: `clm_p1b-idem-${kind}-${randomUUID().slice(0, 8)}`,
          claim: JSON.stringify({ kind, ...detail }),
          type: 'narrative',
          path: `p1b-idem-proof://${kind}`,
          confidence: 0,
          source: 'spend-provider-idempotency-live-proof',
          sourceRef: 'p1b-idem-repair',
          ts: new Date().toISOString(),
        },
        evidenceDir,
      );
    };

    const stateRoot = mkdtempSync(join(tmpdir(), 'p1b-idem-state-'));
    const invocationsLogPath = join(evidenceDir, 'invocations.log');
    const nowIso = '2026-08-06T11:00:00.000Z';
    const now = new Date(nowIso);
    const accountingDay = '2026-08-06';
    const ianaTimezone = 'UTC';
    const dailyCapMinor = 1000;
    const tmpScripts: string[] = [];
    const trackedProbes: Array<{ scriptPath: string; done: Promise<ChildProbeResult> }> = [];
    function probe(args: Omit<Parameters<typeof spawnClaimProbe>[0], 'rootDir' | 'dailyCapMinor' | 'invocationsLogPath'>): Promise<ChildProbeResult> {
      const p = spawnClaimProbe({ ...args, rootDir: stateRoot, dailyCapMinor, invocationsLogPath });
      tmpScripts.push(p.scriptPath);
      trackedProbes.push(p);
      return p.done;
    }

    try {
      // ── 0. genesis ────────────────────────────────────────────────────
      const genesisTotal = getDailyTotal(accountingDay, ianaTimezone, stateRoot);
      expect(genesisTotal.recordCount).toBe(0);
      record('genesis', { genesisTotal });

      // ── 1. request A: claim + invoke + commit 35, in-process ─────────
      const reserveA = await reserve({
        requestId: 'req-A', now, ianaTimezone, projectOrMissionId: 'p1b-idem-live', workOrderId: 'wo-p1b-idem-live',
        provider: 'fake-provider', model: 'fake-model', currency: 'USD', estimatedCostMinor: 40, dailyCapMinor,
        sourceReceiptHash: 'sha256:fake-req-A', rootDir: stateRoot,
      });
      expect(reserveA.ok).toBe(true);
      const claimA = await claimProviderInvocation({ requestId: 'req-A', now, ianaTimezone, rootDir: stateRoot });
      expect(claimA.ok).toBe(true);
      if (!claimA.ok) throw new Error('unreachable');
      expect(claimA.outcome).toBe('claimed');
      let invocationCountA = 0;
      invocationCountA += 1; // the ONE fake-provider "call" — never real network
      const commitA = await commit({ requestId: 'req-A', actualMinor: 35, now, ianaTimezone, rootDir: stateRoot, resultForReplay: { note: 'req-A first invocation' } });
      expect(commitA.ok).toBe(true);
      const afterACommitStateHash = hashPayload(readFileSync(resolveDayFilePath(accountingDay, stateRoot), 'utf8'));
      record('a-invoke-and-commit', { requestId: 'req-A', invocationCountA, committedMinor: 35, stateHash: afterACommitStateHash });

      // ── 2. replay A in-process — invocation count still 1 ────────────
      const replayAInProcess = await claimProviderInvocation({ requestId: 'req-A', now, ianaTimezone, rootDir: stateRoot });
      expect(replayAInProcess.ok).toBe(true);
      if (!replayAInProcess.ok) throw new Error('unreachable');
      expect(replayAInProcess.outcome).toBe('replay');
      // invocationCountA is NOT incremented — this line proves the point by omission.
      expect(invocationCountA).toBe(1);
      record('a-replay-in-process', { requestId: 'req-A', invocationCountAfter: invocationCountA, outcome: replayAInProcess.outcome });

      // ── 3. RESTART — real child `node` process — replay A again ──────
      const preRestartHash = hashPayload(readFileSync(resolveDayFilePath(accountingDay, stateRoot), 'utf8'));
      const restartReplay = await probe({ requestId: 'req-A', mode: 'claim-invoke-commit', nowIso, estimatedCostMinor: 40, actualCostMinor: 999999 });
      const postRestartHash = hashPayload(readFileSync(resolveDayFilePath(accountingDay, stateRoot), 'utf8'));
      expect(restartReplay.claimOk).toBe(true);
      expect(restartReplay.outcome).toBe('replay'); // the fresh OS process ALSO sees COMMITTED and refuses to invoke
      expect(restartReplay.invoked).toBe(false);
      expect(restartReplay.pid).not.toBe(process.pid); // proof this ran in a different OS process
      expect(postRestartHash).toBe(preRestartHash); // state on disk did not change across the restart+replay
      invocationCountA += restartReplay.invoked ? 1 : 0;
      expect(invocationCountA).toBe(1); // STILL 1 after a real process restart
      record('a-restart-boundary-and-replay', {
        mechanism: 'spawned a real child `node` process via tsx (node_modules/tsx/dist/cli.mjs) — a TRUE restart, not vi.resetModules()',
        parentPid: process.pid,
        childPid: restartReplay.pid,
        preRestartStateHash: preRestartHash,
        postRestartStateHash: postRestartHash,
        invocationCountAfterRestartReplay: invocationCountA,
      });

      // ── 4. two CONCURRENT real child processes race for request B ────
      const concurrentResults = await Promise.all([
        probe({ requestId: 'req-B', mode: 'claim-invoke-commit', nowIso, estimatedCostMinor: 60, actualCostMinor: 55 }),
        probe({ requestId: 'req-B', mode: 'claim-invoke-commit', nowIso, estimatedCostMinor: 60, actualCostMinor: 55 }),
      ]);
      const invocationLogLines = existsSync(invocationsLogPath)
        ? readFileSync(invocationsLogPath, 'utf8').split('\n').filter((l) => l.includes('req-B'))
        : [];
      expect(invocationLogLines.length).toBe(1); // exactly one of the two children actually invoked
      expect(concurrentResults.filter((r) => r.invoked).length).toBe(1);
      expect(concurrentResults[0]!.pid).not.toBe(concurrentResults[1]!.pid); // two genuinely different OS processes
      const totalAfterB = getDailyTotal(accountingDay, ianaTimezone, stateRoot);
      record('b-concurrent-real-processes', {
        mechanism: 'two real child `node` processes started back-to-back via node:child_process spawn (not spawnSync), racing on the SAME requestId against the SAME state root — true OS-level concurrency',
        childPids: concurrentResults.map((r) => r.pid),
        invocationLogLineCount: invocationLogLines.length,
        results: concurrentResults,
        dailyTotalAfterB: totalAfterB.dailyTotalMinor,
      });

      // ── 5. request C: claim only (simulated termination before commit) ─
      const claimOnlyC = await probe({ requestId: 'req-C', mode: 'claim-only', nowIso, estimatedCostMinor: 20, actualCostMinor: 20 });
      expect(claimOnlyC.claimOk).toBe(true);
      expect(claimOnlyC.outcome).toBe('claimed');
      expect(claimOnlyC.invoked).toBe(false); // the child deliberately stopped right after the durable claim write — simulated crash
      const totalAfterClaimC = getDailyTotal(accountingDay, ianaTimezone, stateRoot);
      const capBeforeReconciliation = totalAfterClaimC.dailyCapMinor;

      // "RESTART": the reconciliation step below runs in THIS (parent)
      // process — representing an operator/recovery process that starts
      // fresh with no memory of the dead child — and is the explicit,
      // non-automatic reconciliation call the invariant requires.
      const reconciledC = await markPendingReconciliation({
        requestId: 'req-C', reason: 'simulated child-process termination: INVOCATION_STARTED observed with no result on restart recovery', now, ianaTimezone, rootDir: stateRoot,
      });
      expect(reconciledC.ok).toBe(true);
      if (!reconciledC.ok) throw new Error('unreachable');
      expect(reconciledC.record.status).toBe('PENDING_RECONCILIATION');
      const totalAfterReconcileC = getDailyTotal(accountingDay, ianaTimezone, stateRoot);
      const headroomAfterC = capBeforeReconciliation - totalAfterReconcileC.dailyTotalMinor;
      // provider NOT invoked again: the invocations log gained zero lines for req-C.
      const cInvocationLines = existsSync(invocationsLogPath)
        ? readFileSync(invocationsLogPath, 'utf8').split('\n').filter((l) => l.includes('req-C'))
        : [];
      expect(cInvocationLines.length).toBe(0);
      record('c-crash-then-reconciliation', {
        mechanism: 'real child process claimed the invocation (durable INVOCATION_STARTED write) then exited WITHOUT committing — simulated termination between claim and invoke/commit; reconciliation is an explicit call in the parent process, never automatic',
        childPid: claimOnlyC.pid,
        dailyCapMinor: capBeforeReconciliation,
        dailyTotalMinorAfterReconciliation: totalAfterReconcileC.dailyTotalMinor,
        headroomAfterC,
        providerInvocationLinesForC: cInvocationLines.length,
      });
      expect(totalAfterReconcileC.dailyTotalMinor).toBe(totalAfterClaimC.dailyTotalMinor); // reconciliation does not change the counted amount, only the status
      expect(headroomAfterC).toBe(dailyCapMinor - totalAfterReconcileC.dailyTotalMinor);

      // ── 6. corrupt a COPY of ONE committed record → deterministic REJECT ─
      const corruptRoot = mkdtempSync(join(tmpdir(), 'p1b-idem-corrupt-'));
      const liveDayFilePath = resolveDayFilePath(accountingDay, stateRoot);
      const corruptDayFilePath = resolveDayFilePath(accountingDay, corruptRoot);
      copyFileSync(liveDayFilePath, corruptDayFilePath);
      const copyContent = JSON.parse(readFileSync(corruptDayFilePath, 'utf8')) as { records: Record<string, { committedResult?: unknown }> };
      copyContent.records['req-A']!.committedResult = { tampered: true, note: 'this must never be served as a valid replay' };
      writeFileSync(corruptDayFilePath, JSON.stringify(copyContent, null, 2), 'utf8');
      const tamperClaim1 = await claimProviderInvocation({ requestId: 'req-A', now, ianaTimezone, rootDir: corruptRoot });
      const tamperClaim2 = await claimProviderInvocation({ requestId: 'req-A', now, ianaTimezone, rootDir: corruptRoot });
      expect(tamperClaim1.ok).toBe(false);
      expect(tamperClaim2.ok).toBe(false);
      if (tamperClaim1.ok || tamperClaim2.ok) throw new Error('unreachable');
      expect(tamperClaim1.reason).toBe('integrity_violation');
      expect(tamperClaim2.reason).toBe('integrity_violation'); // deterministic — same REJECT every time
      // The LIVE state root is untouched by corruption of its copy.
      const liveTotalAfterCorruptionOfCopy = getDailyTotal(accountingDay, ianaTimezone, stateRoot).dailyTotalMinor;
      record('tamper-copy-deterministic-reject', {
        corruptedCopyPath: corruptDayFilePath,
        rejection1: tamperClaim1.reason,
        rejection2: tamperClaim2.reason,
        deterministic: tamperClaim1.reason === 'integrity_violation' && tamperClaim2.reason === 'integrity_violation',
        liveStateUnaffected: liveTotalAfterCorruptionOfCopy === totalAfterReconcileC.dailyTotalMinor,
      });
      expect(liveTotalAfterCorruptionOfCopy).toBe(totalAfterReconcileC.dailyTotalMinor);

      // ── 7. final ledger total ──────────────────────────────────────────
      const finalTotal = getDailyTotal(accountingDay, ianaTimezone, stateRoot);
      record('final-ledger-total', { dailyTotalMinor: finalTotal.dailyTotalMinor, recordCount: finalTotal.recordCount, dailyCapMinor: finalTotal.dailyCapMinor });
      // 35 (A, committed) + 55 (B, committed by exactly one of two concurrent children) + 20 (C, PENDING_RECONCILIATION, still counted)
      expect(finalTotal.dailyTotalMinor).toBe(35 + 55 + 20);
      expect(finalTotal.recordCount).toBe(3);

      // ── 8. cleanup — delete the disposable state roots, keep the pack ──
      rmSync(stateRoot, { recursive: true, force: true });
      rmSync(corruptRoot, { recursive: true, force: true });
      const stateRootDeleted = !existsSync(stateRoot);
      record('cleanup-result', { stateRootDeleted, evidencePackPreserved: true, evidenceDir });

      expect(stateRootDeleted).toBe(true);
      expect(existsSync(evidenceDir)).toBe(true);
      expect(existsSync(join(evidenceDir, 'ledger.jsonl'))).toBe(true);
      // eslint-disable-next-line no-console
      console.log(`[p1b-idem-live-proof] evidence pack preserved at: ${evidenceDir}`);
    } finally {
      for (const scriptPath of tmpScripts) {
        try { rmSync(scriptPath, { force: true }); } catch { /* ignore */ }
      }
      try { rmSync(stateRoot, { recursive: true, force: true }); } catch { /* already removed */ }
    }
  }, 60_000);
});
