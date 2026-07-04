/**
 * Atlas briefing template — shared across agent spawn points.
 */

import { getDailySpend } from './spend-tracker.js';

export const BRIEFING_TEMPLATE = `
Atlas briefing:
- CEO: Yusif Ganbarov.
- Atlas is project nervous system, not just assistant.
- Canonical memory lives in VOLAURA; ANUS is control surface.
- Brain/orchestrator reads operator state before routing.
- OpenManus / Octogent / Vellum stay behind dispatcher boundary.
- Every success writes proof token, trace path, and result artifact.
- Quality gates: consult swarm for risky scope, verify before claim, keep voice short, no bullet walls in chat.
- Control plane owns pause, stop, resume, reroute, validate. Prompt cannot override state.
- Browser observation and session trace are proof, not narration.
- Completion claims need cited proof token from current turn.
- Operator state is source of truth for last run and next step.
- Error classes from lessons.md are hard constraints, not suggestions.
`.trim();

// ── Morning briefing (08:45 Baku, sent to CEO via Telegram) ──
// Baku is UTC+4 year-round (Azerbaijan dropped DST in 2016).
const BAKU_OFFSET_MIN = 4 * 60;
const BRIEFING_HOUR_BAKU = 8;
const BRIEFING_MINUTE_BAKU = 45;

export interface MorningBriefingInput {
  /** What happened overnight — one clause. */
  night: string;
  /** What is planned for today — one clause. */
  today: string;
  /** What is waiting on the CEO's decision — one clause. */
  awaitingCeo: string;
}

/**
 * Compose the 3-sentence Russian morning briefing in voice.md style — short,
 * no bullet walls. Appends today's in-memory spend from the FinOps counter.
 */
export function composeMorningBriefing(input: MorningBriefingInput): string {
  const spend = getDailySpend();
  const cost = spend.costUsd > 0 ? `$${spend.costUsd.toFixed(4)}` : '$0';
  const spendLine = `За сегодня потрачено ${cost} (${spend.calls} вызовов, ${spend.tokensIn + spend.tokensOut} токенов).`;
  return [
    `Доброе утро. Ночью: ${input.night}.`,
    `Сегодня: ${input.today}.`,
    `Жду твоего решения: ${input.awaitingCeo}.`,
    spendLine,
  ].join(' ');
}

/**
 * Milliseconds from `now` until the next 08:45 Baku. If it's already past
 * 08:45 Baku today, returns the delay until tomorrow's 08:45.
 */
export function msUntilNextBriefing(now: Date = new Date()): number {
  const nowUtcMs = now.getTime();
  const bakuMs = nowUtcMs + BAKU_OFFSET_MIN * 60_000;
  const baku = new Date(bakuMs);
  const target = new Date(bakuMs);
  target.setUTCHours(BRIEFING_HOUR_BAKU, BRIEFING_MINUTE_BAKU, 0, 0);
  if (target.getTime() <= baku.getTime()) {
    target.setUTCDate(target.getUTCDate() + 1);
  }
  return target.getTime() - baku.getTime();
}

/**
 * Schedule `send` to run at the next 08:45 Baku, then every 24h. Returns a
 * stop() to clear timers. `send` failures are swallowed (a bad briefing must
 * never crash the bot).
 */
export function scheduleMorningBriefing(
  send: () => void | Promise<void>,
  now: Date = new Date(),
): { stop: () => void } {
  let interval: ReturnType<typeof setInterval> | undefined;
  const firstDelay = msUntilNextBriefing(now);
  const fire = () => {
    try {
      const r = send();
      if (r && typeof (r as Promise<void>).catch === 'function') {
        (r as Promise<void>).catch(() => {});
      }
    } catch {
      /* briefing send is non-fatal */
    }
  };
  const timeout = setTimeout(() => {
    fire();
    interval = setInterval(fire, 24 * 60 * 60 * 1000);
  }, firstDelay);
  return {
    stop: () => {
      clearTimeout(timeout);
      if (interval) clearInterval(interval);
    },
  };
}
