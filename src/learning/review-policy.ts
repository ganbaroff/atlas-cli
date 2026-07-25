/**
 * Sprint 1 — human review gate for NBA decisions.
 */

import type { LearningAction, LearningDecideInput, LearningDecision } from './contracts.js';

export type LearningDecisionDraft = Omit<LearningDecision, 'decisionId'>;

const LOW_DECISION_SCORE_THRESHOLD = 0.5;
const HIGH_MASTERY_REVIEW = 0.85;

/**
 * Escalate to human review when algorithm decisionScore is low or signals conflict.
 * Sprint 1: deterministic rules only.
 */
export function applyReviewPolicy(
  decision: LearningDecisionDraft,
  input: LearningDecideInput,
): LearningDecisionDraft {
  let requiresHumanReview = decision.requiresHumanReview;

  if (decision.decisionScore < LOW_DECISION_SCORE_THRESHOLD) {
    requiresHumanReview = true;
  }

  const recentWrong = input.lastAnswers.filter((a) => !a).length;
  if (input.mastery >= HIGH_MASTERY_REVIEW && recentWrong >= 2) {
    requiresHumanReview = true;
  }

  if (input.energy === 'low' && decision.action === 'GRILL_ME') {
    requiresHumanReview = true;
  }

  return { ...decision, requiresHumanReview };
}
