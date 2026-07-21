import { describe, it, expect, vi, beforeEach } from 'vitest';
import { routeModel, listAvailableModels } from '../model-router.js';

function clearProviderEnvs(): void {
  vi.stubEnv('GROQ_API_KEY', '');
  vi.stubEnv('NVIDIA_API_KEY', '');
  vi.stubEnv('OPENAI_API_KEY', '');
  vi.stubEnv('OPENROUTER_API_KEY', '');
  vi.stubEnv('ANTHROPIC_API_KEY', '');
  vi.stubEnv('OLLAMA_URL', '');
  vi.stubEnv('OLLAMA_HOST', '');
  vi.stubEnv('ATLAS_PREFERRED_PROVIDER', '');
}

describe('Model Router', () => {
  beforeEach(() => {
    vi.unstubAllEnvs();
    clearProviderEnvs();
  });

  it('returns empty when no keys configured', () => {
    const models = listAvailableModels();
    expect(models).toEqual([]);
  });

  it('detects Groq when key is set', () => {
    vi.stubEnv('GROQ_API_KEY', 'test-key');
    const models = listAvailableModels();
    expect(models.some((m) => m.provider === 'groq')).toBe(true);
  });

  it('routes WORKER to Groq when it is the only configured provider', () => {
    vi.stubEnv('GROQ_API_KEY', 'test-key');
    const result = routeModel({ role: 'WORKER' });
    expect(result.provider).toBe('groq');
  });

  it('routes JUDGE to Groq when it is the only configured provider', () => {
    vi.stubEnv('GROQ_API_KEY', 'test-key');
    const result = routeModel({ role: 'JUDGE' });
    expect(result.provider).toBe('groq');
  });

  it('routes WORKER to NVIDIA first per canon order when NVIDIA + Groq are both set', () => {
    vi.stubEnv('NVIDIA_API_KEY', 'test-key');
    vi.stubEnv('GROQ_API_KEY', 'test-key');
    const result = routeModel({ role: 'WORKER' });
    expect(result.provider).toBe('nvidia');
    expect(result.costTier).toBe(0);
  });

  it('routes WORKER to cheapest available provider', () => {
    vi.stubEnv('NVIDIA_API_KEY', 'test-key');
    vi.stubEnv('OPENROUTER_API_KEY', 'test-key');
    const result = routeModel({ role: 'WORKER' });
    expect(result.provider).toBe('nvidia');
    expect(result.costTier).toBe(0);
  });

  it('throws when no provider available for role', () => {
    expect(() => routeModel({ role: 'WORKER' })).toThrow('No model available');
  });

  it('never routes WORKER to anthropic (credits-before-cash, ADR-013; ADR-0007 follow-up 3)', () => {
    vi.stubEnv('ANTHROPIC_API_KEY', 'test-key');
    vi.stubEnv('GROQ_API_KEY', 'test-key');
    const candidates = listAvailableModels().filter((m) => m.roles.includes('WORKER'));
    expect(candidates.some((m) => m.provider === 'anthropic')).toBe(false);
  });
});
