import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

describe('spend tracker', () => {
  let receiptDir: string;

  beforeEach(() => {
    vi.unstubAllEnvs();
    receiptDir = mkdtempSync(join(tmpdir(), 'atlas-spend-tracker-'));
    vi.stubEnv('ATLAS_SPEND_RECEIPT_DIR', receiptDir);
    vi.stubEnv('ATLAS_STATE_ROOT_REQUIRED', '0');
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    rmSync(receiptDir, { recursive: true, force: true });
  });

  it('free providers cost zero', async () => {
    const { estimateCostUsd } = await import('../atlas/spend-tracker.js');
    expect(estimateCostUsd('nvidia', 1_000_000, 1_000_000)).toBe(0);
    expect(estimateCostUsd('ollama', 5_000_000, 5_000_000)).toBe(0);
    expect(estimateCostUsd('groq', 1_000, 1_000)).toBe(0);
    expect(estimateCostUsd('freellmapi', 1_000, 1_000)).toBe(0);
  });

  it('paid providers estimate from the price map', async () => {
    const { estimateCostUsd } = await import('../atlas/spend-tracker.js');
    // anthropic: $3/1M in, $15/1M out
    expect(estimateCostUsd('anthropic', 1_000_000, 1_000_000)).toBeCloseTo(18, 6);
    // openai gpt-4o-mini class: $0.15 in, $0.6 out
    expect(estimateCostUsd('openai', 1_000_000, 0)).toBeCloseTo(0.15, 6);
  });

  it('unknown provider defaults to zero cost', async () => {
    const { estimateCostUsd } = await import('../atlas/spend-tracker.js');
    expect(estimateCostUsd('some-new-provider', 9_000_000, 9_000_000)).toBe(0);
  });

  it('accumulates the in-memory daily counter', async () => {
    vi.stubEnv('SUPABASE_URL', '');
    vi.stubEnv('SUPABASE_SERVICE_ROLE_KEY', '');
    const { recordSpend, getDailySpend, getDailyTokenTotal, resetDailySpend } =
      await import('../atlas/spend-tracker.js');
    resetDailySpend();
    recordSpend({ provider: 'nvidia', model: 'llama', tokensIn: 100, tokensOut: 50, caller: 'cli' });
    recordSpend({ provider: 'anthropic', model: 'sonnet', tokensIn: 1_000_000, tokensOut: 0, caller: 'telegram' });
    const snap = getDailySpend();
    expect(snap.calls).toBe(2);
    expect(snap.tokensIn).toBe(1_000_100);
    expect(snap.tokensOut).toBe(50);
    expect(getDailyTokenTotal()).toBe(1_000_150);
    // only anthropic input costs: $3
    expect(snap.costUsd).toBeCloseTo(3, 6);
  });

  it('writes an llm_spend row to Supabase when configured (mocked fetch)', async () => {
    vi.stubEnv('SUPABASE_URL', 'https://example.supabase.co');
    vi.stubEnv('SUPABASE_SERVICE_ROLE_KEY', 'sb_secret_test');
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      text: async () => '',
    } as Response);

    const { recordSpend, resetDailySpend } = await import('../atlas/spend-tracker.js');
    resetDailySpend();
    recordSpend({ provider: 'openai', model: 'gpt-4o-mini', tokensIn: 200, tokensOut: 100, caller: 'swarm' });

    // fire-and-forget insert — let the microtask flush
    await new Promise((r) => setTimeout(r, 0));

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, options] = fetchMock.mock.calls[0]!;
    expect(String(url)).toContain('/rest/v1/llm_spend');
    expect((options as RequestInit)?.method).toBe('POST');
    const body = JSON.parse(String((options as RequestInit)?.body));
    expect(body.provider).toBe('openai');
    expect(body.tokens_in).toBe(200);
    expect(body.tokens_out).toBe(100);
    expect(body.caller).toBe('swarm');
    expect(body.est_cost_usd).toBeGreaterThan(0);
    // secret never leaks into the payload
    expect(String((options as RequestInit)?.body)).not.toContain('sb_secret_test');
  });

  it('does not throw when Supabase write rejects (non-blocking)', async () => {
    vi.stubEnv('SUPABASE_URL', 'https://example.supabase.co');
    vi.stubEnv('SUPABASE_SERVICE_ROLE_KEY', 'sb_secret_test');
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('network down'));
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { recordSpend, resetDailySpend } = await import('../atlas/spend-tracker.js');
    resetDailySpend();
    expect(() =>
      recordSpend({ provider: 'anthropic', model: 'sonnet', tokensIn: 10, tokensOut: 10, caller: 'cli' }),
    ).not.toThrow();
    await new Promise((r) => setTimeout(r, 0));
    expect(errSpy).toHaveBeenCalled();
  });

  it('does not throw when the local receipt path has an ordinary IO failure', async () => {
    const blockedPath = join(receiptDir, 'not-a-directory');
    writeFileSync(blockedPath, 'fixture', 'utf8');
    vi.stubEnv('ATLAS_SPEND_RECEIPT_DIR', blockedPath);
    vi.stubEnv('SUPABASE_URL', '');
    vi.stubEnv('SUPABASE_SERVICE_ROLE_KEY', '');
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { getDailySpend, recordSpend, resetDailySpend } =
      await import('../atlas/spend-tracker.js');
    resetDailySpend();

    expect(() => recordSpend({
      provider: 'nvidia',
      model: 'llama',
      tokensIn: 10,
      tokensOut: 5,
      caller: 'cli',
      correlationId: 'ordinary-io-failure',
    })).not.toThrow();
    expect(getDailySpend().calls).toBe(1);
    expect(errSpy).toHaveBeenCalledWith(
      '[spend] local receipt path failed:',
      expect.any(String),
    );
  });

  it('recordSpendFromResult reads AI-SDK usage shapes', async () => {
    vi.stubEnv('SUPABASE_URL', '');
    vi.stubEnv('SUPABASE_SERVICE_ROLE_KEY', '');
    const { recordSpendFromResult, getDailySpend, resetDailySpend } =
      await import('../atlas/spend-tracker.js');
    resetDailySpend();
    recordSpendFromResult(
      { usage: { inputTokens: 12, outputTokens: 8 } },
      { provider: 'nvidia', model: 'llama', caller: 'cli' },
    );
    recordSpendFromResult(
      { usage: { promptTokens: 3, completionTokens: 4 } },
      { provider: 'nvidia', model: 'llama', caller: 'cli' },
    );
    const snap = getDailySpend();
    expect(snap.tokensIn).toBe(15);
    expect(snap.tokensOut).toBe(12);
  });
});
