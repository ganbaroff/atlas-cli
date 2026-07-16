/**
 * Atlas FinOps policy — the stop-cranes the cerebras incident proved we lacked.
 *
 * One place decides, for every model call in the gateway, whether it is allowed:
 *   - ATLAS_PAUSE=1            → kill switch: brain-loop & swarm decompose refuse.
 *   - ATLAS_ALLOW_PAID!=1      → paid providers (openai/openrouter/anthropic) refuse.
 *   - ATLAS_DAILY_TOKEN_CAP    → over cap: free providers warn-once, paid hard-block.
 *   - ATLAS_BRAIN_QUEUE_CAP    → max autonomous queue seeds per UTC day.
 *
 * All limits read env lazily (tests / redeploy can flip them without a rebuild).
 */

import { getDailyTokenTotal } from './spend-tracker.js';
import { loadPolicy } from './policy.js';

export const PAID_PROVIDERS = new Set(['openai', 'openrouter', 'anthropic']);

const DEFAULT_DAILY_TOKEN_CAP = 500_000;
const DEFAULT_BRAIN_QUEUE_CAP = 20;

export function isPaidProvider(provider: string): boolean {
  return PAID_PROVIDERS.has(provider);
}

/** ATLAS_PAUSE=1 kill switch — halts autonomy (brain-loop, swarm decompose). */
export function isPaused(): boolean {
  const v = (process.env['ATLAS_PAUSE'] ?? '').trim().toLowerCase();
  return v === '1' || v === 'true' || v === 'yes';
}

/** ATLAS_ALLOW_PAID=1 — paid providers stay off unless explicitly enabled. */
export function paidAllowed(): boolean {
  const v = (process.env['ATLAS_ALLOW_PAID'] ?? '').trim().toLowerCase();
  return v === '1' || v === 'true' || v === 'yes';
}

export function dailyTokenCap(): number {
  // Precedence: ATLAS_DAILY_TOKEN_CAP env > config/policy.yaml token.daily_cap >
  // DEFAULT_DAILY_TOKEN_CAP (policy.ts falls back to the same 500k default).
  const raw = process.env['ATLAS_DAILY_TOKEN_CAP'];
  if (raw) {
    const n = parseInt(raw, 10);
    if (Number.isFinite(n) && n > 0) return n;
  }
  return loadPolicy().token.daily_cap;
}

export function brainQueueCap(): number {
  const raw = process.env['ATLAS_BRAIN_QUEUE_CAP'];
  if (!raw) return DEFAULT_BRAIN_QUEUE_CAP;
  const n = parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_BRAIN_QUEUE_CAP;
}

export function overDailyCap(): boolean {
  return getDailyTokenTotal() >= dailyTokenCap();
}

// Warn-once latch for free-provider over-cap spam (resets on UTC date change).
let warnedDate = '';
function warnOverCapOnce(caller: string): void {
  const today = new Date().toISOString().slice(0, 10);
  if (warnedDate !== today) {
    warnedDate = today;
    console.warn(
      `[finops] daily token cap ${dailyTokenCap()} exceeded (used ${getDailyTokenTotal()}). ` +
      `Free providers continue; paid providers hard-blocked. caller=${caller}`,
    );
  }
}

export class SpendBlockedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SpendBlockedError';
  }
}

/**
 * Gate one model call. Throws SpendBlockedError when the call must not proceed.
 * Called inside the model gateway BEFORE any tokens are spent.
 *
 *   - paid provider + ATLAS_ALLOW_PAID off   → block.
 *   - paid provider + over daily cap         → block.
 *   - free provider + over daily cap         → allow, warn once.
 */
export function enforceSpendPolicy(provider: string, caller: string): void {
  const paid = isPaidProvider(provider);

  if (paid && !paidAllowed()) {
    throw new SpendBlockedError(
      `Paid provider '${provider}' refused: ATLAS_ALLOW_PAID is not set. (caller=${caller})`,
    );
  }

  if (overDailyCap()) {
    if (paid) {
      throw new SpendBlockedError(
        `Paid provider '${provider}' hard-blocked: daily token cap ${dailyTokenCap()} exceeded. (caller=${caller})`,
      );
    }
    warnOverCapOnce(caller);
  }
}

// ── Brain-loop daily queue cap ──
let queueDay = '';
let queueCount = 0;

/**
 * Register one autonomous queue seed against today's cap.
 * Returns true if allowed (and counts it); false if the daily cap is reached.
 */
export function tryConsumeBrainQueueSlot(): boolean {
  const today = new Date().toISOString().slice(0, 10);
  if (queueDay !== today) {
    queueDay = today;
    queueCount = 0;
  }
  if (queueCount >= brainQueueCap()) return false;
  queueCount += 1;
  return true;
}

export function getBrainQueueCount(): number {
  const today = new Date().toISOString().slice(0, 10);
  if (queueDay !== today) return 0;
  return queueCount;
}

export function resetBrainQueueCounter(): void {
  queueDay = new Date().toISOString().slice(0, 10);
  queueCount = 0;
}
