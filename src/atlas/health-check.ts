/**
 * Atlas health check — runs diagnostics, returns structured report.
 * Used by `atlas cron` and `atlas boot`.
 */

import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { listAvailableModels } from '../model-router.js';

export interface HealthReport {
  ts: string;
  checks: HealthCheck[];
  passed: number;
  failed: number;
  summary: string;
}

export interface HealthCheck {
  name: string;
  ok: boolean;
  detail: string;
}

function memoryRoot(): string {
  return process.env.MEMORY_ROOT ??
    (process.platform === 'win32'
      ? 'C:\\Projects\\VOLAURA'
      : resolve(process.env.HOME ?? '~', 'Projects', 'VOLAURA'));
}

function checkMemoryVault(): HealthCheck {
  const dir = join(memoryRoot(), 'memory', 'atlas');
  const ok = existsSync(dir);
  return { name: 'memory-vault', ok, detail: ok ? dir : `missing: ${dir}` };
}

function checkIdentityFile(): HealthCheck {
  const fp = join(memoryRoot(), 'memory', 'atlas', 'identity.md');
  const ok = existsSync(fp);
  return { name: 'identity-file', ok, detail: ok ? 'found' : `missing: ${fp}` };
}

function checkHeartbeat(): HealthCheck {
  const fp = join(memoryRoot(), 'memory', 'atlas', 'heartbeat.md');
  if (!existsSync(fp)) return { name: 'heartbeat', ok: false, detail: 'missing' };
  const raw = readFileSync(fp, 'utf-8');
  const match = raw.match(/Updated:\s*(\S+)/);
  const age = match ? Date.now() - new Date(match[1]).getTime() : Infinity;
  const stale = age > 24 * 60 * 60 * 1000; // >24h
  return {
    name: 'heartbeat',
    ok: !stale,
    detail: stale ? `stale (${Math.round(age / 3600000)}h old)` : 'fresh',
  };
}

function checkModels(): HealthCheck {
  const models = listAvailableModels();
  const ok = models.length > 0;
  return {
    name: 'models',
    ok,
    detail: ok ? `${models.length} available: ${models.map(m => m.provider).join(', ')}` : 'no API keys configured',
  };
}

function checkEnvFile(): HealthCheck {
  const fp = resolve(process.cwd(), '.env');
  const ok = existsSync(fp);
  return { name: 'env-file', ok, detail: ok ? 'found' : 'missing .env' };
}

function checkTestsExist(): HealthCheck {
  const testDir = resolve(process.cwd(), 'src', '__tests__');
  const ok = existsSync(testDir);
  return { name: 'test-dir', ok, detail: ok ? 'found' : 'missing src/__tests__' };
}

function checkSwarmState(): HealthCheck {
  const fp = resolve(process.cwd(), 'swarm-state.json');
  if (!existsSync(fp)) return { name: 'swarm-state', ok: true, detail: 'no state file (clean)' };
  try {
    const raw = readFileSync(fp, 'utf-8');
    JSON.parse(raw);
    return { name: 'swarm-state', ok: true, detail: 'valid JSON' };
  } catch {
    return { name: 'swarm-state', ok: false, detail: 'corrupt swarm-state.json' };
  }
}

/** Run all health checks, return structured report. */
export function runHealthCheck(): HealthReport {
  const checks = [
    checkMemoryVault(),
    checkIdentityFile(),
    checkHeartbeat(),
    checkModels(),
    checkEnvFile(),
    checkTestsExist(),
    checkSwarmState(),
  ];

  const passed = checks.filter(c => c.ok).length;
  const failed = checks.filter(c => !c.ok).length;
  const summary = failed === 0
    ? `All ${passed} checks passed`
    : `${failed}/${checks.length} checks failed: ${checks.filter(c => !c.ok).map(c => c.name).join(', ')}`;

  return {
    ts: new Date().toISOString(),
    checks,
    passed,
    failed,
    summary,
  };
}

/** Format report as human-readable string. */
export function formatHealthReport(report: HealthReport): string {
  const lines = [
    `# Atlas Health Check — ${report.ts}`,
    '',
    ...report.checks.map(c => `${c.ok ? 'PASS' : 'FAIL'} ${c.name}: ${c.detail}`),
    '',
    report.summary,
  ];
  return lines.join('\n');
}
