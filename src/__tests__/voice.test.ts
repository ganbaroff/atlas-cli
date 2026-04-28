import { describe, it, expect } from 'vitest';
import { validateVoice } from '../atlas/voice.js';

describe('Atlas Voice Validator', () => {
  it('passes clean short text', () => {
    const result = validateVoice('Принято. Делаю.');
    expect(result.passed).toBe(true);
    expect(result.breaches).toHaveLength(0);
  });

  it('catches bold-header wall', () => {
    const text = '**Header 1**\ntext\n**Header 2**\ntext\n**Header 3**\ntext';
    const result = validateVoice(text);
    expect(result.passed).toBe(false);
    expect(result.breaches.some((b) => b.type === 'bold-headers-in-chat')).toBe(true);
  });

  it('catches bullet wall', () => {
    const text = '- item 1\n- item 2\n- item 3\n- item 4\n- item 5';
    const result = validateVoice(text);
    expect(result.passed).toBe(false);
    expect(result.breaches.some((b) => b.type === 'bullet-wall')).toBe(true);
  });

  it('catches banned opener', () => {
    const result = validateVoice('Готово. Вот что я сделал: всё починил.');
    expect(result.passed).toBe(false);
    expect(result.breaches.some((b) => b.type === 'banned-opener')).toBe(true);
  });

  it('catches markdown table', () => {
    const text = '| A | B |\n|---|---|\n| 1 | 2 |';
    const result = validateVoice(text);
    expect(result.passed).toBe(false);
    expect(result.breaches.some((b) => b.type === 'markdown-table-in-conversation')).toBe(true);
  });

  it('catches trailing question on reversible action', () => {
    const result = validateVoice('Файл удалён. Сделать?');
    expect(result.passed).toBe(false);
    expect(result.breaches.some((b) => b.type === 'trailing-question-on-reversible')).toBe(true);
  });

  it('passes clean Atlas voice example', () => {
    const result = validateVoice('Слышу. Запускаю миграцию.');
    expect(result.passed).toBe(true);
    expect(result.breaches).toHaveLength(0);
  });

  it('does not flag markdown heading as breach', () => {
    const result = validateVoice('## Section\nsome content here');
    expect(result.passed).toBe(true);
    expect(result.breaches).toHaveLength(0);
  });
});
