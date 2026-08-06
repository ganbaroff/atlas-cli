/**
 * atlas/spend/override.ts — bounded CEO spend-cap override (P1-B wave 2).
 *
 * The daily spend cap enforced by ledger.ts's reserve() is, by design, a
 * hard ceiling nothing inside this codebase can silently raise. This module
 * is the ONLY sanctioned way to lift it, and only within tight, provable
 * bounds: a CEO-attributed, HMAC-signed, amount-bounded, expiry-bounded,
 * scope-bounded approval — never an ambient flag, never a caller decision.
 *
 * Signing reuse (explicit, per the wave-2 mission): this module does NOT
 * define a second signer. It reuses work-order/sign.ts's HMAC-SHA256
 * primitives (hmacSigner / hmacVerifier / resolveWorkOrderSigner /
 * resolveWorkOrderVerifier) as-is — the same key resolution
 * (ATLAS_WORK_ORDER_SIGNING_KEY, name only, never read or logged here) the
 * signed Work Order envelope already uses. A CEO override is therefore
 * verifiable with the exact same trust root as a Work Order; there is no
 * second key to manage, leak, or forget to rotate. Only the canonical
 * payload shape differs (a CeoOverride is not a WorkOrder), so this module
 * has its own small canonicalizeCeoOverride() — a pure stable-stringify, not
 * a second cryptographic primitive.
 *
 * NEGATIVE SPACE — deliberately absent from this module, and asserted absent
 * by spend-override-and-proof.test.ts's source-scan test:
 *   - No read of the ambient process environment anywhere in this file. The
 *     only way this module ever sees key material is via the
 *     `signer`/`verifier` function parameters callers pass in (defaulting
 *     to sign.ts's own resolvers).
 *   - No function that clears, zeroes, widens, or otherwise mutates a cap
 *     without a validly-signed SignedCeoOverride as input.
 *   - No "test mode" / "dev mode" conditional of any kind. The exact same
 *     code path runs regardless of any ambient runtime-mode setting.
 *   - No exported function an ordinary executor can call to escape a cap —
 *     resolveEffectiveDailyCapMinor() ALWAYS returns the caller-supplied
 *     base cap unchanged unless it is handed a signed override that passes
 *     every check below. A process restart changes nothing: there is no
 *     in-memory state here to restart away from in the first place.
 */

import {
  resolveWorkOrderSigner,
  resolveWorkOrderVerifier,
  type WorkOrderSigner,
  type WorkOrderVerifier,
} from '../work-order/sign.js';
import { assertIntegerMinor, SpendValidationError } from './types.js';

export const CEO_OVERRIDE_SIGNATURE_ALGORITHM = 'HMAC-SHA256' as const;

/** Every CeoOverride.issuedBy MUST start with this prefix — a plain executor identity string can never satisfy it. */
export const CEO_AUTHORITY_PREFIX = 'ceo:';

/** Small clock-skew allowance for an override's issuedAt being ahead of the checker's clock — same tolerance sign.ts's Work Order scope check uses. */
export const CEO_OVERRIDE_CLOCK_SKEW_TOLERANCE_MS = 5 * 60 * 1000;

/** What a bounded override is scoped to — every present field narrows applicability; an absent field means "any" for that dimension. */
export interface CeoOverrideScope {
  readonly missionId?: string;
  readonly workOrderId?: string;
  readonly provider?: string;
}

/** The override payload — every field is part of the signed canonical form. */
export interface CeoOverride {
  readonly overrideId: string;
  /** Must start with CEO_AUTHORITY_PREFIX ('ceo:...') — enforced at sign time AND re-checked at apply time. */
  readonly issuedBy: string;
  readonly scope: CeoOverrideScope;
  /** Bounded EXTRA budget granted on top of the base cap, integer minor units. Never a replacement cap — always additive and always positive. */
  readonly additionalAmountMinor: number;
  readonly currency: string;
  readonly reason: string;
  readonly issuedAt: string;
  /** Mandatory — an override with no expiry cannot be created (see signCeoOverride). */
  readonly expiresAt: string;
}

export interface CeoOverrideIntegrity {
  readonly algorithm: typeof CEO_OVERRIDE_SIGNATURE_ALGORITHM;
  readonly signature: string;
}

/** A CeoOverride plus its signature. signCeoOverride() freezes this at construction. */
export interface SignedCeoOverride extends CeoOverride {
  readonly integrity: CeoOverrideIntegrity;
}

export class CeoOverrideSigningUnavailableError extends Error {
  constructor() {
    super('spend override: refusing to sign — no signing key/signer available');
    this.name = 'CeoOverrideSigningUnavailableError';
  }
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((entry) => stableStringify(entry)).join(',')}]`;
  }
  if (value !== null && typeof value === 'object') {
    const keys = Object.keys(value as Record<string, unknown>).sort();
    const body = keys
      .map((key) => `${JSON.stringify(key)}:${stableStringify((value as Record<string, unknown>)[key])}`)
      .join(',');
    return `{${body}}`;
  }
  return JSON.stringify(value);
}

/** Canonicalize every CeoOverride field (never `integrity`) into one stable string — mirrors work-order/sign.ts's canonicalizeWorkOrder(). */
export function canonicalizeCeoOverride(override: CeoOverride): string {
  return stableStringify(override);
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const key of Object.keys(value as Record<string, unknown>)) {
      deepFreeze((value as Record<string, unknown>)[key]);
    }
    Object.freeze(value);
  }
  return value;
}

/**
 * Sign a CeoOverride. Validates the bounded-ness invariants BEFORE signing
 * (positive integer amount, non-empty CEO-prefixed issuer, expiresAt after
 * issuedAt) so a malformed override can never even acquire a valid
 * signature. Throws CeoOverrideSigningUnavailableError when no signer is
 * available — fail closed, same contract as work-order/sign.ts's
 * signWorkOrder().
 */
export function signCeoOverride(
  override: CeoOverride,
  signer: WorkOrderSigner | undefined = resolveWorkOrderSigner(),
): SignedCeoOverride {
  if (!signer) throw new CeoOverrideSigningUnavailableError();
  if (!override.overrideId.trim()) {
    throw new SpendValidationError('CEO override requires a non-empty overrideId');
  }
  if (!override.issuedBy.startsWith(CEO_AUTHORITY_PREFIX) || override.issuedBy === CEO_AUTHORITY_PREFIX) {
    throw new SpendValidationError(
      `CEO override issuedBy must start with ${JSON.stringify(CEO_AUTHORITY_PREFIX)} and name an authority, got ${JSON.stringify(override.issuedBy)}`,
    );
  }
  assertIntegerMinor(override.additionalAmountMinor, 'additionalAmountMinor');
  if (override.additionalAmountMinor <= 0) {
    throw new SpendValidationError('CEO override additionalAmountMinor must be a positive integer — overrides only ever ADD bounded budget');
  }
  if (!override.reason.trim()) {
    throw new SpendValidationError('CEO override requires a non-empty reason');
  }
  const issuedAtMs = Date.parse(override.issuedAt);
  const expiresAtMs = Date.parse(override.expiresAt);
  if (!Number.isFinite(issuedAtMs)) {
    throw new SpendValidationError('CEO override issuedAt must be a valid ISO-8601 instant');
  }
  if (!Number.isFinite(expiresAtMs)) {
    throw new SpendValidationError('CEO override expiresAt is mandatory and must be a valid ISO-8601 instant');
  }
  if (expiresAtMs <= issuedAtMs) {
    throw new SpendValidationError('CEO override expiresAt must be strictly after issuedAt — an override with no bounded lifetime is refused');
  }

  const canonicalPayload = canonicalizeCeoOverride(override);
  const signature = signer(canonicalPayload);
  const signed: SignedCeoOverride = {
    ...override,
    integrity: { algorithm: CEO_OVERRIDE_SIGNATURE_ALGORITHM, signature },
  };
  return deepFreeze(signed);
}

export type CeoOverrideSignatureCheck = 'valid' | 'missing' | 'invalid';

/** Check a signed override's signature without deciding anything else about it — mirrors work-order/sign.ts's checkWorkOrderSignature(). */
export function checkCeoOverrideSignature(
  signed: SignedCeoOverride,
  verifier: WorkOrderVerifier | undefined = resolveWorkOrderVerifier(),
): CeoOverrideSignatureCheck {
  const integrity = signed.integrity;
  if (
    !integrity
    || integrity.algorithm !== CEO_OVERRIDE_SIGNATURE_ALGORITHM
    || typeof integrity.signature !== 'string'
    || integrity.signature.length === 0
  ) {
    return 'missing';
  }
  if (!verifier) return 'missing';

  const { integrity: _integrity, ...rest } = signed;
  const canonicalPayload = canonicalizeCeoOverride(rest as CeoOverride);
  try {
    return verifier(canonicalPayload, integrity.signature) ? 'valid' : 'invalid';
  } catch {
    return 'invalid';
  }
}

export type CeoOverrideRejectReason =
  | 'signature_missing'
  | 'signature_invalid'
  | 'not_ceo_authority'
  | 'expired'
  | 'future_dated'
  | 'scope_mismatch';

export interface ResolveEffectiveDailyCapInput {
  /** The cap that applies with NO override — always the floor this function returns to on any rejection. */
  readonly baseDailyCapMinor: number;
  readonly missionId: string;
  readonly provider: string;
  readonly workOrderId?: string;
  readonly now: Date;
  /** Absent = no override requested; the base cap applies, full stop. */
  readonly signedOverride?: SignedCeoOverride;
  readonly verifier?: WorkOrderVerifier;
}

export type ResolveEffectiveDailyCapResult =
  | { readonly ok: true; readonly effectiveDailyCapMinor: number; readonly overrideApplied: false }
  | {
      readonly ok: true;
      readonly effectiveDailyCapMinor: number;
      readonly overrideApplied: true;
      readonly overrideId: string;
      readonly appliedAmountMinor: number;
    }
  | { readonly ok: false; readonly reason: CeoOverrideRejectReason; readonly effectiveDailyCapMinor: number };

/**
 * Compute the daily cap actually in effect. This is the ONE function in the
 * codebase authorized to raise a spend cap above its base value, and it can
 * only ever do so by the exact bounded amount a validly-signed,
 * currently-unexpired, in-scope SignedCeoOverride declares — never more,
 * never open-ended, never for a mission/provider/work-order outside what the
 * override names. Every rejection path returns the UNCHANGED base cap; there
 * is no reject path that leaves the caller with anything wider than what it
 * started with.
 */
export function resolveEffectiveDailyCapMinor(
  input: ResolveEffectiveDailyCapInput,
): ResolveEffectiveDailyCapResult {
  assertIntegerMinor(input.baseDailyCapMinor, 'baseDailyCapMinor');

  if (!input.signedOverride) {
    return { ok: true, effectiveDailyCapMinor: input.baseDailyCapMinor, overrideApplied: false };
  }

  const signed = input.signedOverride;
  const verifier = input.verifier ?? resolveWorkOrderVerifier();
  const sigCheck = checkCeoOverrideSignature(signed, verifier);
  if (sigCheck === 'missing') {
    return { ok: false, reason: 'signature_missing', effectiveDailyCapMinor: input.baseDailyCapMinor };
  }
  if (sigCheck === 'invalid') {
    return { ok: false, reason: 'signature_invalid', effectiveDailyCapMinor: input.baseDailyCapMinor };
  }

  if (!signed.issuedBy.startsWith(CEO_AUTHORITY_PREFIX) || signed.issuedBy === CEO_AUTHORITY_PREFIX) {
    return { ok: false, reason: 'not_ceo_authority', effectiveDailyCapMinor: input.baseDailyCapMinor };
  }

  const now = input.now;
  const expiresAtMs = Date.parse(signed.expiresAt);
  if (!Number.isFinite(expiresAtMs) || now.getTime() > expiresAtMs) {
    return { ok: false, reason: 'expired', effectiveDailyCapMinor: input.baseDailyCapMinor };
  }
  const issuedAtMs = Date.parse(signed.issuedAt);
  if (Number.isFinite(issuedAtMs) && issuedAtMs - now.getTime() > CEO_OVERRIDE_CLOCK_SKEW_TOLERANCE_MS) {
    return { ok: false, reason: 'future_dated', effectiveDailyCapMinor: input.baseDailyCapMinor };
  }

  const scope = signed.scope;
  if (scope.missionId !== undefined && scope.missionId !== input.missionId) {
    return { ok: false, reason: 'scope_mismatch', effectiveDailyCapMinor: input.baseDailyCapMinor };
  }
  if (scope.provider !== undefined && scope.provider !== input.provider) {
    return { ok: false, reason: 'scope_mismatch', effectiveDailyCapMinor: input.baseDailyCapMinor };
  }
  if (scope.workOrderId !== undefined && scope.workOrderId !== input.workOrderId) {
    return { ok: false, reason: 'scope_mismatch', effectiveDailyCapMinor: input.baseDailyCapMinor };
  }

  return {
    ok: true,
    effectiveDailyCapMinor: input.baseDailyCapMinor + signed.additionalAmountMinor,
    overrideApplied: true,
    overrideId: signed.overrideId,
    appliedAmountMinor: signed.additionalAmountMinor,
  };
}
