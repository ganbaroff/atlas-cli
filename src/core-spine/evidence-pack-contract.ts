/**
 * Evidence Pack Contract — goal→…→receipt standardization.
 * Narrative alone is never sufficient.
 * Effects must link to recorded commands, tests, or artifacts by stable id.
 */
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { taskIdSchema } from '../exec-graph/contracts.js';

export class EvidencePackError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EvidencePackError';
  }
}

const sha256Hex = z.string().regex(/^[a-f0-9]{64}$/i, 'diff/output hash must be 64 hex chars');

const stableId = z
  .string()
  .min(1)
  .regex(/^[a-zA-Z0-9][a-zA-Z0-9._:-]*$/, 'id must be a stable alphanumeric token');

export const commandRunSchema = z.object({
  /** Stable id referenced by effectProofs.provenBy.ref */
  id: stableId,
  command: z.string().min(1),
  exitCode: z.number().int(),
  /** Required 64-hex output hash — narrative stdout is not enough. */
  outputHash: z.string().regex(/^[a-f0-9]{64}$/i, 'outputHash must be 64 hex chars'),
  skipped: z.boolean().optional(),
});

export const evidenceArtifactSchema = z.object({
  id: stableId,
  kind: z.enum(['diff', 'file', 'output']),
  hash: sha256Hex.optional(),
});

export const effectProofRefSchema = z.object({
  kind: z.enum(['command', 'test', 'artifact']),
  ref: stableId,
});

export const effectProofSchema = z.object({
  effectId: z.string().min(1),
  provenBy: z.array(effectProofRefSchema).min(1),
});

export const evidencePackSchema = z
  .object({
    taskId: taskIdSchema,
    changeId: z.string().min(1),
    projectId: z.string().min(1),
    baseCommit: z.string().min(7),
    executorIdentity: z.string().min(1),
    /** Stable effect identifiers (declared scope). */
    declaredEffects: z.array(z.string().min(1)).min(1),
    /** Stable effect identifiers (actually produced). */
    actualEffects: z.array(z.string().min(1)).min(1),
    /** Explicit effect → command|test|artifact linkage (required; narrative is not proof). */
    effectProofs: z.array(effectProofSchema).min(1),
    /** Optional artifacts that effects may cite (e.g. diff hash record). */
    artifacts: z.array(evidenceArtifactSchema).default([]),
    diffHash: sha256Hex,
    commandsRun: z.array(commandRunSchema),
    testCommands: z.array(commandRunSchema),
    costRecord: z.object({
      provider: z.string().min(1),
      tokens: z.number().int().nonnegative(),
      paid: z.boolean(),
    }),
    /**
     * Commitment hash computed by the COLLECTOR (collectIndependentEvidence) over the
     * evidence-bearing fields at collection time. Required. The verifier recomputes this
     * independently (computeEvidenceHash) and fail-closes on any mismatch — this is the
     * integrity binding between "what was actually collected" and "what gets verified".
     */
    collectedEvidenceHash: z.string().regex(/^[a-f0-9]{64}$/i, 'collectedEvidenceHash must be 64 hex chars'),
    /**
     * ADVISORY ONLY on input: a caller (courier loop, reviewer, prior stage) may attach
     * its own prior/claimed verdict for audit-trail purposes, but the verifier NEVER reads
     * this field to decide the final verdict — see spine-verifier.ts's SPINE_VERIFIER_ID
     * stamping. Optional because a freshly collected pack has no prior verdict yet.
     */
    verifierResult: z
      .object({
        verified: z.boolean(),
        reason: z.string().min(1),
        verifierId: z.string().min(1),
      })
      .optional(),
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
    if (p.commandsRun.length === 0 && p.testCommands.length === 0 && p.artifacts.length === 0) {
      ctx.addIssue({
        code: 'custom',
        path: ['commandsRun'],
        message: 'narrative-only success forbidden: commands, tests, or artifacts required',
      });
    }

    const cmdIds = new Set(p.commandsRun.map((c) => c.id));
    const testIds = new Set(p.testCommands.map((c) => c.id));
    const artIds = new Set(p.artifacts.map((a) => a.id));
    if (cmdIds.size !== p.commandsRun.length) {
      ctx.addIssue({ code: 'custom', path: ['commandsRun'], message: 'duplicate command id' });
    }
    if (testIds.size !== p.testCommands.length) {
      ctx.addIssue({ code: 'custom', path: ['testCommands'], message: 'duplicate test id' });
    }
    if (artIds.size !== p.artifacts.length) {
      ctx.addIssue({ code: 'custom', path: ['artifacts'], message: 'duplicate artifact id' });
    }

    const actual = new Set(p.actualEffects);
    for (const proof of p.effectProofs) {
      if (!actual.has(proof.effectId)) {
        ctx.addIssue({
          code: 'custom',
          path: ['effectProofs'],
          message: `orphan effect proof: ${proof.effectId} not in actualEffects`,
        });
      }
      for (const ref of proof.provenBy) {
        const ok =
          (ref.kind === 'command' && cmdIds.has(ref.ref)) ||
          (ref.kind === 'test' && testIds.has(ref.ref)) ||
          (ref.kind === 'artifact' && artIds.has(ref.ref));
        if (!ok) {
          ctx.addIssue({
            code: 'custom',
            path: ['effectProofs'],
            message: `missing ${ref.kind} reference: ${ref.ref}`,
          });
        }
      }
    }

    for (const effectId of p.actualEffects) {
      if (!p.effectProofs.some((pr) => pr.effectId === effectId)) {
        ctx.addIssue({
          code: 'custom',
          path: ['effectProofs'],
          message: `orphan declared effect: ${effectId} has no effectProof`,
        });
      }
    }
  });

export type EvidencePack = z.infer<typeof evidencePackSchema>;
export type CommandRun = z.infer<typeof commandRunSchema>;
export type EffectProof = z.infer<typeof effectProofSchema>;
export type EvidenceArtifact = z.infer<typeof evidenceArtifactSchema>;

export function parseEvidencePack(input: unknown): EvidencePack {
  const r = evidencePackSchema.safeParse(input);
  if (!r.success) {
    throw new EvidencePackError(r.error.issues.map((i) => i.message).join('; '));
  }
  return r.data;
}

/** Shape computeEvidenceHash needs — a subset of EvidencePack's evidence-bearing fields. */
export type EvidenceHashInput = {
  commandsRun: CommandRun[];
  testCommands: CommandRun[];
  declaredEffects: string[];
  actualEffects: string[];
  effectProofs: EffectProof[];
  artifacts: EvidenceArtifact[];
  diffHash: string;
};

/**
 * Pure, deterministic commitment hash over the evidence-bearing fields of a pack.
 * Same function is used by the collector (to stamp collectedEvidenceHash) and by the
 * verifier (to recompute and compare) — any divergence between what was collected and
 * what is submitted for verification is detected as a hash mismatch, fail-closed.
 * Deterministic key order: all arrays are sorted by stable id/content before hashing so
 * that field re-ordering never changes the hash, only actual content changes do.
 */
export function computeEvidenceHash(pack: EvidenceHashInput): string {
  const canonicalCommand = (c: CommandRun) => ({
    id: c.id,
    command: c.command,
    exitCode: c.exitCode,
    outputHash: c.outputHash,
    skipped: c.skipped ?? false,
  });
  const canonicalArtifact = (a: EvidenceArtifact) => ({
    id: a.id,
    kind: a.kind,
    hash: a.hash ?? null,
  });
  const canonicalProof = (p: EffectProof) => ({
    effectId: p.effectId,
    provenBy: [...p.provenBy]
      .map((r) => ({ kind: r.kind, ref: r.ref }))
      .sort((a, b) => `${a.kind}:${a.ref}`.localeCompare(`${b.kind}:${b.ref}`)),
  });

  const canonical = {
    commandsRun: [...pack.commandsRun].map(canonicalCommand).sort((a, b) => a.id.localeCompare(b.id)),
    testCommands: [...pack.testCommands].map(canonicalCommand).sort((a, b) => a.id.localeCompare(b.id)),
    declaredEffects: [...pack.declaredEffects].sort(),
    actualEffects: [...pack.actualEffects].sort(),
    effectProofs: [...pack.effectProofs].map(canonicalProof).sort((a, b) => a.effectId.localeCompare(b.effectId)),
    artifacts: [...pack.artifacts].map(canonicalArtifact).sort((a, b) => a.id.localeCompare(b.id)),
    diffHash: pack.diffHash,
  };

  return createHash('sha256').update(JSON.stringify(canonical), 'utf8').digest('hex');
}
