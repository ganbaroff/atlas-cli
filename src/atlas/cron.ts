/**
 * Atlas cron — periodic self-check, writes reports to memory.
 *
 * `atlas cron start` — run health check every N minutes (default 30).
 * `atlas cron once`  — single check, print + write report.
 * `atlas cron status` — show last report from disk.
 */

import { writeFile, readFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { runHealthCheck, formatHealthReport, type HealthReport } from './health-check.js';

function healthDir(): string {
  const root = process.env.MEMORY_ROOT ??
    (process.platform === 'win32'
      ? 'C:\\Projects\\VOLAURA'
      : resolve(process.env.HOME ?? '~', 'Projects', 'VOLAURA'));
  return join(root, 'memory', 'atlas', 'health');
}

function reportPath(ts: string): string {
  const safe = ts.replace(/[:.]/g, '-').slice(0, 19);
  return join(healthDir(), `${safe}.md`);
}

function latestReportPath(): string {
  return join(healthDir(), 'latest.md');
}

async function ensureHealthDir(): Promise<void> {
  const dir = healthDir();
  if (!existsSync(dir)) await mkdir(dir, { recursive: true });
}

/** Run one health check, write report to disk, return it. */
export async function runAndPersist(): Promise<HealthReport> {
  const report = runHealthCheck();
  const formatted = formatHealthReport(report);

  await ensureHealthDir();
  await writeFile(reportPath(report.ts), formatted, 'utf-8');
  await writeFile(latestReportPath(), formatted, 'utf-8');

  return report;
}

/** Read last persisted report from disk. */
export async function readLastReport(): Promise<string | null> {
  const fp = latestReportPath();
  if (!existsSync(fp)) return null;
  return readFile(fp, 'utf-8');
}

/** Start recurring cron. Returns cleanup function. */
export function startCron(intervalMinutes = 30): { stop: () => void } {
  const ms = intervalMinutes * 60 * 1000;

  const tick = async () => {
    try {
      const report = await runAndPersist();
      const time = new Date().toISOString().slice(11, 19);
      console.log(`[cron ${time}] ${report.summary}`);
    } catch (err) {
      console.error(`[cron] check failed: ${err instanceof Error ? err.message : err}`);
    }
  };

  // Run immediately, then on interval
  tick();
  const handle = setInterval(tick, ms);

  return {
    stop: () => clearInterval(handle),
  };
}
