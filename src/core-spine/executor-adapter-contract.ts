/**
 * Executor Adapter Contract — normalized interface for future replaceable hands.
 * No Hermes/OpenManus/Cursor/Codex implementations in this module.
 */
import { z } from 'zod';
import { taskIdSchema } from '../exec-graph/contracts.js';

export class ExecutorAdapterContractError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ExecutorAdapterContractError';
  }
}

export const networkPolicySchema = z.enum(['deny', 'allowlist', 'unrestricted']);
export type NetworkPolicy = z.infer<typeof networkPolicySchema>;

export const executorSpendPolicySchema = z.object({
  allowPaid: z.boolean(),
  maxTokens: z.number().int().nonnegative(),
});

export const inputTaskContractSchema = z.object({
  taskId: taskIdSchema,
  objective: z.string().min(1),
  declaredEffects: z.array(z.string().min(1)).min(1),
});

export const cancellationSchema = z.object({
  supported: z.boolean(),
  signal: z.enum(['cooperative', 'hard', 'unsupported']),
});

export const executorAdapterContractSchema = z
  .object({
    adapterId: z.string().min(1),
    version: z.string().min(1),
    capabilities: z.array(z.string().min(1)).min(1),
    requiredPermissions: z.array(z.string().min(1)).min(1),
    allowedPaths: z.array(z.string().min(1)).min(1),
    allowedCommands: z.array(z.string().min(1)).min(1),
    networkPolicy: networkPolicySchema,
    spendPolicy: executorSpendPolicySchema,
    inputTaskContract: inputTaskContractSchema,
    /** Optional runtime fields filled by executors during/after a run. */
    executionStatus: z
      .enum(['idle', 'running', 'cancelled', 'timed-out', 'succeeded', 'failed', 'partial'])
      .optional(),
    producedArtifacts: z.array(z.string().min(1)).optional(),
    commandsEffectsPerformed: z.array(z.string().min(1)).optional(),
    evidenceCollected: z.array(z.string().min(1)).optional(),
    errorReport: z.string().min(1).optional(),
    partialSuccessReport: z.string().min(1).optional(),
    cancellation: cancellationSchema,
    timeoutMs: z.number().int().positive(),
  })
  .superRefine((c, ctx) => {
    if (!c.adapterId.trim()) {
      ctx.addIssue({ code: 'custom', path: ['adapterId'], message: 'adapter identity required' });
    }
    if (c.requiredPermissions.length === 0) {
      ctx.addIssue({
        code: 'custom',
        path: ['requiredPermissions'],
        message: 'unknown/empty permissions fail-closed',
      });
    }
  });

export type ExecutorAdapterContract = z.infer<typeof executorAdapterContractSchema>;

export function parseExecutorAdapterContract(input: unknown): ExecutorAdapterContract {
  const r = executorAdapterContractSchema.safeParse(input);
  if (!r.success) {
    throw new ExecutorAdapterContractError(r.error.issues.map((i) => i.message).join('; '));
  }
  return r.data;
}
