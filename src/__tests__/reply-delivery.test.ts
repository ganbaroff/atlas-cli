import { describe, it, expect } from 'vitest';
import { deliverReply } from '../atlas/reply-delivery.js';

const promoted = {
  promoted: true,
  status: 'promoted' as const,
  reason: 'promotion passed',
  safe_reply: 'Не подтверждено. Проверю.',
  proof_tokens: ['result-quality-evaluator-smoke.verdict'],
  current_turn_proof_tokens: ['proof:call-1'],
};

describe('Reply delivery', () => {
  it('CLI-style path downgrades unverified completion before emit', async () => {
    const result = await deliverReply(
      'Готово. Всё починил.',
      async () => 'Готово. Всё починил.',
      { steps: [] },
      { promotion: { ...promoted, promoted: false, status: 'blocked', reason: 'promotion blocked' } },
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
      { promotion: promoted },
    );

    expect(result.reply).toBe('Готово. proof:call-1 подтвердил исправление.');
    expect(result.emitDecision.emitOriginalReply).toBe(true);
    expect(result.repaired.retried).toBe(true);
    expect(result.emitDecision.matchedProofTokens).toEqual(['proof:call-1']);
  });

  it('downgrades proven-looking completion when promotion is blocked', async () => {
    const result = await deliverReply(
      'Done. proof:call-1 verified.',
      async () => ({
        reply: 'Done. proof:call-1 verified.',
        evidence: {
          toolResults: [{ toolCallId: 'call-1', name: 'operator-status' }],
        },
      }),
      {
        toolResults: [{ toolCallId: 'call-1', name: 'operator-status' }],
      },
      { promotion: { ...promoted, promoted: false, status: 'blocked', reason: 'promotion blocked: evaluator verdict missing' } },
    );

    expect(result.reply).toBe('Не подтверждено. Проверю.');
    expect(result.emitDecision.emitOriginalReply).toBe(false);
    expect(result.emitDecision.reason).toContain('promotion blocked');
  });
});
