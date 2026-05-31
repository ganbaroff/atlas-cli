import { existsSync } from 'node:fs';
import type { TurnEvidenceSource } from '../atlas/turn-evidence.js';
import { collectProofTokens } from '../atlas/turn-evidence.js';
import type { OperatorResult } from './contracts.js';

export interface PromotionState {
  last_run?: {
    status?: string;
    trace_path?: string;
    proof_tokens?: string[];
    evaluation?: OperatorResult['evaluation'];
  };
}

export interface PromotionDecision {
  promoted: boolean;
  status: 'promoted' | 'blocked';
  reason: string;
  safe_reply: string;
  proof_tokens: string[];
  current_turn_proof_tokens: string[];
  winning_result_path?: string;
  source_result_path?: string;
  retry_result_path?: string;
  final_verdict?: 'passed' | 'blocked';
}

export interface PromotionDecisionInput {
  state?: PromotionState;
  result?: OperatorResult;
  evidence?: TurnEvidenceSource;
  artifactExists?: (path: string) => boolean;
}

export const PROMOTION_SAFE_REPLY = 'Не подтверждено. Проверю.';

function unique(values: Array<string | undefined>): string[] {
  return [...new Set(values.filter((value): value is string => Boolean(value && value.trim().length > 0)))];
}

function resultProofTokens(result?: OperatorResult): string[] {
  return unique((result?.evidence ?? []).map((item) => item.proof_token ?? item.id));
}

function blocked(
  reason: string,
  input: PromotionDecisionInput,
  extras: Partial<PromotionDecision> = {},
): PromotionDecision {
  const currentTurnProofTokens = collectProofTokens(input.evidence);
  return {
    promoted: false,
    status: 'blocked',
    reason,
    safe_reply: PROMOTION_SAFE_REPLY,
    proof_tokens: unique([
      ...(input.state?.last_run?.proof_tokens ?? []),
      ...resultProofTokens(input.result),
      ...currentTurnProofTokens,
    ]),
    current_turn_proof_tokens: currentTurnProofTokens,
    ...extras,
  };
}

export function decidePromotion(input: PromotionDecisionInput = {}): PromotionDecision {
  const artifactExists = input.artifactExists ?? existsSync;
  const evaluation = input.result?.evaluation ?? input.state?.last_run?.evaluation;
  const currentTurnProofTokens = collectProofTokens(input.evidence);
  const proofTokens = unique([
    ...(input.state?.last_run?.proof_tokens ?? []),
    ...resultProofTokens(input.result),
    ...currentTurnProofTokens,
  ]);

  if (!evaluation) {
    return blocked('promotion blocked: evaluator verdict missing', input);
  }

  const finalVerdict = evaluation.final_verdict ?? (evaluation.passed ? 'passed' : 'blocked');
  const winningResultPath = evaluation.winning_result_path;

  if (!evaluation.passed || finalVerdict !== 'passed') {
    return blocked('promotion blocked: evaluator verdict did not pass', input, {
      final_verdict: finalVerdict,
      winning_result_path: winningResultPath,
      source_result_path: evaluation.source_result_path,
      retry_result_path: evaluation.retry_result_path,
    });
  }

  if (!winningResultPath) {
    return blocked('promotion blocked: winning_result_path missing', input, {
      final_verdict: finalVerdict,
      source_result_path: evaluation.source_result_path,
      retry_result_path: evaluation.retry_result_path,
    });
  }

  if (!artifactExists(winningResultPath)) {
    return blocked(`promotion blocked: winning result missing: ${winningResultPath}`, input, {
      final_verdict: finalVerdict,
      winning_result_path: winningResultPath,
      source_result_path: evaluation.source_result_path,
      retry_result_path: evaluation.retry_result_path,
    });
  }

  if (evaluation.retry_used && (!evaluation.retry_result_path || !artifactExists(evaluation.retry_result_path))) {
    return blocked('promotion blocked: retry result missing', input, {
      final_verdict: finalVerdict,
      winning_result_path: winningResultPath,
      source_result_path: evaluation.source_result_path,
      retry_result_path: evaluation.retry_result_path,
    });
  }

  if (proofTokens.length === 0) {
    return blocked('promotion blocked: proof tokens missing', input, {
      final_verdict: finalVerdict,
      winning_result_path: winningResultPath,
      source_result_path: evaluation.source_result_path,
      retry_result_path: evaluation.retry_result_path,
    });
  }

  return {
    promoted: true,
    status: 'promoted',
    reason: 'promotion passed: evaluator verdict and durable proof present',
    safe_reply: PROMOTION_SAFE_REPLY,
    proof_tokens: proofTokens,
    current_turn_proof_tokens: currentTurnProofTokens,
    final_verdict: finalVerdict,
    winning_result_path: winningResultPath,
    source_result_path: evaluation.source_result_path,
    retry_result_path: evaluation.retry_result_path,
  };
}
