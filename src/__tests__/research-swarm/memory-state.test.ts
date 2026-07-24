import { describe, it, expect, vi, beforeEach } from 'vitest';
import { probeMemoryState } from '../../research-swarm/memory-state.js';

describe('research-swarm memory-state', () => {
  beforeEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it('returns LOCAL_ONLY when Supabase not configured', async () => {
    vi.stubEnv('SUPABASE_URL', '');
    vi.stubEnv('SUPABASE_SERVICE_ROLE_KEY', '');
    expect(await probeMemoryState()).toBe('LOCAL_ONLY');
  });

  it('returns DEGRADED_MEMORY on Supabase 401', async () => {
    vi.stubEnv('SUPABASE_URL', 'https://example.supabase.co');
    vi.stubEnv('SUPABASE_SERVICE_ROLE_KEY', 'sb_secret_test');
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 401 })));
    expect(await probeMemoryState()).toBe('DEGRADED_MEMORY');
  });

  it('returns OK on successful Supabase probe', async () => {
    vi.stubEnv('SUPABASE_URL', 'https://example.supabase.co');
    vi.stubEnv('SUPABASE_SERVICE_ROLE_KEY', 'sb_secret_test');
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, status: 200 })));
    expect(await probeMemoryState()).toBe('OK');
  });
});
