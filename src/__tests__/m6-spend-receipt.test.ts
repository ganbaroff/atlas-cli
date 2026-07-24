/**
 * M6 — durable spend receipt: one local row per real call (fixture path).
 * Live Supabase DDL remains CEO-gated; local JSONL proves durability without it.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

describe('M6 spend durable receipt', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'atlas-spend-'));
    process.env.ATLAS_SPEND_RECEIPT_DIR = dir;
    vi.stubEnv('SUPABASE_URL', '');
    vi.stubEnv('SUPABASE_SERVICE_ROLE_KEY', '');
  });

  afterEach(() => {
    delete process.env.ATLAS_SPEND_RECEIPT_DIR;
    rmSync(dir, { recursive: true, force: true });
    vi.unstubAllEnvs();
  });

  it('each recordSpend call appends exactly one durable receipt', async () => {
    const { recordSpend, readSpendReceipts, resetDailySpend } = await import('../atlas/spend-tracker.js');
    resetDailySpend();
    recordSpend({
      provider: 'nvidia',
      model: 'llama',
      tokensIn: 10,
      tokensOut: 5,
      caller: 'fixture',
      correlationId: 'corr-1',
    });
    recordSpend({
      provider: 'groq',
      model: 'llama',
      tokensIn: 20,
      tokensOut: 8,
      caller: 'fixture',
      correlationId: 'corr-2',
    });
    const receipts = readSpendReceipts();
    expect(receipts).toHaveLength(2);
    expect(receipts[0]?.correlationId).toBe('corr-1');
    expect(receipts[1]?.correlationId).toBe('corr-2');
    expect(receipts[0]?.provider).toBe('nvidia');
    expect(receipts[1]?.tokensIn).toBe(20);
  });
});
