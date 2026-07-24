/**
 * M6 — provider health unit + routing negative tests.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  clearProviderHealthForTests,
  getProviderHealth,
  isProviderHealthyForRouting,
  markProviderDead,
  markProviderHealthy,
  recordProviderFailure,
} from '../atlas/provider-health.js';
import { routeModel, markProviderDead as routerMarkDead } from '../model-router.js';

describe('M6 provider health', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'atlas-health-'));
    process.env.ATLAS_PROVIDER_HEALTH_DIR = dir;
    clearProviderHealthForTests();
  });

  afterEach(() => {
    delete process.env.ATLAS_PROVIDER_HEALTH_DIR;
    rmSync(dir, { recursive: true, force: true });
  });

  it('unknown provider is healthy for routing by default', () => {
    expect(isProviderHealthyForRouting('nvidia')).toBe(true);
  });

  it('dead provider is excluded until cooldown expires', () => {
    markProviderDead('nvidia', '401 unauthorized', 60_000);
    expect(isProviderHealthyForRouting('nvidia')).toBe(false);
    const entry = getProviderHealth('nvidia');
    expect(entry?.state).toBe('dead');
    expect(entry?.reason).toMatch(/401/);
  });

  it('auth failure → dead; rate limit → degraded', () => {
    expect(recordProviderFailure('groq', 'HTTP 401 Unauthorized')).toBe('dead');
    expect(getProviderHealth('groq')?.state).toBe('dead');
    markProviderHealthy('openai');
    expect(recordProviderFailure('openai', '429 rate limit')).toBe('degraded');
    expect(getProviderHealth('openai')?.state).toBe('degraded');
  });

  it('NEGATIVE: dead provider is never assigned WORKER by routeModel', () => {
    // Ensure at least one other candidate exists via env stubs.
    process.env.GROQ_API_KEY = 'test-groq';
    process.env.NVIDIA_API_KEY = 'test-nvidia';
    markProviderDead('nvidia', 'simulated death', 60_000);
    // Also mark via legacy router API for parity during migration.
    routerMarkDead('nvidia');
    const route = routeModel({ role: 'WORKER', ignoreEnvPreference: true });
    expect(route.provider).not.toBe('nvidia');
  });
});
