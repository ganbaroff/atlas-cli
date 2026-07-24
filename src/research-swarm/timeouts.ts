/**
 * Bounded timeout helpers for research swarm phases.
 */

import type { TimeoutConfig } from './types.js';

function readPositiveInt(envKey: string, fallback: number): number {
  const raw = process.env[envKey];
  if (!raw) return fallback;
  const n = parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

export function readTimeoutConfig(): TimeoutConfig {
  return {
    routingMs: readPositiveInt('ATLAS_SWARM_ROUTING_TIMEOUT_MS', 10_000),
    workerMs: readPositiveInt('ATLAS_SWARM_WORKER_TIMEOUT_MS', 60_000),
    judgeMs: readPositiveInt('ATLAS_SWARM_JUDGE_TIMEOUT_MS', 45_000),
    globalMs: readPositiveInt('ATLAS_SWARM_GLOBAL_TIMEOUT_MS', 180_000),
  };
}

export type TimeoutOutcome<T> =
  | { kind: 'resolved'; value: T }
  | { kind: 'timeout' }
  | { kind: 'rejected'; error: unknown };

export function withTimeoutOutcome<T>(promise: Promise<T>, ms: number): Promise<TimeoutOutcome<T>> {
  return new Promise((resolve) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      resolve({ kind: 'timeout' });
    }, ms);

    promise.then(
      (value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve({ kind: 'resolved', value });
      },
      (error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve({ kind: 'rejected', error });
      },
    );
  });
}

export function remainingMs(deadlineMs: number): number {
  return Math.max(0, deadlineMs - Date.now());
}

export function isPastDeadline(deadlineMs: number): boolean {
  return Date.now() >= deadlineMs;
}
