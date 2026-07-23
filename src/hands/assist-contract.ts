/**
 * hands/assist-contract.ts — Versioned ApprovedAnswerPack contract.
 *
 * M7 Supervised Assist: the answer pack is generated first, then approved
 * as a whole by the CEO. Each pack is bound to:
 *   - exact origin URL
 *   - form fingerprint (CSS selector / form id)
 *   - named field keys/labels with verbatim values
 *   - actionPlanHash (SHA-256 of the plan that generated the pack)
 *   - SHA-256 pack hash (integrity)
 *   - expiry timestamp
 *
 * Field-fill may ONLY insert values VERBATIM from this pack — no on-the-fly
 * rewording by the planner during a live session. Deviation = halt.
 */

import { createHash } from 'node:crypto';
import { z } from 'zod';

export const ASSIST_CONTRACT_VERSION = 1;

// ── Field entry ─────────────────────────────────────────────────────

export const fieldEntrySchema = z.object({
  /** Label or name attribute of the field (used for getByLabel matching). */
  label: z.string().min(1),
  /** Verbatim value to fill, character-for-character. */
  value: z.string(),
  /** Whether this is a select/dropdown (selectOption) vs text input (fillField). */
  type: z.enum(['text', 'select']).default('text'),
});
export type FieldEntry = z.infer<typeof fieldEntrySchema>;

// ── Denied field types ──────────────────────────────────────────────

/** Input types that are ALWAYS denied, even if named in a pack. */
export const DENIED_INPUT_TYPES = new Set([
  'password', 'file', 'hidden',
]);

/** Autocomplete values that indicate credential/sensitive fields. */
export const DENIED_AUTOCOMPLETE = new Set([
  'current-password', 'new-password', 'cc-number', 'cc-exp', 'cc-csc',
  'cc-name', 'cc-type', 'one-time-code', 'webauthn',
]);

// ── Answer pack ─────────────────────────────────────────────────────

export const answerPackSchema = z.object({
  version: z.literal(ASSIST_CONTRACT_VERSION),
  origin: z.string().min(1),
  formFingerprint: z.string().min(1),
  fields: z.array(fieldEntrySchema).min(1),
  actionPlanHash: z.string().min(1),
  createdAt: z.string(),
  expiresAt: z.string(),
});
export type ApprovedAnswerPack = z.infer<typeof answerPackSchema> & {
  /** SHA-256 of the canonical JSON (all fields except packHash). */
  packHash: string;
};

// ── Hash computation ────────────────────────────────────────────────

/**
 * Compute the SHA-256 hash of the pack's canonical content.
 * The hash covers: version, origin, formFingerprint, fields, actionPlanHash,
 * createdAt, expiresAt — everything except packHash itself.
 */
export function computePackHash(pack: Omit<ApprovedAnswerPack, 'packHash'>): string {
  const canonical = JSON.stringify({
    version: pack.version,
    origin: pack.origin,
    formFingerprint: pack.formFingerprint,
    fields: pack.fields,
    actionPlanHash: pack.actionPlanHash,
    createdAt: pack.createdAt,
    expiresAt: pack.expiresAt,
  });
  return createHash('sha256').update(canonical).digest('hex');
}

/**
 * Short hash for TTY challenge display (first 8 chars of packHash).
 */
export function shortHash(packHash: string): string {
  return packHash.slice(0, 8);
}

// ── Pack creation ───────────────────────────────────────────────────

export interface CreatePackInput {
  origin: string;
  formFingerprint: string;
  fields: FieldEntry[];
  actionPlanHash: string;
  ttlMs?: number;
}

const DEFAULT_TTL_MS = 30 * 60 * 1000; // 30 minutes

export function createAnswerPack(input: CreatePackInput): ApprovedAnswerPack {
  const now = new Date();
  const ttl = input.ttlMs ?? DEFAULT_TTL_MS;
  const base = {
    version: ASSIST_CONTRACT_VERSION as 1,
    origin: input.origin,
    formFingerprint: input.formFingerprint,
    fields: input.fields,
    actionPlanHash: input.actionPlanHash,
    createdAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + ttl).toISOString(),
  };
  return { ...base, packHash: computePackHash(base) };
}

// ── Pack validation ─────────────────────────────────────────────────

export type PackValidationError =
  | 'EXPIRED'
  | 'HASH_MISMATCH'
  | 'ORIGIN_MISMATCH'
  | 'FORM_MISMATCH'
  | 'PLAN_MISMATCH'
  | 'SCHEMA_INVALID'
  | 'FIELD_NOT_IN_PACK';

export interface PackValidationResult {
  valid: boolean;
  error?: PackValidationError;
  detail?: string;
}

/**
 * Validate a pack against the current context. Returns valid:true if all
 * bindings match. Any mismatch halts before driver mutation.
 */
export function validatePack(
  pack: ApprovedAnswerPack,
  context: {
    currentOrigin: string;
    currentFormFingerprint: string;
    actionPlanHash: string;
    now?: Date;
  },
): PackValidationResult {
  // Schema check
  const schemaResult = answerPackSchema.safeParse(pack);
  if (!schemaResult.success) {
    return { valid: false, error: 'SCHEMA_INVALID', detail: schemaResult.error.message };
  }

  // Expiry
  const now = context.now ?? new Date();
  if (new Date(pack.expiresAt).getTime() <= now.getTime()) {
    return { valid: false, error: 'EXPIRED', detail: `pack expired at ${pack.expiresAt}` };
  }

  // Hash integrity
  const computed = computePackHash(pack);
  if (computed !== pack.packHash) {
    return { valid: false, error: 'HASH_MISMATCH', detail: 'pack content has been tampered with' };
  }

  // Origin
  if (pack.origin !== context.currentOrigin) {
    return { valid: false, error: 'ORIGIN_MISMATCH', detail: `expected ${pack.origin}, got ${context.currentOrigin}` };
  }

  // Form fingerprint
  if (pack.formFingerprint !== context.currentFormFingerprint) {
    return { valid: false, error: 'FORM_MISMATCH', detail: `expected ${pack.formFingerprint}, got ${context.currentFormFingerprint}` };
  }

  // Action plan hash
  if (pack.actionPlanHash !== context.actionPlanHash) {
    return { valid: false, error: 'PLAN_MISMATCH', detail: 'action plan has changed since pack creation' };
  }

  return { valid: true };
}
