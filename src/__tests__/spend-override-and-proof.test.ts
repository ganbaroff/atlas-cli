/**
 * spend-override-and-proof.test.ts — P1-B wave 2: bounded CEO spend
 * override, tamper rejection, P1-DEBT-01 lease-to-mutation binding closure,
 * and the live bounded proof (Task 4).
 *
 * All state lives under per-test/per-scenario temp directories passed
 * explicitly as `rootDir` — no env stubbing, no shared process state, no
 * network, no real provider call anywhere in this file. TEST_KEY below is an
 * obviously-fake string, never a real secret.
 */

import {
  afterEach, describe, expect, it,
} from 'vitest';
import {
  existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, copyFileSync,
} from 'node:fs';
import { execFileSync, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  reserve,
  commit,
  release,
  getDailyTotal,
  verifyRecordIntegrity,
  resolveDayFilePath,
  signCeoOverride,
  checkCeoOverrideSignature,
  resolveEffectiveDailyCapMinor,
  CeoOverrideSigningUnavailableError,
  type CeoOverride,
  type SignedCeoOverride,
} from '../atlas/spend/index.js';
import { loadOrBootstrapDayFile } from '../atlas/spend/store.js';
import { SpendStateCorruptError } from '../atlas/spend/types.js';
import {
  hmacSigner,
  hmacVerifier,
  signWorkOrder,
  createWorkOrderReplayStore,
  canonicalizeRepoPath,
  acquireRepoWriterLease,
  releaseRepoWriterLease,
  recoverStaleRepoWriterLease,
  clearRepoWriterLeaseForTests,
  runExecutorGate,
  type WorkOrder,
  type RepoWriterLeaseOwner,
} from '../atlas/work-order/index.js';
import { runExecutorGateMutation } from '../atlas/work-order/executor-gate.js';
import { appendClaim, hashPayload } from '../evidence/ledger.js';

// Obviously-fake test keys — never real secrets.
const TEST_KEY = 'test-fake-spend-override-key-not-real-do-not-use';
const OTHER_KEY = 'test-fake-OTHER-key-wrong-signer-not-real-do-not-use';
const signer = hmacSigner(TEST_KEY);
const verifier = hmacVerifier(TEST_KEY);
const otherSigner = hmacSigner(OTHER_KEY);

const WORKTREE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

const cleanupRoots: string[] = [];
const cleanupRepoPathsForLeases: string[] = [];

function trackTempDir(dir: string): string {
  cleanupRoots.push(dir);
  return dir;
}

afterEach(() => {
  for (const repoPath of cleanupRepoPathsForLeases.splice(0)) {
    try { clearRepoWriterLeaseForTests(repoPath); } catch { /* ignore */ }
  }
  for (const dir of cleanupRoots.splice(0)) {
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
});

function baseOverride(overrides: Partial<CeoOverride> = {}): CeoOverride {
  const now = Date.parse('2026-08-06T09:00:00.000Z');
  return {
    overrideId: `ovr-${randomUUID().slice(0, 8)}`,
    issuedBy: 'ceo:yusif',
    scope: { missionId: 'mission-live', provider: 'fake-provider' },
    additionalAmountMinor: 500,
    currency: 'USD',
    reason: 'test-only bounded override',
    issuedAt: new Date(now).toISOString(),
    expiresAt: new Date(now + 60 * 60 * 1000).toISOString(),
    ...overrides,
  };
}

// ── Task 2/3 — forbidden escape hatches are provably absent ───────────────

describe('override.ts — forbidden escape hatches are provably absent', () => {
  const FORBIDDEN_PATTERNS: RegExp[] = [
    /process\.env/i,
    /\bdebug\s*(mode|flag)?\s*[:=]/i,
    /\bbypass\b/i,
    /\breset[A-Z_]*\s*\(/i, // a callable resetXxx()/reset_xxx() — not the English word alone
    /NODE_ENV/i,
    /--force\b/i,
    /skipVerif/i,
    /\bunsafe(Skip|Allow|Override)\b/i,
    /leaseHeld\s*:/i,
  ];
  const SCANNED_FILES = [
    'src/atlas/spend/override.ts',
    'src/atlas/spend/ledger.ts',
    'src/atlas/spend/store.ts',
    'src/atlas/spend/preflight.ts',
  ];

  it('no unrestricted bypass, debug flag, reset command, or leaseHeld-style boolean exists in the spend module source', () => {
    for (const relPath of SCANNED_FILES) {
      const source = readFileSync(join(WORKTREE_ROOT, relPath), 'utf8');
      for (const pattern of FORBIDDEN_PATTERNS) {
        expect(pattern.test(source), `${relPath} must not match ${pattern}`).toBe(false);
      }
    }
  });

  it('override.ts never imports node:child_process or reads env directly — the ONLY way in is a signer/verifier function parameter', () => {
    const source = readFileSync(join(WORKTREE_ROOT, 'src/atlas/spend/override.ts'), 'utf8');
    expect(source).not.toMatch(/node:child_process/);
    expect(source).not.toContain('process.env');
  });
});

// ── 15. executor cannot reset its own spend ────────────────────────────────

describe('15. executor cannot reset its own spend', () => {
  it('with no signed override, the effective cap is ALWAYS the base cap — nothing an executor passes can widen it', () => {
    const result = resolveEffectiveDailyCapMinor({
      baseDailyCapMinor: 1000,
      missionId: 'mission-x',
      provider: 'fake-provider',
      now: new Date('2026-08-06T10:00:00.000Z'),
    });
    expect(result).toEqual({ ok: true, effectiveDailyCapMinor: 1000, overrideApplied: false });
  });

  it('a self-constructed "override" object with no valid signature is rejected and the base cap is returned unchanged', () => {
    const forged = {
      ...baseOverride(),
      integrity: { algorithm: 'HMAC-SHA256' as const, signature: 'deadbeef'.repeat(8) },
    } as SignedCeoOverride;
    const result = resolveEffectiveDailyCapMinor({
      baseDailyCapMinor: 1000,
      missionId: 'mission-live',
      provider: 'fake-provider',
      now: new Date('2026-08-06T10:00:00.000Z'),
      signedOverride: forged,
      verifier,
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.reason).toBe('signature_invalid');
    expect(result.effectiveDailyCapMinor).toBe(1000);
  });

  it('an executor cannot sign its own override — signCeoOverride refuses an issuedBy that is not CEO-prefixed', () => {
    expect(() => signCeoOverride(baseOverride({ issuedBy: 'atlas-executor' }), signer)).toThrow(/issuedBy must start with/);
    expect(() => signCeoOverride(baseOverride({ issuedBy: 'ceo:' }), signer)).toThrow(/issuedBy must start with/);
  });

  it('signCeoOverride refuses to sign at all when no signer is available — fails closed, never "unsigned OK"', () => {
    expect(() => signCeoOverride(baseOverride(), undefined)).toThrow(CeoOverrideSigningUnavailableError);
  });

  it('extra bogus properties on a reserve() call (mimicking a bypass attempt) are ignored — the cap is still enforced from dailyCapMinor alone', async () => {
    const dir = trackTempDir(mkdtempSync(join(tmpdir(), 'atlas-spend-no-reset-')));
    const now = new Date('2026-08-06T10:00:00.000Z');
    // Deliberately probing that unknown fields cannot smuggle a bypass
    // through — cast via `unknown` (not a typed object literal) so this is
    // a genuine runtime probe, not something the type checker would catch
    // for us either way.
    const forgedInput = {
      requestId: 'req-no-reset',
      now,
      ianaTimezone: 'UTC',
      projectOrMissionId: 'atlas',
      workOrderId: 'wo-no-reset',
      provider: 'fake-provider',
      model: 'fake-model',
      currency: 'USD',
      estimatedCostMinor: 2000,
      dailyCapMinor: 1000,
      sourceReceiptHash: 'sha256:test',
      rootDir: dir,
      bypassCap: true,
      override: 'unlimited',
      resetSpend: true,
    } as unknown as Parameters<typeof reserve>[0];
    const attempt = await reserve(forgedInput);
    expect(attempt.ok).toBe(false);
    if (attempt.ok) throw new Error('unreachable');
    expect(attempt.reason).toBe('cap_exceeded');
  });
});

// ── 16. unsigned override rejected ─────────────────────────────────────────

describe('16. unsigned override rejected', () => {
  it('a SignedCeoOverride with no integrity block at all is rejected as signature_missing', () => {
    const unsigned = { ...baseOverride() } as unknown as SignedCeoOverride;
    expect(checkCeoOverrideSignature(unsigned, verifier)).toBe('missing');
    const result = resolveEffectiveDailyCapMinor({
      baseDailyCapMinor: 1000,
      missionId: 'mission-live',
      provider: 'fake-provider',
      now: new Date('2026-08-06T10:00:00.000Z'),
      signedOverride: unsigned,
      verifier,
    });
    expect(result).toEqual({ ok: false, reason: 'signature_missing', effectiveDailyCapMinor: 1000 });
  });

  it('an override signed with a DIFFERENT key is rejected as signature_invalid, not silently trusted', () => {
    const signed = signCeoOverride(baseOverride(), otherSigner);
    const result = resolveEffectiveDailyCapMinor({
      baseDailyCapMinor: 1000,
      missionId: 'mission-live',
      provider: 'fake-provider',
      now: new Date('2026-08-06T10:00:00.000Z'),
      signedOverride: signed,
      verifier, // verifying against TEST_KEY, but it was signed with OTHER_KEY
    });
    expect(result).toEqual({ ok: false, reason: 'signature_invalid', effectiveDailyCapMinor: 1000 });
  });

  it('with no verifier resolvable at all, an override is treated as unsigned (fail-closed, same contract as Work Orders)', () => {
    const signed = signCeoOverride(baseOverride(), signer);
    // Force the "no verifier configured" path deterministically regardless
    // of whether this host's ambient env happens to set the signing key —
    // save and restore so this test never leaks env state.
    const savedKey = process.env.ATLAS_WORK_ORDER_SIGNING_KEY;
    delete process.env.ATLAS_WORK_ORDER_SIGNING_KEY;
    try {
      expect(checkCeoOverrideSignature(signed, undefined)).toBe('missing');
    } finally {
      if (savedKey === undefined) delete process.env.ATLAS_WORK_ORDER_SIGNING_KEY;
      else process.env.ATLAS_WORK_ORDER_SIGNING_KEY = savedKey;
    }
  });
});

// ── 17. expired override rejected ──────────────────────────────────────────

describe('17. expired override rejected', () => {
  it('an override whose expiresAt has already passed is rejected, base cap returned', () => {
    const issuedAt = '2026-08-06T09:00:00.000Z';
    const expiresAt = '2026-08-06T09:05:00.000Z';
    const signed = signCeoOverride(baseOverride({ issuedAt, expiresAt }), signer);
    const result = resolveEffectiveDailyCapMinor({
      baseDailyCapMinor: 1000,
      missionId: 'mission-live',
      provider: 'fake-provider',
      now: new Date('2026-08-06T09:06:00.000Z'), // one minute after expiry
      signedOverride: signed,
      verifier,
    });
    expect(result).toEqual({ ok: false, reason: 'expired', effectiveDailyCapMinor: 1000 });
  });

  it('signCeoOverride refuses to create an override with no bounded lifetime at all (expiresAt <= issuedAt)', () => {
    const issuedAt = '2026-08-06T09:00:00.000Z';
    expect(() => signCeoOverride(baseOverride({ issuedAt, expiresAt: issuedAt }), signer))
      .toThrow(/expiresAt must be strictly after issuedAt/);
  });
});

// ── 18. bounded CEO override works ONLY for its declared scope ────────────

describe('18. bounded CEO override works ONLY for its declared scope (amount + expiry + provider/mission)', () => {
  it('applies exactly its declared additional amount when mission + provider + expiry all match', () => {
    const signed = signCeoOverride(baseOverride({
      scope: { missionId: 'mission-live', provider: 'fake-provider' },
      additionalAmountMinor: 500,
    }), signer);
    const result = resolveEffectiveDailyCapMinor({
      baseDailyCapMinor: 1000,
      missionId: 'mission-live',
      provider: 'fake-provider',
      now: new Date('2026-08-06T09:30:00.000Z'),
      signedOverride: signed,
      verifier,
    });
    expect(result).toEqual({
      ok: true,
      effectiveDailyCapMinor: 1500,
      overrideApplied: true,
      overrideId: signed.overrideId,
      appliedAmountMinor: 500,
    });
  });

  it('refuses to apply for a DIFFERENT mission — base cap unchanged', () => {
    const signed = signCeoOverride(baseOverride({ scope: { missionId: 'mission-live' } }), signer);
    const result = resolveEffectiveDailyCapMinor({
      baseDailyCapMinor: 1000,
      missionId: 'mission-OTHER',
      provider: 'fake-provider',
      now: new Date('2026-08-06T09:30:00.000Z'),
      signedOverride: signed,
      verifier,
    });
    expect(result).toEqual({ ok: false, reason: 'scope_mismatch', effectiveDailyCapMinor: 1000 });
  });

  it('refuses to apply for a DIFFERENT provider — base cap unchanged', () => {
    const signed = signCeoOverride(baseOverride({ scope: { provider: 'fake-provider' } }), signer);
    const result = resolveEffectiveDailyCapMinor({
      baseDailyCapMinor: 1000,
      missionId: 'mission-live',
      provider: 'OTHER-provider',
      now: new Date('2026-08-06T09:30:00.000Z'),
      signedOverride: signed,
      verifier,
    });
    expect(result).toEqual({ ok: false, reason: 'scope_mismatch', effectiveDailyCapMinor: 1000 });
  });

  it('the applied amount is bounded to EXACTLY the declared additionalAmountMinor — never more, regardless of how large a request follows', async () => {
    const signed = signCeoOverride(baseOverride({
      scope: { missionId: 'mission-live', provider: 'fake-provider' },
      additionalAmountMinor: 20,
    }), signer);
    const result = resolveEffectiveDailyCapMinor({
      baseDailyCapMinor: 100,
      missionId: 'mission-live',
      provider: 'fake-provider',
      now: new Date('2026-08-06T09:30:00.000Z'),
      signedOverride: signed,
      verifier,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('unreachable');
    expect(result.effectiveDailyCapMinor).toBe(120);

    // End-to-end: the ledger itself still refuses a request that exceeds
    // even the OVERRIDDEN cap — the override widened the ceiling by exactly
    // 20, not "unlimited".
    const dir = trackTempDir(mkdtempSync(join(tmpdir(), 'atlas-spend-override-bound-')));
    const now = new Date('2026-08-06T09:30:00.000Z');
    const withinOverride = await reserve({
      requestId: 'req-within-override',
      now,
      ianaTimezone: 'UTC',
      projectOrMissionId: 'mission-live',
      workOrderId: 'wo-override-bound',
      provider: 'fake-provider',
      model: 'fake-model',
      currency: 'USD',
      estimatedCostMinor: 120,
      dailyCapMinor: result.effectiveDailyCapMinor,
      sourceReceiptHash: 'sha256:test',
      rootDir: dir,
    });
    expect(withinOverride.ok).toBe(true);

    const beyondOverride = await reserve({
      requestId: 'req-beyond-override',
      now,
      ianaTimezone: 'UTC',
      projectOrMissionId: 'mission-live',
      workOrderId: 'wo-override-bound',
      provider: 'fake-provider',
      model: 'fake-model',
      currency: 'USD',
      estimatedCostMinor: 1,
      dailyCapMinor: result.effectiveDailyCapMinor,
      sourceReceiptHash: 'sha256:test',
      rootDir: dir,
    });
    expect(beyondOverride.ok).toBe(false);
    if (beyondOverride.ok) throw new Error('unreachable');
    expect(beyondOverride.reason).toBe('cap_exceeded');
  });
});

// ── 19. receipt binds workOrderId, requestId and state hash ───────────────

describe('19. receipt binds workOrderId, requestId and state hash', () => {
  it('a committed record carries its own requestId + workOrderId and a self-verifying integrityHash', async () => {
    const dir = trackTempDir(mkdtempSync(join(tmpdir(), 'atlas-spend-receipt-bind-')));
    const now = new Date('2026-08-06T10:00:00.000Z');
    const reserved = await reserve({
      requestId: 'req-bind-1',
      now,
      ianaTimezone: 'UTC',
      projectOrMissionId: 'atlas',
      workOrderId: 'wo-bind-1',
      provider: 'fake-provider',
      model: 'fake-model',
      currency: 'USD',
      estimatedCostMinor: 100,
      dailyCapMinor: 1000,
      sourceReceiptHash: 'sha256:source-bind-1',
      rootDir: dir,
    });
    expect(reserved.ok).toBe(true);
    const committed = await commit({ requestId: 'req-bind-1', actualMinor: 90, now, ianaTimezone: 'UTC', rootDir: dir });
    expect(committed.ok).toBe(true);
    if (!committed.ok) throw new Error('unreachable');

    expect(committed.record.requestId).toBe('req-bind-1');
    expect(committed.record.workOrderId).toBe('wo-bind-1');
    expect(committed.record.sourceReceiptHash).toBe('sha256:source-bind-1');
    expect(verifyRecordIntegrity(committed.record)).toBe(true);

    // The hash is a genuine binding, not a constant: changing ANY bound
    // field breaks verification.
    expect(verifyRecordIntegrity({ ...committed.record, requestId: 'req-bind-DIFFERENT' })).toBe(false);
    expect(verifyRecordIntegrity({ ...committed.record, workOrderId: 'wo-bind-DIFFERENT' })).toBe(false);
    expect(verifyRecordIntegrity({ ...committed.record, committedMinor: 999 })).toBe(false);
  });
});

// ── 20. tampered spend receipt → deterministic REJECT ──────────────────────

describe('20. tampered spend receipt → deterministic REJECT', () => {
  it('a record mutated without recomputing integrityHash fails verification, deterministically on every call', async () => {
    const dir = trackTempDir(mkdtempSync(join(tmpdir(), 'atlas-spend-tamper-')));
    const now = new Date('2026-08-06T10:00:00.000Z');
    await reserve({
      requestId: 'req-tamper-1',
      now,
      ianaTimezone: 'UTC',
      projectOrMissionId: 'atlas',
      workOrderId: 'wo-tamper-1',
      provider: 'fake-provider',
      model: 'fake-model',
      currency: 'USD',
      estimatedCostMinor: 100,
      dailyCapMinor: 1000,
      sourceReceiptHash: 'sha256:source-tamper-1',
      rootDir: dir,
    });
    const committed = await commit({ requestId: 'req-tamper-1', actualMinor: 80, now, ianaTimezone: 'UTC', rootDir: dir });
    expect(committed.ok).toBe(true);
    if (!committed.ok) throw new Error('unreachable');

    const tampered = { ...committed.record, committedMinor: 1 }; // tamper: pretend it only cost 1 minor unit
    expect(verifyRecordIntegrity(tampered)).toBe(false);
    // Deterministic: calling it again (and again) never flips to "valid".
    expect(verifyRecordIntegrity(tampered)).toBe(false);
    expect(verifyRecordIntegrity(tampered)).toBe(false);
    expect(verifyRecordIntegrity(committed.record)).toBe(true); // the untampered original still verifies
  });
});

// ── 23. lease loss immediately before mutation is rejected (P1-DEBT-01) ───

function gitAt(root: string, ...args: string[]): string {
  return execFileSync('git', ['-C', root, ...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
    windowsHide: true,
  });
}

function initFixtureRepo(): { root: string; head: string } {
  const root = trackTempDir(mkdtempSync(join(tmpdir(), 'p1debt01-fixture-')));
  gitAt(root, 'init', '-q');
  gitAt(root, 'config', 'user.email', 'atlas-test@example.invalid');
  gitAt(root, 'config', 'user.name', 'Atlas Test');
  writeFileSync(join(root, 'README.md'), '# fixture\n', 'utf8');
  gitAt(root, 'add', '.');
  gitAt(root, 'commit', '-q', '-m', 'init');
  const head = gitAt(root, 'rev-parse', 'HEAD').trim();
  return { root, head };
}

function buildOrder(root: string, headFull: string, overrides: Partial<WorkOrder> = {}): WorkOrder {
  const now = Date.now();
  return {
    workOrderId: `wo_p1debt01-${randomUUID().slice(0, 8)}`,
    goalId: 'goal-p1b-wave2',
    taskId: 'task-lease-mutation-binding',
    issuerIdentity: 'atlas-planner',
    executorIdentity: 'atlas-executor',
    repoCanonicalPath: canonicalizeRepoPath(root),
    baseBranch: 'main',
    baseHead: headFull,
    worktreePath: root,
    issuedAt: new Date(now).toISOString(),
    expiresAt: new Date(now + 60 * 60 * 1000).toISOString(),
    nonce: `nonce-${randomUUID().slice(0, 8)}`,
    allowedPaths: ['work/**'],
    forbiddenPaths: ['**/*.env'],
    forbiddenActions: ['force-push'],
    allowedCommandClasses: ['fs-write'],
    maxAttempts: 3,
    maxWallClockMs: 20 * 60 * 1000,
    expectedTests: [],
    evidenceRequirements: ['exit-code'],
    rollbackMethod: 'delete work/ and verify git status --porcelain is empty',
    ...overrides,
  };
}

describe('23. lease loss immediately before mutation is rejected (P1-DEBT-01)', () => {
  it('lease RELEASED between authorization and mutation → runExecutorGateMutation refuses, mutate() never runs, file never created', () => {
    const { root, head } = initFixtureRepo();
    cleanupRepoPathsForLeases.push(root);
    const evidenceDir = trackTempDir(mkdtempSync(join(tmpdir(), 'p1debt01-evidence-')));
    const replayStore = createWorkOrderReplayStore(trackTempDir(mkdtempSync(join(tmpdir(), 'p1debt01-replay-'))));

    const order = buildOrder(root, head);
    const signed = signWorkOrder(order, signer);
    const owner: RepoWriterLeaseOwner = { missionId: 'mission-released', workOrderId: signed.workOrderId };
    expect(acquireRepoWriterLease({ repoPath: root, owner }).ok).toBe(true);

    // Authorization succeeds — the lease is genuinely held at this instant.
    const authVerdict = runExecutorGate({
      signed,
      expectedIssuerIdentity: order.issuerIdentity,
      expectedExecutorIdentity: order.executorIdentity,
      worktreeRoot: root,
      candidatePath: 'work/note.txt',
      action: 'write-file',
      commandClass: 'fs-write',
      attemptNumber: 1,
      elapsedWallClockMs: 100,
      missionId: owner.missionId,
      replayStore,
      evidenceDir,
      verifier,
    });
    expect(authVerdict.ok).toBe(true);
    if (!authVerdict.ok) throw new Error('unreachable');

    // The lease is lost BETWEEN authorization and the mutation attempt.
    expect(releaseRepoWriterLease({ repoPath: root, owner })).toEqual({ ok: true });

    const targetFile = join(root, 'work', 'note.txt');
    let mutateCalled = false;
    const mutationVerdict = runExecutorGateMutation(
      {
        signed,
        expectedExecutorIdentity: order.executorIdentity,
        worktreeRoot: root,
        missionId: owner.missionId,
        authorizedWorkOrderHash: authVerdict.workOrderHash,
        evidenceDir,
      },
      () => {
        mutateCalled = true;
        mkdirSync(join(root, 'work'), { recursive: true });
        writeFileSync(targetFile, 'must never be written\n', 'utf8');
      },
    );

    expect(mutationVerdict.ok).toBe(false);
    if (mutationVerdict.ok) throw new Error('unreachable');
    expect(mutationVerdict.reason).toBe('lease_lost_before_mutation');
    expect(mutateCalled).toBe(false);
    expect(existsSync(targetFile)).toBe(false);
  });

  it('lease REPLACED by a different mission (stale recovery) between authorization and mutation → refused, target unchanged', () => {
    const { root, head } = initFixtureRepo();
    cleanupRepoPathsForLeases.push(root);
    const evidenceDir = trackTempDir(mkdtempSync(join(tmpdir(), 'p1debt01-evidence-')));
    const replayStore = createWorkOrderReplayStore(trackTempDir(mkdtempSync(join(tmpdir(), 'p1debt01-replay-'))));

    const order = buildOrder(root, head);
    const signed = signWorkOrder(order, signer);
    const owner: RepoWriterLeaseOwner = { missionId: 'mission-original', workOrderId: signed.workOrderId };
    // Backdated `now` + a short TTL, NOT real elapsed wall-clock time, so
    // "this lease is already expired" is deterministic regardless of how
    // long the git subprocess calls below take.
    const backdatedAcquireNow = new Date(Date.now() - 10 * 60 * 1000);
    const originalAcquire = acquireRepoWriterLease({
      repoPath: root, owner, ttlMs: 1000, now: backdatedAcquireNow,
    });
    expect(originalAcquire.ok).toBe(true);

    const authVerdict = runExecutorGate({
      signed,
      expectedIssuerIdentity: order.issuerIdentity,
      expectedExecutorIdentity: order.executorIdentity,
      worktreeRoot: root,
      candidatePath: 'work/note.txt',
      action: 'write-file',
      commandClass: 'fs-write',
      attemptNumber: 1,
      elapsedWallClockMs: 100,
      missionId: owner.missionId,
      replayStore,
      evidenceDir,
      verifier,
    });
    expect(authVerdict.ok).toBe(true);
    if (!authVerdict.ok) throw new Error('unreachable');

    // Replace the lease with a DIFFERENT mission's ownership. acquire()
    // itself NEVER silently takes over even an expired lease (by design —
    // see repo-writer-lock.ts's module header), so it refuses here...
    const intruderOwner: RepoWriterLeaseOwner = { missionId: 'mission-intruder', workOrderId: 'wo-intruder' };
    const recovered = acquireRepoWriterLease({ repoPath: root, owner: intruderOwner });
    expect(recovered.ok).toBe(false);
    // ...forcing the explicit stale-recovery path, which DOES succeed
    // because the backdated lease genuinely is expired relative to real
    // "now" — this is the REPLACEMENT this test proves.
    const forced = recoverStaleRepoWriterLease({
      repoPath: root,
      owner: intruderOwner,
      reason: 'p1debt01-test: simulate a different mission taking over the stale lease',
    });
    expect(forced.ok).toBe(true);

    const targetFile = join(root, 'work', 'note.txt');
    let mutateCalled = false;
    const mutationVerdict = runExecutorGateMutation(
      {
        signed,
        expectedExecutorIdentity: order.executorIdentity,
        worktreeRoot: root,
        missionId: owner.missionId, // still claiming the ORIGINAL mission — no longer the true owner
        authorizedWorkOrderHash: authVerdict.workOrderHash,
        evidenceDir,
      },
      () => {
        mutateCalled = true;
        mkdirSync(join(root, 'work'), { recursive: true });
        writeFileSync(targetFile, 'must never be written\n', 'utf8');
      },
    );

    expect(mutationVerdict.ok).toBe(false);
    if (mutationVerdict.ok) throw new Error('unreachable');
    expect(mutationVerdict.reason).toBe('lease_lost_before_mutation');
    expect(mutateCalled).toBe(false);
    expect(existsSync(targetFile)).toBe(false);

    expect(releaseRepoWriterLease({ repoPath: root, owner: intruderOwner })).toEqual({ ok: true });
  });

  it('lease EXPIRED (leaseExpiresAt passed) between authorization and mutation → refused even though status is still "held"', () => {
    const { root, head } = initFixtureRepo();
    cleanupRepoPathsForLeases.push(root);
    const evidenceDir = trackTempDir(mkdtempSync(join(tmpdir(), 'p1debt01-evidence-')));
    const replayStore = createWorkOrderReplayStore(trackTempDir(mkdtempSync(join(tmpdir(), 'p1debt01-replay-'))));

    const authTime = new Date('2026-08-06T10:00:00.000Z');
    const order = buildOrder(root, head, {
      issuedAt: authTime.toISOString(),
      expiresAt: new Date(authTime.getTime() + 60 * 60 * 1000).toISOString(),
    });
    const signed = signWorkOrder(order, signer);
    const owner: RepoWriterLeaseOwner = { missionId: 'mission-expiry', workOrderId: signed.workOrderId };
    // A lease that is already-expired BY authTime (acquired with `now` backdated so its TTL has elapsed).
    expect(acquireRepoWriterLease({
      repoPath: root, owner, ttlMs: 60_000, now: new Date(authTime.getTime() - 5 * 60_000),
    }).ok).toBe(true);

    const authVerdict = runExecutorGate({
      signed,
      expectedIssuerIdentity: order.issuerIdentity,
      expectedExecutorIdentity: order.executorIdentity,
      worktreeRoot: root,
      candidatePath: 'work/note.txt',
      action: 'write-file',
      commandClass: 'fs-write',
      attemptNumber: 1,
      elapsedWallClockMs: 100,
      missionId: owner.missionId,
      replayStore,
      evidenceDir,
      now: authTime,
      verifier,
    });
    // runExecutorGate()'s OWN lease check never compared leaseExpiresAt (a
    // pre-existing gap this wave also closes at the mutation step) — it
    // still authorizes here on status+owner alone.
    expect(authVerdict.ok).toBe(true);
    if (!authVerdict.ok) throw new Error('unreachable');

    const targetFile = join(root, 'work', 'note.txt');
    let mutateCalled = false;
    const mutationVerdict = runExecutorGateMutation(
      {
        signed,
        expectedExecutorIdentity: order.executorIdentity,
        worktreeRoot: root,
        missionId: owner.missionId,
        authorizedWorkOrderHash: authVerdict.workOrderHash,
        evidenceDir,
        now: authTime, // the SAME instant — the lease is already expired at acquisition-relative TTL math
      },
      () => {
        mutateCalled = true;
        mkdirSync(join(root, 'work'), { recursive: true });
        writeFileSync(targetFile, 'must never be written\n', 'utf8');
      },
    );

    expect(mutationVerdict.ok).toBe(false);
    if (mutationVerdict.ok) throw new Error('unreachable');
    expect(mutationVerdict.reason).toBe('lease_lost_before_mutation');
    expect(mutateCalled).toBe(false);
    expect(existsSync(targetFile)).toBe(false);

    // The lease's persisted `status` field only ever transitions via an
    // explicit release/recovery call — an elapsed TTL alone does not flip
    // it, so it is still 'held' by the SAME process here and a plain
    // release still succeeds. This is exactly why runExecutorGateMutation's
    // OWN leaseExpiresAt comparison above (not present in the pre-existing
    // runExecutorGate lease check) is the thing that had to catch this case.
    expect(releaseRepoWriterLease({ repoPath: root, owner })).toEqual({ ok: true });
  });

  it('when the lease genuinely IS still held, runExecutorGateMutation proceeds and the mutation happens exactly once', () => {
    const { root, head } = initFixtureRepo();
    cleanupRepoPathsForLeases.push(root);
    const evidenceDir = trackTempDir(mkdtempSync(join(tmpdir(), 'p1debt01-evidence-')));
    const replayStore = createWorkOrderReplayStore(trackTempDir(mkdtempSync(join(tmpdir(), 'p1debt01-replay-'))));

    const order = buildOrder(root, head);
    const signed = signWorkOrder(order, signer);
    const owner: RepoWriterLeaseOwner = { missionId: 'mission-happy-path', workOrderId: signed.workOrderId };
    expect(acquireRepoWriterLease({ repoPath: root, owner }).ok).toBe(true);

    const authVerdict = runExecutorGate({
      signed,
      expectedIssuerIdentity: order.issuerIdentity,
      expectedExecutorIdentity: order.executorIdentity,
      worktreeRoot: root,
      candidatePath: 'work/note.txt',
      action: 'write-file',
      commandClass: 'fs-write',
      attemptNumber: 1,
      elapsedWallClockMs: 100,
      missionId: owner.missionId,
      replayStore,
      evidenceDir,
      verifier,
    });
    expect(authVerdict.ok).toBe(true);
    if (!authVerdict.ok) throw new Error('unreachable');

    const targetFile = join(root, 'work', 'note.txt');
    let mutateCallCount = 0;
    const mutationVerdict = runExecutorGateMutation(
      {
        signed,
        expectedExecutorIdentity: order.executorIdentity,
        worktreeRoot: root,
        missionId: owner.missionId,
        authorizedWorkOrderHash: authVerdict.workOrderHash,
        evidenceDir,
      },
      () => {
        mutateCallCount += 1;
        mkdirSync(join(root, 'work'), { recursive: true });
        writeFileSync(targetFile, 'p1-debt-01 happy path\n', 'utf8');
        return 'wrote-it';
      },
    );

    expect(mutationVerdict.ok).toBe(true);
    if (!mutationVerdict.ok) throw new Error('unreachable');
    expect(mutationVerdict.mutationResult).toBe('wrote-it');
    expect(mutateCallCount).toBe(1);
    expect(existsSync(targetFile)).toBe(true);
    expect(readFileSync(targetFile, 'utf8')).toBe('p1-debt-01 happy path\n');

    rmSync(join(root, 'work'), { recursive: true, force: true });
    expect(releaseRepoWriterLease({ repoPath: root, owner })).toEqual({ ok: true });
  });
});

// ── Task 4 — live bounded proof (disposable state root + fake provider, no network) ──

const TSX_CLI = join(WORKTREE_ROOT, 'node_modules', 'tsx', 'dist', 'cli.mjs');

/** Spawn a genuinely separate `node` process (via tsx, so it can import the .ts source directly) that reads the durable spend total for one accounting day from `rootDir`. This is a TRUE process restart, not an in-process simulation — preferred over `vi.resetModules()` per the mission instructions. */
function readTotalInFreshProcess(rootDir: string, accountingDay: string, ianaTimezone: string): { totalMinor: number; recordCount: number; capMinor: number; childPid: number } {
  const probeScript = join(WORKTREE_ROOT, `.tmp-p1b-restart-probe-${randomUUID().slice(0, 8)}.mts`);
  const probeSource = [
    "import { getDailyTotal } from './src/atlas/spend/index.js';",
    'const [, , rootDir, accountingDay, ianaTimezone] = process.argv;',
    'const total = getDailyTotal(accountingDay, ianaTimezone, rootDir);',
    'process.stdout.write(JSON.stringify({ ...total, pid: process.pid }));',
    '',
  ].join('\n');
  writeFileSync(probeScript, probeSource, 'utf8');
  try {
    const result = spawnSync(process.execPath, [TSX_CLI, probeScript, rootDir, accountingDay, ianaTimezone], {
      cwd: WORKTREE_ROOT,
      encoding: 'utf8',
      windowsHide: true,
    });
    if (result.status !== 0) {
      throw new Error(`restart probe child process failed (exit ${result.status}): ${result.stderr}`);
    }
    const parsed = JSON.parse(result.stdout) as { dailyTotalMinor: number; recordCount: number; dailyCapMinor: number; pid: number };
    return {
      totalMinor: parsed.dailyTotalMinor,
      recordCount: parsed.recordCount,
      capMinor: parsed.dailyCapMinor,
      childPid: parsed.pid,
    };
  } finally {
    try { rmSync(probeScript, { force: true }); } catch { /* ignore */ }
  }
}

describe('P1-B wave 2 — live bounded proof', () => {
  it('cap enforcement survives a real process restart, replay is idempotent, corruption is caught, and lease loss blocks the write', async () => {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const evidenceDir = join(homedir(), '.atlas', 'quarantine', 'evidence', `p1b-live-${stamp}-${randomUUID().slice(0, 8)}`);
    mkdirSync(evidenceDir, { recursive: true });
    const record = (kind: string, detail: Record<string, unknown>): void => {
      appendClaim(
        {
          claimId: `clm_p1b-live-${kind}-${randomUUID().slice(0, 8)}`,
          claim: JSON.stringify({ kind, ...detail }),
          type: 'narrative',
          path: `p1b-live-proof://${kind}`,
          confidence: 0,
          source: 'spend-override-and-proof-live-proof',
          sourceRef: 'p1b-wave2',
          ts: new Date().toISOString(),
        },
        evidenceDir,
      );
    };

    const stateRoot = trackTempDir(mkdtempSync(join(tmpdir(), 'p1b-live-state-')));
    const now = new Date('2026-08-06T11:00:00.000Z');
    const accountingDay = '2026-08-06';
    const ianaTimezone = 'UTC';
    const dailyCapMinor = 100;
    let fakeProviderInvocationCount = 0;

    async function fakeProviderPreflight(requestId: string, estimatedCostMinor: number, actualCostMinor: number) {
      const reserveResult = await reserve({
        requestId,
        now,
        ianaTimezone,
        projectOrMissionId: 'p1b-live',
        workOrderId: 'wo-p1b-live',
        provider: 'fake-provider',
        model: 'fake-model',
        currency: 'USD',
        estimatedCostMinor,
        dailyCapMinor,
        sourceReceiptHash: `sha256:fake-${requestId}`,
        rootDir: stateRoot,
      });
      if (!reserveResult.ok) {
        return { reserveResult, invoked: false as const };
      }
      fakeProviderInvocationCount += 1; // the "provider call" — never a real network call
      const committed = await commit({ requestId, actualMinor: actualCostMinor, now, ianaTimezone, rootDir: stateRoot });
      return { reserveResult, committed, invoked: true as const };
    }

    // ── 0. genesis state hash — before ANYTHING is written ──────────────
    const genesisTotal = getDailyTotal(accountingDay, ianaTimezone, stateRoot);
    const genesisHash = hashPayload(genesisTotal);
    expect(genesisTotal.recordCount).toBe(0);
    record('initial-state-hash', { genesisHash, genesisTotal });

    // ── 1. request A reserves 40, commits actual 35 ──────────────────────
    const a = await fakeProviderPreflight('req-A', 40, 35);
    expect(a.reserveResult.ok).toBe(true);
    expect(a.invoked).toBe(true);
    expect(a.committed?.ok).toBe(true);
    expect(fakeProviderInvocationCount).toBe(1);
    const afterATotal = getDailyTotal(accountingDay, ianaTimezone, stateRoot);
    expect(afterATotal.dailyTotalMinor).toBe(35);
    record('reservation-and-commit', {
      requestId: 'req-A', estimatedCostMinor: 40, actualCostMinor: 35,
      fakeProviderInvocationCount, dailyTotalMinor: afterATotal.dailyTotalMinor,
    });

    // ── 2. restart boundary — genuine child `node` process ───────────────
    const preRestartHash = hashPayload(readFileSync(resolveDayFilePath(accountingDay, stateRoot), 'utf8'));
    const restarted = readTotalInFreshProcess(stateRoot, accountingDay, ianaTimezone);
    const postRestartRaw = readFileSync(resolveDayFilePath(accountingDay, stateRoot), 'utf8');
    const postRestartHash = hashPayload(postRestartRaw);
    expect(restarted.totalMinor).toBe(35); // survives a REAL process death, not an in-memory cache
    expect(restarted.childPid).not.toBe(process.pid); // proof this ran in a different OS process
    expect(postRestartHash).toBe(preRestartHash); // state on disk did not change across the restart
    record('restart-boundary', {
      mechanism: 'spawned a real child `node` process via tsx (node_modules/tsx/dist/cli.mjs) — a TRUE restart, not vi.resetModules()',
      parentPid: process.pid,
      childPid: restarted.childPid,
      preRestartStateHash: preRestartHash,
      postRestartStateHash: postRestartHash,
      totalAfterRestart: restarted.totalMinor,
    });

    // ── 3. request B reserves 60 (left RESERVED, not committed — this is "the remaining reservation") ──
    const bReserve = await reserve({
      requestId: 'req-B',
      now,
      ianaTimezone,
      projectOrMissionId: 'p1b-live',
      workOrderId: 'wo-p1b-live',
      provider: 'fake-provider',
      model: 'fake-model',
      currency: 'USD',
      estimatedCostMinor: 60,
      dailyCapMinor,
      sourceReceiptHash: 'sha256:fake-req-B',
      rootDir: stateRoot,
    });
    expect(bReserve.ok).toBe(true);
    const afterBTotal = getDailyTotal(accountingDay, ianaTimezone, stateRoot);
    expect(afterBTotal.dailyTotalMinor).toBe(95); // 35 committed + 60 reserved
    const headroom = dailyCapMinor - afterBTotal.dailyTotalMinor;
    expect(headroom).toBe(5);
    record('cap-decision', {
      requestId: 'req-B', estimatedCostMinor: 60, dailyTotalMinor: afterBTotal.dailyTotalMinor, dailyCapMinor, headroomMinor: headroom,
    });

    // ── 4. request C attempts to exceed the cap (10 > headroom of 5) ─────
    const invocationCountBeforeC = fakeProviderInvocationCount;
    const c = await fakeProviderPreflight('req-C', 10, 10);
    expect(c.reserveResult.ok).toBe(false);
    expect(c.invoked).toBe(false);
    expect(fakeProviderInvocationCount).toBe(invocationCountBeforeC); // UNCHANGED — the fake provider was never called
    record('rejected-request', {
      requestId: 'req-C', estimatedCostMinor: 10, reason: !c.reserveResult.ok ? c.reserveResult.reason : null,
      fakeProviderInvocationCountBefore: invocationCountBeforeC, fakeProviderInvocationCountAfter: fakeProviderInvocationCount,
    });

    // ── 5. replay request A → no duplicate cost ───────────────────────────
    const totalBeforeReplay = getDailyTotal(accountingDay, ianaTimezone, stateRoot).dailyTotalMinor;
    const replayReserve = await reserve({
      requestId: 'req-A',
      now,
      ianaTimezone,
      projectOrMissionId: 'p1b-live',
      workOrderId: 'wo-p1b-live',
      provider: 'fake-provider',
      model: 'fake-model',
      currency: 'USD',
      estimatedCostMinor: 999999, // deliberately different — idempotency must ignore this
      dailyCapMinor,
      sourceReceiptHash: 'sha256:fake-req-A',
      rootDir: stateRoot,
    });
    expect(replayReserve.ok).toBe(true);
    if (!replayReserve.ok) throw new Error('unreachable');
    expect(replayReserve.idempotent).toBe(true);
    expect(replayReserve.record.reservedMinor).toBe(40); // the ORIGINAL amount, not 999999
    const replayCommit = await commit({ requestId: 'req-A', actualMinor: 777777, now, ianaTimezone, rootDir: stateRoot });
    expect(replayCommit.ok).toBe(true);
    if (!replayCommit.ok) throw new Error('unreachable');
    expect(replayCommit.idempotent).toBe(true);
    expect(replayCommit.record.committedMinor).toBe(35); // still 35 — no double charge
    const totalAfterReplay = getDailyTotal(accountingDay, ianaTimezone, stateRoot).dailyTotalMinor;
    expect(totalAfterReplay).toBe(totalBeforeReplay); // unchanged
    record('replay-evidence', {
      requestId: 'req-A', totalBeforeReplay, totalAfterReplay, replayedCommittedMinor: replayCommit.record.committedMinor,
    });

    // ── 6. corrupt a COPY of the state — never the live state root ───────
    const corruptRoot = trackTempDir(mkdtempSync(join(tmpdir(), 'p1b-live-corrupt-')));
    const liveDayFilePath = resolveDayFilePath(accountingDay, stateRoot);
    const corruptDayFilePath = resolveDayFilePath(accountingDay, corruptRoot);
    copyFileSync(liveDayFilePath, corruptDayFilePath);
    const originalCopyContent = readFileSync(corruptDayFilePath, 'utf8');
    writeFileSync(corruptDayFilePath, originalCopyContent.slice(0, Math.floor(originalCopyContent.length / 2)), 'utf8'); // truncate = invalid JSON
    let tamperError1: unknown;
    let tamperError2: unknown;
    try { loadOrBootstrapDayFile(accountingDay, ianaTimezone, dailyCapMinor, corruptRoot); } catch (e) { tamperError1 = e; }
    try { loadOrBootstrapDayFile(accountingDay, ianaTimezone, dailyCapMinor, corruptRoot); } catch (e) { tamperError2 = e; }
    expect(tamperError1).toBeInstanceOf(SpendStateCorruptError);
    expect(tamperError2).toBeInstanceOf(SpendStateCorruptError); // deterministic — same REJECT every time
    // The LIVE state root is untouched by the corruption of its copy.
    const liveTotalAfterCorruptionOfCopy = getDailyTotal(accountingDay, ianaTimezone, stateRoot).dailyTotalMinor;
    expect(liveTotalAfterCorruptionOfCopy).toBe(totalAfterReplay);
    record('tamper-evidence', {
      corruptedCopyPath: corruptDayFilePath,
      liveStateUnaffected: true,
      rejection1: tamperError1 instanceof Error ? tamperError1.message : String(tamperError1),
      rejection2: tamperError2 instanceof Error ? tamperError2.message : String(tamperError2),
      deterministic: tamperError1 instanceof SpendStateCorruptError && tamperError2 instanceof SpendStateCorruptError,
    });

    // ── 7. cleanly release the remaining reservation (request B) ─────────
    const releasedB = await release({ requestId: 'req-B', now, ianaTimezone, rootDir: stateRoot });
    expect(releasedB.ok).toBe(true);
    if (!releasedB.ok) throw new Error('unreachable');
    expect(releasedB.record.status).toBe('RELEASED');
    const finalTotal = getDailyTotal(accountingDay, ianaTimezone, stateRoot);
    expect(finalTotal.dailyTotalMinor).toBe(35); // back to just A's committed cost
    record('final-ledger-total', { dailyTotalMinor: finalTotal.dailyTotalMinor, recordCount: finalTotal.recordCount });

    // ── 8. lease valid during preflight / removed before mutation / gate refuses the write ──
    const { root: repoRoot, head } = initFixtureRepo();
    cleanupRepoPathsForLeases.push(repoRoot);
    const replayStore = createWorkOrderReplayStore(trackTempDir(mkdtempSync(join(tmpdir(), 'p1b-live-replay-'))));
    const order = buildOrder(repoRoot, head);
    const signedOrder = signWorkOrder(order, signer);
    const leaseOwner: RepoWriterLeaseOwner = { missionId: 'p1b-live-proof-mission', workOrderId: signedOrder.workOrderId };

    const leaseAcquired = acquireRepoWriterLease({ repoPath: repoRoot, owner: leaseOwner });
    expect(leaseAcquired.ok).toBe(true);
    const leaseDuringPreflight = acquireRepoWriterLease({ repoPath: repoRoot, owner: leaseOwner }); // idempotent renew — proves "held" at preflight time
    expect(leaseDuringPreflight.ok).toBe(true);

    const gateVerdict = runExecutorGate({
      signed: signedOrder,
      expectedIssuerIdentity: order.issuerIdentity,
      expectedExecutorIdentity: order.executorIdentity,
      worktreeRoot: repoRoot,
      candidatePath: 'work/p1b-live-proof.txt',
      action: 'write-file',
      commandClass: 'fs-write',
      attemptNumber: 1,
      elapsedWallClockMs: 500,
      missionId: leaseOwner.missionId,
      replayStore,
      evidenceDir,
      verifier,
    });
    expect(gateVerdict.ok).toBe(true);
    if (!gateVerdict.ok) throw new Error('unreachable');

    // Lease removed before mutation.
    expect(releaseRepoWriterLease({ repoPath: repoRoot, owner: leaseOwner })).toEqual({ ok: true });

    const proofTarget = join(repoRoot, 'work', 'p1b-live-proof.txt');
    let mutateCalled = false;
    const finalMutationVerdict = runExecutorGateMutation(
      {
        signed: signedOrder,
        expectedExecutorIdentity: order.executorIdentity,
        worktreeRoot: repoRoot,
        missionId: leaseOwner.missionId,
        authorizedWorkOrderHash: gateVerdict.workOrderHash,
        evidenceDir,
      },
      () => {
        mutateCalled = true;
        mkdirSync(join(repoRoot, 'work'), { recursive: true });
        writeFileSync(proofTarget, 'must never be written\n', 'utf8');
      },
    );
    expect(finalMutationVerdict.ok).toBe(false);
    if (finalMutationVerdict.ok) throw new Error('unreachable');
    expect(finalMutationVerdict.reason).toBe('lease_lost_before_mutation');
    expect(mutateCalled).toBe(false);
    expect(existsSync(proofTarget)).toBe(false);
    record('lease-to-mutation-binding', {
      leaseValidDuringPreflight: leaseDuringPreflight.ok,
      leaseRemovedBeforeMutation: true,
      finalGateReason: finalMutationVerdict.reason,
      mutateCalled,
      targetFileCreated: existsSync(proofTarget),
    });

    // ── 9. cleanup — delete the disposable state root, keep the evidence pack ──
    rmSync(stateRoot, { recursive: true, force: true });
    rmSync(corruptRoot, { recursive: true, force: true });
    const stateRootDeleted = !existsSync(stateRoot);
    record('cleanup-result', { stateRootDeleted, evidencePackPreserved: true, evidenceDir });

    expect(stateRootDeleted).toBe(true);
    expect(existsSync(evidenceDir)).toBe(true);
    expect(existsSync(join(evidenceDir, 'ledger.jsonl'))).toBe(true);
    console.log(`[p1b-live-proof] evidence pack preserved at: ${evidenceDir}`);
  });
});
