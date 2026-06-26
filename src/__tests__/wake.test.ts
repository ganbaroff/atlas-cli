import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect } from 'vitest';
import { loadBrainContext, loadWakeContext } from '../atlas/memory-manager.js';
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

  it('loadBrainContext falls back to compiled BRAIN.md', async () => {
    const root = await mkdtemp(join(tmpdir(), 'atlas-memory-'));
    const previousRoot = process.env.MEMORY_ROOT;
    try {
      const atlas = join(root, 'memory', 'atlas');
      await mkdir(atlas, { recursive: true });
      await writeFile(join(atlas, 'BRAIN.md'), 'compiled-brain-context', 'utf-8');
      process.env.MEMORY_ROOT = root;

      const ctx = await loadBrainContext();
      expect(ctx).toContain('ATLAS BRAIN — COMPILED IDENTITY');
      expect(ctx).toContain('compiled-brain-context');
    } finally {
      if (previousRoot === undefined) {
        delete process.env.MEMORY_ROOT;
      } else {
        process.env.MEMORY_ROOT = previousRoot;
      }
      await rm(root, { recursive: true, force: true });
    }
  });
});
