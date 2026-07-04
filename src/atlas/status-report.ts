/**
 * Atlas /status composer — one message: health, today's spend, brain-loop queue
 * depth, heartbeat freshness. Replaces the deleted dashboard.html.
 *
 * Pure composition: takes structured inputs, returns a voice.md-style string
 * (short, plain lines, no bullet walls, no bold section headers). The Telegram
 * and CLI callers gather the live inputs and hand them here so the exact same
 * text renders on both surfaces.
 */

import { runHealthCheck, type HealthReport } from './health-check.js';
import { getDailySpend } from './spend-tracker.js';
import { getBrainQueueCount, brainQueueCap } from './spend-policy.js';

export interface StatusInputs {
  health: HealthReport;
  spend: Readonly<{
    date: string;
    tokensIn: number;
    tokensOut: number;
    costUsd: number;
    calls: number;
  }>;
  /** Autonomous brain-loop queue seeds used today, and the daily cap. */
  queueUsed: number;
  queueCap: number;
}

/** Gather the live inputs from the in-process meters + health checks. */
export function gatherStatusInputs(): StatusInputs {
  return {
    health: runHealthCheck(),
    spend: getDailySpend(),
    queueUsed: getBrainQueueCount(),
    queueCap: brainQueueCap(),
  };
}

function heartbeatLine(health: HealthReport): string {
  const hb = health.checks.find((c) => c.name === 'heartbeat');
  if (!hb) return 'Пульс: неизвестно.';
  return hb.ok ? `Пульс: свежий (${hb.detail}).` : `Пульс: устал — ${hb.detail}.`;
}

/**
 * Compose the status message in voice.md style. Plain lines, air between them,
 * zero bullet lists. Health first (what's alive), then money, then autonomy.
 */
export function composeStatusReport(inputs: StatusInputs): string {
  const { health, spend, queueUsed, queueCap } = inputs;

  const healthLine =
    health.failed === 0
      ? `Всё живо — ${health.passed} проверок прошли.`
      : `${health.failed} из ${health.checks.length} упало: ${health.checks
          .filter((c) => !c.ok)
          .map((c) => c.name)
          .join(', ')}.`;

  const cost = spend.costUsd > 0 ? `$${spend.costUsd.toFixed(4)}` : '$0';
  const spendLine = `За сегодня ${cost} — ${spend.calls} вызовов, ${spend.tokensIn + spend.tokensOut} токенов.`;

  const queueLine = `Очередь brain-loop: ${queueUsed}/${queueCap} за день.`;

  return [healthLine, spendLine, queueLine, heartbeatLine(health)].join('\n');
}

/** Convenience: gather + compose in one call (the live path). */
export function buildStatusReport(): string {
  return composeStatusReport(gatherStatusInputs());
}
