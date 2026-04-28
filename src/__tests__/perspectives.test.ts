import { describe, it, expect } from 'vitest';
import { PERSPECTIVES, getPerspective, assignPerspectives } from '../atlas/perspectives.js';

describe('swarm perspectives', () => {
  it('has exactly 5 named perspectives', () => {
    expect(PERSPECTIVES).toHaveLength(5);
    const names = PERSPECTIVES.map(p => p.name);
    expect(names).toContain('architect');
    expect(names).toContain('pragmatist');
    expect(names).toContain('qa');
    expect(names).toContain('devils_advocate');
    expect(names).toContain('security');
  });

  it('each perspective has non-empty instruction', () => {
    for (const p of PERSPECTIVES) {
      expect(p.instruction.length).toBeGreaterThan(20);
    }
  });

  it('perspectives are behavioral instructions not persona descriptions', () => {
    for (const p of PERSPECTIVES) {
      expect(p.instruction).not.toMatch(/^You are/);
      expect(p.instruction).not.toMatch(/^I am/);
    }
  });

  it('getPerspective returns correct perspective by name', () => {
    const qa = getPerspective('qa');
    expect(qa).toBeDefined();
    expect(qa!.instruction).toContain('breaks');
  });

  it('getPerspective returns undefined for unknown name', () => {
    expect(getPerspective('nonexistent')).toBeUndefined();
  });

  it('assignPerspectives limits to requested count', () => {
    const three = assignPerspectives(3);
    expect(three).toHaveLength(3);
    const all = assignPerspectives();
    expect(all).toHaveLength(5);
  });

  it('each perspective has a provider assigned for model diversity', () => {
    for (const p of PERSPECTIVES) {
      expect(p.provider).toBeTruthy();
      expect(typeof p.provider).toBe('string');
    }
  });

  it('perspectives use at least 2 different providers', () => {
    const providers = new Set(PERSPECTIVES.map(p => p.provider));
    expect(providers.size).toBeGreaterThanOrEqual(2);
  });
});
