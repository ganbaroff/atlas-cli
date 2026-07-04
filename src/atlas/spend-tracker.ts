/**
 * Atlas FinOps spend tracker — every LLM call flows through here.
 *
 * Why this exists: cerebras was tagged free-tier but silently burned loaded
 * funds because nothing in the codebase knew prices or logged spend. This is
 * the single meter: it estimates cost from a static price map, appends a row
 * to Supabase `llm_spend`, and keeps an in-memory daily counter for the
 * morning briefing / heartbeat rollup.
 *
 * Contract (matches supabase-memory.ts): lazy env, NON-BLOCKING. A Supabase
 * failure is logged and swallowed — spend telemetry must never break a reply.
 */

import { isSupabaseConfigured } from './supabase-memory.js';

export type SpendProvider =
  | 'ollama'
  | 'freellmapi'
  | 'groq'
  | 'nvidia'
  | 'openai'
  | 'openrouter'
  | 'anthropic'
  | string;

export interface RecordSpendInput {
  provider: SpendProvider;
  model: string;
  tokensIn: number;
  tokensOut: number;
  /** Channel tag: telegram | cli | swarm | brain-loop | api. */
  caller: string;
}

/**
 * Rough $/1M-token prices. Free/local providers = 0. Paid providers use a
 * blended input/output constant (deliberately conservative — over-estimates
 * so the daily cap trips early rather than late). Update as pricing shifts.
 */
const PRICE_PER_MILLION: Record<string, { in: number; out: number }> = {
  // Free / local tiers
  ollama: { in: 0, out: 0 },
  freellmapi: { in: 0, out: 0 },
  groq: { in: 0, out: 0 },
  nvidia: { in: 0, out: 0 },
  // Paid tiers (rough public list prices, USD per 1M tokens)
  openai: { in: 0.15, out: 0.6 }, // gpt-4o-mini class
  openrouter: { in: 0.3, out: 0.5 }, // grok-3-mini class (varies by model)
  anthropic: { in: 3, out: 15 }, // claude sonnet class
};

export function estimateCostUsd(
  provider: SpendProvider,
  tokensIn: number,
  tokensOut: number,
): number {
  const price = PRICE_PER_MILLION[provider] ?? { in: 0, out: 0 };
  const cost =
    (Math.max(0, tokensIn) / 1_000_000) * price.in +
    (Math.max(0, tokensOut) / 1_000_000) * price.out;
  // Round to 6 decimals — sub-cent precision without float noise.
  return Math.round(cost * 1_000_000) / 1_000_000;
}

// ── In-memory daily counter (resets on UTC date change) ──
interface DailyCounter {
  date: string; // YYYY-MM-DD (UTC)
  tokensIn: number;
  tokensOut: number;
  costUsd: number;
  calls: number;
}

function todayUtc(): string {
  return new Date().toISOString().slice(0, 10);
}

let daily: DailyCounter = {
  date: todayUtc(),
  tokensIn: 0,
  tokensOut: 0,
  costUsd: 0,
  calls: 0,
};

function rollIfNewDay(): void {
  const today = todayUtc();
  if (daily.date !== today) {
    daily = { date: today, tokensIn: 0, tokensOut: 0, costUsd: 0, calls: 0 };
  }
}

/** Snapshot of today's accumulated spend (in-memory, since process start). */
export function getDailySpend(): Readonly<DailyCounter> {
  rollIfNewDay();
  return { ...daily };
}

/** Total tokens (in+out) counted today — used by the cap enforcer. */
export function getDailyTokenTotal(): number {
  rollIfNewDay();
  return daily.tokensIn + daily.tokensOut;
}

/** Reset the counter (tests / manual). */
export function resetDailySpend(): void {
  daily = { date: todayUtc(), tokensIn: 0, tokensOut: 0, costUsd: 0, calls: 0 };
}

async function writeSpendRow(row: {
  provider: string;
  model: string;
  tokens_in: number;
  tokens_out: number;
  est_cost_usd: number;
  caller: string;
}): Promise<void> {
  const url = process.env['SUPABASE_URL'] ?? '';
  const key = process.env['SUPABASE_SERVICE_ROLE_KEY'] ?? '';
  if (!url || !key) return;
  const isLegacyJWT = key.startsWith('eyJ');
  const headers: Record<string, string> = {
    apikey: key,
    'Content-Type': 'application/json',
    Prefer: 'return=minimal',
  };
  if (isLegacyJWT) headers['Authorization'] = `Bearer ${key}`;
  const res = await fetch(`${url}/rest/v1/llm_spend`, {
    method: 'POST',
    headers,
    body: JSON.stringify(row),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Supabase ${res.status}: ${body.slice(0, 200)}`);
  }
}

/**
 * Record one LLM call's spend. Estimates cost, bumps the in-memory daily
 * counter synchronously, and fires a Supabase insert in the background.
 * NEVER throws — telemetry failures are logged, not propagated.
 */
export function recordSpend(input: RecordSpendInput): number {
  const tokensIn = Number.isFinite(input.tokensIn) ? Math.max(0, Math.trunc(input.tokensIn)) : 0;
  const tokensOut = Number.isFinite(input.tokensOut) ? Math.max(0, Math.trunc(input.tokensOut)) : 0;
  const estCost = estimateCostUsd(input.provider, tokensIn, tokensOut);

  rollIfNewDay();
  daily.tokensIn += tokensIn;
  daily.tokensOut += tokensOut;
  daily.costUsd = Math.round((daily.costUsd + estCost) * 1_000_000) / 1_000_000;
  daily.calls += 1;

  if (isSupabaseConfigured()) {
    writeSpendRow({
      provider: String(input.provider),
      model: input.model,
      tokens_in: tokensIn,
      tokens_out: tokensOut,
      est_cost_usd: estCost,
      caller: input.caller,
    }).catch((err) =>
      console.error('[spend] llm_spend write failed:', err instanceof Error ? err.message : err),
    );
  }

  return estCost;
}

/**
 * Convenience: pull token usage off a Mastra/AI-SDK generate result (shape
 * varies across SDK versions) and record it. Missing usage → 0 tokens, still
 * logs the call so the row count reflects real traffic.
 */
export function recordSpendFromResult(
  result: unknown,
  meta: { provider: SpendProvider; model: string; caller: string },
): number {
  const usage = (result as { usage?: Record<string, unknown> } | undefined)?.usage ?? {};
  const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
  const tokensIn = num(usage['inputTokens']) || num(usage['promptTokens']);
  const tokensOut = num(usage['outputTokens']) || num(usage['completionTokens']);
  return recordSpend({
    provider: meta.provider,
    model: meta.model,
    tokensIn,
    tokensOut,
    caller: meta.caller,
  });
}
