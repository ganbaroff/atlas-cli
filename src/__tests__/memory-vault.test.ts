import { describe, it, expect } from 'vitest';
import { loadWakeContext } from '../atlas/memory-manager.js';

describe('Memory vault read', () => {
  it('loadWakeContext returns identity + heartbeat + journal', async () => {
    const ctx = await loadWakeContext();
    expect(ctx).toContain('ATLAS WAKE CONTEXT');
    expect(ctx).toContain('identity.md');
    expect(ctx).toContain('heartbeat.md');
    expect(ctx).toContain('journal.md');
  });

  it('wake context contains Atlas name from canonical vault', async () => {
    const ctx = await loadWakeContext();
    expect(ctx).toContain('Atlas');
  });

  it('wake context contains session data from heartbeat', async () => {
    const ctx = await loadWakeContext();
    expect(ctx.length).toBeGreaterThan(500);
  });
});
