/**
 * Emotional-decay scoring — the pure-TS mirror of the SQL `recall_atlas_memories`
 * ranking formula (db/migrations/001_emotional_memory.sql). Prod ranks memories in
 * Postgres; this exists so the formula is DOCUMENTED and TESTABLE in the repo without
 * a live DB, and so any future TS-side recall can reuse the identical math.
 *
 *   decay_score = emotional_intensity * exp( -age_days / (7 * decay_multiplier) )
 *
 * High-emotion memories decay slower (decay_multiplier = 1 + intensity*2, so their
 * time constant τ = 7 * multiplier stretches from 7 → 77 days across intensity 0-5),
 * and the leading intensity factor makes zero-emotion rows score 0 regardless of age.
 * Keep this in lock-step with the SQL body: change one, change both.
 */

/** Base half-life-ish time constant (days) before emotional weighting. Matches SQL `7.0`. */
export const DECAY_BASE_DAYS = 7;

export interface DecayInput {
  emotionalIntensity: number; // ZenBrain 0-5 (emotion.ts finishRead)
  decayMultiplier: number; // 1.0 + intensity*2.0 (emotion.ts:175)
  ageDays: number; // now - created_at, in days (>= 0)
}

/**
 * Score one memory. Mirrors the SQL exactly, including the `greatest(mult, 0.0001)`
 * guard that prevents a divide-by-zero if a row somehow has multiplier 0.
 */
export function decayScore(input: DecayInput): number {
  const { emotionalIntensity, decayMultiplier, ageDays } = input;
  const tau = DECAY_BASE_DAYS * Math.max(decayMultiplier, 0.0001);
  return emotionalIntensity * Math.exp(-Math.max(ageDays, 0) / tau);
}
