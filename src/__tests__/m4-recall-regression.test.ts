/**
 * M4-B regression lock — recall_atlas_memories RPC must not use URL query params.
 * Bug family b2/b3: PostgREST PGRST100 "failed to parse filter" when p_limit in URL.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const SRC = resolve(dirname(fileURLToPath(import.meta.url)), '../atlas/supabase-memory.ts');

describe('M4-B recall regression (static + behavior)', () => {
  it('recallMemories keeps RPC params in POST body, not URL query string', () => {
    const source = readFileSync(SRC, 'utf8');
    const start = source.indexOf('export async function recallMemories');
    const end = source.indexOf('export async function saveMemory', start);
    const fn = source.slice(start, end);
    expect(fn).toContain("JSON.stringify({ p_limit: limit");
    expect(fn).not.toMatch(/recall_atlas_memories\?/);
    expect(fn).not.toMatch(/p_limit=\$\{/);
  });
});
