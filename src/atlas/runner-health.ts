/**
 * atlas/runner-health.ts — read-only runner health diagnostic (Wave 1).
 *
 * Contract: no queue claim, no lease write/heartbeat, no remote DB client,
 * no task execution, no network client. Local reads only.
 *
 * Intentionally does NOT import the runner loop module (that module loads the
 * queue claim/complete/fail path and the local task spawner).
 */

import { createHash } from 'node:crypto';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  assertStateRootActivated,
  isStateRootActivationRequired,
  resolveStateRoot,
  StateRootActivationError,
  StateRootConfigurationError,
  type StateRootActivationManifest,
} from './state-root.js';
import {
  DEFAULT_LEASE_TTL_MS,
  getInstanceLeaseInfoReadonly,
  isInstanceProcessAlive,
  type InstanceLease,
} from './instance-lease.js';

export type RunnerHealthVerdict =
  | 'HEALTHY'
  | 'STALE'
  | 'NOT_RUNNING'
  | 'OCCUPIED'
  | 'ACTIVATION_FAILED'
  | 'FLAG_REQUIRED';

export type RunnerHealthLeaseStatus = 'running' | 'occupied' | 'stale' | 'not-started';

export interface RunnerHealthLeaseReport {
  status: RunnerHealthLeaseStatus;
  pid?: number;
  startedAt?: string;
  heartbeatAt?: string;
  heartbeatAgeMs?: number;
}

export interface RunnerHealthReport {
  ok: boolean;
  verdict: RunnerHealthVerdict;
  exitCode: number;
  noClaim: true;
  earliestFailedStep?: string;
  invariant?: string;
  receipt?: Record<string, unknown>;
  boundedRepair?: string;
  restartPoint?: string;
  root: string | null;
  nodeRole: string | null;
  tipSha: string | null;
  dist: { path: string | null; sha256: string | null; mtimeMs: number | null };
  cwd: string;
  lease: RunnerHealthLeaseReport;
  activation: { asserted: boolean; activatedAt?: string };
}

export interface RunnerHealthDeps {
  nowMs?: number;
  cwd?: string;
  entryPath?: string | null;
  tipSha?: () => string | null;
  readLease?: () => InstanceLease | null;
  processAlive?: (pid: number) => boolean;
  resolveRoot?: () => string;
  assertActivation?: (root: string) => StateRootActivationManifest;
  activationRequired?: () => boolean;
  nodeRole?: () => string | null;
  staleAfterMs?: number;
}

/** Pure lease → liveness (mirrors describeRunnerLiveness; no atlas-runner import). */
export function describeLeaseForHealth(
  lease: InstanceLease | null,
  nowMs: number,
  processAlive: (pid: number) => boolean,
  staleAfterMs: number = DEFAULT_LEASE_TTL_MS,
): RunnerHealthLeaseReport {
  if (!lease) return { status: 'not-started' };

  const heartbeatAgeMs = nowMs - Date.parse(lease.heartbeatAt);
  const alive = processAlive(lease.pid) && heartbeatAgeMs <= staleAfterMs;
  const runner = lease.runner?.kind === 'runner' ? lease.runner : undefined;

  return {
    status: alive ? (runner ? 'running' : 'occupied') : 'stale',
    pid: lease.pid,
    startedAt: lease.startedAt,
    heartbeatAt: lease.heartbeatAt,
    heartbeatAgeMs,
  };
}

function defaultTipSha(cwd: string): string | null {
  try {
    const result = spawnSync('git', ['rev-parse', 'HEAD'], {
      cwd,
      encoding: 'utf8',
      windowsHide: true,
      timeout: 5_000,
      env: {
        PATH: process.env.PATH,
        SystemRoot: process.env.SystemRoot,
        // Deny network helpers for git (local tip only).
        GIT_TERMINAL_PROMPT: '0',
        GIT_OPTIONAL_LOCKS: '0',
      },
    });
    if (result.status !== 0) return null;
    const sha = (result.stdout ?? '').trim();
    return /^[0-9a-f]{7,40}$/i.test(sha) ? sha.toLowerCase() : null;
  } catch {
    return null;
  }
}

function hashFileIfPresent(path: string | null | undefined): {
  path: string | null;
  sha256: string | null;
  mtimeMs: number | null;
} {
  if (!path || !existsSync(path)) {
    return { path: path ?? null, sha256: null, mtimeMs: null };
  }
  try {
    const buf = readFileSync(path);
    const sha256 = createHash('sha256').update(buf).digest('hex');
    const mtimeMs = statSync(path).mtimeMs;
    return { path, sha256, mtimeMs };
  } catch {
    return { path, sha256: null, mtimeMs: null };
  }
}

function failureEnvelope(partial: {
  verdict: RunnerHealthVerdict;
  exitCode: number;
  earliestFailedStep: string;
  invariant: string;
  receipt?: Record<string, unknown>;
  boundedRepair: string;
  restartPoint: string;
  root: string | null;
  nodeRole: string | null;
  tipSha: string | null;
  dist: RunnerHealthReport['dist'];
  cwd: string;
  lease: RunnerHealthLeaseReport;
  activation: RunnerHealthReport['activation'];
}): RunnerHealthReport {
  return {
    ok: false,
    noClaim: true,
    ...partial,
  };
}

/**
 * Build a no-claim health report. Caller must pass noClaim=true (CLI enforces flag).
 */
export function runRunnerHealth(
  noClaim: boolean,
  deps: RunnerHealthDeps = {},
): RunnerHealthReport {
  const cwd = deps.cwd ?? process.cwd();
  const nowMs = deps.nowMs ?? Date.now();
  const processAlive = deps.processAlive ?? isInstanceProcessAlive;
  const staleAfterMs = deps.staleAfterMs ?? DEFAULT_LEASE_TTL_MS;
  const tipSha = (deps.tipSha ?? (() => defaultTipSha(cwd)))();
  const entryPath =
    deps.entryPath !== undefined
      ? deps.entryPath
      : (process.argv[1] ?? null);
  const dist = hashFileIfPresent(entryPath);
  const emptyLease: RunnerHealthLeaseReport = { status: 'not-started' };

  if (!noClaim) {
    return failureEnvelope({
      verdict: 'FLAG_REQUIRED',
      exitCode: 2,
      earliestFailedStep: 'require --no-claim',
      invariant: 'runner health must refuse work without --no-claim',
      receipt: { flag: '--no-claim', present: false },
      boundedRepair: 'Re-run: atlas runner health --no-claim',
      restartPoint: 'cli:runner health flag gate',
      root: null,
      nodeRole: null,
      tipSha,
      dist,
      cwd,
      lease: emptyLease,
      activation: { asserted: false },
    });
  }

  let root: string;
  try {
    root = (deps.resolveRoot ?? resolveStateRoot)();
  } catch (error) {
    const code =
      error instanceof StateRootActivationError
        ? error.code
        : error instanceof StateRootConfigurationError
          ? 'root_config'
          : 'root_resolve';
    return failureEnvelope({
      verdict: 'ACTIVATION_FAILED',
      exitCode: 3,
      earliestFailedStep: 'resolveStateRoot',
      invariant: 'health requires a lawful absolute state root',
      receipt: {
        error: error instanceof Error ? error.message : String(error),
        code,
      },
      boundedRepair: 'Set ATLAS_STATE_ROOT to an absolute activated root; set ATLAS_STATE_ROOT_REQUIRED=1',
      restartPoint: 'state-root:resolveStateRoot',
      root: null,
      nodeRole: deps.nodeRole?.() ?? process.env.ATLAS_NODE_ROLE?.trim() ?? null,
      tipSha,
      dist,
      cwd,
      lease: emptyLease,
      activation: { asserted: false },
    });
  }

  const required = (deps.activationRequired ?? isStateRootActivationRequired)();
  let activation: StateRootActivationManifest | null = null;
  if (required) {
    try {
      activation = (deps.assertActivation ?? assertStateRootActivated)(root);
    } catch (error) {
      const code =
        error instanceof StateRootActivationError ? error.code : 'activation_failed';
      return failureEnvelope({
        verdict: 'ACTIVATION_FAILED',
        exitCode: 3,
        earliestFailedStep: 'assertStateRootActivated',
        invariant: 'REQUIRED activation must validate before lease read',
        receipt: {
          root,
          error: error instanceof Error ? error.message : String(error),
          code,
        },
        boundedRepair: 'Repair activation manifest + receipts under root; re-assert',
        restartPoint: 'state-root:assertStateRootActivated',
        root,
        nodeRole: deps.nodeRole?.() ?? process.env.ATLAS_NODE_ROLE?.trim() ?? null,
        tipSha,
        dist,
        cwd,
        lease: emptyLease,
        activation: { asserted: false },
      });
    }
  }

  const lease = describeLeaseForHealth(
    (deps.readLease ?? getInstanceLeaseInfoReadonly)(),
    nowMs,
    processAlive,
    staleAfterMs,
  );

  const nodeRole =
    deps.nodeRole?.() ??
    activation?.nodeRole ??
    process.env.ATLAS_NODE_ROLE?.trim() ??
    null;

  if (lease.status === 'running') {
    return {
      ok: true,
      verdict: 'HEALTHY',
      exitCode: 0,
      noClaim: true,
      root,
      nodeRole,
      tipSha,
      dist,
      cwd,
      lease,
      activation: {
        asserted: required,
        activatedAt: activation?.activatedAt,
      },
    };
  }

  const verdict: RunnerHealthVerdict =
    lease.status === 'stale'
      ? 'STALE'
      : lease.status === 'occupied'
        ? 'OCCUPIED'
        : 'NOT_RUNNING';

  return failureEnvelope({
    verdict,
    exitCode: 1,
    earliestFailedStep: 'lease liveness',
    invariant: 'HEALTHY requires live runner-annotated lease within TTL',
    receipt: { leaseStatus: lease.status, pid: lease.pid, heartbeatAt: lease.heartbeatAt },
    boundedRepair:
      verdict === 'STALE'
        ? 'Clear dead lease only after confirming no live runner PID; then authorized start'
        : 'No runner lease present — do not claim; start only when authorized',
    restartPoint: 'runner-health:lease',
    root,
    nodeRole,
    tipSha,
    dist,
    cwd,
    lease,
    activation: {
      asserted: required,
      activatedAt: activation?.activatedAt,
    },
  });
}

/** Convenience for tests: absolute path of this module (import-banlist anchor). */
export function runnerHealthModulePath(): string {
  return fileURLToPath(import.meta.url).replace(/\.js$/i, '.ts');
}
