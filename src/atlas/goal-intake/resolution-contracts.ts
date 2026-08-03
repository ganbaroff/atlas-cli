/**
 * Atlas Project Resolution v0 — machine-validatable path resolution.
 * Never invents paths. Static registry alone cannot produce READY.
 */
import { z } from 'zod';
import { AtlasGoalIntakeError } from './contracts.js';

export class AtlasProjectResolutionError extends Error {
  constructor(
    message: string,
    readonly code: 'INVALID' | 'UNKNOWN_PROJECT' | 'UNSAFE_BOUNDARY',
  ) {
    super(message);
    this.name = 'AtlasProjectResolutionError';
  }
}

export const resolutionStatusSchema = z.enum(['READY', 'NEEDS_APPROVAL', 'BLOCKED']);
export type ResolutionStatus = z.infer<typeof resolutionStatusSchema>;

export const resolutionPathTypeSchema = z.enum([
  'git-repository',
  'workspace',
  'archive',
  'documentation-only',
  'missing',
]);
export type ResolutionPathType = z.infer<typeof resolutionPathTypeSchema>;

export const resolutionConfidenceSchema = z.enum(['high', 'medium', 'low', 'none']);
export type ResolutionConfidence = z.infer<typeof resolutionConfidenceSchema>;

export const alternativeMatchSchema = z.object({
  path: z.string().min(1),
  pathType: resolutionPathTypeSchema,
  role: z.string().min(1),
  reason: z.string().min(1),
});

export const atlasProjectResolutionSchema = z
  .object({
    projectId: z.string().min(1),
    requestedProjectName: z.string().min(1),
    aliasesMatched: z.array(z.string()),
    status: resolutionStatusSchema,
    /** Verified path only when READY; otherwise null — never invented. */
    canonicalPath: z.string().nullable(),
    pathType: resolutionPathTypeSchema,
    repositoryRoot: z.string().nullable(),
    gitBranch: z.string().nullable(),
    gitHead: z.string().nullable(),
    workingTree: z.enum(['clean', 'dirty', 'unknown', 'n/a']),
    sourceOfTruth: z.array(z.string()).min(1),
    alternativeMatches: z.array(alternativeMatchSchema),
    conflicts: z.array(z.string()),
    staleRegistryFindings: z.array(z.string()),
    confidence: resolutionConfidenceSchema,
    recommendedNextAction: z.string().min(1),
    evidenceReferences: z.array(z.string()).min(1),
  })
  .superRefine((val, ctx) => {
    if (val.status === 'READY') {
      if (!val.canonicalPath) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'READY requires non-null canonicalPath',
          path: ['canonicalPath'],
        });
      }
      if (val.pathType !== 'git-repository') {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'READY requires pathType git-repository',
          path: ['pathType'],
        });
      }
      if (!val.repositoryRoot) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'READY requires non-null repositoryRoot',
          path: ['repositoryRoot'],
        });
      }
      if (!val.gitHead) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'READY requires non-null gitHead',
          path: ['gitHead'],
        });
      }
    } else if (val.canonicalPath !== null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `${val.status} requires canonicalPath: null`,
        path: ['canonicalPath'],
      });
    }
  });

export type AtlasProjectResolution = z.infer<typeof atlasProjectResolutionSchema>;

export function parseAtlasProjectResolution(input: unknown): AtlasProjectResolution {
  const r = atlasProjectResolutionSchema.safeParse(input);
  if (!r.success) {
    throw new AtlasProjectResolutionError(
      r.error.issues.map((i) => i.message).join('; '),
      'INVALID',
    );
  }
  return r.data;
}

/** Re-export intake error for bind failures that reuse intake codes. */
export { AtlasGoalIntakeError };
