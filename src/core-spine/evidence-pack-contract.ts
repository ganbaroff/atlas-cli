/**
 * Evidence Pack Contract — goal→…→receipt standardization.
 * Narrative alone is never sufficient.
 */
import { z } from 'zod';
import { taskIdSchema } from '../exec-graph/contracts.js';

export class EvidencePackError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EvidencePackError';
  }
}

const sha256Hex = z.string().regex(/^[a-f0-9]{64}$/i, 'diff/output hash must be 64 hex chars');

export const commandRunSchema = z.object({
  command: z.string().min(1),
  exitCode: z.number().int(),
  /** Required 64-hex output hash — narrative stdout is not enough. */
  outputHash: z.string().regex(/^[a-f0-9]{64}$/i, 'outputHash must be 64 hex chars'),
  skipped: z.boolean().optional(),
});

export const evidencePackSchema = z
  .object({
    taskId: taskIdSchema,
    changeId: z.string().min(1),
    projectId: z.string().min(1),
    baseCommit: z.string().min(7),
    executorIdentity: z.string().min(1),
    declaredEffects: z.array(z.string().min(1)).min(1),
    actualEffects: z.array(z.string().min(1)).min(1),
    diffHash: sha256Hex,
    commandsRun: z.array(commandRunSchema),
    testCommands: z.array(commandRunSchema),
    costRecord: z.object({
      provider: z.string().min(1),
      tokens: z.number().int().nonnegative(),
      paid: z.boolean(),
    }),
    verifierResult: z.object({
      verified: z.boolean(),
      reason: z.string().min(1),
      verifierId: z.string().min(1),
    }),
    rollbackState: z.object({
      available: z.boolean(),
      method: z.string(),
      proven: z.boolean(),
    }),
    ceoDecision: z.enum(['pending', 'approved', 'rejected', 'deferred']),
  })
  .superRefine((p, ctx) => {
    if (!p.diffHash || p.diffHash.length !== 64) {
      ctx.addIssue({ code: 'custom', path: ['diffHash'], message: 'diff hash required' });
    }
    if (p.commandsRun.length === 0 && p.testCommands.length === 0) {
      ctx.addIssue({
        code: 'custom',
        path: ['commandsRun'],
        message: 'narrative-only success forbidden: commands or tests required',
      });
    }
  });

export type EvidencePack = z.infer<typeof evidencePackSchema>;

export function parseEvidencePack(input: unknown): EvidencePack {
  const r = evidencePackSchema.safeParse(input);
  if (!r.success) {
    throw new EvidencePackError(r.error.issues.map((i) => i.message).join('; '));
  }
  return r.data;
}
