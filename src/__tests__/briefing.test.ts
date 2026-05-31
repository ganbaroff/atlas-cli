import { describe, it, expect } from 'vitest';
import { BRIEFING_TEMPLATE } from '../atlas/briefing.js';

describe('Atlas briefing template', () => {
  it('states CEO, control surface, and quality gates', () => {
    expect(BRIEFING_TEMPLATE).toContain('Yusif Ganbarov');
    expect(BRIEFING_TEMPLATE).toContain('ANUS is control surface');
    expect(BRIEFING_TEMPLATE).toContain('consult swarm');
    expect(BRIEFING_TEMPLATE).toContain('Error classes');
  });
});
