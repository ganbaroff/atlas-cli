/**
 * Shared HandSpec schema — imported by registry + manifest without cycles.
 */

import { z } from 'zod';

export const trustLevelSchema = z.enum(['low', 'medium', 'high']);
export const costClassSchema = z.enum(['FREE', 'FOREGROUND-CEO-SUPERVISED', 'PAID-APPROVAL-ONLY']);
export const autonomySchema = z.enum(['foreground-only', 'read-only-unattended']);
export const retryPolicySchema = z.enum(['none', 'once']);

export const handSpecSchema = z.object({
  handId: z.string().min(1),
  purpose: z.string().min(1),
  capabilities: z.array(z.string().min(1)).min(1),
  trustLevel: trustLevelSchema,
  allowedEnvironments: z.array(z.string().min(1)).min(1),
  allowedActions: z.array(z.string().min(1)).min(1),
  disallowedActions: z.array(z.string().min(1)),
  costClass: costClassSchema,
  autonomy: autonomySchema,
  inputContract: z.string().min(1),
  timeoutMs: z.number().int().positive(),
  retryPolicy: retryPolicySchema,
  abortPolicy: z.string().min(1),
  escalationCondition: z.string().min(1),
});
export type HandSpec = z.infer<typeof handSpecSchema>;

export function parseHandSpec(input: unknown): HandSpec {
  return handSpecSchema.parse(input);
}

export class HandsError extends Error {}
export class HandNotFoundError extends HandsError {}
