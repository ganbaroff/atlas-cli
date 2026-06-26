import { z } from 'zod';

export const evidenceTypeSchema = z.enum([
  'file_exists',
  'file_read',
  'command_exit',
  'browser_observation',
  'browser_session_trace',
  'log_trace',
  'manual_note',
]);

export const operatorRouteSchema = z.enum([
  'local',
  'openmanus',
  'octogent',
  'vellum',
  'manual',
]);

export const operatorStatusSchema = z.enum(['success', 'failure', 'blocked', 'skipped']);
export const operatorExecutorSchema = z.enum(['atlas', 'openmanus', 'octogent', 'vellum', 'manual']);
export const operatorVerifierVerdictSchema = z.enum(['passed', 'blocked']);

export const operatorTaskSchema = z.object({
  id: z.string().regex(/^[a-z0-9][a-z0-9._-]{2,80}$/),
  title: z.string().min(3),
  created_at: z.string().datetime(),
  route: operatorRouteSchema,
  mode: z.enum(['read_only', 'write']),
  cwd: z.string().min(1),
  allowed_paths: z.array(z.string().min(1)).min(1),
  objective: z.string().min(10),
  inputs: z.record(z.string(), z.unknown()).default({}),
  expected_evidence: z.array(evidenceTypeSchema).min(1),
  safety: z.object({
    sandbox_required: z.boolean(),
    network_allowed: z.boolean(),
    write_allowed: z.boolean(),
  }),
}).superRefine((task, ctx) => {
  if (task.mode === 'read_only' && task.safety.write_allowed) {
    ctx.addIssue({
      code: 'custom',
      path: ['safety', 'write_allowed'],
      message: 'read_only tasks must not allow writes',
    });
  }

  if (task.mode === 'write' && !task.safety.write_allowed) {
    ctx.addIssue({
      code: 'custom',
      path: ['safety', 'write_allowed'],
      message: 'write tasks must explicitly allow writes',
    });
  }

  if (task.route === 'openmanus' && !task.safety.sandbox_required) {
    ctx.addIssue({
      code: 'custom',
      path: ['safety', 'sandbox_required'],
      message: 'OpenManus tasks require sandbox',
    });
  }

});

export const operatorEvidenceSchema = z.object({
  id: z.string().regex(/^[a-z0-9][a-z0-9._-]{2,100}$/),
  task_id: z.string().regex(/^[a-z0-9][a-z0-9._-]{2,80}$/),
  type: evidenceTypeSchema,
  source: z.string().min(1),
  observed_at: z.string().datetime(),
  summary: z.string().min(3),
  data: z.record(z.string(), z.unknown()).default({}),
  proof_token: z.string().min(1).optional(),
  verifier: z.string().optional(),
});

const operatorEvaluationIssueSchema = z.object({
  code: z.string().min(1),
  message: z.string().min(1),
});

export const operatorEvaluationAttemptSchema = z.object({
  attempt: z.enum(['source', 'retry']),
  result_path: z.string().min(1),
  result_status: z.enum(['success', 'failure', 'blocked', 'skipped']),
  verdict: z.enum(['passed', 'blocked']),
  score: z.number().int().min(0).max(100),
  summary: z.string().min(3),
  issues: z.array(operatorEvaluationIssueSchema),
  proof_tokens: z.array(z.string().min(1)).default([]),
  evidence_paths: z.array(z.string().min(1)).default([]),
});

export const operatorEvaluationSchema = z.object({
  passed: z.boolean(),
  score: z.number().int().min(0).max(100),
  summary: z.string().min(3),
  issues: z.array(operatorEvaluationIssueSchema),
  evaluated_at: z.string().datetime(),
  evaluator: z.string().min(1),
  final_verdict: z.enum(['passed', 'blocked']).optional(),
  retryable_route: z.boolean().optional(),
  retry_used: z.boolean().optional(),
  source_result_path: z.string().min(1).optional(),
  retry_result_path: z.string().min(1).optional(),
  winning_result_path: z.string().min(1).optional(),
  retry_reason: z.string().min(3).optional(),
  result_chain_paths: z.array(z.string().min(1)).default([]),
  evidence_chain_paths: z.array(z.string().min(1)).default([]),
  attempts: z.array(operatorEvaluationAttemptSchema).default([]),
});

export const operatorPromotionSchema = z.object({
  promoted: z.boolean(),
  status: z.enum(['promoted', 'blocked']),
  reason: z.string().min(1),
  safe_reply: z.string().min(1),
  proof_tokens: z.array(z.string().min(1)).default([]),
  current_turn_proof_tokens: z.array(z.string().min(1)).default([]),
  winning_result_path: z.string().min(1).optional(),
  source_result_path: z.string().min(1).optional(),
  retry_result_path: z.string().min(1).optional(),
  final_verdict: z.enum(['passed', 'blocked']).optional(),
});

export const operatorLifecycleSchema = z.object({
  source_task_id: z.string().regex(/^[a-z0-9][a-z0-9._-]{2,80}$/),
  dispatch_result_path: z.string().min(1).optional(),
  evaluation_task_id: z.string().regex(/^[a-z0-9][a-z0-9._-]{2,80}$/).optional(),
  evaluation_result_path: z.string().min(1).optional(),
  promotion_task_id: z.string().regex(/^[a-z0-9][a-z0-9._-]{2,80}$/).optional(),
  promotion_result_path: z.string().min(1).optional(),
  child_result_paths: z.array(z.string().min(1)).default([]),
  proof_tokens: z.array(z.string().min(1)).default([]),
  final_status: z.enum(['success', 'failure', 'blocked', 'skipped']),
  blocked_reason: z.string().min(1).optional(),
});

export const operatorRunLedgerEntrySchema = z.object({
  run_id: z.string().regex(/^[a-z0-9][a-z0-9._-]{2,120}$/),
  task_id: z.string().regex(/^[a-z0-9][a-z0-9._-]{2,80}$/),
  executor: operatorExecutorSchema,
  started_at: z.string().datetime(),
  completed_at: z.string().datetime(),
  status: operatorStatusSchema,
  verdict: operatorVerifierVerdictSchema,
  expected_evidence_met: z.boolean(),
  proof_tokens: z.array(z.string().min(1)).default([]),
  result_path: z.string().min(1),
}).superRefine((entry, ctx) => {
  const startedAt = Date.parse(entry.started_at);
  const completedAt = Date.parse(entry.completed_at);
  if (Number.isFinite(startedAt) && Number.isFinite(completedAt) && completedAt < startedAt) {
    ctx.addIssue({
      code: 'custom',
      path: ['completed_at'],
      message: 'completed_at must be >= started_at',
    });
  }

  if (entry.status !== 'success' && entry.verdict === 'passed') {
    ctx.addIssue({
      code: 'custom',
      path: ['verdict'],
      message: 'non-success executor status cannot receive passed verifier verdict',
    });
  }

  if (entry.verdict === 'passed' && !entry.expected_evidence_met) {
    ctx.addIssue({
      code: 'custom',
      path: ['expected_evidence_met'],
      message: 'passed verifier verdict requires expected evidence to be met',
    });
  }

  if (entry.verdict === 'passed' && entry.proof_tokens.length === 0) {
    ctx.addIssue({
      code: 'custom',
      path: ['proof_tokens'],
      message: 'passed verifier verdict requires at least one proof token',
    });
  }

});

export const operatorResultSchema = z.object({
  task_id: z.string().regex(/^[a-z0-9][a-z0-9._-]{2,80}$/),
  status: operatorStatusSchema,
  executor: operatorExecutorSchema,
  started_at: z.string().datetime(),
  completed_at: z.string().datetime(),
  summary: z.string().min(3),
  evidence: z.array(operatorEvidenceSchema),
  errors: z.array(z.string()).default([]),
  trace_path: z.string().optional(),
  evaluation: operatorEvaluationSchema.optional(),
  promotion: operatorPromotionSchema.optional(),
  lifecycle: operatorLifecycleSchema.optional(),
});

export type OperatorTask = z.infer<typeof operatorTaskSchema>;
export type OperatorEvidence = z.infer<typeof operatorEvidenceSchema>;
export type OperatorEvaluationAttempt = z.infer<typeof operatorEvaluationAttemptSchema>;
export type OperatorEvaluation = z.infer<typeof operatorEvaluationSchema>;
export type OperatorPromotion = z.infer<typeof operatorPromotionSchema>;
export type OperatorLifecycle = z.infer<typeof operatorLifecycleSchema>;
export type OperatorRunLedgerEntry = z.infer<typeof operatorRunLedgerEntrySchema>;
export type OperatorResult = z.infer<typeof operatorResultSchema>;

export function parseOperatorTask(input: unknown): OperatorTask {
  return operatorTaskSchema.parse(input);
}

export function parseOperatorResult(input: unknown): OperatorResult {
  return operatorResultSchema.parse(input);
}

export function parseOperatorRunLedgerEntry(input: unknown): OperatorRunLedgerEntry {
  return operatorRunLedgerEntrySchema.parse(input);
}

export function selectCanonicalRunLedgerEntry(
  entries: OperatorRunLedgerEntry[],
): OperatorRunLedgerEntry | undefined {
  const sorted = [...entries].sort((a, b) => {
    const byCompleted = Date.parse(a.completed_at) - Date.parse(b.completed_at);
    if (byCompleted !== 0) {
      return byCompleted;
    }
    return a.run_id.localeCompare(b.run_id);
  });
  const passed = sorted.filter((entry) => entry.verdict === 'passed');
  return passed.at(-1) ?? sorted.at(-1);
}

export function validateResultEvidence(task: OperatorTask, result: OperatorResult): {
  passed: boolean;
  missing: string[];
} {
  if (result.status !== 'success') {
    return { passed: true, missing: [] };
  }

  const observed = new Set(result.evidence.map((item) => item.type));
  const missing = task.expected_evidence.filter((type) => !observed.has(type));
  return { passed: missing.length === 0, missing };
}
