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
 * SECOND DEVIATION, SAME REVIEW, NOW UPSTREAMED (V0.1): the legacy
 * notifyCeo() (notify.ts) internally catches every send failure and returns
 * `false` — indistinguishable from "no CEO chat configured" or "kind gated."
 * Routing a real Telegram outage through it would silently mislabel a failed
 * send as "nothing to send," which is exactly the kind of false completion
 * claim this whole recovery effort exists to prevent. Rather than have this
 * module bypass notify.ts with its own ad-hoc token/chat-ID handling (a
 * "parallel notification authority"), the fix now lives in notify.ts itself:
 * notifyCeoResult() returns a typed NOT_CONFIGURED | SUPPRESSED | SENT |
 * FAILED outcome, and its target chat ID is resolved internally — there is no
 * parameter by which this module (or any caller) can direct a send at a chat
 * ID other than TELEGRAM_CEO_CHAT_ID. This module calls notifyCeoResult()
 * only; it does not read TELEGRAM_BOT_TOKEN or TELEGRAM_CEO_CHAT_ID itself.
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
import { notifyCeoResult, type NotifyKind, type NotifyResult } from './notify.js';
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
  /**
   * Injectable send mechanism, forwarded to notifyCeoResult(). Overrides ONLY
   * how the message is transmitted — never the chat ID, which notify.ts
   * resolves internally and is not a parameter anywhere on this path. Tests
   * use this to avoid a real Telegram call; production omits it and gets
   * notify.ts's real telegramSend.
   */
  sendOverride?: (chatId: number, text: string) => Promise<unknown>;
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

  // Canonical send — this is the ONLY notify call in this module. No local
  // token read, no local chat-ID resolution: both live in notify.ts.
  const outcome = await notifyCeoResult(kind, message, opts.sendOverride);

  const outcomeToState: Record<NotifyResult, TickState> = {
    SENT: 'notified',
    SUPPRESSED: 'silent',
    NOT_CONFIGURED: 'silent',
    FAILED: 'notify-failed',
  };
  const outcomeToReason: Record<NotifyResult, string> = {
    SENT: 'notified CEO',
    SUPPRESSED: `notify kind '${kind}' gated (silent by default)`,
    NOT_CONFIGURED: 'no CEO chat configured (TELEGRAM_CEO_CHAT_ID unset)',
    FAILED: `send failed: ${outcome.error ?? 'unknown error'}`,
  };

  if (outcome.result === 'SENT') {
    writeLoopState({ sig, lastNotifyMs: now });
  }

  return {
    state: outcomeToState[outcome.result],
    ts,
    signals,
    sig,
    message,
    sent: outcome.result === 'SENT',
    kind,
    reason: outcomeToReason[outcome.result],
  };
}

// ── Controlled live test notification (V0.1 Blocker 3) ────────────────────────

const TEST_NOTIFY_PREFIX = '[ATLAS V0 TEST — NO ACTION REQUIRED]';
const TEST_NOTIFY_MESSAGE =
  `${TEST_NOTIFY_PREFIX}\n` +
  'Controlled verification of the Local Autonomy V0 notification path. ' +
  'This is a one-time system check, not a real alert — no signals, no repo data, ' +
  'no health internals. Safe to ignore.';

function testNotifyStateFilePath(): string {
  return process.env.ATLAS_AUTONOMY_TEST_STATE_FILE || join(homedir(), '.atlas', 'autonomy-test-notify.json');
}

interface TestNotifyState {
  lastSentMs: number;
}

function readTestNotifyState(): TestNotifyState {
  try {
    const s = JSON.parse(readFileSync(testNotifyStateFilePath(), 'utf8'));
    return { lastSentMs: Number(s.lastSentMs ?? 0) };
  } catch {
    return { lastSentMs: 0 };
  }
}

function writeTestNotifyState(s: TestNotifyState): void {
  try {
    mkdirSync(dirname(testNotifyStateFilePath()), { recursive: true });
    writeFileSync(testNotifyStateFilePath(), JSON.stringify(s));
  } catch {
    /* best-effort */
  }
}

export interface TestNotifyResult {
  attempted: boolean;
  outcomeResult?: NotifyResult;
  error?: string;
  reason: string;
}

/**
 * Sends exactly ONE fixed, clearly-marked test message through the SAME
 * canonical notifyCeoResult() the real loop uses — this is a verification of
 * the notify path itself, not of any real observed signal, so it does NOT
 * touch runTick's production state file (a separate state file + a
 * dedicated interval guards repeat sends of this specific test message).
 * isPaused() is still honored — a paused Atlas does not send this either.
 */
export async function sendControlledTestNotification(
  opts: { now?: number; intervalMin?: number; sendOverride?: (chatId: number, text: string) => Promise<unknown> } = {},
): Promise<TestNotifyResult> {
  const now = opts.now ?? Date.now();
  const intervalMin = opts.intervalMin ?? repoWatchIntervalMin();

  if (isPaused()) {
    return { attempted: false, reason: 'ATLAS_PAUSE active — test notification skipped' };
  }

  const st = readTestNotifyState();
  const elapsedMin = (now - st.lastSentMs) / 60_000;
  if (st.lastSentMs > 0 && elapsedMin < intervalMin) {
    return {
      attempted: false,
      reason: `rate-limited: last test send was ${elapsedMin.toFixed(2)}min ago, interval is ${intervalMin}min`,
    };
  }

  const outcome = await notifyCeoResult('important', TEST_NOTIFY_MESSAGE, opts.sendOverride);
  if (outcome.result === 'SENT') {
    writeTestNotifyState({ lastSentMs: now });
  }
  return {
    attempted: true,
    outcomeResult: outcome.result,
    error: outcome.error,
    reason: `notifyCeoResult -> ${outcome.result}`,
  };
}
