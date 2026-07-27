import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

describe('supabase memory adapter', () => {
  beforeEach(() => {
    vi.unstubAllEnvs();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  it('reads Supabase env lazily after module import', async () => {
    const { isSupabaseConfigured } = await import('../atlas/supabase-memory.js');
    vi.stubEnv('SUPABASE_URL', '');
    vi.stubEnv('SUPABASE_SERVICE_ROLE_KEY', '');
    expect(isSupabaseConfigured()).toBe(false);

    vi.stubEnv('SUPABASE_URL', 'https://example.supabase.co');
    vi.stubEnv('SUPABASE_SERVICE_ROLE_KEY', 'sb_secret_test');
    expect(isSupabaseConfigured()).toBe(true);
  });

  it('regression: claimNextCommand returns null (not the empty array itself) when the queue has nothing to claim', async () => {
    // Live bug found 2026-07-27: the RPC returns [] when nothing is
    // claimable; the old `rows?.[0] ?? rows ?? null` fell through to
    // `?? rows`, returning the empty array AS the "claimed command" — and
    // `![]` is false in JS, so callers' idle-check never fired, treating
    // an empty queue as a claimed row with undefined id/command.
    vi.stubEnv('SUPABASE_URL', 'https://example.supabase.co');
    vi.stubEnv('SUPABASE_SERVICE_ROLE_KEY', 'sb_secret_test');
    vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      text: async () => '[]',
      json: async () => [],
    } as Response);

    const { claimNextCommand } = await import('../atlas/supabase-memory.js');
    const result = await claimNextCommand('test-worker');

    expect(result).toBeNull();
  });

  it('claimNextCommand returns the claimed row when the RPC has real work', async () => {
    vi.stubEnv('SUPABASE_URL', 'https://example.supabase.co');
    vi.stubEnv('SUPABASE_SERVICE_ROLE_KEY', 'sb_secret_test');
    const row = { id: 'cmd-1', command: 'check disk space', payload: null, chat_id: 123, priority: 0 };
    vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      text: async () => JSON.stringify([row]),
      json: async () => [row],
    } as Response);

    const { claimNextCommand } = await import('../atlas/supabase-memory.js');
    const result = await claimNextCommand('test-worker');

    expect(result).toEqual(row);
  });

  it('writes journal and episode entries to atlas_learnings without exposing secrets', async () => {
    vi.stubEnv('SUPABASE_URL', 'https://example.supabase.co');
    vi.stubEnv('SUPABASE_SERVICE_ROLE_KEY', 'sb_secret_test');
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      text: async () => '',
    } as Response);

    const { writeJournalDB, writeEpisodeDB } = await import('../atlas/supabase-memory.js');
    await writeJournalDB('journal entry', 'test-source');
    await writeEpisodeDB({ type: 'test-episode' }, 'test-source');

    expect(fetchMock).toHaveBeenCalledTimes(2);
    const [journalUrl, journalOptions] = fetchMock.mock.calls[0]!;
    expect(String(journalUrl)).toContain('/rest/v1/atlas_learnings');
    const journalBody = String(journalOptions?.body);
    expect(JSON.parse(journalBody).content).toContain('[journal:test-source]');
    expect(journalBody).not.toContain('sb_secret_test');
  });

  it('loadRecentJournalDB uses valid PostgREST filter (no bare bracket → no PGRST100)', async () => {
    vi.stubEnv('SUPABASE_URL', 'https://example.supabase.co');
    vi.stubEnv('SUPABASE_SERVICE_ROLE_KEY', 'sb_secret_test');
    const journalRows = [{ content: '[journal:src]\nentry one', created_at: '2026-07-22T00:00:00Z' }];
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      text: async () => JSON.stringify(journalRows),
    } as unknown as Response);

    const { loadRecentJournalDB } = await import('../atlas/supabase-memory.js');
    const result = await loadRecentJournalDB(3);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const url = String(fetchMock.mock.calls[0]![0]);
    // PostgREST chokes on bare '[' — must be URL-encoded %5B
    expect(url).not.toMatch(/like\.\[/);
    expect(url).toContain('like.%5Bjournal:');
    // Verify it actually parsed the journal content
    expect(result).toBe('entry one');
  });

  it('recallMemories sends p_limit only in POST body, not as URL query param (no PGRST filter parse error)', async () => {
    vi.stubEnv('SUPABASE_URL', 'https://example.supabase.co');
    vi.stubEnv('SUPABASE_SERVICE_ROLE_KEY', 'sb_secret_test');
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      text: async () => JSON.stringify([
        { id: 'uuid-x', category: 'project', content: 'test memory', emotional_intensity: 3, decay_multiplier: 7, created_at: '2026-01-01T00:00:00Z', decay_score: 2.5 },
      ]),
    } as unknown as Response);

    const { recallMemories } = await import('../atlas/supabase-memory.js');
    const results = await recallMemories(5, 'project');
    // Let fire-and-forget write-back settle
    await new Promise(resolve => setTimeout(resolve, 10));

    // First call must be the RPC
    const [url, options] = fetchMock.mock.calls[0]!;
    const urlStr = String(url);

    // URL must NOT contain p_limit as a query param — PostgREST interprets it as a row filter
    expect(urlStr).not.toMatch(/[?&]p_limit=/);
    expect(urlStr).not.toMatch(/[?&]p_category=/);
    expect(urlStr).toContain('rpc/recall_atlas_memories');

    // POST body must contain the RPC parameters
    const body = JSON.parse(String(options?.body));
    expect(body.p_limit).toBe(5);
    expect(body.p_category).toBe('project');

    // Verify response parsing
    expect(results).toHaveLength(1);
    expect(results[0].category).toBe('project');
  });

  // ── recallMemories write-back (Phase 5A-iii) ───────────────────────────────

  it('recallMemories fires bump_recall_count write-back with recalled ids', async () => {
    vi.stubEnv('SUPABASE_URL', 'https://example.supabase.co');
    vi.stubEnv('SUPABASE_SERVICE_ROLE_KEY', 'sb_secret_test');

    const recalledRows = [
      { id: 'uuid-1', category: 'project', content: 'mem1', emotional_intensity: 3, decay_multiplier: 7, created_at: '2026-01-01T00:00:00Z', decay_score: 2.5 },
      { id: 'uuid-2', category: 'project', content: 'mem2', emotional_intensity: 2, decay_multiplier: 5, created_at: '2026-01-02T00:00:00Z', decay_score: 1.5 },
    ];

    let callIndex = 0;
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
      callIndex++;
      return {
        ok: true,
        text: async () => (callIndex === 1 ? JSON.stringify(recalledRows) : ''),
      } as Response;
    });

    const { recallMemories } = await import('../atlas/supabase-memory.js');
    const result = await recallMemories(2);
    // Allow the fire-and-forget write-back to settle
    await new Promise(resolve => setTimeout(resolve, 10));

    // Return value: mapped fields only, no raw db fields
    expect(result).toHaveLength(2);
    expect(result[0]).toEqual({ category: 'project', content: 'mem1', emotional_intensity: 3, decay_score: 2.5 });

    // Write-back call must have been made
    expect(fetchMock.mock.calls.length).toBeGreaterThanOrEqual(2);
    const writebackCall = fetchMock.mock.calls.find(([u]) => String(u).includes('rpc/bump_recall_count'));
    expect(writebackCall).toBeDefined();
    const writeBody = JSON.parse(String(writebackCall![1]?.body));
    expect(writeBody.p_ids).toContain('uuid-1');
    expect(writeBody.p_ids).toContain('uuid-2');
  });

  it('recallMemories swallows write-back failure without throwing', async () => {
    vi.stubEnv('SUPABASE_URL', 'https://example.supabase.co');
    vi.stubEnv('SUPABASE_SERVICE_ROLE_KEY', 'sb_secret_test');

    const recalledRows = [
      { id: 'uuid-3', category: 'project', content: 'mem3', emotional_intensity: 4, decay_multiplier: 9, created_at: '2026-01-01T00:00:00Z', decay_score: 3.0 },
    ];

    let callIndex = 0;
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
      callIndex++;
      if (callIndex === 1) {
        return { ok: true, text: async () => JSON.stringify(recalledRows) } as Response;
      }
      // Simulate write-back failure
      return { ok: false, text: async () => 'server error', status: 500 } as unknown as Response;
    });

    const { recallMemories } = await import('../atlas/supabase-memory.js');
    // Must not throw even when write-back fails
    await expect(recallMemories(1)).resolves.toHaveLength(1);
    // Let the rejection settle (swallowed by .catch)
    await new Promise(resolve => setTimeout(resolve, 10));
  });
});
