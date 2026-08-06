/**
 * work-order-gate.test.ts — P1-A wave 2: RepoWriterLease + executor-gate.ts
 * + the live bounded proof.
 *
 * ALL via real temp git repos and injected fakes — zero network, zero real
 * credentials. TEST_KEY below is an obviously-fake string, never a real
 * secret. State for RepoWriterLease persists under the SAME
 * 'instance-lease' state-root convention wave 1 reused for replay — each
 * test uses a freshly created temp directory as its "repository", so its
 * canonical-path-derived lock key never collides with another test or with
 * a real Atlas instance lease.
 */

import {
  afterEach, describe, expect, it,
} from 'vitest';
import {
  existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync,
} from 'node:fs';
import { execFileSync, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  hmacSigner,
  hmacVerifier,
  signWorkOrder,
  createWorkOrderReplayStore,
  canonicalizeRepoPath,
  acquireRepoWriterLease,
  heartbeatRepoWriterLease,
  releaseRepoWriterLease,
  recoverStaleRepoWriterLease,
  getRepoWriterLeaseInfo,
  clearRepoWriterLeaseForTests,
  runExecutorGate,
  type WorkOrder,
  type RepoWriterLeaseOwner,
} from '../atlas/work-order/index.js';
import {
  appendClaim,
  hashPayload,
  readLedgerEntries,
  verifyLedgerChain,
} from '../evidence/ledger.js';

// Obviously-fake test key — never a real secret.
const TEST_KEY = 'test-fake-work-order-gate-key-not-real-do-not-use';
const signer = hmacSigner(TEST_KEY);
const verifier = hmacVerifier(TEST_KEY);

const cleanupRoots: string[] = [];
const cleanupRepoPathsForLeases: string[] = [];

function trackTempDir(dir: string): string {
  cleanupRoots.push(dir);
  return dir;
}

function gitAt(root: string, ...args: string[]): string {
  return execFileSync('git', ['-C', root, ...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
    windowsHide: true,
  });
}

function initFixtureRepo(): { root: string; head: string } {
  const root = trackTempDir(mkdtempSync(join(tmpdir(), 'wo-gate-fixture-')));
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
    workOrderId: `wo_gate-${randomUUID().slice(0, 8)}`,
    goalId: 'goal-p1a-wave2',
    taskId: 'task-work-order-gate',
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

afterEach(() => {
  for (const repoPath of cleanupRepoPathsForLeases.splice(0)) {
    try { clearRepoWriterLeaseForTests(repoPath); } catch { /* ignore */ }
  }
  for (const dir of cleanupRoots.splice(0)) {
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
});

// ── canonicalizeRepoPath — pure function ────────────────────────────────

describe('canonicalizeRepoPath (pure)', () => {
  it('collapses case differences to one identity on a case-insensitive filesystem', () => {
    const root = trackTempDir(mkdtempSync(join(tmpdir(), 'wo-canon-')));
    const upper = root.toUpperCase();
    const lower = root.toLowerCase();
    expect(canonicalizeRepoPath(upper)).toBe(canonicalizeRepoPath(lower));
  });

  it('collapses forward/backward slash differences to one identity', () => {
    const root = trackTempDir(mkdtempSync(join(tmpdir(), 'wo-canon-')));
    const backslashes = root.replace(/\//g, '\\');
    const forwardslashes = root.replace(/\\/g, '/');
    expect(canonicalizeRepoPath(backslashes)).toBe(canonicalizeRepoPath(forwardslashes));
  });

  it('collapses a trailing separator to the same identity as no trailing separator', () => {
    const root = trackTempDir(mkdtempSync(join(tmpdir(), 'wo-canon-')));
    expect(canonicalizeRepoPath(`${root}\\`)).toBe(canonicalizeRepoPath(root));
    expect(canonicalizeRepoPath(`${root}/`)).toBe(canonicalizeRepoPath(root));
  });

  it('resolves a real path through fs.realpathSync.native without throwing', () => {
    const root = trackTempDir(mkdtempSync(join(tmpdir(), 'wo-canon-')));
    expect(() => canonicalizeRepoPath(root)).not.toThrow();
    expect(canonicalizeRepoPath(root).length).toBeGreaterThan(0);
  });

  it('falls back to lexical normalization for a path that does not exist yet', () => {
    const missing = join(tmpdir(), 'wo-canon-does-not-exist-xyz', 'nested');
    expect(() => canonicalizeRepoPath(missing)).not.toThrow();
  });
});

// ── RepoWriterLease ──────────────────────────────────────────────────────

describe('RepoWriterLease', () => {
  it('a second writer is refused while a live lease is held', () => {
    const dir = trackTempDir(mkdtempSync(join(tmpdir(), 'wo-lease-')));
    cleanupRepoPathsForLeases.push(dir);
    const now = new Date();
    const ownerA: RepoWriterLeaseOwner = { missionId: 'mission-a', workOrderId: 'wo-a' };
    const ownerB: RepoWriterLeaseOwner = { missionId: 'mission-b', workOrderId: 'wo-b' };

    const a = acquireRepoWriterLease({ repoPath: dir, owner: ownerA, now, process: { pid: 111111, bootToken: 'boot-a' } });
    expect(a.ok).toBe(true);

    const b = acquireRepoWriterLease({ repoPath: dir, owner: ownerB, now, process: { pid: 222222, bootToken: 'boot-b' } });
    expect(b.ok).toBe(false);
    if (!b.ok) expect(b.reason).toBe('held_by_other');
  });

  it('equivalent Windows path spellings of the same repo map to one lock', () => {
    const dir = trackTempDir(mkdtempSync(join(tmpdir(), 'wo-lease-')));
    cleanupRepoPathsForLeases.push(dir);
    const now = new Date();
    const ownerA: RepoWriterLeaseOwner = { missionId: 'mission-spell-a', workOrderId: 'wo-spell-a' };
    const ownerB: RepoWriterLeaseOwner = { missionId: 'mission-spell-b', workOrderId: 'wo-spell-b' };

    const a = acquireRepoWriterLease({ repoPath: dir.toUpperCase(), owner: ownerA, now, process: { pid: 111112, bootToken: 'boot-a' } });
    expect(a.ok).toBe(true);

    // Same directory, different case + trailing separator + backslashes.
    const spelledDifferently = `${dir.toLowerCase().replace(/\//g, '\\')}\\`;
    const b = acquireRepoWriterLease({ repoPath: spelledDifferently, owner: ownerB, now, process: { pid: 222223, bootToken: 'boot-b' } });
    expect(b.ok).toBe(false);
    if (!b.ok) expect(b.reason).toBe('held_by_other');
  });

  it('release is recorded — who released and when — and the lease clears', () => {
    const dir = trackTempDir(mkdtempSync(join(tmpdir(), 'wo-lease-')));
    cleanupRepoPathsForLeases.push(dir);
    const owner: RepoWriterLeaseOwner = { missionId: 'mission-release', workOrderId: 'wo-release' };
    const process1 = { pid: 111113, bootToken: 'boot-release' };

    const acquired = acquireRepoWriterLease({ repoPath: dir, owner, process: process1 });
    expect(acquired.ok).toBe(true);

    const beforeRelease = new Date();
    const released = releaseRepoWriterLease({ repoPath: dir, owner, process: process1, now: beforeRelease });
    expect(released).toEqual({ ok: true });

    const info = getRepoWriterLeaseInfo(dir);
    expect(info?.status).toBe('released');
    expect(info?.releasedBy).toEqual(owner);
    expect(info?.releasedAt).toBe(beforeRelease.toISOString());
  });

  it('a different mission cannot release an active lease', () => {
    const dir = trackTempDir(mkdtempSync(join(tmpdir(), 'wo-lease-')));
    cleanupRepoPathsForLeases.push(dir);
    const ownerA: RepoWriterLeaseOwner = { missionId: 'mission-owner', workOrderId: 'wo-owner' };
    const ownerB: RepoWriterLeaseOwner = { missionId: 'mission-intruder', workOrderId: 'wo-intruder' };

    const acquired = acquireRepoWriterLease({ repoPath: dir, owner: ownerA, process: { pid: 111114, bootToken: 'boot-owner' } });
    expect(acquired.ok).toBe(true);

    const releaseAttempt = releaseRepoWriterLease({ repoPath: dir, owner: ownerB, process: { pid: 222224, bootToken: 'boot-intruder' } });
    expect(releaseAttempt).toEqual({ ok: false, reason: 'not_owner' });

    // Lease is still held by the real owner — the refusal did not mutate it.
    const info = getRepoWriterLeaseInfo(dir);
    expect(info?.status).toBe('held');
    expect(info?.owner).toEqual(ownerA);
  });

  it('a crashed process (pid not alive) does NOT silently permit a second writer while the lease is still fresh', () => {
    const dir = trackTempDir(mkdtempSync(join(tmpdir(), 'wo-lease-')));
    cleanupRepoPathsForLeases.push(dir);
    // A pid that is guaranteed dead by the time we check it: spawnSync blocks until the child exits.
    const dead = spawnSync(process.platform === 'win32' ? 'cmd' : 'true', process.platform === 'win32' ? ['/c', 'exit', '0'] : []);
    const deadPid = dead.pid ?? 999999;

    const ownerCrashed: RepoWriterLeaseOwner = { missionId: 'mission-crashed', workOrderId: 'wo-crashed' };
    const ownerSecond: RepoWriterLeaseOwner = { missionId: 'mission-second', workOrderId: 'wo-second' };

    const acquired = acquireRepoWriterLease({
      repoPath: dir,
      owner: ownerCrashed,
      process: { pid: deadPid, bootToken: 'boot-crashed' },
      ttlMs: 20 * 60 * 1000, // still fresh — not expired
    });
    expect(acquired.ok).toBe(true);

    const second = acquireRepoWriterLease({
      repoPath: dir,
      owner: ownerSecond,
      process: { pid: 333333, bootToken: 'boot-second' },
    });
    expect(second.ok).toBe(false);
    if (!second.ok) {
      // No silent takeover — refused exactly like a live holder, even though the pid is dead.
      expect(second.reason).toBe('held_by_other');
      expect(second.holderProcessAlive).toBe(false);
    }
  });

  it('stale lease recovery is explicit and requires recorded evidence — acquire() alone never takes over', () => {
    const dir = trackTempDir(mkdtempSync(join(tmpdir(), 'wo-lease-')));
    cleanupRepoPathsForLeases.push(dir);
    const t0 = new Date();
    const ownerA: RepoWriterLeaseOwner = { missionId: 'mission-stale', workOrderId: 'wo-stale' };
    const ownerB: RepoWriterLeaseOwner = { missionId: 'mission-recoverer', workOrderId: 'wo-recoverer' };

    const acquired = acquireRepoWriterLease({
      repoPath: dir,
      owner: ownerA,
      now: t0,
      ttlMs: 1000,
      process: { pid: 444444, bootToken: 'boot-stale' },
    });
    expect(acquired.ok).toBe(true);

    const later = new Date(t0.getTime() + 10 * 60 * 1000); // well past the 1s ttl

    // Plain acquire() still refuses — it never silently takes over an expired lease.
    const plainAcquire = acquireRepoWriterLease({
      repoPath: dir, owner: ownerB, now: later, process: { pid: 555555, bootToken: 'boot-recoverer' },
    });
    expect(plainAcquire.ok).toBe(false);
    if (!plainAcquire.ok) expect(plainAcquire.reason).toBe('stale_requires_recovery');

    // recoverStaleRepoWriterLease requires a non-empty reason.
    expect(() => recoverStaleRepoWriterLease({
      repoPath: dir, owner: ownerB, now: later, reason: '',
    })).toThrow();

    // A NOT-yet-expired lease refuses recovery too (no early takeover via the recovery path either).
    const tooEarly = recoverStaleRepoWriterLease({
      repoPath: dir, owner: ownerB, now: t0, reason: 'attempting early recovery',
    });
    expect(tooEarly).toEqual({ ok: false, reason: 'lease_not_expired' });

    // The explicit path, with a real reason, at a genuinely-expired now: succeeds and records evidence.
    const recovered = recoverStaleRepoWriterLease({
      repoPath: dir, owner: ownerB, now: later, reason: 'owner lease expired 10 minutes ago; recovering for mission-recoverer',
    });
    expect(recovered.ok).toBe(true);
    if (recovered.ok) {
      expect(recovered.lease.owner).toEqual(ownerB);
      expect(recovered.lease.staleRecovery?.priorOwner).toEqual(ownerA);
      expect(recovered.lease.staleRecovery?.priorLeaseExpiresAt).toBe(new Date(t0.getTime() + 1000).toISOString());
      expect(recovered.lease.staleRecovery?.reason.length).toBeGreaterThan(0);
    }
  });

  it('binds process identity (pid + boot token) into the lease and supports heartbeat renewal', () => {
    const dir = trackTempDir(mkdtempSync(join(tmpdir(), 'wo-lease-')));
    cleanupRepoPathsForLeases.push(dir);
    const owner: RepoWriterLeaseOwner = { missionId: 'mission-hb', workOrderId: 'wo-hb' };
    const proc = { pid: 666666, bootToken: 'boot-hb' };
    const t0 = new Date();

    const acquired = acquireRepoWriterLease({ repoPath: dir, owner, now: t0, ttlMs: 5000, process: proc });
    expect(acquired.ok).toBe(true);
    if (acquired.ok) expect(acquired.lease.process).toEqual(proc);

    const t1 = new Date(t0.getTime() + 2000);
    const renewed = heartbeatRepoWriterLease({ repoPath: dir, owner, now: t1, ttlMs: 5000, process: proc });
    expect(renewed).toBe(true);

    const info = getRepoWriterLeaseInfo(dir);
    expect(info?.leaseExpiresAt).toBe(new Date(t1.getTime() + 5000).toISOString());

    // A non-owner heartbeat is a no-op refusal, not a mutation.
    const wrongProc = heartbeatRepoWriterLease({ repoPath: dir, owner, now: t1, process: { pid: 1, bootToken: 'not-the-owner' } });
    expect(wrongProc).toBe(false);
  });
});

// ── executor-gate ────────────────────────────────────────────────────────

describe('runExecutorGate', () => {
  it('a valid order permits ONE in-scope mutation', () => {
    const { root, head } = initFixtureRepo();
    cleanupRepoPathsForLeases.push(root);
    const evidenceDir = trackTempDir(mkdtempSync(join(tmpdir(), 'wo-gate-evidence-')));
    const replayStore = createWorkOrderReplayStore(trackTempDir(mkdtempSync(join(tmpdir(), 'wo-gate-replay-'))));

    const order = buildOrder(root, head);
    const signed = signWorkOrder(order, signer);
    const owner: RepoWriterLeaseOwner = { missionId: 'mission-valid', workOrderId: signed.workOrderId };
    expect(acquireRepoWriterLease({ repoPath: root, owner }).ok).toBe(true);

    const verdict = runExecutorGate({
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
    expect(verdict.ok).toBe(true);
  });

  it('a path outside allowedPaths is rejected BEFORE any write — the file is never created', () => {
    const { root, head } = initFixtureRepo();
    cleanupRepoPathsForLeases.push(root);
    const evidenceDir = trackTempDir(mkdtempSync(join(tmpdir(), 'wo-gate-evidence-')));
    const replayStore = createWorkOrderReplayStore(trackTempDir(mkdtempSync(join(tmpdir(), 'wo-gate-replay-'))));

    const order = buildOrder(root, head);
    const signed = signWorkOrder(order, signer);
    const owner: RepoWriterLeaseOwner = { missionId: 'mission-oos', workOrderId: signed.workOrderId };
    expect(acquireRepoWriterLease({ repoPath: root, owner }).ok).toBe(true);

    const outOfScopeTarget = join(root, 'other', 'outside.txt');
    const verdict = runExecutorGate({
      signed,
      expectedIssuerIdentity: order.issuerIdentity,
      expectedExecutorIdentity: order.executorIdentity,
      worktreeRoot: root,
      candidatePath: 'other/outside.txt',
      action: 'write-file',
      commandClass: 'fs-write',
      attemptNumber: 1,
      elapsedWallClockMs: 100,
      missionId: owner.missionId,
      replayStore,
      evidenceDir,
      verifier,
    });
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.reason).toBe('path_out_of_scope');
    expect(existsSync(outOfScopeTarget)).toBe(false);
  });

  it('a forbidden command class is rejected', () => {
    const { root, head } = initFixtureRepo();
    cleanupRepoPathsForLeases.push(root);
    const evidenceDir = trackTempDir(mkdtempSync(join(tmpdir(), 'wo-gate-evidence-')));
    const replayStore = createWorkOrderReplayStore(trackTempDir(mkdtempSync(join(tmpdir(), 'wo-gate-replay-'))));

    const order = buildOrder(root, head, { allowedCommandClasses: ['fs-write'] });
    const signed = signWorkOrder(order, signer);
    const owner: RepoWriterLeaseOwner = { missionId: 'mission-cmd', workOrderId: signed.workOrderId };
    expect(acquireRepoWriterLease({ repoPath: root, owner }).ok).toBe(true);

    const verdict = runExecutorGate({
      signed,
      expectedIssuerIdentity: order.issuerIdentity,
      expectedExecutorIdentity: order.executorIdentity,
      worktreeRoot: root,
      candidatePath: 'work/note.txt',
      action: 'write-file',
      commandClass: 'npm-publish',
      attemptNumber: 1,
      elapsedWallClockMs: 100,
      missionId: owner.missionId,
      replayStore,
      evidenceDir,
      verifier,
    });
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.reason).toBe('command_class_forbidden');
  });

  it('first writer acquires the lease and the gate proceeds; without a held lease the gate refuses lease_not_held', () => {
    const { root, head } = initFixtureRepo();
    cleanupRepoPathsForLeases.push(root);
    const evidenceDir = trackTempDir(mkdtempSync(join(tmpdir(), 'wo-gate-evidence-')));
    const replayStore = createWorkOrderReplayStore(trackTempDir(mkdtempSync(join(tmpdir(), 'wo-gate-replay-'))));

    const order = buildOrder(root, head);
    const signed = signWorkOrder(order, signer);

    // No lease acquired at all — gate must refuse.
    const verdict = runExecutorGate({
      signed,
      expectedIssuerIdentity: order.issuerIdentity,
      expectedExecutorIdentity: order.executorIdentity,
      worktreeRoot: root,
      candidatePath: 'work/note.txt',
      action: 'write-file',
      commandClass: 'fs-write',
      attemptNumber: 1,
      elapsedWallClockMs: 100,
      missionId: 'mission-no-lease',
      replayStore,
      evidenceDir,
      verifier,
    });
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.reason).toBe('lease_not_held');
  });

  it('base HEAD mismatch is rejected against the REAL git HEAD, not a caller-supplied claim', () => {
    const { root, head } = initFixtureRepo();
    cleanupRepoPathsForLeases.push(root);
    const evidenceDir = trackTempDir(mkdtempSync(join(tmpdir(), 'wo-gate-evidence-')));
    const replayStore = createWorkOrderReplayStore(trackTempDir(mkdtempSync(join(tmpdir(), 'wo-gate-replay-'))));

    // Sign against the CURRENT real head...
    const order = buildOrder(root, head);
    const signed = signWorkOrder(order, signer);
    const owner: RepoWriterLeaseOwner = { missionId: 'mission-head', workOrderId: signed.workOrderId };
    expect(acquireRepoWriterLease({ repoPath: root, owner }).ok).toBe(true);

    // ...then move the real repo HEAD forward. The signed envelope's baseHead is now stale.
    writeFileSync(join(root, 'second.txt'), 'second commit content\n', 'utf8');
    gitAt(root, 'add', '.');
    gitAt(root, 'commit', '-q', '-m', 'second commit');
    const movedHead = gitAt(root, 'rev-parse', 'HEAD').trim();
    expect(movedHead).not.toBe(head);

    const outOfScopeTarget = join(root, 'work', 'note.txt');
    const verdict = runExecutorGate({
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
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.reason).toBe('base_head_mismatch');
    expect(existsSync(outOfScopeTarget)).toBe(false);
  });

  it('the caller cannot substitute the issuer/executor identity by mirroring the signed envelope\'s own claims', () => {
    const { root, head } = initFixtureRepo();
    cleanupRepoPathsForLeases.push(root);
    const evidenceDir = trackTempDir(mkdtempSync(join(tmpdir(), 'wo-gate-evidence-')));
    const replayStore = createWorkOrderReplayStore(trackTempDir(mkdtempSync(join(tmpdir(), 'wo-gate-replay-'))));

    const order = buildOrder(root, head, {
      issuerIdentity: 'atlas-planner-real',
      executorIdentity: 'atlas-executor-real',
    });
    const signed = signWorkOrder(order, signer);
    const owner: RepoWriterLeaseOwner = { missionId: 'mission-identity', workOrderId: signed.workOrderId };
    expect(acquireRepoWriterLease({ repoPath: root, owner }).ok).toBe(true);

    // The gate is asked with an INDEPENDENTLY-configured expectation that does not match —
    // it must never fall back to trusting signed.issuerIdentity/executorIdentity as "the truth".
    const issuerMismatch = runExecutorGate({
      signed,
      expectedIssuerIdentity: 'atlas-planner-attacker',
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
    expect(issuerMismatch.ok).toBe(false);
    if (!issuerMismatch.ok) expect(issuerMismatch.reason).toBe('issuer_identity_mismatch');

    const executorMismatch = runExecutorGate({
      signed,
      expectedIssuerIdentity: order.issuerIdentity,
      expectedExecutorIdentity: 'atlas-executor-attacker',
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
    expect(executorMismatch.ok).toBe(false);
    if (!executorMismatch.ok) expect(executorMismatch.reason).toBe('wrong_executor_identity');
  });

  it('a receipt binds the exact work-order hash of the rejected envelope', () => {
    const { root, head } = initFixtureRepo();
    cleanupRepoPathsForLeases.push(root);
    const evidenceDir = trackTempDir(mkdtempSync(join(tmpdir(), 'wo-gate-evidence-')));
    const replayStore = createWorkOrderReplayStore(trackTempDir(mkdtempSync(join(tmpdir(), 'wo-gate-replay-'))));

    const order = buildOrder(root, head);
    const signed = signWorkOrder(order, signer);
    // Deliberately no lease acquired — guaranteed, deterministic rejection.
    const verdict = runExecutorGate({
      signed,
      expectedIssuerIdentity: order.issuerIdentity,
      expectedExecutorIdentity: order.executorIdentity,
      worktreeRoot: root,
      candidatePath: 'work/note.txt',
      action: 'write-file',
      commandClass: 'fs-write',
      attemptNumber: 1,
      elapsedWallClockMs: 100,
      missionId: 'mission-hash-bind',
      replayStore,
      evidenceDir,
      verifier,
    });
    expect(verdict.ok).toBe(false);
    if (verdict.ok) throw new Error('unreachable');

    const expectedHash = hashPayload(signed);
    expect(verdict.workOrderHash).toBe(expectedHash);

    const entries = readLedgerEntries(evidenceDir);
    const receipt = entries.find((e) => e.claim.claimId === verdict.receiptClaimId);
    expect(receipt).toBeDefined();
    const parsed = JSON.parse(receipt!.claim.claim) as { workOrderHash: string; workOrderId: string };
    expect(parsed.workOrderHash).toBe(expectedHash);
    expect(parsed.workOrderId).toBe(signed.workOrderId);
  });

  it('a tampered receipt is caught deterministically by the evidence hash chain', () => {
    const { root, head } = initFixtureRepo();
    cleanupRepoPathsForLeases.push(root);
    const evidenceDir = trackTempDir(mkdtempSync(join(tmpdir(), 'wo-gate-evidence-')));
    const replayStore = createWorkOrderReplayStore(trackTempDir(mkdtempSync(join(tmpdir(), 'wo-gate-replay-'))));

    const order = buildOrder(root, head);
    const signed = signWorkOrder(order, signer);
    const verdict = runExecutorGate({
      signed,
      expectedIssuerIdentity: order.issuerIdentity,
      expectedExecutorIdentity: order.executorIdentity,
      worktreeRoot: root,
      candidatePath: 'work/note.txt',
      action: 'write-file',
      commandClass: 'fs-write',
      attemptNumber: 1,
      elapsedWallClockMs: 100,
      missionId: 'mission-tamper',
      replayStore,
      evidenceDir,
      verifier,
    });
    expect(verdict.ok).toBe(false);

    const entries = readLedgerEntries(evidenceDir);
    expect(entries.length).toBeGreaterThan(0);
    const untampered = verifyLedgerChain(entries);
    expect(untampered.ok).toBe(true);

    const tampered = entries.map((entry, index) => (
      index === entries.length - 1
        ? { ...entry, claim: { ...entry.claim, claim: `${entry.claim.claim}-TAMPERED` } }
        : entry
    ));
    const tamperedResult = verifyLedgerChain(tampered);
    expect(tamperedResult.ok).toBe(false);
  });

  it('no signing material appears in any evidence receipt or verdict', () => {
    const { root, head } = initFixtureRepo();
    cleanupRepoPathsForLeases.push(root);
    const evidenceDir = trackTempDir(mkdtempSync(join(tmpdir(), 'wo-gate-evidence-')));
    const replayStore = createWorkOrderReplayStore(trackTempDir(mkdtempSync(join(tmpdir(), 'wo-gate-replay-'))));

    const order = buildOrder(root, head);
    const signed = signWorkOrder(order, signer);
    const verdict = runExecutorGate({
      signed,
      expectedIssuerIdentity: order.issuerIdentity,
      expectedExecutorIdentity: order.executorIdentity,
      worktreeRoot: root,
      candidatePath: 'work/note.txt',
      action: 'write-file',
      commandClass: 'fs-write',
      attemptNumber: 1,
      elapsedWallClockMs: 100,
      missionId: 'mission-no-secret',
      replayStore,
      evidenceDir,
      verifier,
    });
    expect(verdict.ok).toBe(false);
    expect(JSON.stringify(verdict)).not.toContain(TEST_KEY);

    const ledgerRaw = readFileSync(join(evidenceDir, 'ledger.jsonl'), 'utf8');
    expect(ledgerRaw).not.toContain(TEST_KEY);
    const snapshotPath = join(evidenceDir, 'snapshot.json');
    if (existsSync(snapshotPath)) {
      expect(readFileSync(snapshotPath, 'utf8')).not.toContain(TEST_KEY);
    }
  });
});

// ── Step 4 — live bounded proof (disposable fixture repo, never the real one) ──

describe('P1-A wave 2 — live bounded proof', () => {
  it('acquires the lease, makes ONE allowed mutation, proves three rejects, rolls back, and preserves the evidence pack', () => {
    const { root, head } = initFixtureRepo();
    cleanupRepoPathsForLeases.push(root);

    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const evidenceDir = join(homedir(), '.atlas', 'quarantine', 'evidence', `p1a-live-${stamp}-${randomUUID().slice(0, 8)}`);
    mkdirSync(evidenceDir, { recursive: true });

    const missionId = 'p1a-live-proof-mission';
    const order = buildOrder(root, head, {
      workOrderId: `wo_live-proof-${randomUUID().slice(0, 8)}`,
      nonce: `nonce-live-proof-${randomUUID().slice(0, 8)}`,
    });
    const signed = signWorkOrder(order, signer);
    const owner: RepoWriterLeaseOwner = { missionId, workOrderId: signed.workOrderId };

    const replayStoreDir = trackTempDir(mkdtempSync(join(tmpdir(), 'wo-live-replay-')));
    const replayStore = createWorkOrderReplayStore(replayStoreDir);

    // 1. acquire the lease.
    const acquired = acquireRepoWriterLease({ repoPath: root, owner });
    expect(acquired.ok).toBe(true);

    // 2. gate the ONE harmless allowed mutation.
    const verdict = runExecutorGate({
      signed,
      expectedIssuerIdentity: order.issuerIdentity,
      expectedExecutorIdentity: order.executorIdentity,
      worktreeRoot: root,
      candidatePath: 'work/live-proof.txt',
      action: 'write-file',
      commandClass: 'fs-write',
      attemptNumber: 1,
      elapsedWallClockMs: 500,
      missionId,
      replayStore,
      evidenceDir,
      verifier,
    });
    expect(verdict.ok).toBe(true);

    // 3. the mutation itself — performed only after the gate said ok:true.
    mkdirSync(join(root, 'work'), { recursive: true });
    writeFileSync(join(root, 'work', 'live-proof.txt'), 'p1a wave 2 live bounded proof\n', 'utf8');

    // 4. one deterministic check. (git collapses a wholly-untracked new directory
    // to its own path in default --porcelain output, so assert on the directory —
    // confirmed against real `git status --porcelain` output, not assumed.)
    const statusAfterWrite = gitAt(root, 'status', '--porcelain');
    expect(statusAfterWrite).toContain('work/');
    expect(existsSync(join(root, 'work', 'live-proof.txt'))).toBe(true);

    // 5. record success evidence into the SAME pack, via the SAME evidence spine.
    appendClaim(
      {
        claimId: `clm_live-proof-accept-${randomUUID().slice(0, 8)}`,
        claim: JSON.stringify({
          kind: 'work-order-gate-accept',
          verdict: 'ACCEPT',
          workOrderId: signed.workOrderId,
          workOrderHash: verdict.ok ? verdict.workOrderHash : null,
          candidatePath: 'work/live-proof.txt',
        }),
        type: 'narrative',
        path: `work-order://${signed.workOrderId}`,
        confidence: 0,
        source: 'work-order-executor-gate-live-proof',
        sourceRef: signed.workOrderId,
        ts: new Date().toISOString(),
      },
      evidenceDir,
    );

    // 6. release the lease.
    const released = releaseRepoWriterLease({ repoPath: root, owner });
    expect(released).toEqual({ ok: true });

    // 7a. REJECT — replay the SAME order after re-instantiating the replay store from disk.
    // Re-acquire the lease first so replay is the ONLY failing condition being isolated.
    const reacquired = acquireRepoWriterLease({ repoPath: root, owner });
    expect(reacquired.ok).toBe(true);
    const replayStoreFromDisk = createWorkOrderReplayStore(replayStoreDir); // fresh instance, reads the same directory
    const replayVerdict = runExecutorGate({
      signed,
      expectedIssuerIdentity: order.issuerIdentity,
      expectedExecutorIdentity: order.executorIdentity,
      worktreeRoot: root,
      candidatePath: 'work/live-proof.txt',
      action: 'write-file',
      commandClass: 'fs-write',
      attemptNumber: 1,
      elapsedWallClockMs: 500,
      missionId,
      replayStore: replayStoreFromDisk,
      evidenceDir,
      verifier,
    });
    expect(replayVerdict.ok).toBe(false);
    if (!replayVerdict.ok) expect(replayVerdict.reason).toBe('nonce_replayed');

    // 7b. REJECT — a second concurrent writer, while the lease from 7a is still held.
    const concurrentOwner: RepoWriterLeaseOwner = { missionId: 'p1a-live-proof-intruder', workOrderId: 'wo-intruder' };
    const concurrent = acquireRepoWriterLease({ repoPath: root, owner: concurrentOwner });
    expect(concurrent.ok).toBe(false);
    if (!concurrent.ok) expect(concurrent.reason).toBe('held_by_other');

    // 7c. REJECT — a tampered receipt is caught deterministically.
    const entriesBeforeTamper = readLedgerEntries(evidenceDir);
    expect(entriesBeforeTamper.length).toBeGreaterThan(0);
    expect(verifyLedgerChain(entriesBeforeTamper).ok).toBe(true);
    const tamperedEntries = entriesBeforeTamper.map((entry, index) => (
      index === entriesBeforeTamper.length - 1
        ? { ...entry, claim: { ...entry.claim, claim: `${entry.claim.claim}-TAMPERED` } }
        : entry
    ));
    expect(verifyLedgerChain(tamperedEntries).ok).toBe(false);

    // Final release of the re-acquired lease.
    expect(releaseRepoWriterLease({ repoPath: root, owner })).toEqual({ ok: true });

    // 8. roll back the harmless change and prove the fixture repo is back to its base state.
    rmSync(join(root, 'work'), { recursive: true, force: true });
    const statusAfterRollback = gitAt(root, 'status', '--porcelain');
    expect(statusAfterRollback.trim()).toBe('');

    // 9. evidence pack is preserved (asserted before the outer afterEach deletes the fixture repo — NOT the evidence pack, which lives under $HOME, outside cleanupRoots).
    expect(existsSync(evidenceDir)).toBe(true);
    expect(existsSync(join(evidenceDir, 'ledger.jsonl'))).toBe(true);
    console.log(`[p1a-live-proof] evidence pack preserved at: ${evidenceDir}`);
  });
});
