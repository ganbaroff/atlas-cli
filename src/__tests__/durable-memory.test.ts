import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mkdir, writeFile } from 'node:fs/promises';

// Mirrors the real loadLatestHeartbeatDB/loadRecentJournalDB shape (supabase-memory.ts)
// so memory-manager.ts's DB-fallback path can be exercised without a real Supabase call.
const mockState = {
  configured: true,
  heartbeat: 'Updated (DB): 2026-07-09T12:00:00Z\nproviders: 3 | uptime_min: 42 | messages: 7 | chats: 2',
  journal: 'DB journal entry one\n---\nDB journal entry two',
};

vi.mock('../atlas/supabase-memory.js', () => ({
  isSupabaseConfigured: () => mockState.configured,
  loadLatestHeartbeatDB: async () => (mockState.configured ? mockState.heartbeat : null),
  loadRecentJournalDB: async () => (mockState.configured ? mockState.journal : ''),
}));

describe('durable prod memory: DB hydration on a wiped/redeployed local vault', () => {
  const originalMemoryRoot = process.env.MEMORY_ROOT;

  beforeEach(() => {
    vi.resetModules();
    mockState.configured = true;
    // Fresh, empty temp dir each test — simulates Railway's anonymous volume being
    // wiped on redeploy (local heartbeat.md/journal.md/*BRAIN.md are all missing).
    process.env.MEMORY_ROOT = join(tmpdir(), `atlas-durable-memory-test-${randomUUID()}`);
  });

  afterEach(() => {
    if (originalMemoryRoot === undefined) delete process.env.MEMORY_ROOT;
    else process.env.MEMORY_ROOT = originalMemoryRoot;
    vi.restoreAllMocks();
  });

  it('loadWakeContext hydrates heartbeat + journal from Supabase when the local vault is missing', async () => {
    const { loadWakeContext } = await import('../atlas/memory-manager.js');
    const ctx = await loadWakeContext();

    expect(ctx).toContain(mockState.heartbeat);
    expect(ctx).toContain(mockState.journal);
  });

  it('loadBrainContext appends a DB-hydrated RECENT STATE section when heartbeat/journal are missing but TELEGRAM-BRAIN.md exists', async () => {
    // TELEGRAM-BRAIN.md ships in the image/vault; heartbeat.md/journal.md are runtime
    // writes on the wiped anonymous volume — the realistic post-redeploy split.
    const atlasDir = join(process.env.MEMORY_ROOT!, 'memory', 'atlas');
    await mkdir(atlasDir, { recursive: true });
    await writeFile(join(atlasDir, 'TELEGRAM-BRAIN.md'), '# compressed identity\nstay sharp', 'utf-8');

    const { loadBrainContext } = await import('../atlas/memory-manager.js');
    const ctx = await loadBrainContext();

    expect(ctx).toContain('## ATLAS BRAIN — COMPRESSED IDENTITY');
    expect(ctx).toContain('## RECENT STATE (last session)');
    expect(ctx).toContain(mockState.heartbeat);
    expect(ctx).toContain(mockState.journal);
  });

  it('gracefully omits recent state when Supabase is not configured and the local vault is empty (never throws)', async () => {
    mockState.configured = false;

    const { loadWakeContext, loadBrainContext } = await import('../atlas/memory-manager.js');

    await expect(loadWakeContext()).resolves.not.toThrow();
    await expect(loadBrainContext()).resolves.not.toThrow();

    const wake = await loadWakeContext();
    expect(wake).toContain('[missing:'); // heartbeat.md fell through to the raw "missing" marker
    expect(wake).not.toContain(mockState.heartbeat);
    expect(wake).not.toContain(mockState.journal);

    const brain = await loadBrainContext();
    expect(brain).not.toContain('RECENT STATE');
  });
});
