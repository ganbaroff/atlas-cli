/**
 * atlas/work-order/repo-writer-lock.ts — RepoWriterLease (P1-A wave 2).
 *
 * Single-writer mutual exclusion PER REPOSITORY, sitting beneath the signed
 * Work Order envelope (wave 1) and underneath executor-gate.ts (wave 2 step
 * 2). A Work Order proves an executor is AUTHORIZED to touch a repo; a
 * RepoWriterLease proves no OTHER process is concurrently mutating the SAME
 * repo right now. Two different concerns, two different failure modes —
 * this module only does mutual exclusion.
 *
 * Reuse survey (2026-08-06): the mechanism (atomic `wx` lock file +
 * read-modify-write under withExclusiveFileLock) and the state-root
 * directory convention are lifted directly from atlas/instance-lease.ts —
 * this is NOT a parallel lease system. instance-lease.ts answers "which
 * process may run the Atlas machine-wide singleton"; RepoWriterLease answers
 * "which mission may currently mutate THIS repository" — a different key
 * (per-repo, not per-machine) with a DELIBERATELY stricter takeover rule:
 * instance-lease.ts silently reclaims a dead/expired lease on the next
 * acquire call; RepoWriterLease never does that inside acquire — recovering
 * a stale lease is always a separate, explicit call
 * (recoverStaleRepoWriterLease) that records proof. isInstanceProcessAlive
 * is reused as-is from instance-lease.ts rather than re-implementing the
 * same `process.kill(pid, 0)` liveness probe.
 *
 * Persistence reuses the SAME 'instance-lease' state-root store — no new
 * store is registered in state-root.ts's STATE_STORES; see
 * state-writer-inventory.ts's entry for this file.
 */

import { randomUUID, createHash } from 'node:crypto';
import {
  existsSync, mkdirSync, readFileSync, writeFileSync, renameSync, unlinkSync, appendFileSync, realpathSync,
} from 'node:fs';
import { join, resolve as resolvePath } from 'node:path';
import { homedir } from 'node:os';
import { resolveMigratingStateDir } from '../state-root.js';
import { withExclusiveFileLock } from '../../exec-graph/ledger.js';
import { isInstanceProcessAlive } from '../instance-lease.js';

// ── Canonical repository path identity ──────────────────────────────────

/**
 * Collapse different Windows spellings of the SAME repository directory
 * into one identity string: case, forward/backward slashes, trailing
 * separators, and — where the path exists on disk — symlinks and 8.3 short
 * names, resolved via fs.realpathSync.native (the same primitive Windows
 * itself uses to hand back the canonical long-form path for a handle).
 * Pure — no locking, no process state, safe to call from anywhere.
 */
export function canonicalizeRepoPath(inputPath: string): string {
  const trimmed = (inputPath ?? '').trim();
  let candidate = resolvePath(trimmed.replace(/\\/g, '/'));

  const nativeRealpath = realpathSync.native ?? realpathSync;
  try {
    candidate = nativeRealpath(candidate);
  } catch {
    // Path doesn't exist yet (e.g. a Work Order issued before the worktree
    // is created) — fall back to the lexically resolved form. Case/slash/
    // trailing-separator normalization below still applies.
  }

  candidate = candidate.replace(/\\/g, '/').replace(/\/+$/, '');
  if (process.platform === 'win32' || process.platform === 'darwin') {
    candidate = candidate.toLowerCase();
  }
  return candidate;
}

/** Stable, filesystem-safe key derived from a canonical repo path. */
function repoLockKey(canonicalPath: string): string {
  return createHash('sha256').update(canonicalPath).digest('hex').slice(0, 24);
}

// ── Types ────────────────────────────────────────────────────────────────

export interface RepoWriterLeaseOwner {
  readonly missionId: string;
  readonly workOrderId: string;
}

export interface RepoWriterLeaseProcessIdentity {
  readonly pid: number;
  /** Boot-unique token — distinguishes two processes that share a recycled OS pid. */
  readonly bootToken: string;
}

export interface RepoWriterLeaseStaleRecoveryEvidence {
  readonly recoveredBy: RepoWriterLeaseOwner;
  readonly recoveredAt: string;
  readonly priorOwner: RepoWriterLeaseOwner;
  readonly priorProcess: RepoWriterLeaseProcessIdentity;
  readonly priorLeaseExpiresAt: string;
  readonly priorOwnerProcessAlive: boolean;
  readonly reason: string;
}

/** The named lock primitive itself — one record per repository. */
export interface RepoWriterLease {
  readonly repoCanonicalPath: string;
  readonly owner: RepoWriterLeaseOwner;
  readonly process: RepoWriterLeaseProcessIdentity;
  readonly acquiredAt: string;
  readonly leaseExpiresAt: string;
  readonly heartbeatAt: string;
  readonly status: 'held' | 'released';
  readonly releasedAt?: string;
  readonly releasedBy?: RepoWriterLeaseOwner;
  readonly staleRecovery?: RepoWriterLeaseStaleRecoveryEvidence;
}

export type RepoWriterLeaseRefusalReason = 'held_by_other' | 'stale_requires_recovery';

export type RepoWriterLeaseAcquireResult =
  | { readonly ok: true; readonly lease: RepoWriterLease }
  | {
      readonly ok: false;
      readonly reason: RepoWriterLeaseRefusalReason;
      readonly holder: RepoWriterLease;
      readonly holderProcessAlive: boolean;
    };

export type RepoWriterLeaseReleaseResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: 'no_active_lease' | 'not_owner' };

export type RepoWriterLeaseRecoveryResult =
  | { readonly ok: true; readonly lease: RepoWriterLease }
  | { readonly ok: false; readonly reason: 'no_lease_to_recover' | 'lease_not_expired' };

/** Long enough to cover one bounded work-order attempt; renew via heartbeat for longer runs. */
const DEFAULT_LEASE_TTL_MS = 20 * 60 * 1000;

/** This process's own boot-unique identity — stable for the process lifetime, unique across restarts even if the OS recycles the pid. */
export const PROCESS_BOOT_TOKEN = randomUUID();

function thisProcessIdentity(overrides?: Partial<RepoWriterLeaseProcessIdentity>): RepoWriterLeaseProcessIdentity {
  return {
    pid: overrides?.pid ?? process.pid,
    bootToken: overrides?.bootToken ?? PROCESS_BOOT_TOKEN,
  };
}

function sameOwner(a: RepoWriterLeaseOwner, b: RepoWriterLeaseOwner): boolean {
  return a.missionId === b.missionId && a.workOrderId === b.workOrderId;
}

function sameProcess(a: RepoWriterLeaseProcessIdentity, b: RepoWriterLeaseProcessIdentity): boolean {
  return a.pid === b.pid && a.bootToken === b.bootToken;
}

// ── Persistence ──────────────────────────────────────────────────────────

/** Same state family as atlas/instance-lease.ts — no new store registered. */
export function resolveRepoWriterLeaseRootDir(): string {
  return resolveMigratingStateDir('instance-lease', () => join(homedir(), '.atlas'));
}

function repoLeaseDir(canonicalPath: string): string {
  return join(resolveRepoWriterLeaseRootDir(), 'repo-writer-leases', repoLockKey(canonicalPath));
}

function statePath(dir: string): string {
  return join(dir, 'state.json');
}

function eventsPath(dir: string): string {
  return join(dir, 'events.jsonl');
}

function writeAtomic(path: string, data: string): void {
  const tmp = `${path}.${process.pid}.${randomUUID()}.tmp`;
  writeFileSync(tmp, data, 'utf8');
  renameSync(tmp, path);
}

function readState(dir: string): RepoWriterLease | null {
  const path = statePath(dir);
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as RepoWriterLease;
  } catch {
    return null;
  }
}

function appendEvent(dir: string, event: Record<string, unknown>): void {
  mkdirSync(dir, { recursive: true });
  appendFileSync(eventsPath(dir), `${JSON.stringify({ ...event, ts: new Date().toISOString() })}\n`, 'utf8');
}

function isExpired(record: RepoWriterLease, now: Date): boolean {
  const expiresAtMs = Date.parse(record.leaseExpiresAt);
  return !Number.isFinite(expiresAtMs) || now.getTime() >= expiresAtMs;
}

// ── Public operations ───────────────────────────────────────────────────

export interface AcquireRepoWriterLeaseOptions {
  readonly repoPath: string;
  readonly owner: RepoWriterLeaseOwner;
  readonly ttlMs?: number;
  readonly now?: Date;
  /** Test-only override to simulate a distinct OS process within one test process. */
  readonly process?: Partial<RepoWriterLeaseProcessIdentity>;
}

/**
 * Acquire (or idempotently renew, for the SAME owner+process) the writer
 * lease for a repository. Never silently takes over a lease it does not
 * already own — a live OR merely-expired lease held by someone else always
 * refuses here; see recoverStaleRepoWriterLease for the explicit path.
 */
export function acquireRepoWriterLease(
  opts: AcquireRepoWriterLeaseOptions,
): RepoWriterLeaseAcquireResult {
  const canonicalPath = canonicalizeRepoPath(opts.repoPath);
  const dir = repoLeaseDir(canonicalPath);
  const now = opts.now ?? new Date();
  const ttlMs = opts.ttlMs ?? DEFAULT_LEASE_TTL_MS;
  const me = thisProcessIdentity(opts.process);

  return withExclusiveFileLock(dir, 'lease.lock', (): RepoWriterLeaseAcquireResult => {
    const existing = readState(dir);

    if (existing && existing.status === 'held' && !sameOwner(existing.owner, opts.owner)) {
      const holderProcessAlive = isInstanceProcessAlive(existing.process.pid);
      const reason: RepoWriterLeaseRefusalReason = isExpired(existing, now)
        ? 'stale_requires_recovery'
        : 'held_by_other';
      appendEvent(dir, {
        event: 'refused',
        reason,
        repoCanonicalPath: canonicalPath,
        requestedBy: opts.owner,
        holder: existing.owner,
      });
      return { ok: false, reason, holder: existing, holderProcessAlive };
    }

    const renewing = existing !== null && existing.status === 'held' && sameOwner(existing.owner, opts.owner);
    const lease: RepoWriterLease = {
      repoCanonicalPath: canonicalPath,
      owner: opts.owner,
      process: me,
      acquiredAt: renewing ? existing!.acquiredAt : now.toISOString(),
      leaseExpiresAt: new Date(now.getTime() + ttlMs).toISOString(),
      heartbeatAt: now.toISOString(),
      status: 'held',
    };
    mkdirSync(dir, { recursive: true });
    writeAtomic(statePath(dir), JSON.stringify(lease, null, 2));
    appendEvent(dir, {
      event: renewing ? 'renewed' : 'acquired',
      repoCanonicalPath: canonicalPath,
      owner: opts.owner,
      process: me,
    });
    return { ok: true, lease };
  });
}

export interface HeartbeatRepoWriterLeaseOptions {
  readonly repoPath: string;
  readonly owner: RepoWriterLeaseOwner;
  readonly ttlMs?: number;
  readonly now?: Date;
  readonly process?: Partial<RepoWriterLeaseProcessIdentity>;
}

/** Renew an already-held lease. Returns false (no mutation) when the caller is not the current owner. */
export function heartbeatRepoWriterLease(opts: HeartbeatRepoWriterLeaseOptions): boolean {
  const canonicalPath = canonicalizeRepoPath(opts.repoPath);
  const dir = repoLeaseDir(canonicalPath);
  const now = opts.now ?? new Date();
  const ttlMs = opts.ttlMs ?? DEFAULT_LEASE_TTL_MS;
  const me = thisProcessIdentity(opts.process);

  return withExclusiveFileLock(dir, 'lease.lock', (): boolean => {
    const existing = readState(dir);
    if (
      !existing || existing.status !== 'held'
      || !sameOwner(existing.owner, opts.owner)
      || !sameProcess(existing.process, me)
    ) return false;

    const lease: RepoWriterLease = {
      ...existing,
      leaseExpiresAt: new Date(now.getTime() + ttlMs).toISOString(),
      heartbeatAt: now.toISOString(),
    };
    writeAtomic(statePath(dir), JSON.stringify(lease, null, 2));
    appendEvent(dir, {
      event: 'heartbeat',
      repoCanonicalPath: canonicalPath,
      owner: opts.owner,
      process: me,
    });
    return true;
  });
}

export interface ReleaseRepoWriterLeaseOptions {
  readonly repoPath: string;
  readonly owner: RepoWriterLeaseOwner;
  readonly now?: Date;
  readonly process?: Partial<RepoWriterLeaseProcessIdentity>;
}

/** Only the current owner (same missionId+workOrderId+pid+bootToken) may release. Release is recorded in the events journal. */
export function releaseRepoWriterLease(
  opts: ReleaseRepoWriterLeaseOptions,
): RepoWriterLeaseReleaseResult {
  const canonicalPath = canonicalizeRepoPath(opts.repoPath);
  const dir = repoLeaseDir(canonicalPath);
  const now = opts.now ?? new Date();
  const me = thisProcessIdentity(opts.process);

  return withExclusiveFileLock(dir, 'lease.lock', (): RepoWriterLeaseReleaseResult => {
    const existing = readState(dir);
    if (!existing || existing.status !== 'held') {
      return { ok: false, reason: 'no_active_lease' };
    }
    if (!sameOwner(existing.owner, opts.owner) || !sameProcess(existing.process, me)) {
      appendEvent(dir, {
        event: 'release_refused',
        reason: 'not_owner',
        repoCanonicalPath: canonicalPath,
        requestedBy: opts.owner,
        holder: existing.owner,
      });
      return { ok: false, reason: 'not_owner' };
    }

    const released: RepoWriterLease = {
      ...existing,
      status: 'released',
      releasedAt: now.toISOString(),
      releasedBy: opts.owner,
    };
    writeAtomic(statePath(dir), JSON.stringify(released, null, 2));
    appendEvent(dir, {
      event: 'released',
      repoCanonicalPath: canonicalPath,
      owner: opts.owner,
      process: me,
    });
    return { ok: true };
  });
}

export interface RecoverStaleRepoWriterLeaseOptions {
  readonly repoPath: string;
  readonly owner: RepoWriterLeaseOwner;
  readonly reason: string;
  readonly ttlMs?: number;
  readonly now?: Date;
  readonly process?: Partial<RepoWriterLeaseProcessIdentity>;
}

/**
 * Explicitly recover a lease whose leaseExpiresAt has already passed. This
 * NEVER runs implicitly inside acquireRepoWriterLease — a caller must ask
 * for it by name and supply a non-empty `reason`. The prior holder's
 * expired leaseExpiresAt is re-read from disk under the same lock (never
 * trusted from the caller) and is the proof recorded into staleRecovery.
 */
export function recoverStaleRepoWriterLease(
  opts: RecoverStaleRepoWriterLeaseOptions,
): RepoWriterLeaseRecoveryResult {
  if (!opts.reason || !opts.reason.trim()) {
    throw new Error('recoverStaleRepoWriterLease: reason is required and must be non-empty');
  }
  const canonicalPath = canonicalizeRepoPath(opts.repoPath);
  const dir = repoLeaseDir(canonicalPath);
  const now = opts.now ?? new Date();
  const ttlMs = opts.ttlMs ?? DEFAULT_LEASE_TTL_MS;
  const me = thisProcessIdentity(opts.process);

  return withExclusiveFileLock(dir, 'lease.lock', (): RepoWriterLeaseRecoveryResult => {
    const existing = readState(dir);
    if (!existing || existing.status !== 'held') {
      return { ok: false, reason: 'no_lease_to_recover' };
    }
    if (!isExpired(existing, now)) {
      return { ok: false, reason: 'lease_not_expired' };
    }

    const evidence: RepoWriterLeaseStaleRecoveryEvidence = {
      recoveredBy: opts.owner,
      recoveredAt: now.toISOString(),
      priorOwner: existing.owner,
      priorProcess: existing.process,
      priorLeaseExpiresAt: existing.leaseExpiresAt,
      priorOwnerProcessAlive: isInstanceProcessAlive(existing.process.pid),
      reason: opts.reason,
    };

    const lease: RepoWriterLease = {
      repoCanonicalPath: canonicalPath,
      owner: opts.owner,
      process: me,
      acquiredAt: now.toISOString(),
      leaseExpiresAt: new Date(now.getTime() + ttlMs).toISOString(),
      heartbeatAt: now.toISOString(),
      status: 'held',
      staleRecovery: evidence,
    };
    mkdirSync(dir, { recursive: true });
    writeAtomic(statePath(dir), JSON.stringify(lease, null, 2));
    appendEvent(dir, { event: 'stale-recovered', repoCanonicalPath: canonicalPath, evidence });
    return { ok: true, lease };
  });
}

/** Read-only accessor — never mutates. Used by diagnostics, executor-gate.ts, and tests. */
export function getRepoWriterLeaseInfo(repoPath: string): RepoWriterLease | null {
  return readState(repoLeaseDir(canonicalizeRepoPath(repoPath)));
}

/** Test helper — remove all persisted state for one repo's lease. */
export function clearRepoWriterLeaseForTests(repoPath: string): void {
  const dir = repoLeaseDir(canonicalizeRepoPath(repoPath));
  const path = statePath(dir);
  if (existsSync(path)) {
    try { unlinkSync(path); } catch { /* ignore */ }
  }
  const events = eventsPath(dir);
  if (existsSync(events)) {
    try { unlinkSync(events); } catch { /* ignore */ }
  }
}

export { DEFAULT_LEASE_TTL_MS as REPO_WRITER_LEASE_DEFAULT_TTL_MS };
