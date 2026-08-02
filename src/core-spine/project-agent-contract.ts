/**
 * Project Agent Contract — machine-validatable boundary for second projects.
 * Personal Atlas memory writes are always prohibited at the schema layer.
 */
import { z } from 'zod';

export class ProjectAgentContractError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ProjectAgentContractError';
  }
}

export const projectAgentContractSchema = z
  .object({
    projectId: z.string().min(1),
    name: z.string().min(1),
    repositoryBoundaries: z.array(z.string().min(1)).min(1),
    allowedReads: z.array(z.string().min(1)).min(1),
    allowedWrites: z.array(z.string().min(1)).min(1),
    forbiddenPaths: z.array(z.string().min(1)).min(1),
    forbiddenActions: z.array(z.string().min(1)).min(1),
    projectMemoryBoundary: z.string().min(1),
    /** Only 'prohibited' is legal — personal canon stays VOLAURA memory/atlas. */
    personalMemoryWrite: z.literal('prohibited'),
    executorAllowlist: z.array(z.string().min(1)).min(1),
    modelSpendPolicy: z.object({
      allowPaid: z.boolean(),
      maxTokens: z.number().int().nonnegative().optional(),
    }),
    verificationRequirements: z.array(z.string().min(1)).min(1),
    rollback: z.object({
      required: z.boolean(),
      method: z.string().min(1),
    }),
    escalation: z.array(z.string().min(1)).min(1),
    emergencyStop: z.string().min(1),
  })
  .superRefine((c, ctx) => {
    if (c.repositoryBoundaries.length === 0) {
      ctx.addIssue({
        code: 'custom',
        path: ['repositoryBoundaries'],
        message: 'repository boundaries required',
      });
    }
    const personalPath = /memory[\\/]+atlas|VOLAURA[\\/]+memory[\\/]+atlas/i;
    for (const [i, w] of c.allowedWrites.entries()) {
      if (personalPath.test(w)) {
        ctx.addIssue({
          code: 'custom',
          path: ['allowedWrites', i],
          message: 'allowedWrites must not include personal Atlas memory paths',
        });
      }
    }
  });

export type ProjectAgentContract = z.infer<typeof projectAgentContractSchema>;

export function parseProjectAgentContract(input: unknown): ProjectAgentContract {
  const r = projectAgentContractSchema.safeParse(input);
  if (!r.success) {
    // Map zod literal failures on personalMemoryWrite to a clear domain error.
    const msg = r.error.issues.map((i) => i.message).join('; ');
    if (String((input as { personalMemoryWrite?: string })?.personalMemoryWrite) === 'allowed') {
      throw new ProjectAgentContractError(
        'personal memory write through project adapter is prohibited',
      );
    }
    throw new ProjectAgentContractError(msg);
  }
  return r.data;
}
