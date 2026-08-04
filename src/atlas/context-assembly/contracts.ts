/**
 * Atlas Context Assembly v0 — bounded evidence-backed context pack for planning.
 * Read-only. Never invents project details. Does not execute goals.
 */
import { z } from 'zod';

export class AtlasContextAssemblyError extends Error {
  constructor(
    message: string,
    readonly code: 'INVALID' | 'BUDGET' | 'UNKNOWN_AUTHORITY' | 'INSUFFICIENT',
  ) {
    super(message);
    this.name = 'AtlasContextAssemblyError';
  }
}

export const contextPlanningStatusSchema = z.enum([
  'READY_TO_PLAN',
  'NEEDS_APPROVAL',
  'BLOCKED',
]);
export type ContextPlanningStatus = z.infer<typeof contextPlanningStatusSchema>;

export const sourceAuthoritySchema = z.enum([
  'canonical-decision',
  'current-compact',
  'project-canon',
  'verified-repo-docs',
  'recent-receipt',
  'historical',
  'external-readonly-target',
  'goal-contract',
  'project-resolution',
  'unknown',
]);
export type SourceAuthority = z.infer<typeof sourceAuthoritySchema>;

export const sourceTypeSchema = z.enum([
  'personal-memory',
  'project-memory',
  'repository-doc',
  'receipt',
  'decision',
  'external-url',
  'registry',
  'synthetic-test',
]);
export type SourceType = z.infer<typeof sourceTypeSchema>;

export const contextSourceSchema = z.object({
  id: z.string().min(1),
  sourceType: sourceTypeSchema,
  pathOrUrl: z.string().min(1),
  authority: sourceAuthoritySchema,
  freshnessIso: z.string().min(1),
  contentHash: z.string().min(1),
  bytesLoaded: z.number().int().nonnegative(),
  historical: z.boolean().default(false),
  selected: z.boolean(),
  exclusionReason: z.string().optional(),
});

export const extractedFactSchema = z.object({
  text: z.string().min(1),
  kind: z.enum(['fact', 'assumption', 'inference', 'decision', 'constraint', 'blocker']),
  citation: z.string().min(1),
});

export const atlasContextPackSchema = z.object({
  goalId: z.string().min(1),
  projectId: z.string().min(1),
  /** ISO timestamp of assembly — injectable via AssembleContextOptions.nowIso */
  assembledAtIso: z.string().min(1),
  verifiedProjectPath: z.string().nullable(),
  externalTarget: z.string().nullable(),
  /** Explicit: read-only target readiness vs project execution readiness */
  readOnlyTargetReady: z.boolean(),
  projectExecutionReady: z.boolean(),
  selectedSources: z.array(contextSourceSchema),
  facts: z.array(extractedFactSchema),
  decisions: z.array(z.string()),
  constraints: z.array(z.string()),
  knownBlockers: z.array(z.string()),
  unresolvedContradictions: z.array(z.string()),
  staleInformation: z.array(z.string()),
  assumptions: z.array(z.string()),
  missingEvidence: z.array(z.string()),
  contextConfidence: z.enum(['high', 'medium', 'low', 'none']),
  contextBudgetBytes: z.number().int().positive(),
  contextBytesUsed: z.number().int().nonnegative(),
  perSourceMaxBytes: z.number().int().positive(),
  planningStatus: contextPlanningStatusSchema,
  conciseCeoSummary: z.string().min(1),
});

export type AtlasContextPack = z.infer<typeof atlasContextPackSchema>;
export type ContextSource = z.infer<typeof contextSourceSchema>;
export type ExtractedFact = z.infer<typeof extractedFactSchema>;

export function parseAtlasContextPack(input: unknown): AtlasContextPack {
  const r = atlasContextPackSchema.safeParse(input);
  if (!r.success) {
    throw new AtlasContextAssemblyError(
      r.error.issues.map((i) => i.message).join('; '),
      'INVALID',
    );
  }
  return r.data;
}
