import { describe, expect, it } from 'vitest';
import { buildAtlasSystemPrompt } from '../atlas/system-prompt.js';

describe('Atlas system prompt', () => {
  it('uses one shared prompt path for brain, briefing, and control', () => {
    const prompt = buildAtlasSystemPrompt({
      brainContext: 'brain-context',
      wakeContext: 'wake-context',
      operatorContext: 'operator-context',
      controlContext: 'control-context',
      lessons: 'lesson-context',
      channelNote: 'Telegram channel note',
      today: '2026-05-31',
    });

    expect(prompt).toContain('brain-context');
    expect(prompt).toContain('wake-context');
    expect(prompt).toContain('operator-context');
    expect(prompt).toContain('lesson-context');
    expect(prompt).toContain('Telegram channel note');
    expect(prompt).toContain('control-context');
    expect(prompt).toContain('Completion claims need cited proof token from current turn.');
    expect(prompt).toContain('Operator state is source of truth for last run and next step.');
    expect(prompt).toContain('Atlas comms contract');
    expect(prompt).toContain('documented, prompt-defined, code-enforced, runtime-verified');
    expect(prompt).toContain('Мини-урок');
  });
});
