/**
 * Sprint 1 — transparent Next Best Action scorer.
 * No LLM in the scoring path; weights are explicit and testable.
 */

import type {
  Difficulty,
  LearningAction,
  LearningCandidate,
  LearningDecideInput,
  LearningDecision,
  ScoreBreakdown,
} from './contracts.js';
import { applyReviewPolicy } from './review-policy.js';

const MATH_VISUAL_CONCEPTS = new Set(['sigmoid', 'derivative', 'gradient', 'matrix']);

const REASON_TEMPLATES: Record<string, string> = {
  sigmoid: 'Повторяющаяся ошибка в понимании вероятности',
  derivative: 'Повторяющаяся ошибка в понимании скорости изменения',
  default: 'Повторяющаяся ошибка в понимании концепции',
};

/** Per-action weight table keyed by learner signal name. */
const ACTION_WEIGHTS: Record<LearningAction, Record<string, number>> = {
  VISUAL_EXPLANATION: {
    base: 0.1,
    repeatedErrors: 0.22,
    lowMastery: 0.18,
    slowResponse: 0.08,
    mathVisualConcept: 0.12,
    highErrorRate: 0.08,
  },
  SCHEMA_DIAGRAM: {
    base: 0.08,
    repeatedErrors: 0.12,
    lowMastery: 0.1,
    mathVisualConcept: 0.1,
    highErrorRate: 0.04,
  },
  FLASHCARDS: {
    base: 0.08,
    lowMastery: 0.15,
    slowResponse: 0.08,
    lowEnergy: 0.1,
    repeatedErrors: 0.14,
  },
  GRILL_ME: {
    base: 0.1,
    mediumEnergy: 0.15,
    highEnergy: 0.22,
    midErrorRate: 0.1,
    higherMastery: 0.08,
    repeatedErrors: 0.12,
  },
  TEXT_EXPLANATION: {
    base: 0.08,
    higherMastery: 0.15,
    mediumEnergy: 0.06,
  },
  PRACTICE_QUIZ: {
    base: 0.08,
    midMastery: 0.14,
    mediumEnergy: 0.08,
  },
  AUDIO_EXPLANATION: {
    base: 0.08,
    lowEnergy: 0.12,
    slowResponse: 0.06,
  },
};

function clamp01(n: number): number {
  return Math.max(0, Math.min(1, n));
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function errorRate(lastAnswers: boolean[]): number {
  if (!lastAnswers.length) return 0;
  return lastAnswers.filter((a) => !a).length / lastAnswers.length;
}

function pickDifficulty(mastery: number): Difficulty {
  if (mastery < 0.4) return 'BEGINNER';
  if (mastery < 0.7) return 'INTERMEDIATE';
  return 'ADVANCED';
}

function pickReason(concept: string, repeatedErrors: boolean): string {
  const key = concept.toLowerCase();
  if (repeatedErrors && REASON_TEMPLATES[key]) return REASON_TEMPLATES[key]!;
  if (repeatedErrors) return REASON_TEMPLATES.default!;
  return `Низкий mastery по «${concept}» — нужен более простой формат`;
}

function learnerSignals(input: LearningDecideInput): Record<string, number> {
  const err = errorRate(input.lastAnswers);
  const repeatedErrors = input.lastAnswers.filter((a) => !a).length >= 2;
  const conceptKey = input.concept.toLowerCase();
  return {
    repeatedErrors: repeatedErrors ? 1 : 0,
    lowMastery: input.mastery < 0.5 ? 1 : 0,
    slowResponse: input.responseTimeSec > 20 ? 1 : 0,
    highErrorRate: err >= 0.5 ? 1 : 0,
    mathVisualConcept: MATH_VISUAL_CONCEPTS.has(conceptKey) ? 1 : 0,
    lowEnergy: input.energy === 'low' ? 1 : 0,
    mediumEnergy: input.energy === 'medium' ? 1 : 0,
    highEnergy: input.energy === 'high' ? 1 : 0,
    midErrorRate: err >= 0.3 && err < 0.7 ? 1 : 0,
    higherMastery: input.mastery >= 0.5 ? 1 : 0,
    midMastery: input.mastery >= 0.4 && input.mastery < 0.7 ? 1 : 0,
  };
}

/** Score one candidate with explicit factor breakdown. */
export function scoreCandidate(
  input: LearningDecideInput,
  candidate: LearningCandidate,
): ScoreBreakdown {
  const signals = learnerSignals(input);
  const weights = ACTION_WEIGHTS[candidate.action];
  const factors: Record<string, number> = {};

  for (const [signal, weight] of Object.entries(weights)) {
    if (signal === 'base') {
      factors.base = weight;
      continue;
    }
    const active = signals[signal] ?? 0;
    if (active > 0) factors[signal] = weight;
  }

  const score = clamp01(Object.values(factors).reduce((a, b) => a + b, 0));
  return { action: candidate.action, score, factors };
}

export function rankCandidates(
  input: LearningDecideInput,
  candidates: LearningCandidate[],
): ScoreBreakdown[] {
  return candidates
    .map((c) => scoreCandidate(input, c))
    .sort((a, b) => b.score - a.score || a.action.localeCompare(b.action));
}

/** Pick next best action from scored candidates. */
export function decideNextAction(
  input: LearningDecideInput,
  candidates: LearningCandidate[],
): LearningDecision {
  const ranked = rankCandidates(input, candidates);
  const winner = ranked[0]!;
  const alternatives = ranked.slice(1, 3).map((r) => r.action);
  const repeatedErrors = input.lastAnswers.filter((a) => !a).length >= 2;

  const draft = applyReviewPolicy(
    {
      action: winner.action,
      difficulty: pickDifficulty(input.mastery),
      reason: pickReason(input.concept, repeatedErrors),
      decisionScore: round2(winner.score),
      alternatives,
      requiresHumanReview: false,
    },
    input,
  );

  return draft;
}

/** Attach decisionId after scoring — called by request-port only. */
export function finalizeDecision(
  draft: ReturnType<typeof decideNextAction>,
  decisionId: string,
): LearningDecision {
  return { ...draft, decisionId };
}
