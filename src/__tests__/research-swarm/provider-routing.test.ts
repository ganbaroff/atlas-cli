import { describe, it, expect, vi, beforeEach } from 'vitest';
import { routeWorkerProvider, ProviderRoutingError } from '../../research-swarm/provider-routing.js';

describe('research-swarm provider-routing', () => {
  beforeEach(() => {
    vi.unstubAllEnvs();
    vi.stubEnv('NVIDIA_API_KEY', 'test-nvidia');
    vi.stubEnv('GROQ_API_KEY', 'test-groq');
    vi.stubEnv('ATLAS_PREFERRED_PROVIDER', '');
    vi.stubEnv('ATLAS_ALLOW_PAID', '');
  });

  it('routes worker to preferred provider without mutating ATLAS_PREFERRED_PROVIDER', () => {
    const route = routeWorkerProvider({ preferred: 'groq' });
    expect(route.provider).toBe('groq');
    expect(process.env['ATLAS_PREFERRED_PROVIDER']).toBe('');
  });

  it('blocks paid provider when ATLAS_ALLOW_PAID is not set', () => {
    vi.stubEnv('OPENAI_API_KEY', 'test-openai');
    expect(() => routeWorkerProvider({ preferred: 'openai' })).toThrow(ProviderRoutingError);
  });

  it('allows paid provider when ATLAS_ALLOW_PAID=1', () => {
    vi.stubEnv('OPENAI_API_KEY', 'test-openai');
    vi.stubEnv('ATLAS_ALLOW_PAID', '1');
    const route = routeWorkerProvider({ preferred: 'openai' });
    expect(route.provider).toBe('openai');
  });

  it('env ATLAS_PREFERRED_PROVIDER does not affect explicit routeWorkerProvider call', () => {
    vi.stubEnv('ATLAS_PREFERRED_PROVIDER', 'groq');
    const route = routeWorkerProvider({ preferred: 'nvidia' });
    expect(route.provider).toBe('nvidia');
  });

  it('falls back to default when no preference given', () => {
    const route = routeWorkerProvider({});
    expect(route.provider).toBe('nvidia');
  });
});
