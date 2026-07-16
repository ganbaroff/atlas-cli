/**
 * autonomy-loop — Local Autonomy V0 (+ V1 per-signal alert semantics).
 *
 * Implements docs/AUTONOMY-RECOVERY-PLAN.md §2-5: one bounded, evidence-gated
 * tick that observes existing read-only signals (repo_watch, runHealthCheck —
 * which already includes a real, file-based heartbeat-staleness check) and
 * notifies the CEO ONLY when a signal's own state genuinely transitions.
 * Zero LLM calls per tick. The only shell execution anywhere in this path is
 * repo_watch's own execFileSync('git', ...) with a fixed, code-determined
 * subcommand set — never the general-purpose shellTool, never an
 * LLM-generated command.
 *
 * DEVIATION FROM THE PLAN, FOUND DURING AN ADVERSARIAL REVIEW OF THIS CODE
 * (documented, not silently dropped): the plan's §2 named heartbeat-alert.ts's
 * "3 consecutive stale readings" counter as a signal to reuse. That counter is
 * an in-process module singleton with no persistence — it resets to 0 every
 * fresh `atlas autonomy-tick` process (single-tick CLI invocation, no
 * daemon). Under that invocation model the 3-strikes threshold can never be
 * reached, so wiring it in would be dead, misleading state. The underlying
 * signal it exists to catch (a stale heartbeat file) is already captured
 * correctly and process-independently by runHealthCheck()'s own 'heartbeat'
 * check. So this loop reads heartbeat staleness through
 * `signals.health.checks` only; heartbeat-alert.ts is not imported.
 *
 * V0.1 (notify hardening): notifyCeoResult() in notify.ts returns a typed
 * NOT_CONFIGURED | SUPPRESSED | SENT | FAILED outcome and resolves the CEO
 * chat ID internally — this module does not read TELEGRAM_BOT_TOKEN or
 * TELEGRAM_CEO_CHAT_ID itself, and has no parameter through which it (or any
 * caller) could direct a send at any other chat ID.
 *
 * V1 (alert semantics, this revision) — REPLACES the V0 combined-signature
 * notify gate. THE BUG V1 FIXES: V0 computed one combined signature
 * (`repoSig || healthVec`) and notified whenever that combined string
 * changed. Any commit to ANY watched repo changes `repoSig`, which changes
 * the combined signature, which re-fired a notify — even when the actual
 * *cause* of concern (e.g. a stale heartbeat) was completely unchanged and
 * already reported. A routine, unrelated commit was silently re-alerting an
 * already-known failure every time it landed. Confirmed live: a 60-minute
 * scheduler smoke sent 2 real Telegram alerts for the SAME unchanged stale
 * heartbeat, retriggered purely by unrelated repo commits landing mid-window.
 *
 * V1 MODEL: each observed signal (heartbeat; each of the other 6 health
 * checks, by name; and repo-watch's own git-health) is tracked as an
 * independent identity with a persisted HEALTHY/FAILING resting state (plus
 * an implicit UNKNOWN before any tick has ever observed it). Every tick,
 * each signal's raw reading is compared to its OWN persisted prior state —
 * never to a combined snapshot of everything else. A notify fires only for
 * signals whose reading changed the transition class:
 *   - UNKNOWN|HEALTHY -> FAILING  : "new-failure"     -> notify
 *   - FAILING -> FAILING, same severity band          -> "unchanged-failure", silent
 *   - FAILING -> FAILING, severity band worsened       -> "escalation"        -> notify
 *   - FAILING -> HEALTHY                               -> "recovery"          -> notify
 *   - UNKNOWN|HEALTHY -> HEALTHY                        -> "no-change",        silent
 * All signals are evaluated every tick; an unrelated signal's transition
 * never touches another signal's persisted record (this is the direct fix —
 * a repo commit updates ONLY the repo-watch record, never the heartbeat
 * record). Multiple genuinely-new events in the same tick are folded into
 * ONE Telegram message (one notifyCeoResult() call), not one send per event
 * and not suppressed against each other — "a new independent failure still
 * notifies even while another failure remains active" (the reviewed
 * requirement) falls out naturally because each signal's transition is
 * judged independently.
 *
 * Severity bands exist only for `heartbeat`, the one signal in this codebase
 * with a genuine continuous severity axis (staleness age): mild (24-72h),
 * moderate (72-168h), severe (>=168h/1wk) — see health-check.ts's
 * `ageHours` field. The other 6 health checks are flat booleans with no
 * natural "worse" dimension, so they have no escalation axis — a
 * still-failing boolean check stays "unchanged-failure" (silent) until it
 * either flips to ok or the tick simply stops observing it (neither
 * happens today), which is honest: there is nothing to escalate about a
 * check that only has "pass"/"fail".
 *
 * repo-watch's OWN digest content (branch/dirty-count/latest-commit) is
 * deliberately NOT itself a notify trigger in this loop — that content
 * changes on every routine commit, which is exactly the false-positive path
 * V1 removes. repo-watch's HEALTHY/FAILING state here tracks only whether
 * `git` itself is working for every watched repo (RepoStatus.ok) — a repo
 * a user actually wants surfaced digest-by-digest already has its own,
 * separate mechanism: `atlas repo-watch --notify` (repo-watch.ts's own
 * independent change-gated notify path, untouched by this revision).
 *
 * No periodic reminders in V1 (an unchanged FAILING signal stays silent
 * indefinitely, by design — see EXTERNAL-CTO-STATE.md for the explicit CEO
 * decision this reflects). No new external store: alert state is one JSON
 * file at `~/.atlas/alert-state.json` (override via
 * ATLAS_ALERT_STATE_FILE), same convention as V0's state file. A
 * missing/corrupt state file is read as "everything UNKNOWN" — safe,
 * bootstraps fresh, and cannot spam (a signal that's UNKNOWN and happens to
 * be currently failing notifies exactly once, same as any first-ever
 * failure would).
 *
 * SCOPE (unchanged from V0): LOCAL ONLY, not wired into Railway's boot();
 * single-tick, invoked manually or by an OS-level scheduler; no
 * setInterval/daemon; queue-depth (the plan's optional 4th signal) still has
 * no safe read-only producer anywhere in this codebase and is NOT modeled —
 * flagged, not silently dropped, same as V0.
 *
 * CORRECTNESS: isPaused() is checked BEFORE observing AND again immediately
 * before notifying, so a pause set mid-tick still suppresses the send.
 */

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { scanRepos, formatDigest } from './repo-watch.js';
import { repoWatchRoots, repoWatchIntervalMin } from './policy.js';
import { runHealthCheck, type HealthReport, type HealthCheck } from './health-check.js';
import { notifyCeoResult, type NotifyKind, type NotifyResult } from './notify.js';
import { isPaused } from './spend-policy.js';

export interface TickSignals {
  repoDigest: string;
  /** true iff every watched repo's git status read cleanly (RepoStatus.ok). */
  repoOk: boolean;
  health: HealthReport;
}

export type TickState = 'paused' | 'observed' | 'silent' | 'notified' | 'notify-failed';

export interface TickResult {
  state: TickState;
  ts: string;
  reason: string;
  signals?: TickSignals;
  events?: SignalEvent[];
  message?: string;
  sent?: boolean;
  kind?: NotifyKind;
}

// ── V1 per-signal alert state ──────────────────────────────────────────────

export type SignalState = 'HEALTHY' | 'FAILING' | 'UNKNOWN';

export interface SignalRecord {
  state: SignalState;
  /** Severity band at last observation, only meaningful for signals that have one (heartbeat). */
  band?: string;
}

export interface AlertState {
  signals: Record<string, SignalRecord>;
}

export type TransitionKind = 'new-failure' | 'unchanged-failure' | 'escalation' | 'recovery' | 'no-change';

export interface SignalEvent {
  id: string;
  transition: TransitionKind;
  ok: boolean;
  detail: string;
  band?: string;
}

function alertStateFilePath(): string {
  return process.env.ATLAS_ALERT_STATE_FILE || join(homedir(), '.atlas', 'alert-state.json');
}

/** Malformed or missing state reads as "everything UNKNOWN" — safe bootstrap, never throws. */
export function readAlertState(): AlertState {
  try {
    const parsed: unknown = JSON.parse(readFileSync(alertStateFilePath(), 'utf8'));
    const out: Record<string, SignalRecord> = {};
    if (parsed && typeof parsed === 'object' && 'signals' in parsed) {
      const rawSignals = (parsed as { signals: unknown }).signals;
      if (rawSignals && typeof rawSignals === 'object' && !Array.isArray(rawSignals)) {
        for (const [id, rec] of Object.entries(rawSignals as Record<string, unknown>)) {
          // Defensive: reject dunder keys outright rather than relying on
          // downstream spreads being proto-safe (adversarial-review finding).
          if (id === '__proto__' || id === 'constructor' || id === 'prototype') continue;
          if (rec && typeof rec === 'object' && !Array.isArray(rec)) {
            const r = rec as { state?: unknown; band?: unknown };
            const state: SignalState = r.state === 'HEALTHY' || r.state === 'FAILING' ? r.state : 'UNKNOWN';
            out[id] = { state, band: typeof r.band === 'string' ? r.band : undefined };
          }
        }
      }
    }
    return { signals: out };
  } catch {
    return { signals: {} };
  }
}

function writeAlertState(s: AlertState): void {
  try {
    mkdirSync(dirname(alertStateFilePath()), { recursive: true });
    writeFileSync(alertStateFilePath(), JSON.stringify(s));
  } catch (e) {
    // Not best-effort-silent: a PERSISTENT write failure means the on-disk
    // baseline never advances, so every subsequent tick re-reads stale prior
    // state and can re-classify an unchanged, already-known failure as
    // new-failure again — exactly the storm this module exists to prevent.
    // Surfacing this on stderr is the only signal an operator gets that the
    // per-signal dedupe guarantee is not currently holding (adversarial-review finding).
    console.error(
      `[autonomy-loop] failed to persist alert state — next tick may re-notify already-known failures: ${(e as Error)?.message ?? e}`,
    );
  }
}

/** Test/manual hook — drop persisted alert state so the next tick starts fresh (all UNKNOWN). */
export function resetAlertState(): void {
  writeAlertState({ signals: {} });
}

/**
 * Observe: run the read-only signals. Never throws — each underlying
 * function (scanRepos/runHealthCheck) already fails closed on its own
 * inputs (repo_watch returns {ok:false} per-repo; health-check checks are
 * independent booleans, including a real, file-based heartbeat check).
 */
export function observe(): TickSignals {
  const statuses = scanRepos(repoWatchRoots());
  const repoDigest = formatDigest(statuses);
  const repoOk = statuses.every((s) => s.ok);
  const health = runHealthCheck();
  return { repoDigest, repoOk, health };
}

function heartbeatBand(check: HealthCheck): string | undefined {
  if (check.ok) return undefined;
  const hours = check.ageHours;
  if (hours === undefined) return 'unknown';
  if (hours >= 168) return 'severe';
  if (hours >= 72) return 'moderate';
  return 'mild';
}

/** Ordering for escalation direction — only a strictly HIGHER severity counts as "worsened". */
const BAND_SEVERITY: Readonly<Record<string, number>> = { unknown: 0, mild: 1, moderate: 2, severe: 3 };

/** This tick's raw per-signal readings, keyed by stable signal id. */
function currentReadings(signals: TickSignals): Array<{ id: string; ok: boolean; detail: string; band?: string }> {
  const readings: Array<{ id: string; ok: boolean; detail: string; band?: string }> = [];
  for (const check of signals.health.checks) {
    if (check.name === 'heartbeat') {
      readings.push({ id: 'heartbeat', ok: check.ok, detail: check.detail, band: heartbeatBand(check) });
    } else {
      readings.push({ id: `health:${check.name}`, ok: check.ok, detail: check.detail });
    }
  }
  readings.push({
    id: 'repo-watch',
    ok: signals.repoOk,
    detail: signals.repoOk ? 'all watched repos read cleanly' : 'git read failed for at least one watched repo',
  });
  return readings;
}

function detectTransition(prev: SignalRecord | undefined, ok: boolean, band: string | undefined): TransitionKind {
  const prevState: SignalState = prev?.state ?? 'UNKNOWN';
  if (ok) {
    return prevState === 'FAILING' ? 'recovery' : 'no-change';
  }
  if (prevState !== 'FAILING') return 'new-failure';
  // Escalation fires ONLY when severity strictly WORSENED (adversarial-review
  // finding: comparing "band !== prev.band" fired on ANY change, including
  // improvement — e.g. moderate -> mild while still failing was mislabeled
  // "ESCALATED", which is backwards and actively misleading). An improving-
  // but-still-failing band, or an equal band, is 'unchanged-failure' (silent).
  if (band !== undefined && prev?.band !== undefined) {
    const worsened = (BAND_SEVERITY[band] ?? 0) > (BAND_SEVERITY[prev.band] ?? 0);
    if (worsened) return 'escalation';
  }
  return 'unchanged-failure';
}

/**
 * Per-signal transition detection — the core of V1. Every signal is judged
 * ONLY against its own prior record; an unrelated signal changing (e.g. a
 * repo commit) never touches another signal's (e.g. heartbeat's) record or
 * transition. Returns the notable events (excludes 'no-change' and
 * 'unchanged-failure', which are silent by design) plus the fully refreshed
 * state to persist regardless of whether anything notable happened.
 */
export function computeSignalEvents(
  signals: TickSignals,
  state: AlertState,
): { events: SignalEvent[]; nextState: AlertState } {
  const readings = currentReadings(signals);
  const nextSignals: Record<string, SignalRecord> = { ...state.signals };
  const events: SignalEvent[] = [];
  for (const r of readings) {
    const prev = state.signals[r.id];
    const transition = detectTransition(prev, r.ok, r.band);
    if (transition !== 'no-change' && transition !== 'unchanged-failure') {
      events.push({ id: r.id, transition, ok: r.ok, detail: r.detail, band: r.band });
    }
    nextSignals[r.id] = { state: r.ok ? 'HEALTHY' : 'FAILING', band: r.ok ? undefined : r.band };
  }
  return { events, nextState: { signals: nextSignals } };
}

const TRANSITION_LABEL: Record<'new-failure' | 'escalation' | 'recovery', string> = {
  'new-failure': 'NEW FAILURE',
  escalation: 'ESCALATED',
  recovery: 'RECOVERED',
};

/** Compose the CEO-facing message describing exactly this tick's notable events — nothing re-dumped. */
export function formatEventMessage(events: SignalEvent[]): string {
  const lines = events.map((e) => {
    const label = TRANSITION_LABEL[e.transition as 'new-failure' | 'escalation' | 'recovery'] ?? e.transition;
    const bandSuffix = e.band ? ` [${e.band}]` : '';
    return `${label}: ${e.id}${bandSuffix} — ${e.detail}`;
  });
  return lines.join('\n').slice(0, 4000);
}

export interface RunTickOptions {
  notify?: boolean;
  now?: number;
  /**
   * Injectable signal source, defaulting to the real observe(). Tests use
   * fixed fixtures here (real repo/health signals are not guaranteed
   * identical moments apart, which would make transition tests flaky for
   * environmental reasons unrelated to the state machine's correctness).
   */
  observeFn?: () => TickSignals;
  /**
   * Injectable send mechanism, forwarded to notifyCeoResult(). Overrides
   * ONLY how the message is transmitted — never the chat ID, which notify.ts
   * resolves internally and is not a parameter anywhere on this path.
   */
  sendOverride?: (chatId: number, text: string) => Promise<unknown>;
}

/**
 * One tick of the autonomy loop. See module doc for the V1 per-signal
 * transition model and the correctness requirement on isPaused() being
 * checked twice.
 */
export async function runTick(opts: RunTickOptions = {}): Promise<TickResult> {
  const now = opts.now ?? Date.now();
  const ts = new Date(now).toISOString();

  if (isPaused()) {
    return { state: 'paused', ts, reason: 'ATLAS_PAUSE active — tick skipped before observing' };
  }

  const doObserve = opts.observeFn ?? observe;
  const signals = doObserve();
  const priorState = readAlertState();
  const { events, nextState } = computeSignalEvents(signals, priorState);

  // Persist the refreshed per-signal state every tick, whether or not
  // anything notable happened — an "unchanged-failure" tick still needs its
  // band/state re-confirmed so the NEXT tick's comparison stays correct.
  writeAlertState(nextState);

  if (events.length === 0) {
    return { state: 'silent', ts, signals, events, reason: 'no actionable signal transitions this tick' };
  }

  if (!opts.notify) {
    const summary = events.map((e) => `${e.id}:${e.transition}`).join(', ');
    return { state: 'observed', ts, signals, events, reason: `dry-run — would notify on: ${summary}` };
  }

  // Re-check pause right before notifying — a pause set mid-tick must still win.
  if (isPaused()) {
    return { state: 'paused', ts, signals, events, reason: 'ATLAS_PAUSE active — notify suppressed after observing' };
  }

  const message = formatEventMessage(events);
  const hasNewOrEscalated = events.some((e) => e.transition === 'new-failure' || e.transition === 'escalation');
  const kind: NotifyKind = hasNewOrEscalated ? 'error' : 'important'; // pure recoveries -> 'important'

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

  return {
    state: outcomeToState[outcome.result],
    ts,
    signals,
    events,
    message,
    sent: outcome.result === 'SENT',
    kind,
    reason: outcomeToReason[outcome.result],
  };
}

// ── Controlled live test notification (V0.1 Blocker 3) ────────────────────────
// Unchanged by V1: this is a verification of the notify PATH itself, not of
// any observed signal, so it intentionally does not touch the V1 alert
// state above — it has always used its own separate state file.

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
 * canonical notifyCeoResult() the real loop uses. Uses its own state file +
 * interval (default: policy's repo-watch interval) so it can never be
 * confused with or interfere with the V1 alert-state loop above.
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
