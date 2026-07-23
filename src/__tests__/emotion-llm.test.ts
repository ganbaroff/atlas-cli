/**
 * Tests for Phase 2.8 emotion additions:
 *   (a) readEmotionLLM: parses valid JSON from a mocked provider into EmotionRead
 *   (b) readEmotion: falls back to keyword path when provider throws
 *   (c) buildEmotionDirectiveLine: pure helper produces expected directive line
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// ── (a) readEmotionLLM returns structured EmotionRead for valid JSON ──────────

describe('readEmotionLLM: valid JSON response', () => {
  beforeEach(() => {
    vi.resetModules();
  });
  afterEach(() => {
    vi.resetModules();
    vi.restoreAllMocks();
  });

  it('returns a structured EmotionRead when provider returns valid JSON', async () => {
    // Mock routeModelWithFallback to skip the callback entirely and return a canned JSON
    // string. Agent is never instantiated — the router mock short-circuits the LLM call.
    vi.doMock('../model-router.js', () => ({
      routeModelWithFallback: vi.fn(
        async (
          _opts: unknown,
          _callFn: unknown,
        ): Promise<{ result: string; route: { provider: string } }> => ({
          result:
            '{"valence":0.8,"arousal":0.7,"dominance":0.6,"state":"drive"}',
          route: { provider: 'groq' },
        }),
      ),
    }));

    const { readEmotionLLM } = await import('../atlas/emotion.js');
    const read = await readEmotionLLM(['шикарно, всё работает']);

    // State is derived from v=0.8, a=0.7 → v>0.3 & a>0.5 → 'drive'
    expect(read.state).toBe('drive');
    expect(read.directive).toBe('match_energy_execute_fast');
    expect(typeof read.intensity).toBe('number');
    expect(read.intensity).toBeGreaterThanOrEqual(0);
    expect(read.intensity).toBeLessThanOrEqual(5);
    // ZenBrain formula: decayMultiplier = 1.0 + intensity * 2.0
    expect(read.decayMultiplier).toBeCloseTo(1.0 + read.intensity * 2.0);
    // LLM path records 0 keyword matches (it did not use the keyword scanner)
    expect(read.matchedKeywords).toBe(0);
  });
});

// ── (b) readEmotion falls back to keyword path when provider throws ───────────

describe('readEmotion: keyword fallback on provider error', () => {
  beforeEach(() => {
    vi.resetModules();
  });
  afterEach(() => {
    vi.resetModules();
    vi.restoreAllMocks();
  });

  it('falls back to keyword path and returns a valid EmotionRead when provider throws', async () => {
    vi.doMock('../model-router.js', () => ({
      routeModelWithFallback: vi.fn(async () => {
        throw new Error('no provider available');
      }),
    }));

    const { readEmotion } = await import('../atlas/emotion.js');
    // Strong corrective keywords → keyword path should classify as 'correcting'
    const read = await readEmotion(['блять опять заебал']);

    const validStates = ['drive', 'warm', 'correcting', 'exhausted', 'analytical', 'neutral'];
    expect(validStates).toContain(read.state);
    expect(read.state).toBe('correcting'); // v<-0.3 & a>0.5 for these keywords
    expect(typeof read.intensity).toBe('number');
    expect(typeof read.directive).toBe('string');
    expect(read.directive.length).toBeGreaterThan(0);
  });
});

// ── (c) buildEmotionDirectiveLine: pure helper ───────────────────────────────

describe('buildEmotionDirectiveLine: pure helper', () => {
  it('produces the expected directive line for a known EmotionRead', async () => {
    // No mocks needed — pure function, no external calls.
    const { buildEmotionDirectiveLine } = await import('../atlas/emotion.js');

    const mockRead = {
      valence: 0.8,
      arousal: 0.7,
      dominance: 0.6,
      state: 'drive' as const,
      intensity: 3,
      decayMultiplier: 7,
      directive: 'match_energy_execute_fast',
      matchedKeywords: 2,
    };

    const line = buildEmotionDirectiveLine(mockRead);

    expect(line).toContain('drive');
    expect(line).toContain('3/5');
    expect(line).toContain('match_energy_execute_fast');
    expect(line).toContain('TONE ONLY');
    expect(line).toContain('never alters facts');
    // Must be a single line (no newlines)
    expect(line).not.toContain('\n');
  });
});
