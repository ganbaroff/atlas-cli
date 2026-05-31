import { describe, it, expect } from 'vitest';
import { collectProofTokens, decideCompletionEmit } from '../gates/verify-completion-walk.js';

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

  it('allows completion claim with proof tokens from tool evidence', () => {
    const evidence = {
      steps: [
        {
          toolCalls: [{ name: 'read-file' }],
          toolResults: [{ name: 'read-file' }],
        },
      ],
    };
    const tokens = collectProofTokens(evidence);
    expect(tokens).toContain('step-tool:read-file');
    expect(tokens).toContain('step-result:read-file');

    const result = decideCompletionEmit('Готово. Всё починил.', evidence);
    expect(result.emitOriginalReply).toBe(true);
    expect(result.emitReply).toBe('Готово. Всё починил.');
    expect(result.proofTokens.length).toBeGreaterThan(0);
  });
});
