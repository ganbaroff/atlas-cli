import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { routeWorkerProvider, routeJudgeProvider, ProviderRoutingError } from '../../research-swarm/provider-routing.js';
import { clearProviderHealthForTests, markProviderDead } from '../../atlas/provider-health.js';
import { resetDailySpend } from '../../atlas/spend-tracker.js';

describe('research-swarm provider-routing', () => {
  let healthDir: string;

  let receiptDir: string;

  beforeEach(() => {
    healthDir = mkdtempSync(join(tmpdir(), 'atlas-swarm-route-'));
    receiptDir = mkdtempSync(join(tmpdir(), 'atlas-spend-route-'));
    process.env.ATLAS_PROVIDER_HEALTH_DIR = healthDir;
    process.env.ATLAS_SPEND_RECEIPT_DIR = receiptDir;
    clearProviderHealthForTests();
    resetDailySpend();
    vi.unstubAllEnvs();
    vi.stubEnv('NVIDIA_API_KEY', 'test-nvidia');
    vi.stubEnv('GROQ_API_KEY', 'test-groq');
    vi.stubEnv('ATLAS_PREFERRED_PROVIDER', '');
    vi.stubEnv('ATLAS_ALLOW_PAID', '');
  });

  afterEach(() => {
    delete process.env.ATLAS_PROVIDER_HEALTH_DIR;
    delete process.env.ATLAS_SPEND_RECEIPT_DIR;
    rmSync(healthDir, { recursive: true, force: true });
    rmSync(receiptDir, { recursive: true, force: true });
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

  it('M6 honesty: dead preferred provider is not assignable to swarm worker', () => {
    markProviderDead('nvidia', 'simulated auth failure', 60_000);
    expect(() => routeWorkerProvider({ preferred: 'nvidia' })).toThrow(ProviderRoutingError);
    expect(() => routeWorkerProvider({ preferred: 'nvidia' })).toThrow(/dead\/cooldown/);
  });

  it('M6 honesty: healthy provider proceeds for swarm worker', () => {
    const route = routeWorkerProvider({ preferred: 'groq' });
    expect(route.provider).toBe('groq');
  });

  it('M6 honesty: judge route never assigns a dead provider', () => {
    markProviderDead('nvidia', 'simulated death', 60_000);
    const route = routeJudgeProvider();
    expect(route.provider).not.toBe('nvidia');
  });
});
