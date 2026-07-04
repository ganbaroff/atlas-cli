/**
 * Heartbeat-stale alert (Phase 4.3). The cron self-check reads heartbeat
 * freshness every run. A single stale reading is noise — the bot may have just
 * restarted. THREE consecutive stale readings means the heartbeat writer is
 * genuinely dead, and that earns exactly one CEO alert (silent-by-default still
 * holds: this routes through notify('error', …)).
 *
 * This module is the pure counter: it decides whether a run should alert. It
 * does not send — the caller wires it to notifyCeo so this stays testable
 * without Telegram.
 */

export const STALE_ALERT_THRESHOLD = 3;

interface AlertState {
  consecutiveStale: number;
  alerted: boolean; // latched so we alert once, not every run past the threshold
}

let state: AlertState = { consecutiveStale: 0, alerted: false };

export interface HeartbeatAlertDecision {
  /** How many consecutive stale runs so far. */
  consecutiveStale: number;
  /** True on the exact run that crosses the threshold — send the alert now. */
  shouldAlert: boolean;
}

/**
 * Feed one cron run's heartbeat result. `stale === true` means the heartbeat
 * check failed (stale/missing). Returns whether this run should fire the alert.
 *
 *   - fresh reading  → reset counter + latch.
 *   - stale reading  → increment; alert exactly once when it first reaches the
 *                      threshold; stay silent on further stale runs until reset.
 */
export function recordHeartbeatCheck(stale: boolean): HeartbeatAlertDecision {
  if (!stale) {
    state = { consecutiveStale: 0, alerted: false };
    return { consecutiveStale: 0, shouldAlert: false };
  }

  state.consecutiveStale += 1;
  const crossed = state.consecutiveStale >= STALE_ALERT_THRESHOLD;
  const shouldAlert = crossed && !state.alerted;
  if (shouldAlert) state.alerted = true;
  return { consecutiveStale: state.consecutiveStale, shouldAlert };
}

/** Current consecutive-stale count (read-only). */
export function getConsecutiveStale(): number {
  return state.consecutiveStale;
}

/** Reset the counter (tests / manual). */
export function resetHeartbeatAlert(): void {
  state = { consecutiveStale: 0, alerted: false };
}

/**
 * Given a health report, return the alert decision. Pulls the 'heartbeat' check
 * and treats a failed check as stale.
 */
export function evaluateHeartbeat(report: {
  checks: Array<{ name: string; ok: boolean; detail: string }>;
}): HeartbeatAlertDecision & { detail: string } {
  const hb = report.checks.find((c) => c.name === 'heartbeat');
  const stale = hb ? !hb.ok : true;
  const decision = recordHeartbeatCheck(stale);
  return { ...decision, detail: hb?.detail ?? 'heartbeat check missing' };
}
