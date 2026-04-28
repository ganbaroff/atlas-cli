import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock fs/promises to avoid real disk writes
vi.mock('node:fs/promises', () => ({
  writeFile: vi.fn().mockResolvedValue(undefined),
  readFile: vi.fn().mockResolvedValue('# Atlas Health Check\n\nAll checks passed'),
  mkdir: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('node:fs', () => ({
  existsSync: vi.fn().mockReturnValue(true),
  readFileSync: vi.fn().mockReturnValue('Updated: 2026-04-27T00:00:00Z'),
}));

describe('cron', () => {
  beforeEach(() => {
    vi.stubEnv('MEMORY_ROOT', '/tmp/atlas-test-vault');
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('runAndPersist returns a HealthReport', async () => {
    const { runAndPersist } = await import('../atlas/cron.js');
    const report = await runAndPersist();
    expect(report.ts).toBeTruthy();
    expect(typeof report.passed).toBe('number');
  });

  it('readLastReport returns string or null', async () => {
    const { readLastReport } = await import('../atlas/cron.js');
    const result = await readLastReport();
    expect(typeof result === 'string' || result === null).toBe(true);
  });

  it('startCron returns stop function', async () => {
    const { startCron } = await import('../atlas/cron.js');
    const { stop } = startCron(1); // 1 minute interval
    expect(typeof stop).toBe('function');
    stop(); // cleanup
  });
});
