import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
import { shouldNotify, formatError, notifyCeo, notifyCeoResult } from '../atlas/notify.js';
import { isQuietHours, enqueue, drainQueue, clearQueue, readQueue } from '../atlas/notify-queue.js';

describe('notification gate', () => {
  it('allows briefing, error, important, remote-result, panic', () => {
    expect(shouldNotify('briefing')).toBe(true);
    expect(shouldNotify('error')).toBe(true);
    expect(shouldNotify('important')).toBe(true);
    expect(shouldNotify('remote-result')).toBe(true);
    expect(shouldNotify('panic')).toBe(true);
  });

  it('silences chatter by default', () => {
    expect(shouldNotify('chatter')).toBe(false);
  });

  it('formatError follows "не смог X, причина Y, делаю Z"', () => {
    const e = formatError('собрать статус', 'нет ключа Supabase', 'проверяю логи');
    expect(e).toBe('Не смог собрать статус, причина: нет ключа Supabase. Делаю: проверяю логи.');
  });
});

describe('notifyCeo', () => {
  it('sends allowed kinds to the CEO chat', async () => {
    const send = vi.fn().mockResolvedValue(undefined);
    const ok = await notifyCeo('briefing', 'доброе утро', { send, ceoChatId: '42' });
    expect(ok).toBe(true);
    expect(send).toHaveBeenCalledWith(42, 'доброе утро');
  });

  it('drops gated (chatter) kinds without sending', async () => {
    const send = vi.fn().mockResolvedValue(undefined);
    const ok = await notifyCeo('chatter', 'бла бла', { send, ceoChatId: '42' });
    expect(ok).toBe(false);
    expect(send).not.toHaveBeenCalled();
  });

  it('no-ops when no CEO chat is configured', async () => {
    const send = vi.fn().mockResolvedValue(undefined);
    const ok = await notifyCeo('error', 'упал', { send, ceoChatId: undefined });
    expect(ok).toBe(false);
    expect(send).not.toHaveBeenCalled();
  });

  it('never throws when send fails, returns false', async () => {
    const send = vi.fn().mockRejectedValue(new Error('telegram down'));
    const ok = await notifyCeo('error', 'упал', { send, ceoChatId: '42' });
    expect(ok).toBe(false);
  });
});

describe('notifyCeoResult — canonical structured-result API (V0.1)', () => {
  const priorChatId = process.env.TELEGRAM_CEO_CHAT_ID;

  beforeEach(async () => {
    // Mock isQuietHours to false so pre-M7 tests are not affected by real clock.
    const notifyQueue = await import('../atlas/notify-queue.js');
    vi.spyOn(notifyQueue, 'isQuietHours').mockReturnValue(false);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    if (priorChatId === undefined) delete process.env.TELEGRAM_CEO_CHAT_ID;
    else process.env.TELEGRAM_CEO_CHAT_ID = priorChatId;
  });

  it('SENT: configured CEO target + successful send', async () => {
    process.env.TELEGRAM_CEO_CHAT_ID = '777';
    const send = vi.fn().mockResolvedValue(undefined);
    const outcome = await notifyCeoResult('important', 'hello', send);
    expect(outcome).toEqual({ result: 'SENT' });
    expect(send).toHaveBeenCalledWith(777, 'hello');
  });

  it('FAILED: configured target but send throws — distinct from NOT_CONFIGURED', async () => {
    process.env.TELEGRAM_CEO_CHAT_ID = '777';
    const send = vi.fn().mockRejectedValue(new Error('telegram HTTP 500'));
    const outcome = await notifyCeoResult('error', 'boom', send);
    expect(outcome.result).toBe('FAILED');
    expect(outcome.error).toMatch(/telegram HTTP 500/);
  });

  it('NOT_CONFIGURED: no CEO chat ID set — send is never attempted', async () => {
    delete process.env.TELEGRAM_CEO_CHAT_ID;
    const send = vi.fn();
    const outcome = await notifyCeoResult('important', 'hello', send);
    expect(outcome).toEqual({ result: 'NOT_CONFIGURED' });
    expect(send).not.toHaveBeenCalled();
  });

  it('SUPPRESSED: gated kind (chatter) — send is never attempted even with a valid target', async () => {
    process.env.TELEGRAM_CEO_CHAT_ID = '777';
    const send = vi.fn();
    const outcome = await notifyCeoResult('chatter', 'noise', send);
    expect(outcome).toEqual({ result: 'SUPPRESSED' });
    expect(send).not.toHaveBeenCalled();
  });

  it('cannot target an arbitrary chat ID: the target always comes from TELEGRAM_CEO_CHAT_ID, never from the caller', async () => {
    process.env.TELEGRAM_CEO_CHAT_ID = '111';
    const send = vi.fn().mockResolvedValue(undefined);
    // notifyCeoResult's signature has no chat-ID parameter at all — only kind, msg, send.
    // Changing the env is the ONLY way to change the target; calling it differently cannot.
    await notifyCeoResult('important', 'msg one', send);
    expect(send.mock.calls[0][0]).toBe(111);

    process.env.TELEGRAM_CEO_CHAT_ID = '222';
    await notifyCeoResult('important', 'msg two', send);
    expect(send.mock.calls[1][0]).toBe(222); // only the env change moved the target, not a caller-supplied value
  });
});

// ═══════════════════════════════════════════════════════════════════════
// M7: Quiet-hours policy + notify queue
// ═══════════════════════════════════════════════════════════════════════

describe('M7 quiet-hours policy', () => {
  it('23:30 Baku (19:30 UTC) is quiet hours', () => {
    // 23:30 Baku = 19:30 UTC (UTC+4)
    const dt = new Date('2026-07-23T19:30:00Z');
    expect(isQuietHours(dt)).toBe(true);
  });

  it('08:01 Baku (04:01 UTC) is NOT quiet hours', () => {
    const dt = new Date('2026-07-23T04:01:00Z');
    expect(isQuietHours(dt)).toBe(false);
  });

  it('03:00 Baku (23:00 UTC day before) is quiet hours', () => {
    // 03:00 Baku = 23:00 UTC (previous day)
    const dt = new Date('2026-07-22T23:00:00Z');
    expect(isQuietHours(dt)).toBe(true);
  });

  it('12:00 Baku (08:00 UTC) is NOT quiet hours', () => {
    const dt = new Date('2026-07-23T08:00:00Z');
    expect(isQuietHours(dt)).toBe(false);
  });

  it('23:00 Baku (19:00 UTC) is quiet hours (inclusive)', () => {
    const dt = new Date('2026-07-23T19:00:00Z');
    expect(isQuietHours(dt)).toBe(true);
  });
});

describe('M7 notify queue', () => {
  const priorQueuePath = process.env.ATLAS_NOTIFY_QUEUE_PATH;

  beforeEach(() => {
    const { mkdtempSync } = require('node:fs');
    const { join } = require('node:path');
    const { tmpdir } = require('node:os');
    const tmpDir = mkdtempSync(join(tmpdir(), 'notify-queue-test-'));
    process.env.ATLAS_NOTIFY_QUEUE_PATH = join(tmpDir, 'queue.json');
    clearQueue();
  });

  afterEach(() => {
    if (priorQueuePath === undefined) delete process.env.ATLAS_NOTIFY_QUEUE_PATH;
    else process.env.ATLAS_NOTIFY_QUEUE_PATH = priorQueuePath;
  });

  it('enqueue adds entry, chatter is suppressed', () => {
    expect(enqueue('important', 'test message')).toBe('QUEUED');
    expect(enqueue('chatter', 'noise')).toBe('SUPPRESSED');
    const state = readQueue();
    expect(state.entries).toHaveLength(1);
    expect(state.entries[0].kind).toBe('important');
  });

  it('drain sends digest and clears queue', async () => {
    enqueue('error', 'something broke');
    enqueue('important', 'heads up');

    let sentMsg = '';
    const send = async (msg: string) => { sentMsg = msg; };
    // 08:01 Baku = 04:01 UTC → outside quiet hours
    const result = await drainQueue(send, new Date('2026-07-23T04:01:00Z'));
    expect(result.sent).toBe(true);
    expect(result.count).toBe(2);
    expect(sentMsg).toContain('Queued notifications (2)');

    // Queue is cleared
    const afterDrain = readQueue();
    expect(afterDrain.entries).toHaveLength(0);
  });

  it('drain retains queue on send failure', async () => {
    enqueue('error', 'critical');
    const send = async () => { throw new Error('telegram down'); };
    const result = await drainQueue(send, new Date('2026-07-23T04:01:00Z'));
    expect(result.sent).toBe(false);
    expect(result.error).toContain('telegram down');

    // Queue retained
    const afterFail = readQueue();
    expect(afterFail.entries).toHaveLength(1);
  });

  it('drain refuses during quiet hours', async () => {
    enqueue('important', 'test');
    const send = async () => {};
    // 23:30 Baku = 19:30 UTC → quiet hours
    const result = await drainQueue(send, new Date('2026-07-23T19:30:00Z'));
    expect(result.sent).toBe(false);
    expect(result.error).toContain('quiet hours');
  });
});

describe('M7 notifyCeoResult quiet-hours integration', () => {
  const priorChatId = process.env.TELEGRAM_CEO_CHAT_ID;
  const priorQueuePath = process.env.ATLAS_NOTIFY_QUEUE_PATH;

  beforeEach(() => {
    const { mkdtempSync } = require('node:fs');
    const { join } = require('node:path');
    const { tmpdir } = require('node:os');
    const tmpDir = mkdtempSync(join(tmpdir(), 'notify-queue-integ-'));
    process.env.ATLAS_NOTIFY_QUEUE_PATH = join(tmpDir, 'queue.json');
    process.env.TELEGRAM_CEO_CHAT_ID = '777';
    clearQueue();
  });

  afterEach(() => {
    if (priorChatId === undefined) delete process.env.TELEGRAM_CEO_CHAT_ID;
    else process.env.TELEGRAM_CEO_CHAT_ID = priorChatId;
    if (priorQueuePath === undefined) delete process.env.ATLAS_NOTIFY_QUEUE_PATH;
    else process.env.ATLAS_NOTIFY_QUEUE_PATH = priorQueuePath;
  });

  it('23:30 Baku important notification => QUEUED + send count 0', async () => {
    // Mock isQuietHours to return true (simulate 23:30 Baku)
    const notifyQueue = await import('../atlas/notify-queue.js');
    vi.spyOn(notifyQueue, 'isQuietHours').mockReturnValue(true);

    const send = vi.fn().mockResolvedValue(undefined);
    const outcome = await notifyCeoResult('important', 'test alert', send);
    expect(outcome.result).toBe('QUEUED');
    expect(send).not.toHaveBeenCalled();

    vi.restoreAllMocks();
  });

  it('panic at 23:30 => SENT (bypasses quiet hours)', async () => {
    const notifyQueue = await import('../atlas/notify-queue.js');
    vi.spyOn(notifyQueue, 'isQuietHours').mockReturnValue(true);

    const send = vi.fn().mockResolvedValue(undefined);
    const outcome = await notifyCeoResult('panic', 'EMERGENCY', send);
    expect(outcome.result).toBe('SENT');
    expect(send).toHaveBeenCalledWith(777, 'EMERGENCY');

    vi.restoreAllMocks();
  });

  it('08:01 Baku sends immediately (no queue)', async () => {
    const notifyQueue = await import('../atlas/notify-queue.js');
    vi.spyOn(notifyQueue, 'isQuietHours').mockReturnValue(false);

    const send = vi.fn().mockResolvedValue(undefined);
    const outcome = await notifyCeoResult('important', 'normal alert', send);
    expect(outcome.result).toBe('SENT');
    expect(send).toHaveBeenCalledWith(777, 'normal alert');

    vi.restoreAllMocks();
  });
});
