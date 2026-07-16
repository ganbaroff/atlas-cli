import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync, writeFileSync, rmSync, mkdtempSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import * as spendPolicy from '../atlas/spend-policy.js';
import {
  observe,
  computeSignalEvents,
  formatEventMessage,
  readAlertState,
  runTick,
  sendControlledTestNotification,
  type TickSignals,
  type AlertState,
} from '../atlas/autonomy-loop.js';

// Fixed fixtures for the state-machine tests. Real repo/health signals are
// not guaranteed identical moments apart, so gating-logic tests use
// hand-constructed TickSignals via runTick's injectable observeFn, not live
// observe() calls (mirrors repo-watch.test.ts's decideNotify fixtures).

function health(checks: TickSignals['health']['checks']): TickSignals['health'] {
  const passed = checks.filter((c) => c.ok).length;
  const failed = checks.length - passed;
  return {
    ts: '2026-07-17T00:00:00.000Z',
    checks,
    passed,
    failed,
    summary: failed === 0 ? `All ${passed} checks passed` : `${failed}/${checks.length} checks failed`,
  };
}

const HEALTHY = health([
  { name: 'memory-vault', ok: true, detail: 'found' },
  { name: 'identity-file', ok: true, detail: 'found' },
  { name: 'heartbeat', ok: true, detail: 'fresh' },
  { name: 'models', ok: true, detail: '3 available' },
]);

const HEARTBEAT_MILD = health([
  HEALTHY.checks[0],
  HEALTHY.checks[1],
  { name: 'heartbeat', ok: false, detail: 'stale (30h old)', ageHours: 30 },
  HEALTHY.checks[3],
]);

const HEARTBEAT_MODERATE = health([
  HEALTHY.checks[0],
  HEALTHY.checks[1],
  { name: 'heartbeat', ok: false, detail: 'stale (80h old)', ageHours: 80 },
  HEALTHY.checks[3],
]);

const HEARTBEAT_SEVERE = health([
  HEALTHY.checks[0],
  HEALTHY.checks[1],
  { name: 'heartbeat', ok: false, detail: 'stale (200h old)', ageHours: 200 },
  HEALTHY.checks[3],
]);

const HEARTBEAT_MILD_AND_MODELS_FAILING = health([
  HEALTHY.checks[0],
  HEALTHY.checks[1],
  { name: 'heartbeat', ok: false, detail: 'stale (30h old)', ageHours: 30 },
  { name: 'models', ok: false, detail: 'no API keys configured' },
]);

function signals(h: TickSignals['health'], overrides: Partial<TickSignals> = {}): TickSignals {
  return {
    repoDigest: 'Repo watch:\n- ANUS: branch main, clean — abc123 initial',
    repoOk: true,
    health: h,
    ...overrides,
  };
}

const EMPTY_STATE: AlertState = { signals: {} };

describe('autonomy-loop observe() (real signals, shape-only)', () => {
  it('observe() returns well-shaped signals without throwing', () => {
    const s = observe();
    expect(typeof s.repoDigest).toBe('string');
    expect(typeof s.repoOk).toBe('boolean');
    expect(s.health.checks.length).toBeGreaterThan(0);
  });
});

describe('computeSignalEvents — V1 per-signal transition model (fixed fixtures)', () => {
  it('1. first stale heartbeat -> exactly one new-failure event, nothing else', () => {
    const { events } = computeSignalEvents(signals(HEARTBEAT_MILD), EMPTY_STATE);
    const heartbeatEvents = events.filter((e) => e.id === 'heartbeat');
    expect(heartbeatEvents).toHaveLength(1);
    expect(heartbeatEvents[0].transition).toBe('new-failure');
    // nothing else fired — HEALTHY->HEALTHY on the other checks is silent
    expect(events).toHaveLength(1);
  });

  it('2. same heartbeat reading next tick -> suppressed (unchanged-failure, no event)', () => {
    const { nextState } = computeSignalEvents(signals(HEARTBEAT_MILD), EMPTY_STATE);
    const { events } = computeSignalEvents(signals(HEARTBEAT_MILD), nextState);
    expect(events.filter((e) => e.id === 'heartbeat')).toHaveLength(0);
  });

  it('3. same heartbeat + unrelated repo digest/commit change -> heartbeat stays suppressed; repo-watch itself has no event (git still ok, only digest content changed, which V1 does not treat as a signal transition)', () => {
    const { nextState } = computeSignalEvents(signals(HEARTBEAT_MILD), EMPTY_STATE);
    const changedRepo = signals(HEARTBEAT_MILD, {
      repoDigest: 'Repo watch:\n- ANUS: branch main, 4 dirty — def456 a real new commit',
      repoOk: true, // git still worked — only the digest CONTENT changed
    });
    const { events } = computeSignalEvents(changedRepo, nextState);
    expect(events.filter((e) => e.id === 'heartbeat')).toHaveLength(0);
    expect(events.filter((e) => e.id === 'repo-watch')).toHaveLength(0);
    expect(events).toHaveLength(0); // THE bug this redesign fixes: zero events, not a re-alert
  });

  it('4. heartbeat recovery -> exactly one recovery event', () => {
    const { nextState } = computeSignalEvents(signals(HEARTBEAT_MILD), EMPTY_STATE);
    const { events } = computeSignalEvents(signals(HEALTHY), nextState);
    const heartbeatEvents = events.filter((e) => e.id === 'heartbeat');
    expect(heartbeatEvents).toHaveLength(1);
    expect(heartbeatEvents[0].transition).toBe('recovery');
  });

  it('5. post-recovery stale heartbeat -> exactly one new-failure event again', () => {
    let state = EMPTY_STATE;
    state = computeSignalEvents(signals(HEARTBEAT_MILD), state).nextState; // first failure
    state = computeSignalEvents(signals(HEALTHY), state).nextState; // recovery
    const { events } = computeSignalEvents(signals(HEARTBEAT_MILD), state); // fails again
    const heartbeatEvents = events.filter((e) => e.id === 'heartbeat');
    expect(heartbeatEvents).toHaveLength(1);
    expect(heartbeatEvents[0].transition).toBe('new-failure');
  });

  it('6. a different health check fails while heartbeat remains stale -> exactly one new alert for the new one, heartbeat stays silent', () => {
    const { nextState } = computeSignalEvents(signals(HEARTBEAT_MILD), EMPTY_STATE);
    const { events } = computeSignalEvents(signals(HEARTBEAT_MILD_AND_MODELS_FAILING), nextState);
    expect(events.filter((e) => e.id === 'heartbeat')).toHaveLength(0); // still silent
    const modelEvents = events.filter((e) => e.id === 'health:models');
    expect(modelEvents).toHaveLength(1);
    expect(modelEvents[0].transition).toBe('new-failure');
    expect(events).toHaveLength(1); // exactly one alert, not two
  });

  it('7a. failure worsening (mild -> severe band) -> one escalation event', () => {
    const { nextState } = computeSignalEvents(signals(HEARTBEAT_MILD), EMPTY_STATE);
    const { events } = computeSignalEvents(signals(HEARTBEAT_SEVERE), nextState);
    const heartbeatEvents = events.filter((e) => e.id === 'heartbeat');
    expect(heartbeatEvents).toHaveLength(1);
    expect(heartbeatEvents[0].transition).toBe('escalation');
    expect(heartbeatEvents[0].band).toBe('severe');
  });

  it('7b. same band (mild -> mild, just an older detail string) -> no escalation, suppressed', () => {
    const { nextState } = computeSignalEvents(signals(HEARTBEAT_MILD), EMPTY_STATE);
    const stillMild = health([
      HEALTHY.checks[0],
      HEALTHY.checks[1],
      { name: 'heartbeat', ok: false, detail: 'stale (45h old)', ageHours: 45 }, // different hours, same band
      HEALTHY.checks[3],
    ]);
    const { events } = computeSignalEvents(signals(stillMild), nextState);
    expect(events.filter((e) => e.id === 'heartbeat')).toHaveLength(0);
  });

  it('7c. moderate -> mild (band IMPROVES but does not fully recover) -> NOT an escalation, silent (adversarial-review fix: only worsening escalates)', () => {
    const { nextState } = computeSignalEvents(signals(HEARTBEAT_MODERATE), EMPTY_STATE);
    const { events } = computeSignalEvents(signals(HEARTBEAT_MILD), nextState);
    // band changed (moderate -> mild) but this is an IMPROVEMENT, not a
    // worsening. An earlier revision of detectTransition() fired escalation
    // on ANY band change (including improvement), which would have surfaced
    // a CEO-facing "ESCALATED: heartbeat" message for a case that got
    // better — backwards and actively misleading. Fixed to compare severity
    // ordering (BAND_SEVERITY) and only escalate on a strict increase.
    expect(events.filter((e) => e.id === 'heartbeat')).toHaveLength(0);
  });

  it('7d. mild -> severe -> moderate: escalates once (mild->severe), then stays silent on the subsequent improvement (severe->moderate)', () => {
    let state = EMPTY_STATE;
    state = computeSignalEvents(signals(HEARTBEAT_MILD), state).nextState;
    const escalated = computeSignalEvents(signals(HEARTBEAT_SEVERE), state);
    expect(escalated.events.filter((e) => e.id === 'heartbeat' && e.transition === 'escalation')).toHaveLength(1);
    state = escalated.nextState;
    const improved = computeSignalEvents(signals(HEARTBEAT_MODERATE), state);
    expect(improved.events.filter((e) => e.id === 'heartbeat')).toHaveLength(0); // improvement, not escalation
  });

  it('8. state survives a simulated new process (fresh readAlertState() call reads back what a prior write persisted)', () => {
    const stateDir = mkdtempSync(join(tmpdir(), 'atlas-alert-state-reload-'));
    const stateFile = join(stateDir, 'alert-state.json');
    const prior = process.env.ATLAS_ALERT_STATE_FILE;
    process.env.ATLAS_ALERT_STATE_FILE = stateFile;
    try {
      const { nextState } = computeSignalEvents(signals(HEARTBEAT_MILD), EMPTY_STATE);
      writeFileSync(stateFile, JSON.stringify(nextState));
      // Simulate a brand new process: readAlertState() re-parses from disk, no in-memory carry-over.
      const reloaded = readAlertState();
      expect(reloaded.signals.heartbeat?.state).toBe('FAILING');
      expect(reloaded.signals.heartbeat?.band).toBe('mild');
      const { events } = computeSignalEvents(signals(HEARTBEAT_MILD), reloaded);
      expect(events.filter((e) => e.id === 'heartbeat')).toHaveLength(0); // still suppressed after reload
    } finally {
      if (prior === undefined) delete process.env.ATLAS_ALERT_STATE_FILE;
      else process.env.ATLAS_ALERT_STATE_FILE = prior;
      rmSync(stateDir, { recursive: true, force: true });
    }
  });

  it('9a. malformed/missing state file (syntax error) reads as safe empty (all UNKNOWN), never throws, and an already-real failure fires exactly once (not a storm)', () => {
    const stateDir = mkdtempSync(join(tmpdir(), 'atlas-alert-state-malformed-'));
    const stateFile = join(stateDir, 'alert-state.json');
    const prior = process.env.ATLAS_ALERT_STATE_FILE;
    process.env.ATLAS_ALERT_STATE_FILE = stateFile;
    try {
      writeFileSync(stateFile, '{not valid json!!!');
      expect(() => readAlertState()).not.toThrow();
      const reloaded = readAlertState();
      expect(reloaded.signals).toEqual({});
      const { events } = computeSignalEvents(signals(HEARTBEAT_MILD), reloaded);
      expect(events.filter((e) => e.id === 'heartbeat')).toHaveLength(1); // exactly one, not a storm
    } finally {
      if (prior === undefined) delete process.env.ATLAS_ALERT_STATE_FILE;
      else process.env.ATLAS_ALERT_STATE_FILE = prior;
      rmSync(stateDir, { recursive: true, force: true });
    }
  });

  it('9b. malformed-but-valid-JSON shapes (array-as-signals, __proto__ key, non-object rec) are all rejected safely — adversarial-review coverage gap', () => {
    const stateDir = mkdtempSync(join(tmpdir(), 'atlas-alert-state-adversarial-'));
    const stateFile = join(stateDir, 'alert-state.json');
    const prior = process.env.ATLAS_ALERT_STATE_FILE;
    process.env.ATLAS_ALERT_STATE_FILE = stateFile;
    try {
      const payloads = [
        '{"signals": null}',
        '{"signals": []}',
        '{"signals": "x"}',
        '{"signals": {"heartbeat": "not-an-object"}}',
        '{"signals": {"__proto__": {"state":"FAILING","band":"severe"}}}',
      ];
      for (const payload of payloads) {
        writeFileSync(stateFile, payload);
        expect(() => readAlertState()).not.toThrow();
        const state = readAlertState();
        expect(state.signals.heartbeat).toBeUndefined();
        // The __proto__ payload specifically must not pollute the shared Object prototype.
        expect(({} as Record<string, unknown>).state).toBeUndefined();
        expect(({} as Record<string, unknown>).band).toBeUndefined();
      }
    } finally {
      if (prior === undefined) delete process.env.ATLAS_ALERT_STATE_FILE;
      else process.env.ATLAS_ALERT_STATE_FILE = prior;
      rmSync(stateDir, { recursive: true, force: true });
    }
  });

  it('2. a PERSISTENT write failure logs (not silent) and does not crash the tick — adversarial-review REAL ISSUE, fixed', async () => {
    vi.spyOn(spendPolicy, 'isPaused').mockReturnValue(false);
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const stateDir = mkdtempSync(join(tmpdir(), 'atlas-alert-state-writefail-'));
    // Point the state file at a path whose PARENT does not exist and cannot
    // be created (a file, not a directory, sits where the parent dir would
    // need to be) — forces mkdirSync/writeFileSync to throw.
    const blockerFile = join(stateDir, 'blocker');
    writeFileSync(blockerFile, 'x');
    const impossiblePath = join(blockerFile, 'alert-state.json'); // blockerFile is a file, not a dir
    const prior = process.env.ATLAS_ALERT_STATE_FILE;
    process.env.ATLAS_ALERT_STATE_FILE = impossiblePath;
    try {
      const result = await runTick({ notify: false, observeFn: () => signals(HEARTBEAT_MILD) });
      expect(result.state).toBe('observed'); // tick completes normally despite the write failure
      expect(errSpy).toHaveBeenCalled();
      expect(String(errSpy.mock.calls[0][0])).toMatch(/failed to persist alert state/);
    } finally {
      errSpy.mockRestore();
      if (prior === undefined) delete process.env.ATLAS_ALERT_STATE_FILE;
      else process.env.ATLAS_ALERT_STATE_FILE = prior;
      rmSync(stateDir, { recursive: true, force: true });
    }
  });

  it('12a. no LLM/model-router import anywhere in this module (static zero-paid-call proof)', async () => {
    const src = readFileSync(new URL('../atlas/autonomy-loop.ts', import.meta.url), 'utf8');
    expect(src).not.toMatch(/from ['"].*model-router/);
    expect(src).not.toMatch(/from ['"].*\/llm/);
  });
});

describe('formatEventMessage', () => {
  it('describes exactly the given events, stays under the Telegram-safe length', () => {
    const { events } = computeSignalEvents(signals(HEARTBEAT_MILD), EMPTY_STATE);
    const msg = formatEventMessage(events);
    expect(msg.length).toBeLessThanOrEqual(4000);
    expect(msg).toContain('NEW FAILURE: heartbeat');
    expect(msg).toContain('[mild]');
  });

  it('labels a recovery event distinctly from a new failure', () => {
    const { nextState } = computeSignalEvents(signals(HEARTBEAT_MILD), EMPTY_STATE);
    const { events } = computeSignalEvents(signals(HEALTHY), nextState);
    const msg = formatEventMessage(events);
    expect(msg).toContain('RECOVERED: heartbeat');
  });
});

describe('autonomy-loop runTick — end-to-end tick behavior (fixed fixtures via observeFn)', () => {
  let stateDir: string;
  let stateFile: string;
  let priorChatId: string | undefined;

  beforeEach(() => {
    vi.restoreAllMocks();
    stateDir = mkdtempSync(join(tmpdir(), 'atlas-autonomy-test-'));
    stateFile = join(stateDir, 'alert-state.json');
    process.env.ATLAS_ALERT_STATE_FILE = stateFile;
    priorChatId = process.env.TELEGRAM_CEO_CHAT_ID;
    process.env.TELEGRAM_CEO_CHAT_ID = '12345';
  });

  afterEach(() => {
    vi.restoreAllMocks();
    delete process.env.ATLAS_ALERT_STATE_FILE;
    if (priorChatId === undefined) delete process.env.TELEGRAM_CEO_CHAT_ID;
    else process.env.TELEGRAM_CEO_CHAT_ID = priorChatId;
    try {
      rmSync(dirname(stateFile), { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  });

  it('10a. PAUSED: isPaused()=true skips the tick before observing (observeFn never called)', async () => {
    vi.spyOn(spendPolicy, 'isPaused').mockReturnValue(true);
    const observeFn = vi.fn(() => signals(HEARTBEAT_MILD));
    const result = await runTick({ notify: true, observeFn });
    expect(result.state).toBe('paused');
    expect(result.reason).toMatch(/before observing/);
    expect(result.signals).toBeUndefined();
    expect(observeFn).not.toHaveBeenCalled();
  });

  it('SILENT: no signal transitions this tick (first-ever observation, all healthy)', async () => {
    vi.spyOn(spendPolicy, 'isPaused').mockReturnValue(false);
    const result = await runTick({ notify: true, observeFn: () => signals(HEALTHY) });
    expect(result.state).toBe('silent');
    expect(result.reason).toMatch(/no actionable signal transitions/);
  });

  it('OBSERVED (dry-run): a real transition exists but notify was not requested', async () => {
    vi.spyOn(spendPolicy, 'isPaused').mockReturnValue(false);
    const result = await runTick({ notify: false, observeFn: () => signals(HEARTBEAT_MILD) });
    expect(result.state).toBe('observed');
    expect(result.reason).toMatch(/dry-run/);
    expect(result.events?.some((e) => e.id === 'heartbeat' && e.transition === 'new-failure')).toBe(true);
  });

  it('NOTIFIED: a transition exists + notify requested -> sends via canonical notifyCeoResult() and persists refreshed state', async () => {
    vi.spyOn(spendPolicy, 'isPaused').mockReturnValue(false);
    const sendOverride = vi.fn().mockResolvedValue(undefined);

    const result = await runTick({ notify: true, observeFn: () => signals(HEARTBEAT_MILD), sendOverride });
    expect(result.state).toBe('notified');
    expect(result.sent).toBe(true);
    expect(sendOverride).toHaveBeenCalledTimes(1);
    expect(sendOverride.mock.calls[0][0]).toBe(12345); // TELEGRAM_CEO_CHAT_ID resolved by notify.ts, not this module

    const persisted = JSON.parse(readFileSync(stateFile, 'utf8'));
    expect(persisted.signals.heartbeat.state).toBe('FAILING');
    expect(persisted.signals.heartbeat.band).toBe('mild');
  });

  it('10b. re-checks isPaused() immediately before notifying, not just at tick start (send never attempted)', async () => {
    vi.spyOn(spendPolicy, 'isPaused').mockReturnValueOnce(false).mockReturnValueOnce(true);
    const sendOverride = vi.fn();
    const result = await runTick({ notify: true, observeFn: () => signals(HEARTBEAT_MILD), sendOverride });
    expect(result.state).toBe('paused');
    expect(result.reason).toMatch(/after observing/);
    expect(sendOverride).not.toHaveBeenCalled();
  });

  it('NOTIFY-FAILED: a send error is caught, never throws, distinguishable from "no CEO chat configured"', async () => {
    vi.spyOn(spendPolicy, 'isPaused').mockReturnValue(false);
    const sendOverride = vi.fn().mockRejectedValue(new Error('telegram down'));
    const result = await runTick({ notify: true, observeFn: () => signals(HEARTBEAT_MILD), sendOverride });
    expect(result.state).toBe('notify-failed');
    expect(result.reason).toMatch(/send failed/);

    // Re-run with no chat configured — must land on a DIFFERENT, distinguishable reason.
    delete process.env.TELEGRAM_CEO_CHAT_ID;
    const result2 = await runTick({
      notify: true,
      now: Date.now() + 1,
      observeFn: () => signals(HEARTBEAT_SEVERE), // different signal so it's a fresh transition
      sendOverride: vi.fn(),
    });
    expect(result2.state).toBe('silent');
    expect(result2.reason).toMatch(/no CEO chat configured/);
  });

  it('uses "error" kind when a new/escalated failure is present, "important" for a pure recovery', async () => {
    vi.spyOn(spendPolicy, 'isPaused').mockReturnValue(false);
    const sendOverride = vi.fn().mockResolvedValue(undefined);

    const r1 = await runTick({ notify: true, observeFn: () => signals(HEARTBEAT_MILD), sendOverride });
    expect(r1.state).toBe('notified');
    expect(r1.kind).toBe('error');

    const r2 = await runTick({
      notify: true,
      now: Date.now() + 1,
      observeFn: () => signals(HEALTHY),
      sendOverride,
    });
    expect(r2.state).toBe('notified');
    expect(r2.kind).toBe('important'); // pure recovery, not an error
  });

  it('11a. cannot be made to target an arbitrary chat ID — sendOverride only overrides the transport, not the destination', async () => {
    vi.spyOn(spendPolicy, 'isPaused').mockReturnValue(false);
    process.env.TELEGRAM_CEO_CHAT_ID = '99999';
    const sendOverride = vi.fn().mockResolvedValue(undefined);
    await runTick({ notify: true, observeFn: () => signals(HEARTBEAT_MILD), sendOverride });
    expect(sendOverride.mock.calls[0][0]).toBe(99999);
  });

  it('11b. RunTickOptions has no chatId/target field — compile-time guard, not a runtime call', () => {
    // @ts-expect-error — proves the option does not exist; if this ever stops
    // erroring (someone added a chatId field), the build breaks here first.
    const bad: import('../atlas/autonomy-loop.js').RunTickOptions = { chatId: 1 };
    expect(bad).toBeDefined(); // never awaited/executed — type-check only
  });

  it('12b. a routine unrelated repo commit during an active heartbeat failure does not resend — the exact storm path this redesign removes', async () => {
    vi.spyOn(spendPolicy, 'isPaused').mockReturnValue(false);
    const sendOverride = vi.fn().mockResolvedValue(undefined);

    const first = await runTick({ notify: true, observeFn: () => signals(HEARTBEAT_MILD), sendOverride });
    expect(first.state).toBe('notified');
    expect(sendOverride).toHaveBeenCalledTimes(1);

    // Same heartbeat failure, but the repo digest changed (a real commit landed) —
    // this is the exact scenario that double-sent in the live scheduler smoke.
    const second = await runTick({
      notify: true,
      now: Date.now() + 1,
      observeFn: () =>
        signals(HEARTBEAT_MILD, {
          repoDigest: 'Repo watch:\n- ANUS: branch main, 2 dirty — def456 unrelated real commit',
        }),
      sendOverride,
    });
    expect(second.state).toBe('silent');
    expect(sendOverride).toHaveBeenCalledTimes(1); // still 1 — no second send
  });
});

describe('sendControlledTestNotification — V0.1 Blocker 3 rate-limit + pause guard (unchanged by V1)', () => {
  let testStateDir: string;
  let testStateFile: string;
  let priorChatId: string | undefined;

  beforeEach(() => {
    vi.restoreAllMocks();
    testStateDir = mkdtempSync(join(tmpdir(), 'atlas-test-notify-'));
    testStateFile = join(testStateDir, 'test-notify-state.json');
    process.env.ATLAS_AUTONOMY_TEST_STATE_FILE = testStateFile;
    priorChatId = process.env.TELEGRAM_CEO_CHAT_ID;
    process.env.TELEGRAM_CEO_CHAT_ID = '12345';
  });

  afterEach(() => {
    vi.restoreAllMocks();
    delete process.env.ATLAS_AUTONOMY_TEST_STATE_FILE;
    if (priorChatId === undefined) delete process.env.TELEGRAM_CEO_CHAT_ID;
    else process.env.TELEGRAM_CEO_CHAT_ID = priorChatId;
    try {
      rmSync(testStateDir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  });

  it('sends once, then rate-limits an immediate second call (uses its own state file, not the V1 alert-state one)', async () => {
    vi.spyOn(spendPolicy, 'isPaused').mockReturnValue(false);
    const sendOverride = vi.fn().mockResolvedValue(undefined);
    const now = Date.now();

    const first = await sendControlledTestNotification({ now, intervalMin: 15, sendOverride });
    expect(first.attempted).toBe(true);
    expect(first.outcomeResult).toBe('SENT');
    expect(sendOverride).toHaveBeenCalledTimes(1);

    const second = await sendControlledTestNotification({ now: now + 60_000, intervalMin: 15, sendOverride });
    expect(second.attempted).toBe(false);
    expect(second.reason).toMatch(/rate-limited/);
    expect(sendOverride).toHaveBeenCalledTimes(1); // still 1 — second call never attempted a send
  });

  it('10c. a paused Atlas does not send the test notification either', async () => {
    vi.spyOn(spendPolicy, 'isPaused').mockReturnValue(true);
    const sendOverride = vi.fn();
    const result = await sendControlledTestNotification({ sendOverride });
    expect(result.attempted).toBe(false);
    expect(sendOverride).not.toHaveBeenCalled();
  });
});
