/**
 * Atlas Goal Intake v0 — machine-validatable GoalContract.
 * Converts a CEO message into an execution contract bound to exec-graph.
 * Not a second planner or memory system.
 */
import { z } from 'zod';

export class AtlasGoalIntakeError extends Error {
  constructor(
    message: string,
    readonly code:
      | 'UNKNOWN_PROJECT'
      | 'BLOCKED'
      | 'NEEDS_APPROVAL'
      | 'INVALID'
      | 'BIND_FAILED',
  ) {
    super(message);
    this.name = 'AtlasGoalIntakeError';
  }
}

export const goalIntakeRiskSchema = z.enum(['low', 'medium', 'high', 'critical']);
export type GoalIntakeRisk = z.infer<typeof goalIntakeRiskSchema>;

export const goalIntakeStatusSchema = z.enum([
  'ready',
  'needs-approval',
  'blocked',
  'unknown-project',
]);
export type GoalIntakeStatus = z.infer<typeof goalIntakeStatusSchema>;

export const atlasGoalContractSchema = z.object({
  originalCeoMessage: z.string().min(1),
  interpretedObjective: z.string().min(1),
  selectedProject: z.object({
    projectId: z.string().min(1),
    name: z.string().min(1),
  }),
  projectPath: z.string().nullable(),
  relevantCanonicalMemorySources: z.array(z.string()),
  requestedOutcome: z.string().min(1),
  allowedActions: z.array(z.string()).min(1),
  forbiddenActions: z.array(z.string()).min(1),
  riskLevel: goalIntakeRiskSchema,
  approvalRequirements: z.array(z.string()),
  completionCriteria: z.array(z.string()).min(1),
  evidenceRequirements: z.array(z.string()).min(1),
  unresolvedAssumptions: z.array(z.string()),
  recommendedNextWorkflow: z.string().min(1),
  /** Intake control fields (still part of the contract surface). */
  status: goalIntakeStatusSchema,
  facts: z.array(z.string()),
  assumptions: z.array(z.string()),
  conciseCeoSummary: z.string().min(1),
  memoryConflicts: z.array(z.string()).default([]),
  staleMemoryWarnings: z.array(z.string()).default([]),
  execGraphBinding: z
    .object({
      goalId: z.string().min(1),
      taskId: z.string().min(1),
    })
    .optional(),
});

export type AtlasGoalContract = z.infer<typeof atlasGoalContractSchema>;

export function parseAtlasGoalContract(input: unknown): AtlasGoalContract {
  const r = atlasGoalContractSchema.safeParse(input);
  if (!r.success) {
    throw new AtlasGoalIntakeError(r.error.issues.map((i) => i.message).join('; '), 'INVALID');
  }
  return r.data;
}
