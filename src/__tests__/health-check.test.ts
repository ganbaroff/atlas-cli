import { describe, it, expect, vi, beforeEach } from 'vitest';
import { runHealthCheck, formatHealthReport } from '../atlas/health-check.js';

describe('health-check', () => {
  beforeEach(() => {
    // Set MEMORY_ROOT to a temp path so tests don't depend on real vault
    vi.stubEnv('MEMORY_ROOT', '/tmp/atlas-test-vault');
  });

  it('runHealthCheck returns structured report', () => {
    const report = runHealthCheck();
    expect(report.ts).toBeTruthy();
    expect(Array.isArray(report.checks)).toBe(true);
    expect(report.checks.length).toBeGreaterThan(0);
    expect(typeof report.passed).toBe('number');
    expect(typeof report.failed).toBe('number');
    expect(typeof report.summary).toBe('string');
    expect(report.passed + report.failed).toBe(report.checks.length);
  });

  it('each check has name, ok, detail', () => {
    const report = runHealthCheck();
    for (const c of report.checks) {
      expect(typeof c.name).toBe('string');
      expect(typeof c.ok).toBe('boolean');
      expect(typeof c.detail).toBe('string');
    }
  });

  it('formatHealthReport produces readable string', () => {
    const report = runHealthCheck();
    const text = formatHealthReport(report);
    expect(text).toContain('Atlas Health Check');
    expect(text).toContain(report.summary);
  });

  it('models check reflects env state', () => {
    const report = runHealthCheck();
    const modelsCheck = report.checks.find(c => c.name === 'models');
    expect(modelsCheck).toBeDefined();
    // In test env, likely no API keys → should report 0 or mention "no API keys"
    expect(typeof modelsCheck!.ok).toBe('boolean');
  });
});
