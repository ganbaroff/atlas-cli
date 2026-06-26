import { describe, it, expect } from 'vitest';
import { collectProofTokens, decideCompletionEmit } from '../gates/verify-completion-walk.js';

const promoted = {
  promoted: true,
  status: 'promoted' as const,
  reason: 'promotion passed',
};

describe('verify_completion_walk', () => {
  it('passes clean reply with no completion claim', () => {
    const result = decideCompletionEmit('Слышу. Запускаю миграцию.', { steps: [] });
    expect(result.emitOriginalReply).toBe(true);
    expect(result.emitReply).toBe('Слышу. Запускаю миграцию.');
    expect(result.claimDetected).toBe(false);
  });

  it('downgrades completion claim without proof tokens', () => {
    const result = decideCompletionEmit('Готово. Всё починил.', { steps: [] });
    expect(result.emitOriginalReply).toBe(false);
    expect(result.emitReply).toBe('Не подтверждено. Проверю.');
    expect(result.reason).toBe('completion claim without proof-token');
  });

  it('allows completion claim only when reply cites current-turn proof token', () => {
    const evidence = {
      steps: [
        {
          toolCalls: [{ toolCallId: 'call-1', name: 'read-file' }],
          toolResults: [{ toolCallId: 'call-1', name: 'read-file' }],
        },
      ],
    };
    const tokens = collectProofTokens(evidence);
    expect(tokens).toContain('proof:call-1');

    const blocked = decideCompletionEmit('Готово. Всё починил.', evidence);
    expect(blocked.emitOriginalReply).toBe(false);
    expect(blocked.reason).toBe('completion claim without cited proof-token');

    const missingPromotion = decideCompletionEmit('Готово. proof:call-1 всё починил.', evidence);
    expect(missingPromotion.emitOriginalReply).toBe(false);
    expect(missingPromotion.reason).toContain('promotion');

    const result = decideCompletionEmit('Готово. proof:call-1 всё починил.', evidence, { promotion: promoted });
    expect(result.emitOriginalReply).toBe(true);
    expect(result.emitReply).toBe('Готово. proof:call-1 всё починил.');
    expect(result.proofTokens.length).toBeGreaterThan(0);
    expect(result.matchedProofTokens).toEqual(['proof:call-1']);
  });
});
