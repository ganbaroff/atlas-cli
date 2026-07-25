/**
 * Sprint 1 — candidate action generator.
 * LLM may suggest ordering/hints; all candidates enter the transparent scorer.
 */

import {
  learningActionSchema,
  type LearningAction,
  type LearningCandidate,
  type LearningDecideInput,
} from './contracts.js';

export type LlmCandidateSuggestFn = (
  input: LearningDecideInput,
) => Promise<{ actions: LearningAction[]; hint?: string }>;

const ALL_ACTIONS = learningActionSchema.options;

const CONCEPT_PREFERRED: Record<string, LearningAction[]> = {
  sigmoid: ['VISUAL_EXPLANATION', 'SCHEMA_DIAGRAM', 'PRACTICE_QUIZ'],
  derivative: ['VISUAL_EXPLANATION', 'TEXT_EXPLANATION', 'PRACTICE_QUIZ'],
};

function defaultCandidates(input: LearningDecideInput): LearningCandidate[] {
  const conceptKey = input.concept.toLowerCase();
  const preferred = CONCEPT_PREFERRED[conceptKey] ?? [];
  const ordered = [
    ...preferred,
    ...ALL_ACTIONS.filter((a) => !preferred.includes(a)),
  ];
  return ordered.map((action) => ({ action }));
}

/**
 * Build candidate list for NBA scoring.
 * When llmSuggest is provided, its actions are prepended (deduped) with optional hint attached.
 */
export async function generateCandidates(
  input: LearningDecideInput,
  opts?: { llmSuggest?: LlmCandidateSuggestFn },
): Promise<LearningCandidate[]> {
  const base = defaultCandidates(input);
  if (!opts?.llmSuggest) return base;

  try {
    const suggestion = await opts.llmSuggest(input);
    const seen = new Set<LearningAction>();
    const merged: LearningCandidate[] = [];
    for (const action of suggestion.actions) {
      if (seen.has(action)) continue;
      seen.add(action);
      merged.push({ action, llmHint: suggestion.hint });
    }
    for (const c of base) {
      if (seen.has(c.action)) continue;
      seen.add(c.action);
      merged.push(c);
    }
    return merged;
  } catch {
    return base;
  }
}
