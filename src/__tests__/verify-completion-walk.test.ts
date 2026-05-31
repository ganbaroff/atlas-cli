import { describe, it, expect } from 'vitest';
import { collectProofTokens, verifyCompletionWalk } from '../gates/verify-completion-walk.js';

describe('verify_completion_walk', () => {
  it('passes clean reply with no completion claim', () => {
    const result = verifyCompletionWalk('Слышу. Запускаю миграцию.', { steps: [] });
    expect(result.allowed).toBe(true);
    expect(result.reply).toBe('Слышу. Запускаю миграцию.');
    expect(result.claimDetected).toBe(false);
  });

  it('downgrades completion claim without proof tokens', () => {
    const result = verifyCompletionWalk('Готово. Всё починил.', { steps: [] });
    expect(result.allowed).toBe(false);
    expect(result.reply).toBe('Не подтверждено. Проверю.');
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

    const result = verifyCompletionWalk('Готово. Всё починил.', evidence);
    expect(result.allowed).toBe(true);
    expect(result.reply).toBe('Готово. Всё починил.');
    expect(result.proofTokens.length).toBeGreaterThan(0);
  });
});
