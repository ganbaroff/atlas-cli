/**
 * P0.4 — spend counter rehydrates from persisted receipts on restart.
 * Tests prove the daily counter survives a simulated process restart
 * and that yesterday's receipts do not leak into today's count.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { SpendReceipt } from '../atlas/spend-tracker.js';

describe('spend rehydrate on restart', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'atlas-spend-rehydrate-'));
    vi.stubEnv('ATLAS_SPEND_RECEIPT_DIR', dir);
    vi.stubEnv('SUPABASE_URL', '');
    vi.stubEnv('SUPABASE_SERVICE_ROLE_KEY', '');
    vi.resetModules();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    rmSync(dir, { recursive: true, force: true });
  });

  it('restart continuity: counter starts from persisted receipts, not zero', async () => {
    // Phase 1: record spend in a "first process"
    const mod1 = await import('../atlas/spend-tracker.js');
    mod1.resetDailySpend();
    mod1.recordSpend({
      provider: 'anthropic',
      model: 'sonnet',
      tokensIn: 1_000_000,
      tokensOut: 500_000,
      caller: 'test',
      correlationId: 'rehydrate-1',
    });

    const before = mod1.getDailySpend();
    expect(before.tokensIn).toBe(1_000_000);
    expect(before.tokensOut).toBe(500_000);
    expect(before.calls).toBe(1);

    // Phase 2: simulate process restart — clear module cache, reimport
    vi.resetModules();
    const mod2 = await import('../atlas/spend-tracker.js');

    // The counter should start from the persisted receipts, not zero
    const after = mod2.getDailySpend();
    expect(after.tokensIn).toBe(1_000_000);
    expect(after.tokensOut).toBe(500_000);
    expect(after.calls).toBe(1);
    expect(after.costUsd).toBeGreaterThan(0);
  });

  it('day boundary: yesterday receipts are NOT counted into today', async () => {
    // Write a receipt with yesterday's timestamp directly to the file
    const yesterday = new Date();
    yesterday.setUTCDate(yesterday.getUTCDate() - 1);

    const receipt: SpendReceipt = {
      ts: yesterday.toISOString(),
      correlationId: 'old-receipt',
      provider: 'anthropic',
      model: 'sonnet',
      tokensIn: 2_000_000,
      tokensOut: 1_000_000,
      estCostUsd: 21,
      caller: 'test',
    };

    mkdirSync(dir, { recursive: true });
    appendFileSync(join(dir, 'spend-receipts.jsonl'), JSON.stringify(receipt) + '\n', 'utf8');

    // Import fresh — should NOT pick up yesterday's receipt
    const mod = await import('../atlas/spend-tracker.js');
    const snap = mod.getDailySpend();
    expect(snap.tokensIn).toBe(0);
    expect(snap.tokensOut).toBe(0);
    expect(snap.calls).toBe(0);
    expect(snap.costUsd).toBe(0);
  });

  it('regression: same-process accounting still works after rehydration', async () => {
    // Pre-seed a receipt for today
    const todayReceipt: SpendReceipt = {
      ts: new Date().toISOString(),
      correlationId: 'seed-1',
      provider: 'nvidia',
      model: 'llama',
      tokensIn: 100,
      tokensOut: 50,
      estCostUsd: 0,
      caller: 'test',
    };
    mkdirSync(dir, { recursive: true });
    appendFileSync(join(dir, 'spend-receipts.jsonl'), JSON.stringify(todayReceipt) + '\n', 'utf8');

    const mod = await import('../atlas/spend-tracker.js');

    // Rehydrated state should include the seed
    const snapBefore = mod.getDailySpend();
    expect(snapBefore.tokensIn).toBe(100);
    expect(snapBefore.calls).toBe(1);

    // Now record a new call — should ADD to the rehydrated base
    mod.recordSpend({
      provider: 'nvidia',
      model: 'llama',
      tokensIn: 200,
      tokensOut: 100,
      caller: 'test',
      correlationId: 'new-1',
    });

    const snapAfter = mod.getDailySpend();
    expect(snapAfter.tokensIn).toBe(300);
    expect(snapAfter.tokensOut).toBe(150);
    expect(snapAfter.calls).toBe(2);
  });
});
