/**
 * In-repo, opt-in queue worker — the CONSUMER side of the Atlas command queue.
 *
 * Closes the "external, unaudited executor" gap in docs/QUEUE-CONTRACT.md.
 * The brain-loop PRODUCES commands (queueRemoteCommand); this worker CONSUMES
 * them (claimNextCommand → execute → completeCommand/failCommand) — but ONLY
 * when ATLAS_INPROC_WORKER=1, so it never double-executes alongside the
 * external CEO-machine consumer. Exactly one consumer must be active.
 *
 * Design constraints honoured:
 *   - OFF by default (env flag).                          — anti-double-run
 *   - Executor is dependency-injected, never Claude.      — Constitution Art. 0
 *   - Budget-guarded (ATLAS_PAUSE / daily cap).           — FinOps stop-crane
 *   - Atomic claim (FOR UPDATE SKIP LOCKED via RPC).      — idempotent
 *   - 30-min stale TTL swept before each poll.            — TTL / re-claim
 *   - Never throws; Supabase failures logged, loop lives. — non-blocking
 */

import {
  claimNextCommand,
  completeCommand,
  failCommand,
  sweepStaleCommands,
  isSupabaseConfigured,
} from './supabase-memory.js';
import { formatReceipt } from './receipt.js';
import { isPaused, overDailyCap } from './spend-policy.js';

/** Shape returned by claimNextCommand. */
export interface ClaimedCommand {
  id: string;
  command: string;
  payload: unknown;
  chat_id: number;
  priority: number;
}

/**
 * A command executor. Dependency-injected so this worker is NOT hardcoded to
 * any specific model/agent (Constitution: never Claude as a swarm agent).
 * Returns the raw textual output of running `cmd.command`.
 */
export type CommandExecutor = (cmd: ClaimedCommand) => Promise<string>;

/** Stale-claim TTL from QUEUE-CONTRACT.md (default 30 minutes). */
const STALE_TTL_MINUTES = 30;

/** ATLAS_INPROC_WORKER=1 opt-in flag — mirrors isPaused()/paidAllowed() parsing. */
export function inProcWorkerEnabled(): boolean {
  const v = (process.env['ATLAS_INPROC_WORKER'] ?? '').trim().toLowerCase();
  return v === '1' || v === 'true' || v === 'yes';
}

/**
 * Default executor: a SAFE no-op that does not spend a single token.
 *
 * It runs no model and no shell — it simply acknowledges the command with a
 * receipt so the queue lifecycle is provable end-to-end without wiring the
 * worker to any agent. Real deployments inject their own executor (e.g. one
 * routing through the free-first model gateway). Keeping the default inert is
 * the conservative choice: an accidentally-enabled worker can never run
 * arbitrary commands or burn budget.
 */
export const safeNoopExecutor: CommandExecutor = async (cmd) => {
  return `acknowledged (in-proc no-op executor): ${cmd.command.slice(0, 200)}`;
};

export interface WorkerDeps {
  executor?: CommandExecutor;
  workerId?: string;
  /** Injectable for tests; defaults to the real spend-policy guards. */
  paused?: () => boolean;
  overCap?: () => boolean;
  logger?: Pick<Console, 'log' | 'warn' | 'error'>;
}

export interface TickResult {
  claimed: boolean;
  executed: boolean;
  skippedReason?: 'paused' | 'over-cap' | 'empty' | 'not-configured';
  commandId?: string;
}

// Skip-log latch — avoid spamming logs every poll while paused/over-cap.
let lastSkipLog = '';

/**
 * Process AT MOST ONE queued command. Returns what happened. Never throws.
 *
 * Order:
 *   1. Config guard — no Supabase → nothing to do.
 *   2. Sweep stale claims (honours 30-min TTL → re-claimable / dead).
 *   3. Budget guard BEFORE claiming — if paused or over cap, do NOT claim
 *      (leaves the item pending for a healthy consumer / next window).
 *   4. Atomic claim. If empty → done.
 *   5. Execute via injected executor. Success → completeCommand(result+receipt);
 *      throw → failCommand(error).
 */
export async function runWorkerTick(deps: WorkerDeps = {}): Promise<TickResult> {
  const log = deps.logger ?? console;
  const executor = deps.executor ?? safeNoopExecutor;
  const workerId = deps.workerId ?? `inproc-${process.pid}`;
  const paused = deps.paused ?? isPaused;
  const overCap = deps.overCap ?? overDailyCap;

  if (!isSupabaseConfigured()) {
    return { claimed: false, executed: false, skippedReason: 'not-configured' };
  }

  // Sweep first so a crashed prior claim (>30 min) is re-claimable this tick.
  try {
    await sweepStaleCommands(STALE_TTL_MINUTES);
  } catch (e: any) {
    log.error('[queue-worker] stale sweep failed:', e?.message?.slice(0, 200));
  }

  // BUDGET GUARD — refuse to claim while paused or over the daily cap, so the
  // command stays pending (unclaimed / requeued) instead of being consumed and
  // dropped. Log once per state-change to avoid spam.
  if (paused()) {
    if (lastSkipLog !== 'paused') {
      lastSkipLog = 'paused';
      log.warn('[queue-worker] ATLAS_PAUSE=1 — not claiming; commands left pending');
    }
    return { claimed: false, executed: false, skippedReason: 'paused' };
  }
  if (overCap()) {
    if (lastSkipLog !== 'over-cap') {
      lastSkipLog = 'over-cap';
      log.warn('[queue-worker] daily token cap exceeded — not claiming; commands left pending');
    }
    return { claimed: false, executed: false, skippedReason: 'over-cap' };
  }
  lastSkipLog = '';

  let claimed: ClaimedCommand | null = null;
  try {
    claimed = (await claimNextCommand(workerId)) as ClaimedCommand | null;
  } catch (e: any) {
    log.error('[queue-worker] claim failed:', e?.message?.slice(0, 200));
    return { claimed: false, executed: false };
  }

  if (!claimed || !claimed.id) {
    return { claimed: false, executed: false, skippedReason: 'empty' };
  }

  const cmd = claimed;
  try {
    const output = await executor(cmd);
    const receipt = formatReceipt(cmd.command, output);
    await completeCommand(cmd.id, { output, receipt });
    log.log(`[queue-worker] done cmd=${cmd.id.slice(0, 8)} chat=${cmd.chat_id}`);
    return { claimed: true, executed: true, commandId: cmd.id };
  } catch (e: any) {
    const errMsg = e?.message ? String(e.message) : String(e);
    // Attach a receipt to the failure too, so failures are auditable.
    const receipt = formatReceipt(cmd.command, `ERROR: ${errMsg}`);
    try {
      await failCommand(cmd.id, `${errMsg}\n${receipt}`);
    } catch (fe: any) {
      log.error('[queue-worker] failCommand failed:', fe?.message?.slice(0, 200));
    }
    log.error(`[queue-worker] executor threw cmd=${cmd.id.slice(0, 8)}:`, errMsg.slice(0, 200));
    return { claimed: true, executed: false, commandId: cmd.id };
  }
}

/**
 * Start the polling loop. Returns a stop() handle. OFF unless ATLAS_INPROC_WORKER=1.
 * The caller (telegram boot) decides whether to start it; this guard is a
 * second belt-and-braces so the worker can never run unopted.
 */
export function startInProcWorker(
  intervalMs: number,
  deps: WorkerDeps = {},
): { stop: () => void; enabled: boolean } {
  const log = deps.logger ?? console;
  if (!inProcWorkerEnabled()) {
    return { stop: () => {}, enabled: false };
  }
  log.log(`[queue-worker] in-proc worker ON (ATLAS_INPROC_WORKER=1) — polling every ${Math.round(intervalMs / 1000)}s`);
  const timer = setInterval(() => {
    runWorkerTick(deps).catch((e: any) =>
      log.error('[queue-worker] tick error:', e?.message?.slice(0, 200)),
    );
  }, intervalMs);
  if (typeof (timer as any).unref === 'function') (timer as any).unref();
  return { stop: () => clearInterval(timer), enabled: true };
}

/** Test-only: reset the skip-log latch between cases. */
export function _resetSkipLog(): void {
  lastSkipLog = '';
}
