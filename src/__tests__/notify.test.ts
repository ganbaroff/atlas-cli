import { afterEach, describe, it, expect, vi } from 'vitest';
import { shouldNotify, formatError, notifyCeo, notifyCeoResult } from '../atlas/notify.js';

describe('notification gate', () => {
  it('allows briefing, error, important, remote-result', () => {
    expect(shouldNotify('briefing')).toBe(true);
    expect(shouldNotify('error')).toBe(true);
    expect(shouldNotify('important')).toBe(true);
    expect(shouldNotify('remote-result')).toBe(true);
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

  afterEach(() => {
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
