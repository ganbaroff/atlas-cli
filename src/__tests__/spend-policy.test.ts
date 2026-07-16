import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

describe('spend policy (caps, paid flag, pause, queue cap)', () => {
  beforeEach(() => {
    vi.unstubAllEnvs();
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  it('paid providers refuse without ATLAS_ALLOW_PAID', async () => {
    vi.stubEnv('ATLAS_ALLOW_PAID', '');
    const { enforceSpendPolicy, SpendBlockedError } = await import('../atlas/spend-policy.js');
    expect(() => enforceSpendPolicy('anthropic', 'cli')).toThrow(SpendBlockedError);
    expect(() => enforceSpendPolicy('openai', 'cli')).toThrow(/ATLAS_ALLOW_PAID/);
    expect(() => enforceSpendPolicy('openrouter', 'cli')).toThrow();
  });

  it('paid providers allowed when ATLAS_ALLOW_PAID=1 and under cap', async () => {
    vi.stubEnv('ATLAS_ALLOW_PAID', '1');
    vi.stubEnv('ATLAS_DAILY_TOKEN_CAP', '500000');
    const { enforceSpendPolicy, resetBrainQueueCounter } = await import('../atlas/spend-policy.js');
    const { resetDailySpend } = await import('../atlas/spend-tracker.js');
    resetDailySpend();
    resetBrainQueueCounter();
    expect(() => enforceSpendPolicy('anthropic', 'cli')).not.toThrow();
  });

  it('free providers always allowed under cap', async () => {
    const { enforceSpendPolicy } = await import('../atlas/spend-policy.js');
    const { resetDailySpend } = await import('../atlas/spend-tracker.js');
    resetDailySpend();
    expect(() => enforceSpendPolicy('nvidia', 'telegram')).not.toThrow();
    expect(() => enforceSpendPolicy('groq', 'telegram')).not.toThrow();
  });

  it('over daily cap: free providers allowed (warn once), paid hard-blocked', async () => {
    vi.stubEnv('ATLAS_ALLOW_PAID', '1');
    vi.stubEnv('ATLAS_DAILY_TOKEN_CAP', '100');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { enforceSpendPolicy, SpendBlockedError } = await import('../atlas/spend-policy.js');
    const { recordSpend, resetDailySpend } = await import('../atlas/spend-tracker.js');
    resetDailySpend();
    // push over the 100-token cap
    recordSpend({ provider: 'nvidia', model: 'x', tokensIn: 200, tokensOut: 0, caller: 'cli' });
    // free provider still allowed, warns once
    expect(() => enforceSpendPolicy('nvidia', 'cli')).not.toThrow();
    expect(() => enforceSpendPolicy('groq', 'cli')).not.toThrow();
    expect(warn).toHaveBeenCalledTimes(1); // warn-once latch
    // paid provider hard-blocked even with ALLOW_PAID=1
    expect(() => enforceSpendPolicy('anthropic', 'cli')).toThrow(SpendBlockedError);
  });

  it('isPaused reflects ATLAS_PAUSE', async () => {
    // Point the pause-file at a guaranteed-absent path so this asserts the env var only.
    vi.stubEnv('ATLAS_PAUSE_FILE', join(tmpdir(), `atlas-no-pause-${process.pid}`));
    const mod = await import('../atlas/spend-policy.js');
    vi.stubEnv('ATLAS_PAUSE', '');
    expect(mod.isPaused()).toBe(false);
    vi.stubEnv('ATLAS_PAUSE', '1');
    expect(mod.isPaused()).toBe(true);
    vi.stubEnv('ATLAS_PAUSE', 'true');
    expect(mod.isPaused()).toBe(true);
  });

  it('isPaused reflects the desktop pause file (Phase 2 panic)', async () => {
    const pauseFile = join(tmpdir(), `atlas-pause-marker-${process.pid}`);
    try { rmSync(pauseFile); } catch { /* absent */ }
    vi.stubEnv('ATLAS_PAUSE', '');
    vi.stubEnv('ATLAS_PAUSE_FILE', pauseFile);
    const mod = await import('../atlas/spend-policy.js');
    expect(mod.isPaused()).toBe(false); // no file yet
    writeFileSync(pauseFile, 'paused', 'utf8');
    expect(mod.isPaused()).toBe(true); // file present → paused
    rmSync(pauseFile);
    expect(mod.isPaused()).toBe(false); // file gone → resumed
  });

  it('brain queue cap consumes N slots then refuses', async () => {
    vi.stubEnv('ATLAS_BRAIN_QUEUE_CAP', '3');
    const { tryConsumeBrainQueueSlot, getBrainQueueCount, resetBrainQueueCounter } =
      await import('../atlas/spend-policy.js');
    resetBrainQueueCounter();
    expect(tryConsumeBrainQueueSlot()).toBe(true);
    expect(tryConsumeBrainQueueSlot()).toBe(true);
    expect(tryConsumeBrainQueueSlot()).toBe(true);
    expect(getBrainQueueCount()).toBe(3);
    expect(tryConsumeBrainQueueSlot()).toBe(false); // over cap
    expect(getBrainQueueCount()).toBe(3);
  });

  it('cap defaults hold when env unset', async () => {
    vi.stubEnv('ATLAS_DAILY_TOKEN_CAP', '');
    vi.stubEnv('ATLAS_BRAIN_QUEUE_CAP', '');
    const { dailyTokenCap, brainQueueCap } = await import('../atlas/spend-policy.js');
    expect(dailyTokenCap()).toBe(500000);
    expect(brainQueueCap()).toBe(20);
  });
});
