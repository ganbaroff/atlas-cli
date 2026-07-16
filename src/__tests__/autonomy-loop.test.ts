import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { writeFileSync, readFileSync, rmSync, mkdtempSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import * as spendPolicy from '../atlas/spend-policy.js';
import {
  observe,
  combinedSignature,
  formatTickMessage,
  runTick,
  sendControlledTestNotification,
  type TickSignals,
} from '../atlas/autonomy-loop.js';

// Fixed fixtures for the state-machine tests — mirrors repo-watch.test.ts's
// decideNotify fixtures. Real repo signals (git status of an OneDrive-synced
// tree) are not guaranteed identical moments apart, so gating-logic tests use
// hand-constructed TickSignals via runTick's injectable observeFn, not two
// live observe() calls.
const HEALTHY: TickSignals['health'] = {
  ts: '2026-07-17T00:00:00.000Z',
  checks: [
    { name: 'memory-vault', ok: true, detail: 'found' },
    { name: 'identity-file', ok: true, detail: 'found' },
    { name: 'heartbeat', ok: true, detail: 'fresh' },
  ],
  passed: 3,
  failed: 0,
  summary: 'All 3 checks passed',
};
const FAILING: TickSignals['health'] = {
  ...HEALTHY,
  checks: [HEALTHY.checks[0], HEALTHY.checks[1], { name: 'heartbeat', ok: false, detail: 'stale (30h old)' }],
  passed: 2,
  failed: 1,
  summary: '1/3 checks failed: heartbeat',
};
const A: TickSignals = {
  repoDigest: 'Repo watch:\n- ANUS: branch main, clean — abc123 initial',
  repoSig: 'ANUS:main:0:0:abc123 initial',
  health: HEALTHY,
};
const B: TickSignals = {
  ...A,
  repoDigest: 'Repo watch:\n- ANUS: branch main, 3 dirty — abc123 initial',
  repoSig: 'ANUS:main:3:0:abc123 initial', // changed (dirty count)
};
const B_FAILING: TickSignals = { ...B, health: FAILING };

describe('autonomy-loop observe/combinedSignature (real signals, shape-only)', () => {
  it('observe() returns well-shaped signals without throwing', () => {
    const signals = observe();
    expect(typeof signals.repoDigest).toBe('string');
    expect(typeof signals.repoSig).toBe('string');
    expect(signals.health.checks.length).toBeGreaterThan(0);
  });

  it('combinedSignature is deterministic for the same signals object', () => {
    const signals = observe();
    expect(combinedSignature(signals)).toBe(combinedSignature(signals));
  });
});

describe('autonomy-loop combinedSignature/formatTickMessage (fixed fixtures)', () => {
  it('differs when repo signature changes', () => {
    expect(combinedSignature(A)).not.toBe(combinedSignature(B));
  });

  it('differs when the health vector changes', () => {
    expect(combinedSignature(A)).not.toBe(combinedSignature(B_FAILING));
  });

  it('formatTickMessage stays under the Telegram-safe length and includes key sections', () => {
    const msg = formatTickMessage(A);
    expect(msg.length).toBeLessThanOrEqual(4000);
    expect(msg).toContain('Health:');
  });
});

describe('autonomy-loop runTick — state machine (fixed fixtures via observeFn)', () => {
  let stateDir: string;
  let stateFile: string;
  let priorChatId: string | undefined;

  beforeEach(() => {
    vi.restoreAllMocks();
    stateDir = mkdtempSync(join(tmpdir(), 'atlas-autonomy-test-'));
    stateFile = join(stateDir, 'state.json');
    process.env.ATLAS_AUTONOMY_STATE_FILE = stateFile;
    priorChatId = process.env.TELEGRAM_CEO_CHAT_ID;
    process.env.TELEGRAM_CEO_CHAT_ID = '12345';
  });

  afterEach(() => {
    vi.restoreAllMocks();
    delete process.env.ATLAS_AUTONOMY_STATE_FILE;
    if (priorChatId === undefined) delete process.env.TELEGRAM_CEO_CHAT_ID;
    else process.env.TELEGRAM_CEO_CHAT_ID = priorChatId;
    try {
      rmSync(dirname(stateFile), { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  });

  it('PAUSED: isPaused()=true skips the tick before observing (observeFn never called)', async () => {
    vi.spyOn(spendPolicy, 'isPaused').mockReturnValue(true);
    const observeFn = vi.fn(() => A);
    const result = await runTick({ notify: true, observeFn });
    expect(result.state).toBe('paused');
    expect(result.reason).toMatch(/before observing/);
    expect(result.signals).toBeUndefined();
    expect(observeFn).not.toHaveBeenCalled();
  });

  it('SILENT: no change since the last recorded snapshot', async () => {
    vi.spyOn(spendPolicy, 'isPaused').mockReturnValue(false);
    const sig = combinedSignature(A);
    writeFileSync(stateFile, JSON.stringify({ sig, lastNotifyMs: Date.now() }));

    const result = await runTick({ notify: true, now: Date.now() + 60_000, observeFn: () => A });
    expect(result.state).toBe('silent');
    expect(result.reason).toMatch(/no change/);
  });

  it('SILENT (rate-limited): changed but interval has not elapsed', async () => {
    vi.spyOn(spendPolicy, 'isPaused').mockReturnValue(false);
    const now = Date.now();
    writeFileSync(stateFile, JSON.stringify({ sig: combinedSignature(A), lastNotifyMs: now }));

    const result = await runTick({ notify: true, now: now + 60_000, intervalMin: 15, observeFn: () => B }); // 1 min < 15
    expect(result.state).toBe('silent');
    expect(result.reason).toMatch(/rate-limited/);
  });

  it('OBSERVED (dry-run): changed + interval elapsed, but notify not requested', async () => {
    vi.spyOn(spendPolicy, 'isPaused').mockReturnValue(false);
    const now = Date.now();
    writeFileSync(stateFile, JSON.stringify({ sig: combinedSignature(A), lastNotifyMs: 0 }));

    const result = await runTick({ notify: false, now, intervalMin: 15, observeFn: () => B });
    expect(result.state).toBe('observed');
    expect(result.reason).toMatch(/dry-run/);
  });

  it('NOTIFIED: changed + interval elapsed + notify requested -> sends via canonical notifyCeoResult() and persists state', async () => {
    vi.spyOn(spendPolicy, 'isPaused').mockReturnValue(false);
    const sendOverride = vi.fn().mockResolvedValue(undefined);
    const now = Date.now();
    writeFileSync(stateFile, JSON.stringify({ sig: combinedSignature(A), lastNotifyMs: 0 }));

    const result = await runTick({ notify: true, now, intervalMin: 15, observeFn: () => B, sendOverride });
    expect(result.state).toBe('notified');
    expect(result.sent).toBe(true);
    expect(sendOverride).toHaveBeenCalledTimes(1);
    expect(sendOverride.mock.calls[0][0]).toBe(12345); // TELEGRAM_CEO_CHAT_ID resolved by notify.ts, not this module

    const persisted = JSON.parse(readFileSync(stateFile, 'utf8'));
    expect(persisted.lastNotifyMs).toBe(now);
    expect(persisted.sig).toBe(combinedSignature(B));
  });

  it('re-checks isPaused() immediately before notifying, not just at tick start (send never attempted)', async () => {
    // Not paused for the FIRST check (tick start), paused by the SECOND check (pre-notify).
    vi.spyOn(spendPolicy, 'isPaused').mockReturnValueOnce(false).mockReturnValueOnce(true);
    const sendOverride = vi.fn();
    const now = Date.now();
    writeFileSync(stateFile, JSON.stringify({ sig: combinedSignature(A), lastNotifyMs: 0 }));

    const result = await runTick({ notify: true, now, intervalMin: 15, observeFn: () => B, sendOverride });
    expect(result.state).toBe('paused');
    expect(result.reason).toMatch(/after observing/);
    expect(sendOverride).not.toHaveBeenCalled();
  });

  it('NOTIFY-FAILED: a send error is caught, never throws, and state is not persisted', async () => {
    vi.spyOn(spendPolicy, 'isPaused').mockReturnValue(false);
    const sendOverride = vi.fn().mockRejectedValue(new Error('telegram down'));
    const now = Date.now();
    writeFileSync(stateFile, JSON.stringify({ sig: combinedSignature(A), lastNotifyMs: 0 }));

    const result = await runTick({ notify: true, now, intervalMin: 15, observeFn: () => B, sendOverride });
    expect(result.state).toBe('notify-failed');
    expect(result.reason).toMatch(/send failed/);

    const persisted = JSON.parse(readFileSync(stateFile, 'utf8'));
    expect(persisted.lastNotifyMs).toBe(0); // unchanged — the failed send must not be recorded as delivered
  });

  it('NOTIFY-FAILED is distinguishable from "no CEO chat configured" (both must not collapse to the same reason)', async () => {
    vi.spyOn(spendPolicy, 'isPaused').mockReturnValue(false);
    delete process.env.TELEGRAM_CEO_CHAT_ID;
    const sendOverride = vi.fn();
    const now = Date.now();
    writeFileSync(stateFile, JSON.stringify({ sig: combinedSignature(A), lastNotifyMs: 0 }));

    const result = await runTick({ notify: true, now, intervalMin: 15, observeFn: () => B, sendOverride });
    expect(result.state).toBe('silent'); // no config -> genuinely nothing to send, correctly silent
    expect(result.reason).toMatch(/no CEO chat configured/);
    expect(sendOverride).not.toHaveBeenCalled(); // never attempted a send with no target
  });

  it('uses "error" kind when a health check has failed, "important" otherwise', async () => {
    vi.spyOn(spendPolicy, 'isPaused').mockReturnValue(false);
    const sendOverride = vi.fn().mockResolvedValue(undefined);
    const now = Date.now();

    writeFileSync(stateFile, JSON.stringify({ sig: combinedSignature(A), lastNotifyMs: 0 }));
    const r1 = await runTick({ notify: true, now, intervalMin: 15, observeFn: () => B, sendOverride });
    expect(r1.state).toBe('notified');
    expect(r1.kind).toBe('important');

    writeFileSync(stateFile, JSON.stringify({ sig: combinedSignature(A), lastNotifyMs: 0 }));
    const r2 = await runTick({ notify: true, now: now + 1, intervalMin: 15, observeFn: () => B_FAILING, sendOverride });
    expect(r2.state).toBe('notified');
    expect(r2.kind).toBe('error');
  });

  it('cannot be made to target an arbitrary chat ID — sendOverride only overrides the transport, not the destination', async () => {
    // Even though sendOverride is a full mock, the FIRST argument it receives
    // (the chat ID) always comes from notify.ts's internal resolveCeoChatId(),
    // never from anything runTick/autonomy-loop passes explicitly. This module
    // has no chatId field anywhere in RunTickOptions.
    vi.spyOn(spendPolicy, 'isPaused').mockReturnValue(false);
    process.env.TELEGRAM_CEO_CHAT_ID = '99999';
    const sendOverride = vi.fn().mockResolvedValue(undefined);
    const now = Date.now();
    writeFileSync(stateFile, JSON.stringify({ sig: combinedSignature(A), lastNotifyMs: 0 }));

    await runTick({ notify: true, now, intervalMin: 15, observeFn: () => B, sendOverride });
    expect(sendOverride.mock.calls[0][0]).toBe(99999);
  });

  it('RunTickOptions has no chatId/target field — compile-time guard, not a runtime call', () => {
    // @ts-expect-error — proves the option does not exist; if this ever stops
    // erroring (someone added a chatId field), the build breaks here first.
    const bad: import('../atlas/autonomy-loop.js').RunTickOptions = { chatId: 1 };
    expect(bad).toBeDefined(); // never awaited/executed — type-check only
  });
});

describe('sendControlledTestNotification — V0.1 Blocker 3 rate-limit + pause guard', () => {
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

  it('sends once, then rate-limits an immediate second call (uses its own state file, not the production one)', async () => {
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

  it('a paused Atlas does not send the test notification either', async () => {
    vi.spyOn(spendPolicy, 'isPaused').mockReturnValue(true);
    const sendOverride = vi.fn();
    const result = await sendControlledTestNotification({ sendOverride });
    expect(result.attempted).toBe(false);
    expect(sendOverride).not.toHaveBeenCalled();
  });
});
