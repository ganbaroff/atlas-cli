import { describe, it, expect } from 'vitest';
import { modelFamily } from '../../research-swarm/model-family.js';

describe('research-swarm model-family', () => {
  it('maps nvidia llama to llama family', () => {
    expect(modelFamily('nvidia', 'meta/llama-3.3-70b-instruct')).toBe('llama');
  });

  it('maps anthropic to claude', () => {
    expect(modelFamily('anthropic', 'claude-sonnet-4-20250514')).toBe('claude');
  });

  it('maps gemini direct', () => {
    expect(modelFamily('gemini', 'gemini-2.5-flash')).toBe('gemini');
  });
});
