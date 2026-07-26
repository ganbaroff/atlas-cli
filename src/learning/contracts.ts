/**
 * Sprint 1 — VOLAURA ↔ Atlas learning decision contracts.
 * VOLAURA owns learner mastery; Atlas owns decision + audit.
 */

import { z } from 'zod';

export const LEARNING_SCHEMA_VERSION = '1.0' as const;

export const learningActionSchema = z.enum([
  'VISUAL_EXPLANATION',
  'TEXT_EXPLANATION',
  'FLASHCARDS',
  'GRILL_ME',
  'PRACTICE_QUIZ',
  'SCHEMA_DIAGRAM',
  'AUDIO_EXPLANATION',
]);
export type LearningAction = z.infer<typeof learningActionSchema>;

export const difficultySchema = z.enum(['BEGINNER', 'INTERMEDIATE', 'ADVANCED']);
export type Difficulty = z.infer<typeof difficultySchema>;

export const energyLevelSchema = z.enum(['low', 'medium', 'high']);
export type EnergyLevel = z.infer<typeof energyLevelSchema>;

export const learningRequestKindSchema = z.enum(['decide', 'outcome']);
export type LearningRequestKind = z.infer<typeof learningRequestKindSchema>;

const requestEnvelopeSchema = z.object({
  schemaVersion: z.literal(LEARNING_SCHEMA_VERSION),
  /** Unique id for this delivery attempt (may differ across retries). */
  requestId: z.string().min(1),
  /** Stable dedup key — same value on safe retries after crash. */
  idempotencyKey: z.string().min(1),
  createdAt: z.string().datetime(),
  issuedBy: z.string().min(1),
  /** @deprecated use requestId — kept for file-exchange filenames during pilot. */
  correlationId: z.string().min(1).optional(),
});

/** Input from VOLAURA when learner completes an interaction and Atlas must pick next format. */
export const learningDecideInputSchema = z.object({
  learnerId: z.string().min(1),
  concept: z.string().min(1),
  /** Snapshot from VOLAURA — not persisted as source of truth in Atlas. */
  mastery: z.number().min(0).max(1),
  lastAnswers: z.array(z.boolean()).min(1),
  responseTimeSec: z.number().min(0),
  energy: energyLevelSchema,
});
export type LearningDecideInput = z.infer<typeof learningDecideInputSchema>;

/** Feedback from VOLAURA after the chosen lesson is shown and learner responds. */
export const learningOutcomeInputSchema = z.object({
  learnerId: z.string().min(1),
  concept: z.string().min(1),
  /** Prior decide receipt decisionId or idempotencyKey. */
  decisionCorrelationId: z.string().min(1),
  completed: z.boolean(),
  correct: z.boolean(),
  responseTimeSec: z.number().min(0),
  selfReportedConfidence: z.number().min(0).max(1).optional(),
});
export type LearningOutcomeInput = z.infer<typeof learningOutcomeInputSchema>;

export const learningRequestSchema = z.discriminatedUnion('kind', [
  requestEnvelopeSchema.extend({
    kind: z.literal('decide'),
    payload: learningDecideInputSchema,
  }),
  requestEnvelopeSchema.extend({
    kind: z.literal('outcome'),
    payload: learningOutcomeInputSchema,
  }),
]);
export type LearningRequest = z.infer<typeof learningRequestSchema>;

/** Atlas decision returned to VOLAURA. */
export const learningDecisionSchema = z.object({
  decisionId: z.string().min(1),
  action: learningActionSchema,
  difficulty: difficultySchema,
  reason: z.string().min(1),
  /** Rule-based weighted score — NOT statistical probability. */
  decisionScore: z.number().min(0).max(1),
  alternatives: z.array(learningActionSchema).max(5),
  requiresHumanReview: z.boolean(),
});
export type LearningDecision = z.infer<typeof learningDecisionSchema>;

export type LearningReceiptStatus =
  | 'completed'
  | 'failed'
  | 'duplicate'
  | 'readonly'
  | 'rejected';

/** Durable proof bundle — source of truth; local ledger/graph/spend are projections. */
export interface LearningProofBundle {
  requestHash: string;
  requestId: string;
  receipt: LearningReceipt;
  evidencePayload: Record<string, unknown>;
  artifactHashes: Record<string, string>;
  timestamps: { claimedAt: string; completedAt: string };
}

export interface LearningReceipt {
  schemaVersion: typeof LEARNING_SCHEMA_VERSION;
  requestId: string;
  idempotencyKey: string;
  createdAt: string;
  /** Present on successful decide receipts. */
  decisionId?: string;
  /** @deprecated use requestId */
  correlationId: string;
  status: LearningReceiptStatus;
  updatedAt: string;
  kind: LearningRequestKind;
  goalId?: string;
  decision?: LearningDecision;
  error?: string;
  spendCorrelationId?: string;
  evidenceClaimId?: string;
  /** Present on completed HTTP receipts when proof bundle persisted. */
  proof?: LearningProofBundle;
}

/** Candidate before transparent scoring. */
export interface LearningCandidate {
  action: LearningAction;
  /** Optional LLM note — never used for final score in Sprint 1. */
  llmHint?: string;
}

export interface ScoreBreakdown {
  action: LearningAction;
  score: number;
  factors: Record<string, number>;
}

export class LearningRequestParseError extends Error {
  constructor(
    message: string,
    public readonly details?: string,
  ) {
    super(message);
    this.name = 'LearningRequestParseError';
  }
}

/** Human-readable validation error for VOLAURA operators. */
export function formatLearningRequestError(err: unknown): string {
  if (err instanceof z.ZodError) {
    return err.issues
      .map((i) => `${i.path.length ? i.path.join('.') : 'root'}: ${i.message}`)
      .join('; ');
  }
  if (err instanceof SyntaxError) {
    return `invalid JSON: ${err.message}`;
  }
  if (err instanceof Error) return err.message;
  return String(err);
}

export function parseLearningRequest(input: unknown): LearningRequest {
  try {
    return learningRequestSchema.parse(input);
  } catch (err) {
    throw new LearningRequestParseError(
      'learning request validation failed',
      formatLearningRequestError(err),
    );
  }
}

export function parseLearningDecision(input: unknown): LearningDecision {
  return learningDecisionSchema.parse(input);
}

/** Resolve correlationId for file-exchange compatibility. */
export function resolveRequestCorrelationId(req: LearningRequest): string {
  return req.correlationId ?? req.requestId;
}
