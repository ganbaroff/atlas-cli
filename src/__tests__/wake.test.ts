import { describe, it, expect, vi } from 'vitest';
import { loadWakeContext } from '../atlas/memory-manager.js';
import { IDENTITY } from '../atlas/identity.js';

describe('wake command prerequisites', () => {
  it('IDENTITY is always available (inline fallback)', () => {
    expect(IDENTITY.name).toBe('Atlas');
    expect(IDENTITY.role).toContain('project');
    expect(IDENTITY.ecosystem_products.length).toBeGreaterThan(0);
  });

  it('loadWakeContext returns structured sections', async () => {
    const ctx = await loadWakeContext();
    // Must contain all wake protocol sections
    expect(ctx).toContain('identity.md');
    expect(ctx).toContain('heartbeat.md');
    expect(ctx).toContain('journal.md');
    expect(ctx).toContain('relationships.md');
    expect(ctx).toContain('lessons.md');
  });

  it('wake context contains heartbeat section with parseable format', async () => {
    const ctx = await loadWakeContext();
    const hbMatch = ctx.match(/### heartbeat\.md[\s\S]*?(?=###|$)/);
    expect(hbMatch).not.toBeNull();
  });

  it('wake context contains journal section', async () => {
    const ctx = await loadWakeContext();
    const jMatch = ctx.match(/### journal\.md[\s\S]*$/);
    expect(jMatch).not.toBeNull();
  });

  it('wake context contains debts and vision sections', async () => {
    const ctx = await loadWakeContext();
    expect(ctx).toContain('atlas-debts-to-ceo.md');
    expect(ctx).toContain('project_v0laura_vision.md');
  });
});
