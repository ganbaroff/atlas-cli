/**
 * Supabase memory probe — formal DEGRADED_MEMORY on auth failure.
 */

import { isSupabaseConfigured } from '../atlas/supabase-memory.js';
import type { MemoryState } from './types.js';

export async function probeMemoryState(): Promise<MemoryState> {
  if (!isSupabaseConfigured()) return 'LOCAL_ONLY';

  try {
    const url = process.env['SUPABASE_URL'] ?? '';
    const key = process.env['SUPABASE_SERVICE_ROLE_KEY'] ?? '';
    const isLegacyJWT = key.startsWith('eyJ');
    const headers: Record<string, string> = {
      apikey: key,
      Accept: 'application/json',
    };
    if (isLegacyJWT) headers['Authorization'] = `Bearer ${key}`;

    const res = await fetch(`${url}/rest/v1/bot_heartbeats?select=id&limit=1`, { headers });
    if (res.status === 401 || res.status === 403) return 'DEGRADED_MEMORY';
    if (!res.ok) return 'DEGRADED_MEMORY';
    return 'OK';
  } catch {
    return 'DEGRADED_MEMORY';
  }
}
