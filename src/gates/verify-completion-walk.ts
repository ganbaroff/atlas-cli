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
  promotion?: {
    promoted: boolean;
    status: 'promoted' | 'blocked';
    reason: string;
  };
  reason?: string;
}

export interface CompletionEmitOptions {
  promotion?: CompletionEmitDecision['promotion'];
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
  options: CompletionEmitOptions = {},
): CompletionEmitDecision {
  const claimDetected = hasCompletionClaim(reply);
  const proofTokens = collectProofTokens(evidence);
  const matchedProofTokens = matchProofTokens(reply, proofTokens);
  const promotion = options.promotion;

  if (!claimDetected) {
    return {
      emitReply: reply,
      emitOriginalReply: true,
      claimDetected: false,
      proofTokens,
      matchedProofTokens,
      promotion,
    };
  }

  if (proofTokens.length > 0 && hasProofCitation(reply, proofTokens) && promotion?.promoted) {
    return {
      emitReply: reply,
      emitOriginalReply: true,
      claimDetected: true,
      proofTokens,
      matchedProofTokens,
      promotion,
    };
  }

  return {
    emitReply: SAFE_DOWNGRADE,
    emitOriginalReply: false,
    claimDetected: true,
    proofTokens,
    matchedProofTokens,
    promotion,
    reason: proofTokens.length > 0
      ? (hasProofCitation(reply, proofTokens)
        ? `completion claim without promoted task result: ${promotion?.reason ?? 'promotion missing'}`
        : 'completion claim without cited proof-token')
      : 'completion claim without proof-token',
  };
}

export const verifyCompletionWalk = decideCompletionEmit;
