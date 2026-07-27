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
import type { TypedEffect } from '../goal-runner/types.js';
import { classifyEffect, hasRedLine, redLineReason } from '../goal-runner/red-line.js';
import { deriveEffectsFromText } from './action-router.js';
import { claimNextCommand, completeCommand, failCommand } from './supabase-memory.js';
import { runTask } from './task-spawner.js';
import { effectivelyPaused } from './control-plane.js';

// ── Types ──────────────────────────────────────────────────────────────

export interface RunnerDeps {
  claim: typeof claimNextCommand;
  complete: typeof completeCommand;
  fail: typeof failCommand;
  runLocal: (objective: string) => Promise<{ output: string; exitCode: number | null }>;
  isPaused: () => boolean;
  workerId: string;
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

export function defaultRunnerDeps(): RunnerDeps {
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
  };
}

// ── Red-line gate (text-level, conservative) ───────────────────────────
//
// Reuses action-router's deriveEffectsFromText (keyword→EffectKind mapping)
// plus red-line.ts's classifyEffect/hasRedLine. A command with ANY red-line
// effect is refused. Unknown text with no keyword hits is treated as safe
// at this level — the Hand-level gate catches deeper risks later.

function checkRedLine(commandText: string): { blocked: boolean; reason: string } {
  const effects: TypedEffect[] = deriveEffectsFromText(commandText);
  if (hasRedLine(effects)) {
    return { blocked: true, reason: redLineReason(effects) };
  }
  return { blocked: false, reason: '' };
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

  // Gate 3: red-line check BEFORE execution
  const redLine = checkRedLine(commandText);
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
