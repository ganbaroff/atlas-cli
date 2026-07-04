import { describe, it, expect } from 'vitest';
import { composeStatusReport } from '../atlas/status-report.js';
import type { HealthReport } from '../atlas/health-check.js';

function healthWith(overrides: Partial<HealthReport> = {}): HealthReport {
  const checks = overrides.checks ?? [
    { name: 'memory-vault', ok: true, detail: 'ok' },
    { name: 'heartbeat', ok: true, detail: 'fresh' },
    { name: 'models', ok: true, detail: '3 available' },
  ];
  const passed = checks.filter((c) => c.ok).length;
  const failed = checks.filter((c) => !c.ok).length;
  return {
    ts: '2026-07-05T00:00:00Z',
    checks,
    passed,
    failed,
    summary: failed === 0 ? `All ${passed} checks passed` : `${failed} failed`,
    ...overrides,
  };
}

describe('composeStatusReport', () => {
  it('contains health, spend, queue and heartbeat sections', () => {
    const text = composeStatusReport({
      health: healthWith(),
      spend: { date: '2026-07-05', tokensIn: 100, tokensOut: 200, costUsd: 0.0021, calls: 4 },
      queueUsed: 2,
      queueCap: 20,
    });
    // health section
    expect(text).toContain('Всё живо');
    expect(text).toContain('3 проверок');
    // spend section
    expect(text).toContain('$0.0021');
    expect(text).toContain('4 вызовов');
    expect(text).toContain('300 токенов');
    // queue section
    expect(text).toContain('Очередь brain-loop: 2/20');
    // heartbeat freshness
    expect(text).toContain('Пульс: свежий');
  });

  it('surfaces failed checks by name', () => {
    const text = composeStatusReport({
      health: healthWith({
        checks: [
          { name: 'memory-vault', ok: true, detail: 'ok' },
          { name: 'heartbeat', ok: false, detail: 'stale (30h old)' },
          { name: 'models', ok: false, detail: 'no API keys' },
        ],
      }),
      spend: { date: '2026-07-05', tokensIn: 0, tokensOut: 0, costUsd: 0, calls: 0 },
      queueUsed: 0,
      queueCap: 20,
    });
    expect(text).toContain('2 из 3 упало');
    expect(text).toContain('heartbeat');
    expect(text).toContain('models');
    expect(text).toContain('Пульс: устал');
    expect(text).toContain('stale (30h old)');
    expect(text).toContain('$0');
  });

  it('is plain lines, no bullet walls', () => {
    const text = composeStatusReport({
      health: healthWith(),
      spend: { date: '2026-07-05', tokensIn: 1, tokensOut: 1, costUsd: 0, calls: 1 },
      queueUsed: 0,
      queueCap: 20,
    });
    expect(text).not.toContain('\n- ');
    expect(text).not.toContain('**');
  });
});
