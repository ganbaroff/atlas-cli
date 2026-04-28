import { describe, it, expect, vi, beforeEach } from 'vitest';
import { routeModel, listAvailableModels } from '../model-router.js';

describe('Model Router', () => {
  beforeEach(() => {
    vi.unstubAllEnvs();
  });

  it('returns empty when no keys configured', () => {
    vi.stubEnv('CEREBRAS_API_KEY', '');
    vi.stubEnv('OPENROUTER_API_KEY', '');
    vi.stubEnv('NVIDIA_API_KEY', '');
    vi.stubEnv('ANTHROPIC_API_KEY', '');
    vi.stubEnv('OLLAMA_URL', '');
    vi.stubEnv('OLLAMA_HOST', '');
    const models = listAvailableModels();
    expect(models).toEqual([]);
  });

  it('detects Cerebras when key is set', () => {
    vi.stubEnv('CEREBRAS_API_KEY', 'test-key');
    const models = listAvailableModels();
    expect(models.some((m) => m.provider === 'cerebras')).toBe(true);
  });

  it('routes WORKER to cheapest available provider', () => {
    vi.stubEnv('NVIDIA_API_KEY', 'test-key');
    vi.stubEnv('OPENROUTER_API_KEY', 'test-key');
    const result = routeModel({ role: 'WORKER' });
    expect(result.provider).toBe('nvidia');
    expect(result.costTier).toBe(0);
  });

  it('throws when no provider available for role', () => {
    vi.stubEnv('CEREBRAS_API_KEY', '');
    vi.stubEnv('OPENROUTER_API_KEY', '');
    vi.stubEnv('NVIDIA_API_KEY', '');
    vi.stubEnv('ANTHROPIC_API_KEY', '');
    vi.stubEnv('OLLAMA_URL', '');
    vi.stubEnv('OLLAMA_HOST', '');
    expect(() => routeModel({ role: 'WORKER' })).toThrow('No model available');
  });
});
