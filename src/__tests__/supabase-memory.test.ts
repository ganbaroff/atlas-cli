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
});
