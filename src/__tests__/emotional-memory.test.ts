import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { decayScore } from '../atlas/decay-score.js';
import { analyzeWindow } from '../atlas/emotion.js';

describe('emotional-memory: decay formula (SQL mirror)', () => {
  // decay_score = emotional_intensity * exp(-age_days / (7 * decay_multiplier))
  const mult = (intensity: number) => 1.0 + intensity * 2.0;

  it('ranks high-intensity recent ABOVE low-intensity old', () => {
    const highRecent = decayScore({ emotionalIntensity: 5, decayMultiplier: mult(5), ageDays: 3 });
    const lowOld = decayScore({ emotionalIntensity: 1, decayMultiplier: mult(1), ageDays: 40 });
    expect(highRecent).toBeGreaterThan(lowOld);
  });

  it('high-emotion decays SLOWER: at equal age, high-intensity keeps more score', () => {
    // Normalize by peak intensity so we compare RETAINED fraction, not raw magnitude.
    const age = 30;
    const highRetained = decayScore({ emotionalIntensity: 5, decayMultiplier: mult(5), ageDays: age }) / 5;
    const lowRetained = decayScore({ emotionalIntensity: 1, decayMultiplier: mult(1), ageDays: age }) / 1;
    expect(highRetained).toBeGreaterThan(lowRetained);
  });

  it('zero-emotion memory scores 0 regardless of recency (trivia never wins recall)', () => {
    expect(decayScore({ emotionalIntensity: 0, decayMultiplier: 1, ageDays: 0 })).toBe(0);
  });

  it('score decreases monotonically with age for a fixed memory', () => {
    const fresh = decayScore({ emotionalIntensity: 3, decayMultiplier: mult(3), ageDays: 1 });
    const stale = decayScore({ emotionalIntensity: 3, decayMultiplier: mult(3), ageDays: 60 });
    expect(fresh).toBeGreaterThan(stale);
  });
});

describe('emotional-memory: write path uses the REAL computed intensity', () => {
  beforeEach(() => {
    vi.unstubAllEnvs();
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it('saveEmotionalMemory passes the intensity from emotion.analyzeWindow, not a constant', async () => {
    vi.resetModules();
    vi.stubEnv('SUPABASE_URL', 'https://example.supabase.co');
    vi.stubEnv('SUPABASE_SERVICE_ROLE_KEY', 'sb_secret_test');
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      text: async () => '',
    } as Response);

    // A strongly corrective message → real ZenBrain read, high intensity.
    const message = 'блять опять проебал нахуя';
    const read = analyzeWindow([message]);
    expect(read.intensity).toBeGreaterThanOrEqual(2);

    const { saveEmotionalMemory } = await import('../atlas/supabase-memory.js');
    const saved = await saveEmotionalMemory({
      category: `ceo_turn:${read.state}`,
      content: message,
      intensity: read.intensity,
      decayMultiplier: read.decayMultiplier,
    });

    expect(saved).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, options] = fetchMock.mock.calls[0]!;
    expect(String(url)).toContain('/rest/v1/atlas_learnings');
    const body = JSON.parse(String(options?.body));
    // The persisted intensity MUST equal the real emotion read for this input.
    expect(body.emotional_intensity).toBe(read.intensity);
    expect(body.decay_multiplier).toBe(read.decayMultiplier);
    // And it must not leak the service key.
    expect(String(options?.body)).not.toContain('sb_secret_test');
  });

  it('below-threshold exchanges are NOT saved (no fetch)', async () => {
    vi.resetModules();
    vi.stubEnv('SUPABASE_URL', 'https://example.supabase.co');
    vi.stubEnv('SUPABASE_SERVICE_ROLE_KEY', 'sb_secret_test');
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      text: async () => '',
    } as Response);

    // A neutral "ок" → intensity below the gate.
    const read = analyzeWindow(['ок']);
    const { saveEmotionalMemory, EMOTIONAL_MEMORY_MIN_INTENSITY } = await import('../atlas/supabase-memory.js');
    expect(read.intensity).toBeLessThan(EMOTIONAL_MEMORY_MIN_INTENSITY);

    const saved = await saveEmotionalMemory({
      category: `ceo_turn:${read.state}`,
      content: 'ок',
      intensity: read.intensity,
      decayMultiplier: read.decayMultiplier,
    });

    expect(saved).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('save failure never throws (returns false, reply path is safe)', async () => {
    vi.resetModules();
    vi.stubEnv('SUPABASE_URL', 'https://example.supabase.co');
    vi.stubEnv('SUPABASE_SERVICE_ROLE_KEY', 'sb_secret_test');
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('network down'));

    const { saveEmotionalMemory } = await import('../atlas/supabase-memory.js');
    // Use a fresh content string so dedup doesn't short-circuit before the fetch.
    const saved = await saveEmotionalMemory({
      category: 'ceo_turn:correcting',
      content: `failure-path-${Date.now()}`,
      intensity: 4,
      decayMultiplier: 9,
    });

    expect(saved).toBe(false); // failed, but did NOT throw
  });
});
