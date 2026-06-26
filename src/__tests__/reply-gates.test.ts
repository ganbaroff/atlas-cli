import { describe, it, expect } from 'vitest';
import { repairReply, validateReply, summarizeReplyGate } from '../atlas/reply-gates.js';

describe('Reply gates', () => {
  it('passes clean reply without retry', async () => {
    const result = await repairReply('Слышу. Запускаю миграцию.', async () => {
      throw new Error('should not retry clean reply');
    });

    expect(result.retried).toBe(false);
    expect(result.reply).toBe('Слышу. Запускаю миграцию.');
    expect(result.firstPass.voice.passed).toBe(true);
    expect(result.firstPass.completion.passed).toBe(true);
  });

  it('retries reply that breaks voice and completion gates', async () => {
    let prompt = '';
    const result = await repairReply('Готово. Вот что я сделал:\n- item 1\n- item 2\n- item 3\n- item 4', async (nextPrompt) => {
      prompt = nextPrompt;
      return 'Слышу. Исправляю.';
    });

    expect(prompt).toContain('banned-opener');
    expect(prompt).toContain('bullet-wall');
    expect(prompt).toContain('completion claim without proof');
    expect(result.retried).toBe(true);
    expect(result.firstPass.voice.passed).toBe(false);
    expect(result.firstPass.completion.passed).toBe(false);
    expect(result.retryPass?.voice.passed).toBe(true);
    expect(result.retryPass?.completion.passed).toBe(true);
    expect(result.reply).toBe('Слышу. Исправляю.');
  });

  it('threads current turn proof tokens into retry prompt', async () => {
    let prompt = '';
    await repairReply(
      'Готово. Всё починил.',
      async (nextPrompt) => {
        prompt = nextPrompt;
        return 'Слышу. Проверяю.';
      },
      {
        steps: [
          {
            toolCalls: [{ toolCallId: 'call-1', name: 'read-file' }],
            toolResults: [{ toolCallId: 'call-1', name: 'read-file' }],
          },
        ],
      },
    );

    expect(prompt).toContain('Current turn proof tokens:');
    expect(prompt).toContain('proof:call-1');
    expect(prompt).toContain('Мини-урок');
  });

  it('summarizes mixed gate failure', () => {
    const summary = summarizeReplyGate(validateReply('Готово. Вот что я сделал:\n- item 1'));
    expect(summary).toContain('voice=');
    expect(summary).toContain('completion=');
  });
});
