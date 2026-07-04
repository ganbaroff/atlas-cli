import { describe, it, expect, beforeEach } from 'vitest';
import {
  recordHeartbeatCheck,
  evaluateHeartbeat,
  getConsecutiveStale,
  resetHeartbeatAlert,
  STALE_ALERT_THRESHOLD,
} from '../atlas/heartbeat-alert.js';

describe('heartbeat-stale alert counter', () => {
  beforeEach(() => resetHeartbeatAlert());

  it('does not alert before the threshold', () => {
    expect(recordHeartbeatCheck(true).shouldAlert).toBe(false); // 1
    expect(recordHeartbeatCheck(true).shouldAlert).toBe(false); // 2
    expect(getConsecutiveStale()).toBe(2);
  });

  it('alerts exactly once on the run that crosses 3 consecutive stale', () => {
    recordHeartbeatCheck(true);
    recordHeartbeatCheck(true);
    const third = recordHeartbeatCheck(true);
    expect(STALE_ALERT_THRESHOLD).toBe(3);
    expect(third.consecutiveStale).toBe(3);
    expect(third.shouldAlert).toBe(true);
    // further stale runs stay silent (latched) — no alert spam
    expect(recordHeartbeatCheck(true).shouldAlert).toBe(false);
    expect(recordHeartbeatCheck(true).shouldAlert).toBe(false);
  });

  it('a fresh reading resets the counter and re-arms the alert', () => {
    recordHeartbeatCheck(true);
    recordHeartbeatCheck(true);
    recordHeartbeatCheck(true); // alerted
    recordHeartbeatCheck(false); // fresh → reset
    expect(getConsecutiveStale()).toBe(0);
    // must be able to alert again after recovery + 3 new stale runs
    recordHeartbeatCheck(true);
    recordHeartbeatCheck(true);
    expect(recordHeartbeatCheck(true).shouldAlert).toBe(true);
  });

  it('evaluateHeartbeat reads the heartbeat check from a health report', () => {
    const stale = { checks: [{ name: 'heartbeat', ok: false, detail: 'stale (30h old)' }] };
    const d1 = evaluateHeartbeat(stale);
    expect(d1.detail).toBe('stale (30h old)');
    expect(d1.consecutiveStale).toBe(1);
    evaluateHeartbeat(stale);
    const d3 = evaluateHeartbeat(stale);
    expect(d3.shouldAlert).toBe(true);
  });

  it('a missing heartbeat check counts as stale', () => {
    const d = evaluateHeartbeat({ checks: [{ name: 'models', ok: true, detail: 'ok' }] });
    expect(d.consecutiveStale).toBe(1);
    expect(d.detail).toContain('missing');
  });
});
