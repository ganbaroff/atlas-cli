import { describe, it, expect, beforeEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { buildStatusReport } from '../atlas/status-report.js';

describe('atlas status subcommand (CLI parity with Telegram)', () => {
  beforeEach(() => {
    vi.stubEnv('MEMORY_ROOT', '/tmp/atlas-test-vault');
  });

  it('buildStatusReport (shared by CLI + Telegram) yields the same sections', () => {
    const text = buildStatusReport();
    // Same four sections the Telegram /status renders.
    expect(text).toMatch(/живо|упало/); // health
    expect(text).toContain('За сегодня'); // spend
    expect(text).toContain('Очередь brain-loop:'); // queue
    expect(text).toContain('Пульс:'); // heartbeat
  });

  it('cli.ts registers a status command driven by buildStatusReport', () => {
    const src = readFileSync(resolve(__dirname, '../cli.ts'), 'utf-8');
    expect(src).toMatch(/\.command\('status'\)/);
    expect(src).toContain('buildStatusReport');
  });
});

describe('CLI emotion parity (already landed — guard against regression)', () => {
  it('cli chat builds recentUserMessages newest-first and passes them to the agent', () => {
    const src = readFileSync(resolve(__dirname, '../cli.ts'), 'utf-8');
    // newest-first window fed into the shared brain-planner via the agent factory.
    expect(src).toContain('recentUserMessages');
    expect(src).toContain('createAtlasAgentWithRoute');
    // the window is reversed (newest-first) to match analyzeWindow's contract.
    expect(src).toMatch(/recentUserMessages[\s\S]{0,200}\.reverse\(\)/);
  });
});
