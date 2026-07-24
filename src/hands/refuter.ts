/**
 * hands/refuter.ts — Hand Contract V0: the deterministic second-opinion check.
 *
 * WHAT THIS IS: for any non-'low' DelegationRiskClass (security, production,
 * data-mutation, high-blast-radius — see ./risk.ts's needsRefuter()), run an
 * INDEPENDENT second ./verifier.ts's verify() call over the same receipt and
 * require it to agree with the primary verdict. NO LLM, NO paid model, NO
 * network — V0 keeps the refuter fully deterministic specifically to avoid
 * token cost and to keep "does this receipt hold up" reproducible.
 *
 * Because verify() is itself deterministic and pure (no I/O side effects,
 * only reads), running it twice is a real check, not theater: it catches a
 * transient failure mode (e.g. a race where the file existed a moment ago
 * but doesn't now) rather than just re-confirming the same cached answer.
 *
 * Low-risk delegations skip this entirely — {triggered: false, passed: true}
 * — so a 'low' riskClass never pays the double-verify cost.
 */

import { needsRefuter } from './risk.js';
import { verify } from './verifier.js';
import type { DelegationRiskClass } from './contract.js';
import type { Receipt } from './contract.js';

export interface RefuterResult {
  triggered: boolean;
  passed: boolean;
  reason: string;
}

/**
 * Runs the refuter for `brief.riskClass` against `receipt`, comparing its own
 * independent verdict to `primaryVerdict` (the verdict already produced by
 * the caller's first ./verifier.ts verify() call).
 */
export function runRefuter(
  brief: { riskClass: DelegationRiskClass },
  receipt: Receipt,
  primaryVerdict: boolean,
): RefuterResult {
  if (!needsRefuter(brief.riskClass)) {
    return { triggered: false, passed: true, reason: 'low-risk, refuter suppressed' };
  }

  const second = verify(receipt);
  const agree = second.verified === primaryVerdict;
  return {
    triggered: true,
    passed: agree,
    reason: agree
      ? `refuter agrees with primary verdict (${primaryVerdict}): ${second.reason}`
      : `refuter DISAGREES with primary verdict (primary=${primaryVerdict}, refuter=${second.verified}): ${second.reason}`,
  };
}
