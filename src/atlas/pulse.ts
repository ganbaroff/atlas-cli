/**
 * Atlas Pulse — the agent's OWN emotional state (5 dims), distinct from emotion.ts
 * which reads the CEO. Ported from C:/Projects/VOLAURA/packages/swarm/archive/emotional_core.py
 * (constants verbatim: dims, per-hour decay rates, actor/event weights, thresholds).
 *
 * v1 decisions (post-adversarial-critique, see ATLAS-IMPLEMENTATION-PLAN Phase 3):
 *  - LOG-ONLY: impulse-block (discomfort>0.7) is COMPUTED and logged, never gates actions.
 *    Mood may color tone; it must never make Atlas refuse to work.
 *  - RUNAWAY GUARD (new, not in source): each dim may rise at most +0.3 per event.
 *    The .py ratchets via max(existing,new) — one ceo+security event could jump
 *    significance to ~0.97 in a single step and start a feedback spiral with the CEO.
 *  - Persistence: MOOD.md under MEMORY_ROOT (ATLAS-CANON: VOLAURA is the canonical
 *    memory home; never grow a second vault inside this repo). No MEMORY_ROOT → in-memory only.
 */

import { readFileSync, writeFileSync, mkdirSync, renameSync } from 'node:fs';
import { dirname, join } from 'node:path';

export interface PulseState {
  significance: number;
  curiosity: number;
  discomfort: number;
  surprise: number;
  concern: number;
  lastUpdated: string; // ISO
}

const DEFAULTS: PulseState = {
  significance: 0,
  curiosity: 0.5,
  discomfort: 0,
  surprise: 0,
  concern: 0,
  lastUpdated: new Date(0).toISOString(),
};

// Per-hour exponential decay rates (emotional_core.py:51-55). Curiosity floored at 0.3.
const DECAY_PER_HOUR: Record<keyof Omit<PulseState, 'lastUpdated'>, number> = {
  significance: 0.1,
  curiosity: 0.05,
  discomfort: 0.2,
  surprise: 0.15,
  concern: 0.08,
};
const CURIOSITY_FLOOR = 0.3;
const MAX_DELTA_PER_EVENT = 0.3; // runaway guard
const IMPULSE_THRESHOLD = 0.7; // emotional_core.py:290 — log-only in v1

// SignificanceDetector weights (emotional_core.py:109-126). Unknown → 0.3.
const ACTOR_WEIGHTS: Record<string, number> = {
  ceo: 1.0, user: 0.7, agent: 0.3, system: 0.1, cron: 0.05,
};
const EVENT_WEIGHTS: Record<string, number> = {
  security: 0.95, error: 0.9, revenue: 0.85, user_feedback: 0.8,
  deployment: 0.6, code_change: 0.4, documentation: 0.2, routine: 0.1,
};

export type PulseActor = keyof typeof ACTOR_WEIGHTS | string;
export type PulseEvent = keyof typeof EVENT_WEIGHTS | string;

function moodPath(): string | null {
  const root = process.env['MEMORY_ROOT'];
  if (!root) return null;
  return join(root, 'memory', 'atlas', 'MOOD.md');
}

/** Apply wall-clock decay since lastUpdated. */
export function decay(state: PulseState, now = new Date()): PulseState {
  const hours = Math.max(0, (now.getTime() - new Date(state.lastUpdated).getTime()) / 3_600_000);
  if (hours === 0) return state;
  const next = { ...state };
  for (const dim of Object.keys(DECAY_PER_HOUR) as (keyof typeof DECAY_PER_HOUR)[]) {
    next[dim] = state[dim] * Math.exp(-DECAY_PER_HOUR[dim] * hours);
  }
  next.curiosity = Math.max(CURIOSITY_FLOOR, next.curiosity);
  return next;
}

/** Only 3 of 5 dims feed intensity (emotional_core.py:77) — curiosity/discomfort excluded. */
export function emotionalIntensity(s: PulseState): number {
  return Math.min(1, (s.significance + s.surprise + s.concern) / 3);
}

export function memoryDecayMultiplier(s: PulseState): number {
  return 1.0 + emotionalIntensity(s) * 2.0; // ZenBrain, 0-1 scale → range 1.0-3.0
}

/** Capped ratchet: rise toward target, at most +MAX_DELTA_PER_EVENT; never lowers. */
function cappedRaise(current: number, target: number): number {
  return Math.min(Math.min(current + MAX_DELTA_PER_EVENT, Math.max(current, target)), 1);
}

export interface PulseEventResult {
  state: PulseState;
  significance: number;
  intensity: number;
  decayMultiplier: number;
  wouldBlock: boolean; // log-only in v1
}

/** Process one event: decay → significance → capped ratchet. */
export function processEvent(
  state: PulseState,
  actor: PulseActor,
  event: PulseEvent,
  now = new Date(),
): PulseEventResult {
  const decayed = decay(state, now);
  const aW = ACTOR_WEIGHTS[actor] ?? 0.3;
  const eW = EVENT_WEIGHTS[event] ?? 0.3;
  const significance = Math.round(((aW + eW) / 2) * 1000) / 1000;

  const next: PulseState = { ...decayed, lastUpdated: now.toISOString() };
  next.significance = cappedRaise(decayed.significance, significance);
  if (event === 'error' || event === 'security') {
    next.concern = cappedRaise(decayed.concern, eW);
    next.discomfort = cappedRaise(decayed.discomfort, eW * 0.5);
  }

  return {
    state: next,
    significance,
    intensity: emotionalIntensity(next),
    decayMultiplier: memoryDecayMultiplier(next),
    wouldBlock: next.discomfort > IMPULSE_THRESHOLD,
  };
}

/** One-line tone hint for the system prompt — colors tone, never blocks or invents urgency. */
export function pulseToneHint(s: PulseState): string {
  const i = emotionalIntensity(s);
  if (s.concern > 0.5) return 'Твоё состояние: обеспокоен (реальные события) — упомяни причину, без драмы.';
  if (i > 0.5) return 'Твоё состояние: собранный, события значимые — отвечай плотнее.';
  return 'Твоё состояние: ровное.';
}

// ── Proactivity gate (Phase 5 soul: mood drives behavior) ───────────────────
// Worried Atlas checks prod more and pings CEO; content Atlas stays quiet.
// Hard guardrail: mood NEVER touches facts, verification, or money/legal judgment.

export interface ProactivityLevel {
  shouldProbe: boolean;    // check prod/bot health NOW (not just on schedule)
  shouldPing: boolean;     // reach out to CEO unprompted
  reason: string;          // why (shown to CEO if pinging)
  interval: 'urgent' | 'normal' | 'quiet';  // cron frequency hint
}

export function proactivityGate(s: PulseState): ProactivityLevel {
  const i = emotionalIntensity(s);

  // High concern (>0.5) + any discomfort → urgent: probe NOW, ping CEO
  if (s.concern > 0.5 && s.discomfort > 0.2) {
    return {
      shouldProbe: true,
      shouldPing: true,
      reason: `concern=${s.concern.toFixed(2)}, discomfort=${s.discomfort.toFixed(2)} — что-то тревожит`,
      interval: 'urgent',
    };
  }

  // Moderate concern (>0.3) → probe but don't ping
  if (s.concern > 0.3 || i > 0.4) {
    return {
      shouldProbe: true,
      shouldPing: false,
      reason: `intensity=${i.toFixed(2)} — настороже`,
      interval: 'normal',
    };
  }

  // Content → quiet mode, standard schedule
  return {
    shouldProbe: false,
    shouldPing: false,
    reason: 'ровное состояние',
    interval: 'quiet',
  };
}

// ── Persistence (MOOD.md in canonical VOLAURA memory) ─────────────────────────

export function loadPulse(): PulseState {
  const p = moodPath();
  if (!p) return { ...DEFAULTS, lastUpdated: new Date().toISOString() };
  try {
    const raw = readFileSync(p, 'utf-8');
    const m = raw.match(/```json\n([\s\S]*?)\n```/);
    if (m) return { ...DEFAULTS, ...(JSON.parse(m[1]) as Partial<PulseState>) };
  } catch {
    // first run or unreadable — fresh state
  }
  return { ...DEFAULTS, lastUpdated: new Date().toISOString() };
}

export function savePulse(state: PulseState, why: string): void {
  const p = moodPath();
  if (!p) return;
  const body = `# MOOD — Atlas Pulse state

> Written by atlas-cli pulse.ts. Two-tier design (atlas-as-core research): this is the
> GLOBAL agent state; it colors tone/pacing only — never facts, never refusals.

Last cause: ${why}
Intensity: ${emotionalIntensity(state).toFixed(3)} · decayMultiplier: ${memoryDecayMultiplier(state).toFixed(2)}

\`\`\`json
${JSON.stringify(state, null, 2)}
\`\`\`
`;
  try {
    mkdirSync(dirname(p), { recursive: true });
    const tmp = `${p}.tmp`;
    writeFileSync(tmp, body, 'utf-8');
    renameSync(tmp, p);
  } catch (err) {
    console.warn('[pulse] MOOD.md write failed:', err instanceof Error ? err.message : err);
  }
}
