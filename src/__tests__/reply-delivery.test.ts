import { describe, it, expect } from 'vitest';
import { deliverReply } from '../atlas/reply-delivery.js';

describe('Reply delivery', () => {
  it('CLI-style path downgrades unverified completion before emit', async () => {
    const result = await deliverReply(
      'Готово. Всё починил.',
      async () => 'Готово. Всё починил.',
      { steps: [] },
    );

    expect(result.reply).toBe('Не подтверждено. Проверю.');
    expect(result.emitDecision.emitOriginalReply).toBe(false);
    expect(result.repaired.retried).toBe(true);
  });

  it('Telegram-style path emits proven completion unchanged', async () => {
    const result = await deliverReply(
      'Готово. Всё починил.',
      async () => ({
        reply: 'Готово. proof:call-1 подтвердил исправление.',
        evidence: {
          steps: [
            {
              toolCalls: [{ toolCallId: 'call-1', name: 'read-file' }],
              toolResults: [{ toolCallId: 'call-1', name: 'read-file' }],
            },
          ],
        },
      }),
      {
        steps: [
          {
            toolCalls: [{ toolCallId: 'old-call', name: 'read-file' }],
            toolResults: [{ toolCallId: 'old-call', name: 'read-file' }],
          },
        ],
      },
    );

    expect(result.reply).toBe('Готово. proof:call-1 подтвердил исправление.');
    expect(result.emitDecision.emitOriginalReply).toBe(true);
    expect(result.repaired.retried).toBe(true);
    expect(result.emitDecision.matchedProofTokens).toEqual(['proof:call-1']);
  });
});
