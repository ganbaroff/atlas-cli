import { describe, it, expect } from 'vitest';
import { PERSPECTIVES, getPerspective, assignPerspectives } from '../atlas/perspectives.js';

describe('swarm perspectives', () => {
  it('loads at least 3 perspectives (defaults or config)', () => {
    expect(PERSPECTIVES.length).toBeGreaterThanOrEqual(3);
  });

  it('each perspective has non-empty name and instruction', () => {
    for (const p of PERSPECTIVES) {
      expect(p.name.length).toBeGreaterThan(0);
      expect(p.instruction.length).toBeGreaterThan(10);
    }
  });

  it('perspectives are behavioral instructions not persona descriptions', () => {
    for (const p of PERSPECTIVES) {
      expect(p.instruction).not.toMatch(/^You are/);
      expect(p.instruction).not.toMatch(/^I am/);
    }
  });

  it('getPerspective returns match by name', () => {
    const first = PERSPECTIVES[0];
    const found = getPerspective(first.name);
    expect(found).toBeDefined();
    expect(found!.name).toBe(first.name);
  });

  it('getPerspective returns undefined for unknown name', () => {
    expect(getPerspective('nonexistent')).toBeUndefined();
  });

  it('assignPerspectives limits to requested count', () => {
    const two = assignPerspectives(2);
    expect(two).toHaveLength(2);
    const all = assignPerspectives();
    expect(all).toHaveLength(PERSPECTIVES.length);
  });

  it('no duplicate perspective names', () => {
    const names = PERSPECTIVES.map(p => p.name);
    expect(new Set(names).size).toBe(names.length);
  });
});
