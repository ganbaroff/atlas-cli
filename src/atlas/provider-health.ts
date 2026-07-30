/**
 * M6 — Provider health state (durable, deterministic).
 * Dead providers are never assigned WORKER roles until cooldown expires.
 */

import {
  existsSync, mkdirSync, readFileSync, writeFileSync, renameSync, unlinkSync,
} from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import type { ProviderName } from '../model-router.js';
import { resolveMigratingStateDir } from './state-root.js';

export type ProviderHealthState = 'healthy' | 'degraded' | 'dead';

export interface ProviderHealthEntry {
  provider: ProviderName;
  state: ProviderHealthState;
  updatedAt: string;
  /** ISO timestamp when cooldown ends (dead/degraded). */
  cooldownUntil?: string;
  reason?: string;
  consecutiveFailures: number;
}

export interface ProviderHealthStore {
  updatedAt: string;
  providers: Record<string, ProviderHealthEntry>;
}

const DEFAULT_DEAD_COOLDOWN_MS = 5 * 60 * 1000;
const DEFAULT_DEGRADED_COOLDOWN_MS = 60 * 1000;
const FAIL_THRESHOLD_DEAD = 2;

export function resolveProviderHealthDir(): string {
  return resolveMigratingStateDir(
    'provider-health',
    () => join(homedir(), '.atlas'),
  );
}

function healthPath(): string {
  return join(resolveProviderHealthDir(), 'provider-health.json');
}

function ensureHealthDir(): void {
  mkdirSync(resolveProviderHealthDir(), { recursive: true });
}

function writeAtomic(path: string, data: string): void {
  ensureHealthDir();
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, data, 'utf8');
  renameSync(tmp, path);
}

function loadStore(): ProviderHealthStore {
  const path = healthPath();
  // Read path must not mkdir — some tests mock node:fs without mkdirSync.
  if (!existsSync(path)) {
    return { updatedAt: new Date().toISOString(), providers: {} };
  }
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as ProviderHealthStore;
  } catch {
    return { updatedAt: new Date().toISOString(), providers: {} };
  }
}

function saveStore(store: ProviderHealthStore): void {
  store.updatedAt = new Date().toISOString();
  writeAtomic(healthPath(), JSON.stringify(store, null, 2));
}

function cooldownActive(entry: ProviderHealthEntry, now = Date.now()): boolean {
  if (!entry.cooldownUntil) return false;
  const until = Date.parse(entry.cooldownUntil);
  return Number.isFinite(until) && until > now;
}

/** True when provider may be selected for routing. */
export function isProviderHealthyForRouting(provider: ProviderName, now = Date.now()): boolean {
  const store = loadStore();
  const entry = store.providers[provider];
  if (!entry) return true;
  if (entry.state === 'healthy') return true;
  if (entry.state === 'degraded') {
    // Degraded may still be tried after cooldown; during cooldown skip.
    return !cooldownActive(entry, now);
  }
  // dead — never assign until cooldown expires
  if (entry.state === 'dead') {
    if (cooldownActive(entry, now)) return false;
    // cooldown expired → clear to healthy for a retry chance
    entry.state = 'healthy';
    entry.consecutiveFailures = 0;
    delete entry.cooldownUntil;
    delete entry.reason;
    saveStore(store);
    return true;
  }
  return true;
}

export function getProviderHealth(provider: ProviderName): ProviderHealthEntry | null {
  return loadStore().providers[provider] ?? null;
}

export function listProviderHealth(): ProviderHealthEntry[] {
  return Object.values(loadStore().providers);
}

export function markProviderHealthy(provider: ProviderName): void {
  const store = loadStore();
  store.providers[provider] = {
    provider,
    state: 'healthy',
    updatedAt: new Date().toISOString(),
    consecutiveFailures: 0,
  };
  saveStore(store);
}

export function markProviderDegraded(
  provider: ProviderName,
  reason: string,
  cooldownMs = DEFAULT_DEGRADED_COOLDOWN_MS,
): void {
  const store = loadStore();
  const prev = store.providers[provider];
  const failures = (prev?.consecutiveFailures ?? 0) + 1;
  store.providers[provider] = {
    provider,
    state: 'degraded',
    updatedAt: new Date().toISOString(),
    cooldownUntil: new Date(Date.now() + cooldownMs).toISOString(),
    reason,
    consecutiveFailures: failures,
  };
  saveStore(store);
}

export function markProviderDead(
  provider: ProviderName,
  reason: string,
  cooldownMs = DEFAULT_DEAD_COOLDOWN_MS,
): void {
  const store = loadStore();
  const prev = store.providers[provider];
  store.providers[provider] = {
    provider,
    state: 'dead',
    updatedAt: new Date().toISOString(),
    cooldownUntil: new Date(Date.now() + cooldownMs).toISOString(),
    reason,
    consecutiveFailures: (prev?.consecutiveFailures ?? 0) + FAIL_THRESHOLD_DEAD,
  };
  saveStore(store);
}

/** Classify error → degraded or dead and persist. */
export function recordProviderFailure(provider: ProviderName, error: string): ProviderHealthState {
  if (/401|403|unauth|invalid.?api.?key/i.test(error)) {
    markProviderDead(provider, error);
    return 'dead';
  }
  if (/429|rate.?limit/i.test(error)) {
    markProviderDegraded(provider, error);
    return 'degraded';
  }
  if (/timeout|timed out|ECONNREFUSED|ENOTFOUND|network/i.test(error)) {
    const prev = getProviderHealth(provider);
    if ((prev?.consecutiveFailures ?? 0) >= 1) {
      markProviderDead(provider, error);
      return 'dead';
    }
    markProviderDegraded(provider, error);
    return 'degraded';
  }
  markProviderDegraded(provider, error);
  return 'degraded';
}

/** Test helper. */
export function clearProviderHealthForTests(): void {
  const path = healthPath();
  if (existsSync(path)) unlinkSync(path);
}

export { DEFAULT_DEAD_COOLDOWN_MS, DEFAULT_DEGRADED_COOLDOWN_MS };
