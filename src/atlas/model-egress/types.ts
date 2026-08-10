/**
 * atlas/model-egress/types.ts — C5A-2: types for the loopback egress leg.
 *
 * WHY THIS EXISTS. The C5A broker (atlas/model-broker) refuses any upstream
 * whose hostname is not loopback, and it asserts that BEFORE it listens
 * (upstream-policy.ts + createBrokerServer). That is its security proof, not a
 * setting — so the broker can only ever forward to something on 127.0.0.1.
 * Until 2026-08-11 the only such thing was mock-upstream.ts, which means "first
 * chat through the broker" was a chat with a mock.
 *
 * This module is the missing half: the ONE process allowed to leave the
 * machine. It listens on loopback (so it is a legal broker upstream), holds the
 * provider auth material, applies the credits ladder and a hard spend cap, and
 * forwards to exactly one real provider.
 *
 * The division of labour is deliberate and must stay this way:
 *   Hermes  -> broker : is this call AUTHORIZED? (signature, nonce, expiry, scope)
 *   broker  -> egress : is this call AFFORDABLE and where does it GO?
 * The broker never learns a provider secret; the egress leg never re-decides
 * authorization. Neither is a second copy of the other.
 */

/**
 * Ladder order is the CEO's standing directive, not a preference:
 * NVIDIA Inception credits -> Vertex -> Azure -> free tiers -> paid last.
 * `paid` tiers exist in the type so a future entry cannot be mislabelled.
 */
export type EgressTier = 'credits' | 'free' | 'paid';

export interface EgressProviderSpec {
  readonly id: string;
  /** Full chat.completions URL. Must be https and must NOT be loopback. */
  readonly chatCompletionsUrl: string;
  /** Name only — this module never stores or logs the value itself. */
  readonly authEnvVar: string;
  readonly tier: EgressTier;
  /** Ladder position; lower wins. Duplicated ranks are a configuration bug. */
  readonly rank: number;
}

/** One machine-readable deny code per refusal class. Mirrors BrokerDenyReason's discipline. */
export type EgressDenyReason =
  | 'no_provider_configured'
  | 'spend_cap_exhausted'
  | 'malformed_request'
  | 'model_mismatch'
  | 'upstream_unavailable'
  | 'upstream_redirect'
  | 'upstream_bad_response'
  | 'upstream_error';

export interface EgressConfig {
  readonly host: '127.0.0.1' | '::1';
  readonly port: number;
  /** Resolved once at startup from the ladder — never re-resolved per request. */
  readonly provider: EgressProviderSpec;
  /** The single model this leg may request. A mismatch is a refusal, not a rewrite. */
  readonly approvedModel: string;
  readonly spendCap: SpendCapLimits;
}

export interface SpendCapLimits {
  readonly maxRequests: number;
  readonly maxTotalTokens: number;
  /**
   * Charged when a response carries no parseable `usage`. Unknown cost must
   * still consume budget, otherwise an upstream that omits usage grants an
   * unlimited allowance.
   */
  readonly unknownUsageCharge: number;
}

export interface SpendSnapshot {
  readonly requests: number;
  readonly totalTokens: number;
  readonly requestsRemaining: number;
  readonly tokensRemaining: number;
}

/** The one thing the egress leg produces per call: a FORWARD/DENY verdict plus receipt metadata. */
export interface EgressDecision {
  readonly decision: 'FORWARD' | 'DENY';
  readonly reason?: EgressDenyReason;
  readonly egressRequestId: string;
  readonly providerId: string | null;
  readonly tier: EgressTier | null;
  readonly model: string | null;
  readonly status: number;
  readonly latencyMs: number;
  readonly tokensCharged: number;
  readonly requestsRemaining: number;
  readonly tokensRemaining: number;
}
