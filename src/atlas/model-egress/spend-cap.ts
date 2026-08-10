/**
 * atlas/model-egress/spend-cap.ts — C5A-2 hard spend cap.
 *
 * Non-negotiable #2: a token cap is set BEFORE anything runs, not after the
 * bill arrives. This cap is checked before every forward and charged after
 * every response, and it fails CLOSED in all three ambiguous cases:
 *   - a response with no parseable `usage` is charged `unknownUsageCharge`;
 *   - an upstream error still counts as one request against the request cap;
 *   - once either limit is reached, every later call is refused, including the
 *     one that would only just exceed it.
 *
 * In-process by design for v0: the egress leg is a single long-lived process,
 * and a restart is a deliberate CEO/Atlas act that re-reads the configured cap.
 * Persisting spend across restarts belongs to the later spend-ledger work, not
 * here — an in-memory counter that is honest is better than a durable one that
 * is not yet audited.
 */

import type { SpendCapLimits, SpendSnapshot } from './types.js';

export class SpendCap {
  private requests = 0;
  private totalTokens = 0;

  constructor(private readonly limits: SpendCapLimits) {
    if (limits.maxRequests <= 0 || limits.maxTotalTokens <= 0) {
      throw new Error('model-egress: spend cap must be positive on both axes');
    }
    if (limits.unknownUsageCharge <= 0) {
      throw new Error('model-egress: unknownUsageCharge must be positive, or unknown cost is free');
    }
  }

  /** True only while BOTH axes still have room. Checked before every forward. */
  canSpend(): boolean {
    return this.requests < this.limits.maxRequests && this.totalTokens < this.limits.maxTotalTokens;
  }

  /**
   * Charges one request plus its token cost. `tokens` of null means the usage
   * could not be read — charged at the configured unknown rate rather than zero.
   */
  charge(tokens: number | null): number {
    const charged = tokens === null || !Number.isFinite(tokens) || tokens < 0
      ? this.limits.unknownUsageCharge
      : Math.ceil(tokens);
    this.requests += 1;
    this.totalTokens += charged;
    return charged;
  }

  snapshot(): SpendSnapshot {
    return {
      requests: this.requests,
      totalTokens: this.totalTokens,
      requestsRemaining: Math.max(0, this.limits.maxRequests - this.requests),
      tokensRemaining: Math.max(0, this.limits.maxTotalTokens - this.totalTokens),
    };
  }
}

/**
 * Reads `usage.total_tokens` from an OpenAI-shaped response, falling back to
 * prompt+completion when the total is absent. Returns null on anything it
 * cannot trust — the caller charges the unknown rate for null, so a malformed
 * or hostile usage block can never make a call free.
 */
export function readTotalTokens(body: unknown): number | null {
  if (typeof body !== 'object' || body === null) return null;
  const usage = (body as { usage?: unknown }).usage;
  if (typeof usage !== 'object' || usage === null) return null;

  const total = (usage as { total_tokens?: unknown }).total_tokens;
  if (typeof total === 'number' && Number.isFinite(total) && total >= 0) return total;

  const prompt = (usage as { prompt_tokens?: unknown }).prompt_tokens;
  const completion = (usage as { completion_tokens?: unknown }).completion_tokens;
  if (
    typeof prompt === 'number' && Number.isFinite(prompt) && prompt >= 0 &&
    typeof completion === 'number' && Number.isFinite(completion) && completion >= 0
  ) {
    return prompt + completion;
  }
  return null;
}
