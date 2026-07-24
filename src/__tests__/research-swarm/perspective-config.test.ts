import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  auditPerspectiveConfig,
  validateDeclaredWorkerProvider,
} from '../../research-swarm/perspective-config.js';
import type { Perspective } from '../../atlas/perspectives.js';

describe('perspective-config', () => {
  const envBackup = { ...process.env };

  beforeEach(() => {
    process.env = { ...envBackup, NVIDIA_API_KEY: 'test-nvidia-key' };
    delete process.env.ATLAS_ALLOW_PAID;
  });

  afterEach(() => {
    process.env = envBackup;
  });

  it('flags unknown provider (cerebras) without silent remap', () => {
    const perspectives: Perspective[] = [
      { name: 'qa', provider: 'cerebras', instruction: 'test' },
    ];
    const audit = auditPerspectiveConfig(perspectives);
    expect(audit.issues).toHaveLength(1);
    expect(audit.issues[0]?.code).toBe('unknown_provider');
    expect(validateDeclaredWorkerProvider('cerebras')).toEqual({
      ok: false,
      status: 'routing_error',
      error: 'unknown_provider:cerebras',
    });
  });

  it('flags anthropic worker assignment as not_worker_role or paid_blocked', () => {
    const preflight = validateDeclaredWorkerProvider('anthropic');
    expect(preflight.ok).toBe(false);
    if (preflight.ok) return;
    expect(['routing_error', 'blocked']).toContain(preflight.status);
  });

  it('allows undeclared provider (router auto-pick)', () => {
    expect(validateDeclaredWorkerProvider(undefined)).toEqual({ ok: true });
  });

  it('lists available worker providers from registry + env', () => {
    const audit = auditPerspectiveConfig([]);
    expect(audit.availableWorkerProviders).toContain('nvidia');
  });
});
