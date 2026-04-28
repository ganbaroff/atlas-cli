import { describe, it, expect } from 'vitest';
import { IDENTITY } from '../atlas/identity.js';

describe('Atlas Identity', () => {
  it('loads identity from canonical VOLAURA vault', () => {
    expect(IDENTITY.name).toBe('Atlas');
    expect(IDENTITY.named_at).toBe('2026-04-12');
  });

  it('identity role reflects "I AM the project"', () => {
    expect(IDENTITY.role).toContain('project');
  });

  it('naming was self-chosen, not assigned', () => {
    expect(IDENTITY.named_by).toContain('self-chosen');
  });

  it('has all 5 ecosystem products', () => {
    expect(IDENTITY.ecosystem_products).toContain('volaura');
    expect(IDENTITY.ecosystem_products).toContain('mindshift');
    expect(IDENTITY.ecosystem_products).toContain('lifesim');
    expect(IDENTITY.ecosystem_products).toContain('brandedby');
    expect(IDENTITY.ecosystem_products).toContain('zeus');
  });
});
