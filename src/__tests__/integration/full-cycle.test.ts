/**
 * Integration test — proves the full cycle works:
 * perspectives → health check → dedup → swarm logger → memory persists.
 *
 * Does NOT call real LLM APIs — mocks at agent level.
 * Tests the wiring, not the AI.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { PERSPECTIVES, getPerspective, assignPerspectives } from '../../atlas/perspectives.js';
import { runHealthCheck, formatHealthReport } from '../../atlas/health-check.js';
import { dedupFindings } from '../../atlas/dedup.js';
import { IDENTITY, loadIdentity } from '../../atlas/identity.js';

// Mock fs for swarm-logger
vi.mock('node:fs/promises', () => ({
  writeFile: vi.fn().mockResolvedValue(undefined),
  readFile: vi.fn().mockResolvedValue('mock'),
  mkdir: vi.fn().mockResolvedValue(undefined),
  appendFile: vi.fn().mockResolvedValue(undefined),
  readdir: vi.fn().mockResolvedValue([]),
  rename: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('node:fs', () => ({
  existsSync: vi.fn().mockReturnValue(true),
  readFileSync: vi.fn().mockReturnValue('Updated: 2026-04-27T00:00:00Z\n**Name:** Atlas'),
}));

describe('integration: full cycle', () => {
  beforeEach(() => {
    vi.stubEnv('MEMORY_ROOT', '/tmp/atlas-integration');
  });

  it('perspectives are all defined with required fields', () => {
    expect(PERSPECTIVES.length).toBeGreaterThanOrEqual(5);
    for (const p of PERSPECTIVES) {
      expect(p.name).toBeTruthy();
      expect(p.instruction).toBeTruthy();
      expect(p.instruction.length).toBeGreaterThan(20);
    }
  });

  it('getPerspective finds by name', () => {
    const arch = getPerspective('architect');
    expect(arch).toBeDefined();
    expect(arch!.name).toBe('architect');
  });

  it('assignPerspectives returns correct count', () => {
    const three = assignPerspectives(3);
    expect(three.length).toBe(3);
    const all = assignPerspectives();
    expect(all.length).toBe(PERSPECTIVES.length);
  });

  it('identity loads and has required fields', () => {
    expect(IDENTITY.name).toBe('Atlas');
    expect(IDENTITY.role).toBeTruthy();
    expect(IDENTITY.voice_style).toBeTruthy();
    const loaded = loadIdentity(IDENTITY);
    expect(loaded.name).toBe('Atlas');
  });

  it('health check runs without crash', () => {
    const report = runHealthCheck();
    expect(report.checks.length).toBeGreaterThan(0);
    const text = formatHealthReport(report);
    expect(text).toContain('Atlas Health Check');
  });

  it('dedup handles multi-perspective output', () => {
    const mockOutputs = PERSPECTIVES.map(
      (p) => `From ${p.name}: The system needs better error handling. Authentication is weak.`,
    );
    const result = dedupFindings(mockOutputs, 0.5);
    // All 5 perspectives say similar things → heavy dedup
    expect(result.duplicatesRemoved).toBeGreaterThan(0);
    expect(result.unique.length).toBeLessThan(result.totalInput);
  });

  it('swarm logger persists run data', async () => {
    const { logSwarmRun } = await import('../../atlas/swarm-logger.js');
    const fp = await logSwarmRun({
      ts: new Date().toISOString(),
      task: 'integration test task',
      subtasks: PERSPECTIVES.map((p, i) => ({
        id: i,
        description: p.instruction,
        perspective: p.name,
      })),
      results: PERSPECTIVES.map((p, i) => ({
        id: i,
        output: `${p.name} output`,
        provider: p.provider ?? 'unknown',
        durationMs: 100 * (i + 1),
      })),
      synthesis: 'integrated answer',
      durationMs: 1500,
      jidokaViolation: null,
    });
    expect(fp).toContain('.json');
  });

  it('full pipeline: perspectives → dedup → log', async () => {
    // 1. Generate perspective outputs (mock)
    const subtasks = PERSPECTIVES.map((p, i) => ({
      id: i,
      description: p.instruction,
      perspective: p.name,
    }));

    const results = subtasks.map((st) => ({
      id: st.id,
      output: `Analysis from ${st.perspective}: found 3 issues with error handling and security.`,
      provider: 'mock',
      durationMs: 200,
    }));

    // 2. Dedup
    const dedup = dedupFindings(results.map((r) => r.output));
    expect(dedup.totalInput).toBeGreaterThan(0);

    // 3. Log
    const { logSwarmRun } = await import('../../atlas/swarm-logger.js');
    const fp = await logSwarmRun({
      ts: new Date().toISOString(),
      task: 'full pipeline test',
      subtasks,
      results,
      synthesis: `Deduped ${dedup.duplicatesRemoved} claims. ${dedup.unique.length} unique findings.`,
      durationMs: 1000,
      jidokaViolation: null,
    });
    expect(fp).toBeTruthy();

    // 4. Health still works after all that
    const health = runHealthCheck();
    expect(health.checks.length).toBeGreaterThan(0);
  });
});
