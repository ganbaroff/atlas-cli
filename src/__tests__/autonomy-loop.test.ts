import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { writeFileSync, readFileSync, rmSync, mkdtempSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import * as spendPolicy from '../atlas/spend-policy.js';
import { observe, combinedSignature, formatTickMessage, runTick, type TickSignals } from '../atlas/autonomy-loop.js';

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
  let priorToken: string | undefined;
  let priorChatId: string | undefined;

  beforeEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    stateDir = mkdtempSync(join(tmpdir(), 'atlas-autonomy-test-'));
    stateFile = join(stateDir, 'state.json');
    process.env.ATLAS_AUTONOMY_STATE_FILE = stateFile;
    priorToken = process.env.TELEGRAM_BOT_TOKEN;
    priorChatId = process.env.TELEGRAM_CEO_CHAT_ID;
    process.env.TELEGRAM_BOT_TOKEN = 'test-token';
    process.env.TELEGRAM_CEO_CHAT_ID = '12345';
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    delete process.env.ATLAS_AUTONOMY_STATE_FILE;
    if (priorToken === undefined) delete process.env.TELEGRAM_BOT_TOKEN;
    else process.env.TELEGRAM_BOT_TOKEN = priorToken;
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

  it('NOTIFIED: changed + interval elapsed + notify requested -> sends (via real fetch, mocked) and persists state', async () => {
    vi.spyOn(spendPolicy, 'isPaused').mockReturnValue(false);
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ ok: true }) });
    vi.stubGlobal('fetch', fetchMock);
    const now = Date.now();
    writeFileSync(stateFile, JSON.stringify({ sig: combinedSignature(A), lastNotifyMs: 0 }));

    const result = await runTick({ notify: true, now, intervalMin: 15, observeFn: () => B });
    expect(result.state).toBe('notified');
    expect(result.sent).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0][0])).toContain('api.telegram.org');

    const persisted = JSON.parse(readFileSync(stateFile, 'utf8'));
    expect(persisted.lastNotifyMs).toBe(now);
    expect(persisted.sig).toBe(combinedSignature(B));
  });

  it('re-checks isPaused() immediately before notifying, not just at tick start (send never attempted)', async () => {
    // Not paused for the FIRST check (tick start), paused by the SECOND check (pre-notify).
    vi.spyOn(spendPolicy, 'isPaused').mockReturnValueOnce(false).mockReturnValueOnce(true);
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const now = Date.now();
    writeFileSync(stateFile, JSON.stringify({ sig: combinedSignature(A), lastNotifyMs: 0 }));

    const result = await runTick({ notify: true, now, intervalMin: 15, observeFn: () => B });
    expect(result.state).toBe('paused');
    expect(result.reason).toMatch(/after observing/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('NOTIFY-FAILED: a real send error (missing token) is caught, never throws, and state is not persisted', async () => {
    vi.spyOn(spendPolicy, 'isPaused').mockReturnValue(false);
    delete process.env.TELEGRAM_BOT_TOKEN; // forces the real telegramSend() to throw synchronously, no fetch mock needed
    const now = Date.now();
    writeFileSync(stateFile, JSON.stringify({ sig: combinedSignature(A), lastNotifyMs: 0 }));

    const result = await runTick({ notify: true, now, intervalMin: 15, observeFn: () => B });
    expect(result.state).toBe('notify-failed');
    expect(result.reason).toMatch(/send failed/);

    const persisted = JSON.parse(readFileSync(stateFile, 'utf8'));
    expect(persisted.lastNotifyMs).toBe(0); // unchanged — the failed send must not be recorded as delivered
  });

  it('NOTIFY-FAILED is distinguishable from "no CEO chat configured" (both must not collapse to silent)', async () => {
    vi.spyOn(spendPolicy, 'isPaused').mockReturnValue(false);
    delete process.env.TELEGRAM_CEO_CHAT_ID;
    const now = Date.now();
    writeFileSync(stateFile, JSON.stringify({ sig: combinedSignature(A), lastNotifyMs: 0 }));

    const result = await runTick({ notify: true, now, intervalMin: 15, observeFn: () => B });
    expect(result.state).toBe('silent'); // no config -> genuinely nothing to send, correctly silent
    expect(result.reason).toMatch(/no CEO chat configured/);
  });

  it('uses "error" kind when a health check has failed, "important" otherwise', async () => {
    vi.spyOn(spendPolicy, 'isPaused').mockReturnValue(false);
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ ok: true }) });
    vi.stubGlobal('fetch', fetchMock);
    const now = Date.now();

    writeFileSync(stateFile, JSON.stringify({ sig: combinedSignature(A), lastNotifyMs: 0 }));
    const r1 = await runTick({ notify: true, now, intervalMin: 15, observeFn: () => B });
    expect(r1.state).toBe('notified');
    expect(r1.kind).toBe('important');

    writeFileSync(stateFile, JSON.stringify({ sig: combinedSignature(A), lastNotifyMs: 0 }));
    const r2 = await runTick({ notify: true, now: now + 1, intervalMin: 15, observeFn: () => B_FAILING });
    expect(r2.state).toBe('notified');
    expect(r2.kind).toBe('error');
  });
});
