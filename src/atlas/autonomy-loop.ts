/**
 * autonomy-loop — Local Autonomy V0.
 *
 * Implements docs/AUTONOMY-RECOVERY-PLAN.md §2-5: one bounded, evidence-gated
 * tick that observes existing read-only signals (repo_watch, runHealthCheck —
 * which already includes a real, file-based heartbeat-staleness check),
 * computes a combined change signature, and notifies the CEO ONLY on change +
 * rate-limit-elapsed. Zero LLM calls per tick. The only shell execution
 * anywhere in this path is repo_watch's own execFileSync('git', ...) with a
 * fixed, code-determined subcommand set — never the general-purpose
 * shellTool, never an LLM-generated command, so the autonomy whitelist in
 * policy.yaml is not even exercised by this loop.
 *
 * DEVIATION FROM THE PLAN, FOUND DURING AN ADVERSARIAL REVIEW OF THIS CODE
 * (documented, not silently dropped): the plan's §2 named heartbeat-alert.ts's
 * "3 consecutive stale readings" counter as a signal to reuse. That counter is
 * an in-process module singleton (heartbeat-alert.ts's `state` variable) with
 * no persistence — it resets to 0 every fresh `atlas autonomy-tick` process,
 * which is exactly how this V0 loop runs (single-tick CLI invocation, no
 * daemon; see SCOPE below). Under that invocation model the 3-strikes
 * threshold can never be reached, so wiring it in would be dead, misleading
 * state — the "consecutive stale" number would always read 0 or 1, never
 * reflecting real history. The underlying signal it exists to catch (a stale
 * heartbeat file) is already captured correctly and process-independently by
 * runHealthCheck()'s own 'heartbeat' check (health-check.ts's checkHeartbeat,
 * which reads the real timestamp file fresh each call — no counter needed).
 * So this loop reads heartbeat staleness through `signals.health.checks`
 * only; heartbeat-alert.ts is not imported. Making the 3-strikes counter
 * actually work would mean adding new cross-process persistence to a shared
 * module also used elsewhere — out of scope for a minimal first loop.
 *
 * SECOND DEVIATION, SAME REVIEW: notifyCeo() (notify.ts) internally catches
 * every send failure and returns `false` — indistinguishable from "no CEO
 * chat configured" or "kind gated." Routing a real Telegram outage through it
 * would silently mislabel a failed send as "nothing to send," which is
 * exactly the kind of false completion claim this whole recovery effort
 * exists to prevent. This module reuses notify.ts's `shouldNotify()` gate
 * directly (so the kind-gating semantics stay centralized and consistent
 * with the rest of the codebase) but performs the actual send itself, inside
 * its own try/catch, so a genuine failure reaches the 'notify-failed' state
 * instead of being swallowed.
 *
 * SCOPE (V0, matches the plan exactly):
 *   - LOCAL ONLY. Not wired into Railway's boot() — see plan §6/§8: that is a
 *     separate, CEO-approved second phase, not part of this module.
 *   - Single-tick, invoked manually or by an OS-level scheduler (Windows Task
 *     Scheduler running `atlas autonomy-tick --notify` on an interval). This
 *     module deliberately does NOT start its own setInterval/daemon process —
 *     Task Scheduler already solves "run this periodically, survive
 *     restarts, don't double-run" more robustly than reinventing it here,
 *     and the plan's own §6 names Task Scheduler as the intended mechanism.
 *   - Queue-depth inspection (the plan's 4th, explicitly OPTIONAL signal) is
 *     NOT implemented: no safe read-only count exists in supabase-memory.ts
 *     today (only claimNextCommand, which DEQUEUES — forbidden by the plan's
 *     "no dequeue/consume" rule). Adding one is a new Supabase query, out of
 *     scope for a minimal first loop. Flagged here, not silently dropped.
 *   - No new whitelist entries, no deploy, no push, no paid model, no email.
 *
 * CORRECTNESS: isPaused() is checked BEFORE observing AND again immediately
 * before notifying, so a pause set mid-tick still suppresses the send (plan
 * §4's explicit requirement — "not just at boot/startup").
 */

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { scanRepos, formatDigest, signature as repoSignature } from './repo-watch.js';
import { repoWatchRoots, repoWatchIntervalMin } from './policy.js';
import { runHealthCheck, formatHealthReport, type HealthReport } from './health-check.js';
import { shouldNotify, type NotifyKind } from './notify.js';
import { isPaused } from './spend-policy.js';

export interface TickSignals {
  repoDigest: string;
  repoSig: string;
  health: HealthReport;
}

export type TickState = 'paused' | 'observed' | 'silent' | 'notified' | 'notify-failed';

export interface TickResult {
  state: TickState;
  ts: string;
  reason: string;
  signals?: TickSignals;
  sig?: string;
  message?: string;
  sent?: boolean;
  kind?: NotifyKind;
}

function stateFilePath(): string {
  return process.env.ATLAS_AUTONOMY_STATE_FILE || join(homedir(), '.atlas', 'autonomy-loop.json');
}

interface LoopState {
  sig: string;
  lastNotifyMs: number;
}

function readLoopState(): LoopState {
  try {
    const s = JSON.parse(readFileSync(stateFilePath(), 'utf8'));
    return { sig: String(s.sig ?? ''), lastNotifyMs: Number(s.lastNotifyMs ?? 0) };
  } catch {
    return { sig: '', lastNotifyMs: 0 };
  }
}

function writeLoopState(s: LoopState): void {
  try {
    mkdirSync(dirname(stateFilePath()), { recursive: true });
    writeFileSync(stateFilePath(), JSON.stringify(s));
  } catch {
    /* best-effort — a failed write only means the next tick re-notifies */
  }
}

/** Test/manual hook — drop persisted state so the next tick starts fresh. */
export function resetLoopState(): void {
  writeLoopState({ sig: '', lastNotifyMs: 0 });
}

/**
 * Observe: run the read-only signals. Never throws — each underlying
 * function (scanRepos/runHealthCheck) already fails closed on its own inputs
 * (repo_watch returns {ok:false} per-repo; health-check checks are
 * independent booleans, including a real, file-based heartbeat check).
 */
export function observe(): TickSignals {
  const statuses = scanRepos(repoWatchRoots());
  const repoDigest = formatDigest(statuses);
  const repoSig = repoSignature(statuses);
  const health = runHealthCheck();
  return { repoDigest, repoSig, health };
}

/** Combined change signature across all signals — assessing step. */
export function combinedSignature(signals: TickSignals): string {
  const healthVec = signals.health.checks.map((c) => (c.ok ? '1' : '0')).join('');
  return [signals.repoSig, healthVec].join('||');
}

/** Compose the CEO-facing message for a notified tick. */
export function formatTickMessage(signals: TickSignals): string {
  const healthLines = formatHealthReport(signals.health)
    .split('\n')
    .filter((l) => l.startsWith('PASS') || l.startsWith('FAIL'));
  const lines = [signals.repoDigest, '', `Health: ${signals.health.summary}`, ...healthLines];
  return lines.join('\n').slice(0, 4000);
}

/** Telegram sender for the notify gate — mirrors repo-watch.ts's own copy (DI pattern). */
async function telegramSend(chatId: number, text: string): Promise<unknown> {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) throw new Error('TELEGRAM_BOT_TOKEN missing');
  const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, text: text.slice(0, 4096) }),
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error(`telegram HTTP ${res.status}`); // status only, no token
  return res.json();
}

export interface RunTickOptions {
  notify?: boolean;
  now?: number;
  intervalMin?: number;
  /**
   * Injectable signal source, defaulting to the real observe(). Tests use
   * fixed fixtures here (mirroring repo-watch.test.ts's decideNotify
   * fixtures) rather than two live observe() calls — real repo signals
   * (git status of an OneDrive-synced tree) are not guaranteed identical
   * moments apart, which would make signature-equality tests flaky for
   * environmental reasons unrelated to the state machine's correctness.
   */
  observeFn?: () => TickSignals;
}

/**
 * One tick of the autonomy loop. See module doc for the correctness
 * requirement on isPaused() being checked twice.
 */
export async function runTick(opts: RunTickOptions = {}): Promise<TickResult> {
  const now = opts.now ?? Date.now();
  const ts = new Date(now).toISOString();

  if (isPaused()) {
    return { state: 'paused', ts, reason: 'ATLAS_PAUSE active — tick skipped before observing' };
  }

  const doObserve = opts.observeFn ?? observe;
  const signals = doObserve();
  const sig = combinedSignature(signals);
  const st = readLoopState();
  const intervalMin = opts.intervalMin ?? repoWatchIntervalMin();

  if (sig === st.sig) {
    return { state: 'silent', ts, signals, sig, reason: 'no change since last recorded snapshot' };
  }
  const elapsedMin = (now - st.lastNotifyMs) / 60_000;
  if (elapsedMin < intervalMin) {
    return {
      state: 'silent',
      ts,
      signals,
      sig,
      reason: `changed but rate-limited (${elapsedMin.toFixed(1)}min < ${intervalMin}min)`,
    };
  }

  // Re-check pause right before notifying — a pause set mid-tick must still win.
  if (isPaused()) {
    return { state: 'paused', ts, signals, sig, reason: 'ATLAS_PAUSE active — notify suppressed after observing' };
  }

  if (!opts.notify) {
    return { state: 'observed', ts, signals, sig, reason: 'dry-run (notify not requested)' };
  }

  const message = formatTickMessage(signals);
  const failedChecks = signals.health.checks.filter((c) => !c.ok).length;
  const kind: NotifyKind = failedChecks > 0 ? 'error' : 'important';

  // Reuse notify.ts's own gate (shouldNotify) for centralized kind-gating, but
  // perform the send ourselves — notifyCeo() swallows send failures into a
  // plain `false`, which would make a real outage indistinguishable from "no
  // CEO chat configured." See module doc for why that matters here.
  if (!shouldNotify(kind)) {
    return { state: 'silent', ts, signals, sig, message, sent: false, kind, reason: `notify kind '${kind}' gated (silent by default)` };
  }
  const chatIdRaw = process.env.TELEGRAM_CEO_CHAT_ID;
  const chatId = chatIdRaw ? parseInt(chatIdRaw, 10) : NaN;
  if (!Number.isFinite(chatId)) {
    return { state: 'silent', ts, signals, sig, message, sent: false, kind, reason: 'no CEO chat configured (TELEGRAM_CEO_CHAT_ID unset)' };
  }

  try {
    await telegramSend(chatId, message);
    writeLoopState({ sig, lastNotifyMs: now });
    return { state: 'notified', ts, signals, sig, message, sent: true, kind, reason: 'notified CEO' };
  } catch (e) {
    return {
      state: 'notify-failed',
      ts,
      signals,
      sig,
      message,
      sent: false,
      kind,
      reason: `send failed: ${(e as Error)?.message?.slice(0, 150)}`,
    };
  }
}
