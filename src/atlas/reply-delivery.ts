import { repairReply, type ReplyGateRepairResult } from './reply-gates.js';
import {
  decideCompletionEmit,
  type CompletionEmitDecision,
  type TurnEvidenceSource,
} from '../gates/verify-completion-walk.js';

export interface ReplyDeliveryResult {
  reply: string;
  repaired: ReplyGateRepairResult;
  emitDecision: CompletionEmitDecision;
}

export async function deliverReply(
  reply: string,
  retry: (prompt: string) => Promise<string | { reply: string; evidence?: TurnEvidenceSource }>,
  evidence?: TurnEvidenceSource,
): Promise<ReplyDeliveryResult> {
  const repaired = await repairReply(reply, retry, evidence);
  const emitDecision = decideCompletionEmit(repaired.reply, repaired.replyEvidence ?? evidence);

  return {
    reply: emitDecision.emitReply,
    repaired,
    emitDecision,
  };
}
