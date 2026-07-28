/**
 * atlas/atlas-runner.ts — local-node command runner (L2 ladder).
 *
 * Claims work orders from the Supabase atlas_command_queue, red-line
 * checks them, executes safe ones via task-spawner, and writes results
 * back. Fully injectable — tests never touch real Supabase or spawn
 * subprocesses.
 *
 * Safety invariants:
 *   - Red-line commands are NEVER auto-executed (fail with needs-approval).
 *   - Control-plane pause stops claiming immediately.
 *   - A crash in one tick never corrupts the next tick.
 *   - No exec-graph write imports — the runner is a consumer only.
 *
 * See docs/architecture/ATLAS-ARCHITECTURE.md §6.2 for the full contract.
 */

import { hostname } from 'node:os';
import { join } from 'node:path';
import { homedir } from 'node:os';
import type { TypedEffect } from '../goal-runner/types.js';
import { classifyEffect, hasRedLine, redLineReason, checkRedLineWithClassifier } from '../goal-runner/red-line.js';
import { deriveEffectsFromText } from './action-router.js';
import { claimNextCommand, completeCommand, failCommand } from './supabase-memory.js';
import { runTask } from './task-spawner.js';
import { effectivelyPaused } from './control-plane.js';
import {
  getInstanceLeaseInfo,
  isInstanceProcessAlive,
  DEFAULT_LEASE_TTL_MS,
  type InstanceLease,
} from './instance-lease.js';
import {
  verifyPayload,
  createNonceLedger,
  getSigningKey,
  type NonceLedger,
  type VerifyResult,
} from './queue-auth.js';

// ── Types ──────────────────────────────────────────────────────────────

export interface RunnerDeps {
  claim: typeof claimNextCommand;
  complete: typeof completeCommand;
  fail: typeof failCommand;
  runLocal: (objective: string) => Promise<{ output: string; exitCode: number | null }>;
  isPaused: () => boolean;
  workerId: string;
  /** Returns the signing key or undefined (enforcement off). Injectable for tests. */
  getSigningKey?: () => string | undefined;
  /** Nonce ledger for replay protection. Injectable for tests. */
  nonceLedger?: NonceLedger;
}

export type RunnerTickResult =
  | { status: 'paused' }
  | { status: 'idle' }
  | { status: 'completed'; commandId: string; output: string }
  | { status: 'refused'; commandId: string; reason: string }
  | { status: 'failed'; commandId: string; error: string };

export interface RunnerLoopOpts {
  maxTicks?: number;
  tickIntervalMs?: number;
  onTick?: (r: RunnerTickResult) => void;
}

// ── Default deps (production wiring) ───────────────────────────────────

function resolveWorkerId(): string {
  if (process.env['ATLAS_RUNNER_ID']) return process.env['ATLAS_RUNNER_ID'];
  return `${hostname()}-${process.pid}`;
}

// ── Once-per-boot warning tracking ────────────────────────────────────
let _noKeyWarningEmitted = false;

/** Reset for tests — not exported to production consumers. */
export function _resetNoKeyWarning(): void {
  _noKeyWarningEmitted = false;
}

export function defaultRunnerDeps(): RunnerDeps {
  const stateDir = process.env['ATLAS_STATE_DIR'] ?? join(homedir(), '.atlas');
  return {
    claim: claimNextCommand,
    complete: completeCommand,
    fail: failCommand,
    runLocal: async (objective: string) => {
      const result = await runTask(objective);
      return { output: result.output, exitCode: result.exitCode };
    },
    isPaused: () => effectivelyPaused(),
    workerId: resolveWorkerId(),
    getSigningKey,
    nonceLedger: createNonceLedger(stateDir),
  };
}

// ── Red-line gate (text-level, conservative) ───────────────────────────
//
// Reuses action-router's deriveEffectsFromText (keyword→EffectKind mapping)
// plus red-line.ts's classifyEffect/hasRedLine. A command with ANY red-line
// effect is refused. Unknown text with no keyword hits is treated as safe
// at this level — the Hand-level gate catches deeper risks later.

async function checkRedLine(commandText: string): Promise<{ blocked: boolean; reason: string }> {
  // Layer 1: effect-based red-line check (deterministic, via action-router keywords)
  const effects: TypedEffect[] = deriveEffectsFromText(commandText);
  if (hasRedLine(effects)) {
    return { blocked: true, reason: redLineReason(effects) };
  }
  // Layer 2: additive classifier vote (keyword floor + optional LLM, via red-line.ts)
  return checkRedLineWithClassifier(commandText);
}

// ── Single tick ────────────────────────────────────────────────────────

export async function runnerTick(deps: RunnerDeps): Promise<RunnerTickResult> {
  // Gate 1: pause/stop
  if (deps.isPaused()) {
    return { status: 'paused' };
  }

  // Gate 2: claim
  let claimed: Awaited<ReturnType<typeof claimNextCommand>>;
  try {
    claimed = await deps.claim(deps.workerId);
  } catch (err) {
    // Claim failure is transient — report but don't crash the loop.
    const msg = err instanceof Error ? err.message : String(err);
    return { status: 'failed', commandId: 'claim-error', error: `claim failed: ${msg}` };
  }

  if (!claimed) {
    return { status: 'idle' };
  }

  const commandId = claimed.id;
  const commandText = claimed.command;

  // Gate 2.5: malformed-row guard. A claimed row is external data (a
  // Supabase table any producer can write to) — TypeScript's declared
  // shape is not a runtime guarantee. A non-string command must never
  // reach the red-line scanner (which assumes text.toLowerCase() is
  // safe) or be silently treated as "no red-line effects found" —
  // either would be wrong for a safety gate. Fail it explicitly.
  if (typeof commandText !== 'string' || commandText.trim().length === 0) {
    const reason = 'malformed command: missing or non-string command text';
    try {
      await deps.fail(commandId, reason);
    } catch { /* best-effort */ }
    return { status: 'failed', commandId, error: reason };
  }

  // Gate 2.7: work-order authenticity (P0.1 Wave D).
  // When the signing key is configured, verify sig/ts/nonce/replay.
  // When the key is NOT configured, accept with a once-per-boot warning.
  const signingKey = deps.getSigningKey ? deps.getSigningKey() : undefined;
  if (signingKey && deps.nonceLedger) {
    const authResult = verifyPayload(
      { command: commandText, chat_id: claimed.chat_id, payload: claimed.payload },
      signingKey,
      deps.nonceLedger,
    );
    if (!authResult.ok) {
      const reason = `auth-failed: ${authResult.reason}`;
      try {
        await deps.fail(commandId, reason);
      } catch { /* best-effort */ }
      return { status: 'refused', commandId, reason };
    }
  } else if (!signingKey) {
    if (!_noKeyWarningEmitted) {
      console.warn('[atlas-runner] ATLAS_QUEUE_SIGNING_KEY not set — queue authenticity enforcement OFF. Set the key on both producer and runner to enable.');
      _noKeyWarningEmitted = true;
    }
  }

  // Gate 3: red-line check BEFORE execution. Wrapped defensively — this
  // gate must never crash the process (found live 2026-07-27: an
  // unguarded downstream .toLowerCase() on bad input took down the
  // whole runner via a native libuv assertion, not just this tick).
  // Any exception here is conservatively treated as a failure, never as
  // "no red line" — a broken classifier must not silently permit execution.
  let redLine: { blocked: boolean; reason: string };
  try {
    redLine = await checkRedLine(commandText);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const reason = `red-line check failed (treated as blocked): ${msg}`;
    try {
      await deps.fail(commandId, reason);
    } catch { /* best-effort */ }
    return { status: 'refused', commandId, reason };
  }
  if (redLine.blocked) {
    const reason = `needs-approval: ${redLine.reason}`;
    try {
      await deps.fail(commandId, reason);
    } catch { /* best-effort — the refusal is logged either way */ }
    return { status: 'refused', commandId, reason };
  }

  // Gate 4: execute
  //
  // Only a genuine exitCode===0 counts as success. exitCode===null is NOT
  // treated as success: task-spawner's runTask() returns exitCode:null for
  // at least four distinct non-completion cases (emergency pause, control
  // block, "another task already running", and a signal-killed timeout) —
  // conflating any of those with "done" would report false completion to
  // the operator for work that never actually ran. Evidence discipline:
  // no claim of done without a real, observed success signal.
  try {
    const result = await deps.runLocal(commandText);
    if (result.exitCode === 0) {
      await deps.complete(commandId, result.output);
      return { status: 'completed', commandId, output: result.output };
    } else {
      const errorMsg = `exit ${result.exitCode}: ${result.output}`.slice(0, 2000);
      await deps.fail(commandId, errorMsg);
      return { status: 'failed', commandId, error: errorMsg };
    }
  } catch (err) {
    // runLocal threw — fail the command, don't crash the loop.
    const msg = err instanceof Error ? err.message : String(err);
    try {
      await deps.fail(commandId, `runner error: ${msg}`);
    } catch { /* best-effort */ }
    return { status: 'failed', commandId, error: `runner error: ${msg}` };
  }
}

// ── Loop ───────────────────────────────────────────────────────────────

export async function runRunnerLoop(
  deps: RunnerDeps,
  opts: RunnerLoopOpts = {},
): Promise<void> {
  const { maxTicks, tickIntervalMs = 15_000, onTick } = opts;
  let tickCount = 0;
  let stopping = false;

  const onSignal = () => { stopping = true; };
  process.on('SIGINT', onSignal);
  process.on('SIGTERM', onSignal);

  try {
    while (!stopping) {
      if (maxTicks !== undefined && tickCount >= maxTicks) break;

      const result = await runnerTick(deps);
      tickCount++;
      if (onTick) onTick(result);

      if (maxTicks !== undefined && tickCount >= maxTicks) break;
      if (stopping) break;

      // Sleep between ticks (interruptible by setting stopping=true)
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, tickIntervalMs);
        // If we get a signal during sleep, clear timer and proceed to exit
        const earlyExit = () => {
          stopping = true;
          clearTimeout(timer);
          resolve();
        };
        process.once('SIGINT', earlyExit);
        process.once('SIGTERM', earlyExit);
        // Clean up the extra listeners once the timer fires normally
        setTimeout(() => {
          process.removeListener('SIGINT', earlyExit);
          process.removeListener('SIGTERM', earlyExit);
        }, tickIntervalMs + 10);
      });
    }
  } finally {
    process.removeListener('SIGINT', onSignal);
    process.removeListener('SIGTERM', onSignal);
  }
}

// ── Liveness status (for `atlas runner status`) ─────────────────────────
//
// The runner is always launched via `node dist/cli.js runner start`, and
// cli.ts's top-level guard already acquires the M4-C instance lease and
// heartbeats it every DEFAULT_LEASE_TTL_MS/3 for the life of the process
// (src/atlas/instance-lease.ts). Reused here rather than inventing a
// second heartbeat file — one lease, one liveness signal, machine-wide.

export type RunnerLivenessStatus = 'running' | 'stale' | 'not-started';

export interface RunnerLivenessReport {
  status: RunnerLivenessStatus;
  pid?: number;
  startedAt?: string;
  heartbeatAt?: string;
  heartbeatAgeMs?: number;
  /** Whether queue authenticity enforcement is active (signing key set). */
  authEnforcement?: 'on' | 'off';
}

/** Pure — testable without touching the real lease file. */
export function describeRunnerLiveness(
  lease: InstanceLease | null,
  nowMs: number,
  processAlive: (pid: number) => boolean,
  staleAfterMs: number = DEFAULT_LEASE_TTL_MS,
): RunnerLivenessReport {
  if (!lease) return { status: 'not-started' };

  const heartbeatAgeMs = nowMs - Date.parse(lease.heartbeatAt);
  const alive = processAlive(lease.pid) && heartbeatAgeMs <= staleAfterMs;

  return {
    status: alive ? 'running' : 'stale',
    pid: lease.pid,
    startedAt: lease.startedAt,
    heartbeatAt: lease.heartbeatAt,
    heartbeatAgeMs,
  };
}

/** Production wiring — reads the real lease file, checks the real process table. */
export function runnerLivenessNow(): RunnerLivenessReport {
  const report = describeRunnerLiveness(getInstanceLeaseInfo(), Date.now(), isInstanceProcessAlive);
  report.authEnforcement = getSigningKey() ? 'on' : 'off';
  return report;
}
