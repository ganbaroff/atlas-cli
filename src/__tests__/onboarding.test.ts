import { describe, it, expect } from 'vitest';
import { classifyStart, coldStartMessages } from '../atlas/onboarding.js';

describe('classifyStart', () => {
  it('known when chat matches the CEO chat id', () => {
    expect(classifyStart({ chatId: 42, ceoChatId: '42' })).toBe('known');
    expect(classifyStart({ chatId: 42, ceoChatId: ' 42 ' })).toBe('known');
  });

  it('quiz when the deep-link payload is quiz (preserves funnel)', () => {
    expect(classifyStart({ chatId: 99, ceoChatId: '42', payload: 'quiz' })).toBe('quiz');
    expect(classifyStart({ chatId: 99, payload: 'QUIZ' })).toBe('quiz');
  });

  it('cold for an unknown user with no payload', () => {
    expect(classifyStart({ chatId: 99, ceoChatId: '42' })).toBe('cold');
    expect(classifyStart({ chatId: 99 })).toBe('cold');
  });
});

describe('coldStartMessages', () => {
  it('is at most two messages', () => {
    const msgs = coldStartMessages();
    expect(msgs).toHaveLength(2);
  });

  it('first says who Atlas is and what it can do; second is the next action', () => {
    const [intro, action] = coldStartMessages();
    expect(intro).toContain('Атлас');
    expect(intro.length).toBeGreaterThan(0);
    expect(action).toContain('/help');
    // no bullet walls in either
    expect(intro).not.toContain('\n- ');
    expect(action).not.toContain('\n- ');
  });
});
