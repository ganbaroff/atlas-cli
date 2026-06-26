import { repairReply, type ReplyGateRepairResult } from './reply-gates.js';
import {
  decideCompletionEmit,
  type CompletionEmitDecision,
  type TurnEvidenceSource,
} from '../gates/verify-completion-walk.js';
import { readOperatorState, type OperatorStateRecord } from './control-plane.js';
import { decidePromotion, type PromotionDecision } from '../operator/promotion.js';

export interface ReplyDeliveryResult {
  reply: string;
  repaired: ReplyGateRepairResult;
  emitDecision: CompletionEmitDecision;
  promotion: PromotionDecision;
}

export interface ReplyDeliveryOptions {
  state?: OperatorStateRecord;
  promotion?: PromotionDecision;
}

export async function deliverReply(
  reply: string,
  retry: (prompt: string) => Promise<string | { reply: string; evidence?: TurnEvidenceSource }>,
  evidence?: TurnEvidenceSource,
  options: ReplyDeliveryOptions = {},
): Promise<ReplyDeliveryResult> {
  const repaired = await repairReply(reply, retry, evidence);
  const replyEvidence = repaired.replyEvidence ?? evidence;
  const promotion = options.promotion ?? decidePromotion({
    state: options.state ?? readOperatorState(),
    evidence: replyEvidence,
  });
  const emitDecision = decideCompletionEmit(repaired.reply, replyEvidence, { promotion });

  return {
    reply: emitDecision.emitReply,
    repaired,
    emitDecision,
    promotion,
  };
}
