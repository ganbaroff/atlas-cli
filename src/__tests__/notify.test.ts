import { describe, it, expect, vi } from 'vitest';
import { shouldNotify, formatError, notifyCeo } from '../atlas/notify.js';

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
