/**
 * M8 — typed claim schemas (SPEC-M8-EVIDENCE-AUDIT §3).
 */

import { z } from 'zod';

export const claimTypeSchema = z.enum([
  'file-exists',
  'commit-exists',
  'file-contains',
  'command-output-match',
  'browser-action',
  'narrative',
  'audit-finding',
]);
export type ClaimType = z.infer<typeof claimTypeSchema>;

export const claimIdSchema = z.string().regex(/^clm_[a-z0-9][a-z0-9._-]{1,80}$/);
export const auditVerdictSchema = z.enum(['confirmed', 'stale', 'tampered', 'count-mismatch']);

export const typedClaimSchema = z
  .object({
    claimId: claimIdSchema,
    claim: z.string().min(1),
    type: claimTypeSchema,
    path: z.string().min(1),
    confidence: z.number().min(0).max(1),
    source: z.string().min(1),
    sourceRef: z.string().min(1).optional(),
    command: z.string().min(1).optional(),
    expectedSubstring: z.string().min(1).optional(),
    auditVerdict: auditVerdictSchema.optional(),
    ts: z.string().datetime(),
  })
  .superRefine((c, ctx) => {
    if (c.type === 'narrative' && c.confidence > 0) {
      ctx.addIssue({
        code: 'custom',
        path: ['confidence'],
        message: "type 'narrative' has no independently checkable evidence; confidence must be 0",
      });
    }
    if (c.type === 'file-contains' && !c.expectedSubstring) {
      ctx.addIssue({ code: 'custom', path: ['expectedSubstring'], message: 'file-contains requires expectedSubstring' });
    }
    if (c.type === 'command-output-match' && (!c.command || !c.expectedSubstring)) {
      ctx.addIssue({ code: 'custom', path: ['command'], message: 'command-output-match requires command + expectedSubstring' });
    }
    if (c.type === 'audit-finding' && (!c.auditVerdict || !c.sourceRef)) {
      ctx.addIssue({ code: 'custom', path: ['auditVerdict'], message: 'audit-finding requires auditVerdict + sourceRef' });
    }
  });

export type TypedClaim = z.infer<typeof typedClaimSchema>;

export function parseTypedClaim(input: unknown): TypedClaim {
  return typedClaimSchema.parse(input);
}
