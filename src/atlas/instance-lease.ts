/**
 * M4-C — Atlas instance anti-fork lease.
 * One writer per machine; second concurrent launch is read-only with loud notice.
 */

import { randomUUID } from 'node:crypto';
import {
  existsSync, mkdirSync, readFileSync, writeFileSync, renameSync, unlinkSync,
} from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { resolveMigratingStateDir } from './state-root.js';

export type InstanceLeaseMode = 'writer' | 'readonly';

/**
 * Self-declared state of the process holding the lease.
 *
 * Written by the lease OWNER at startup, read by anyone. This exists so
 * diagnostics describe the RUNNING process instead of the process doing
 * the asking (defect found live 2026-07-28: `runner status` computed
 * authEnforcement from its own env, so a probe that never loaded .env
 * reported "off" while enforcement was actually on).
 *
 * Anything here is a claim about the owner, valid only while the owner
 * holds the lease — acquireInstanceLease() drops it on takeover.
 */
export interface RunnerAnnotation {
  /** Explicit runner identity. Optional only for legacy lease-file compatibility. */
  kind?: 'runner';
  /** Queue authenticity enforcement, as resolved by the RUNNING process. */
  authEnforcement?: 'on' | 'off';
  /** Built entry the owner is executing (absolute path). */
  entryPath?: string;
  /** mtime of that built entry — which build is actually live. */
  buildMtimeMs?: number;
  /** Build freshness verdict at the moment the owner started. */
  buildFreshness?: 'fresh' | 'stale' | 'unknown';
  /** When the owner recorded this. */
  recordedAt?: string;
}

export interface InstanceLease {
  instanceId: string;
  pid: number;
  startedAt: string;
  heartbeatAt: string;
  /** Present only once the owner has declared its own state. */
  runner?: RunnerAnnotation;
}

export interface InstanceLeaseResult {
  mode: InstanceLeaseMode;
  instanceId: string;
  reason?: string;
}

const DEFAULT_LEASE_TTL_MS = 60_000;

/** Status observes an existing lease; all other CLI commands need writer protection. */
export function shouldAcquireInstanceLease(argv: readonly string[]): boolean {
  return !(argv[0] === 'runner' && argv[1] === 'status');
}

export function resolveInstanceLeaseDir(): string {
  return resolveMigratingStateDir(
    'instance-lease',
    () => join(homedir(), '.atlas'),
  );
}

function leasePath(): string {
  const dir = resolveInstanceLeaseDir();
  mkdirSync(dir, { recursive: true });
  return join(dir, 'instance-lease.json');
}

function isProcessAlive(pid: number): boolean {
  if (!Number.isFinite(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err: unknown) {
    const code = (err as NodeJS.ErrnoException)?.code;
    if (code === 'EPERM') return true;
    return false;
  }
}

function writeAtomic(path: string, data: string): void {
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, data, 'utf8');
  renameSync(tmp, path);
}

function readLease(): InstanceLease | null {
  const path = leasePath();
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as InstanceLease;
  } catch {
    return null;
  }
}

function isLeaseFresh(lease: InstanceLease, ttlMs: number): boolean {
  const hb = Date.parse(lease.heartbeatAt);
  return Number.isFinite(hb) && Date.now() - hb < ttlMs;
}

/** Acquire or observe instance lease. Second live writer → readonly. */
export function acquireInstanceLease(opts?: {
  instanceId?: string;
  ttlMs?: number;
}): InstanceLeaseResult {
  const instanceId = opts?.instanceId ?? randomUUID();
  const ttlMs = opts?.ttlMs ?? DEFAULT_LEASE_TTL_MS;
  const path = leasePath();
  const existing = readLease();

  if (existing && existing.instanceId !== instanceId) {
    const alive = isProcessAlive(existing.pid);
    const fresh = isLeaseFresh(existing, ttlMs);
    if (alive && fresh) {
      return {
        mode: 'readonly',
        instanceId,
        reason: `another Atlas instance holds the lease (pid=${existing.pid}, id=${existing.instanceId.slice(0, 8)})`,
      };
    }
  }

  const now = new Date().toISOString();
  const lease: InstanceLease = {
    instanceId,
    pid: process.pid,
    startedAt: existing?.instanceId === instanceId ? existing.startedAt : now,
    heartbeatAt: now,
  };
  writeAtomic(path, JSON.stringify(lease, null, 2));
  return { mode: 'writer', instanceId };
}

export function heartbeatInstanceLease(instanceId: string): boolean {
  const existing = readLease();
  if (!existing || existing.instanceId !== instanceId || existing.pid !== process.pid) {
    return false;
  }
  existing.heartbeatAt = new Date().toISOString();
  writeAtomic(leasePath(), JSON.stringify(existing, null, 2));
  return true;
}

/**
 * Record the calling process's own state into the lease it owns.
 *
 * Ownership is proven by acquisition-specific instanceId and pid. A
 * read-only second instance therefore cannot overwrite the real writer's
 * declaration — it just gets `false`.
 *
 * Merges into any existing annotation. Returns false when not the owner.
 */
export function annotateInstanceLease(
  instanceId: string,
  patch: RunnerAnnotation,
): boolean {
  const existing = readLease();
  if (
    !existing
    || existing.instanceId !== instanceId
    || existing.pid !== process.pid
  ) return false;
  existing.runner = {
    ...existing.runner,
    ...patch,
    recordedAt: patch.recordedAt ?? new Date().toISOString(),
  };
  writeAtomic(leasePath(), JSON.stringify(existing, null, 2));
  return true;
}

export function releaseInstanceLease(instanceId: string): void {
  const existing = readLease();
  if (!existing || existing.instanceId !== instanceId) return;
  if (existing.pid !== process.pid) return;
  try {
    unlinkSync(leasePath());
  } catch { /* ignore */ }
}

const heartbeatTimers = new Map<string, NodeJS.Timeout>();

/** Periodic heartbeat so long-idle writers keep the lease (closes M4-ADV-02). */
export function startInstanceLeaseHeartbeat(
  instanceId: string,
  intervalMs = Math.floor(DEFAULT_LEASE_TTL_MS / 3),
): void {
  stopInstanceLeaseHeartbeat(instanceId);
  const timer = setInterval(() => {
    heartbeatInstanceLease(instanceId);
  }, intervalMs);
  // Don't keep process alive solely for heartbeat in tests/CLI short commands.
  if (typeof timer.unref === 'function') timer.unref();
  heartbeatTimers.set(instanceId, timer);
}

export function stopInstanceLeaseHeartbeat(instanceId: string): void {
  const timer = heartbeatTimers.get(instanceId);
  if (timer) {
    clearInterval(timer);
    heartbeatTimers.delete(instanceId);
  }
}

/** Test helper — clear lease file. */
export function clearInstanceLeaseForTests(): void {
  stopInstanceLeaseHeartbeat('inst-hb');
  for (const id of [...heartbeatTimers.keys()]) stopInstanceLeaseHeartbeat(id);
  const path = leasePath();
  if (existsSync(path)) unlinkSync(path);
}

/** Read-only accessor for external status/diagnostic tools (e.g. `atlas runner status`). */
export function getInstanceLeaseInfo(): InstanceLease | null {
  return readLease();
}

export { isProcessAlive as isInstanceProcessAlive, DEFAULT_LEASE_TTL_MS };
