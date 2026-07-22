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
        { category: 'project', content: 'test memory', emotional_intensity: 3, decay_score: 2.5 },
      ]),
    } as unknown as Response);

    const { recallMemories } = await import('../atlas/supabase-memory.js');
    const results = await recallMemories(5, 'project');

    expect(fetchMock).toHaveBeenCalledTimes(1);
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
});
