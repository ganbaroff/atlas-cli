/**
 * verify_completion_walk — emit decision for completion claims.
 *
 * If reply claims completion but current turn has no cited proof token,
 * downgrade claim before emit. No retry loop here. Substrate only.
 */

import {
  collectProofTokens,
  hasProofCitation,
  matchProofTokens,
  type TurnEvidenceSource,
} from '../atlas/turn-evidence.js';

export type { TurnEvidenceSource };
export { collectProofTokens, hasProofCitation, matchProofTokens };

export interface CompletionEmitDecision {
  emitReply: string;
  emitOriginalReply: boolean;
  claimDetected: boolean;
  proofTokens: string[];
  matchedProofTokens: string[];
  reason?: string;
}

const COMPLETION_CLAIM_KEYWORDS = [
  'done',
  'готово',
  'completed',
  'shipped',
  'fixed',
  'verified',
  'passed',
  'works',
  'work',
  'worked',
  'success',
  'successful',
  'successfully',
  'закрыто',
  'closed',
  'проверено',
  'сделано',
];
const SAFE_DOWNGRADE = 'Не подтверждено. Проверю.';

function hasCompletionClaim(reply: string): boolean {
  const lower = reply.toLowerCase();
  if (lower.includes('✅')) return true;
  return COMPLETION_CLAIM_KEYWORDS.some((keyword) => lower.includes(keyword));
}

export function decideCompletionEmit(
  reply: string,
  evidence?: TurnEvidenceSource,
): CompletionEmitDecision {
  const claimDetected = hasCompletionClaim(reply);
  const proofTokens = collectProofTokens(evidence);
  const matchedProofTokens = matchProofTokens(reply, proofTokens);

  if (!claimDetected) {
    return {
      emitReply: reply,
      emitOriginalReply: true,
      claimDetected: false,
      proofTokens,
      matchedProofTokens,
    };
  }

  if (proofTokens.length > 0 && hasProofCitation(reply, proofTokens)) {
    return {
      emitReply: reply,
      emitOriginalReply: true,
      claimDetected: true,
      proofTokens,
      matchedProofTokens,
    };
  }

  return {
    emitReply: SAFE_DOWNGRADE,
    emitOriginalReply: false,
    claimDetected: true,
    proofTokens,
    matchedProofTokens,
    reason: proofTokens.length > 0
      ? 'completion claim without cited proof-token'
      : 'completion claim without proof-token',
  };
}

export const verifyCompletionWalk = decideCompletionEmit;
