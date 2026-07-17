/**
 * hands/contract.ts — Hand Contract V0: DelegationBrief + Receipt schemas.
 *
 * WHAT THIS IS: the data contracts a task's delegation to a Hand (see
 * ./registry.ts) is described and evidenced by. Mirrors
 * exec-graph/contracts.ts's style: zod schemas, superRefine() for
 * cross-field invariants a plain shape check can't express, and a
 * `parseX(input): X` helper next to each schema.
 *
 * DelegationBrief.taskId / Receipt.taskId reuse exec-graph's own
 * taskIdSchema (the `tsk_...` regex) rather than a bare string, so a brief
 * or receipt can never cite an id shape exec-graph itself would reject.
 *
 * Receipt's superRefine enforces "the cited evidence kind actually carries
 * the fields needed to check it" — a 'file-contains' receipt without a ref
 * or expectedSubstring, or a 'command-output-match' receipt without a
 * command, is malformed at the SCHEMA level, before ./verifier.ts ever sees
 * it. 'narrative' receipts need nothing extra — they get rejected by
 * ./verifier.ts on principle, not for missing fields.
 */

import { z } from 'zod';
import { createHash } from 'node:crypto';
import { taskIdSchema } from '../exec-graph/contracts.js';

export const delegationRiskClassSchema = z.enum([
  'low',
  'security',
  'production',
  'data-mutation',
  'high-blast-radius',
]);
export type DelegationRiskClass = z.infer<typeof delegationRiskClassSchema>;

export const delegationBriefSchema = z.object({
  taskId: taskIdSchema,
  handId: z.string().min(1),
  objective: z.string().min(1),
  allowedActions: z.array(z.string().min(1)),
  /** Must be independently checkable — "the tests pass" is not falsifiable, "vitest run exits 0 and prints X" is. */
  expectedResult: z.string().min(1),
  timeoutMs: z.number().int().positive(),
  riskClass: delegationRiskClassSchema,
});
export type DelegationBrief = z.infer<typeof delegationBriefSchema>;

export function parseDelegationBrief(input: unknown): DelegationBrief {
  return delegationBriefSchema.parse(input);
}

export const receiptKindSchema = z.enum([
  'file-exists',
  'commit-exists',
  'file-contains',
  'command-output-match',
  'narrative',
]);
export type ReceiptKind = z.infer<typeof receiptKindSchema>;

export const receiptSchema = z
  .object({
    taskId: taskIdSchema,
    handId: z.string().min(1),
    submittedBy: z.string().min(1),
    kind: receiptKindSchema,
    /** path / commit sha, required for file-exists / commit-exists / file-contains. */
    ref: z.string().min(1).optional(),
    /** command string, required for command-output-match — must match ./verifier.ts's read-only allowlist. */
    command: z.string().min(1).optional(),
    /** required for file-contains / command-output-match. */
    expectedSubstring: z.string().min(1).optional(),
    claimedResult: z.string().min(1),
    artifacts: z.array(z.string().min(1)).optional(),
  })
  .superRefine((r, ctx) => {
    if ((r.kind === 'file-exists' || r.kind === 'commit-exists' || r.kind === 'file-contains') && !r.ref) {
      ctx.addIssue({ code: 'custom', path: ['ref'], message: `receipt kind '${r.kind}' requires ref` });
    }
    if (r.kind === 'file-contains' && !r.expectedSubstring) {
      ctx.addIssue({
        code: 'custom',
        path: ['expectedSubstring'],
        message: "receipt kind 'file-contains' requires expectedSubstring",
      });
    }
    if (r.kind === 'command-output-match') {
      if (!r.command) {
        ctx.addIssue({ code: 'custom', path: ['command'], message: "receipt kind 'command-output-match' requires command" });
      }
      if (!r.expectedSubstring) {
        ctx.addIssue({
          code: 'custom',
          path: ['expectedSubstring'],
          message: "receipt kind 'command-output-match' requires expectedSubstring",
        });
      }
    }
    // A whitespace-only or near-empty expectedSubstring (e.g. ' ') passes
    // z.string().min(1) but is a degenerate check — it would "verify" against
    // almost any file/command output. Require >=3 meaningful (trimmed) chars
    // for the two kinds that gate verification on this field.
    if (
      (r.kind === 'file-contains' || r.kind === 'command-output-match')
      && r.expectedSubstring !== undefined
      && r.expectedSubstring.trim().length < 3
    ) {
      ctx.addIssue({
        code: 'custom',
        path: ['expectedSubstring'],
        message: `receipt kind '${r.kind}' requires expectedSubstring with >=3 meaningful (trimmed) characters`,
      });
    }
  });
export type Receipt = z.infer<typeof receiptSchema>;

export function parseReceipt(input: unknown): Receipt {
  return receiptSchema.parse(input);
}

/** Deterministic, key-order-independent canonicalization for hashing. */
function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === 'object') {
    return Object.keys(value as Record<string, unknown>)
      .sort()
      .reduce<Record<string, unknown>>((acc, key) => {
        acc[key] = canonicalize((value as Record<string, unknown>)[key]);
        return acc;
      }, {});
  }
  return value;
}

/**
 * Stable content hash of a receipt — same receipt content (any key order)
 * always hashes the same. This is the idempotency key
 * exec-graph-adapter.ts's submitReceipt() uses to make a duplicate
 * submission a no-op instead of a second evidence entry.
 */
export function receiptHash(receipt: Receipt): string {
  const canonical = JSON.stringify(canonicalize(receipt));
  return createHash('sha256').update(canonical).digest('hex');
}
