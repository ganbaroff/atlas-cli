/**
 * atlas/work-order/validate.ts — the deterministic Work Order verdict gate.
 *
 * Given the same signed envelope, the same explicit runtime context, and the
 * same replay-store/verifier state, this always returns the same verdict.
 * The only state mutation is the one it is explicitly handed — the injected
 * WorkOrderReplayStore — mirroring atlas/queue-auth.ts's
 * verifyPayload(row, key, ledger) shape exactly.
 *
 * validateWorkOrder() is a ONE-TIME claim gate: it consumes the envelope's
 * nonce/workOrderId as one of its checks, so call it exactly once, at the
 * moment an executor accepts a Work Order for execution — not once per
 * file write or per retry attempt inside that execution. maxAttempts /
 * maxWallClockMs are evaluated from the (attemptNumber, elapsedWallClockMs)
 * the caller supplies at that single claim moment.
 *
 * Path-scope reuse survey: tools/fs-guard.ts's isSensitivePath() classifier
 * is reused here as an unconditional floor — a candidate path fs-guard
 * already classifies as sensitive (.env, keys/, secrets/, .git/, *.pem,
 * id_rsa, ...) is always forbidden, regardless of what a Work Order's own
 * allowedPaths says. Beyond that floor, fs-guard.ts exposes no
 * parameterized allow/deny-glob primitive to reuse: its own
 * checkWorkspaceConfinement() is bound to a single ATLAS_WORKSPACE_ROOT env
 * var and only applies to the 'autonomy' actor, so it cannot express a Work
 * Order's arbitrary allowedPaths/forbiddenPaths glob lists. The minimal glob
 * matcher below is therefore new, narrowly-scoped code — not a
 * reimplementation of something fs-guard.ts already provides.
 */

import { isSensitivePath } from '../../tools/fs-guard.js';
import type {
  SignedWorkOrder,
  WorkOrderValidationFailureReason,
  WorkOrderValidationVerdict,
} from './types.js';
import {
  checkWorkOrderSignature,
  resolveWorkOrderVerifier,
  type WorkOrderVerifier,
} from './sign.js';
import type { WorkOrderReplayStore } from './replay.js';

/** Small clock-skew allowance for an envelope's issuedAt being ahead of the checker's clock. */
export const CLOCK_SKEW_TOLERANCE_MS = 5 * 60 * 1000; // 5 minutes

export interface WorkOrderValidationContext {
  /** Wall clock the check runs against. Defaults to `new Date()`. */
  now?: Date;
  /** Signature verifier; defaults to resolveWorkOrderVerifier() (env-key-backed, fails closed when unset). */
  verifier?: WorkOrderVerifier;
  /** Durable replay store — required; there is no in-memory-only default (replay protection must be durable). */
  replayStore: WorkOrderReplayStore;
  /** Identity of the process claiming to execute this order. */
  executorIdentity: string;
  /** Repository the executor is actually operating in. */
  repoCanonicalPath: string;
  /** Base HEAD the executor actually observed in that repository. */
  baseHead: string;
  /** Path the executor is attempting to touch, if this claim is scoped to one path. */
  candidatePath?: string;
  /** Action the executor is attempting, if this claim is scoped to one action. */
  action?: string;
  /** Command class the executor is attempting, if this claim is scoped to one command. */
  commandClass?: string;
  /** 1-based attempt count for this Work Order. */
  attemptNumber: number;
  /** Wall-clock time elapsed (ms) since work on this Work Order began. */
  elapsedWallClockMs: number;
}

function fail(reason: WorkOrderValidationFailureReason): WorkOrderValidationVerdict {
  return { ok: false, reason };
}

function normalizePath(path: string): string {
  return path.replace(/\\/g, '/');
}

/** Minimal glob support: `**` = any chars incl. `/`, `*` = any chars except `/`, `?` = one char. */
function globToRegExp(glob: string): RegExp {
  const normalized = normalizePath(glob);
  let pattern = '';
  for (let i = 0; i < normalized.length; i += 1) {
    const char = normalized[i]!;
    if (char === '*' && normalized[i + 1] === '*') {
      pattern += '.*';
      i += 1;
    } else if (char === '*') {
      pattern += '[^/]*';
    } else if (char === '?') {
      pattern += '[^/]';
    } else {
      pattern += char.replace(/[.+^${}()|[\]\\]/g, '\\$&');
    }
  }
  return new RegExp(`^${pattern}$`);
}

function matchesAnyGlob(candidate: string, globs: readonly string[]): boolean {
  const normalizedCandidate = normalizePath(candidate);
  return globs.some((glob) => globToRegExp(glob).test(normalizedCandidate));
}

/**
 * Validate + claim a signed Work Order in one deterministic pass. Checks run
 * in a fixed order and the first failing check wins — callers get exactly
 * one reason per verdict, never a list.
 */
export function validateWorkOrder(
  signed: SignedWorkOrder,
  ctx: WorkOrderValidationContext,
): WorkOrderValidationVerdict {
  const now = ctx.now ?? new Date();
  const verifier = ctx.verifier ?? resolveWorkOrderVerifier();

  const signatureCheck = checkWorkOrderSignature(signed, verifier);
  if (signatureCheck === 'missing') return fail('signature_missing');
  if (signatureCheck === 'invalid') return fail('signature_invalid');

  const expiresAtMs = Date.parse(signed.expiresAt);
  if (!Number.isFinite(expiresAtMs) || now.getTime() > expiresAtMs) {
    return fail('expired');
  }

  const issuedAtMs = Date.parse(signed.issuedAt);
  if (Number.isFinite(issuedAtMs) && issuedAtMs - now.getTime() > CLOCK_SKEW_TOLERANCE_MS) {
    return fail('future_dated');
  }

  const replay = ctx.replayStore.consumeIfFresh(signed.workOrderId, signed.nonce);
  if (!replay.ok) return fail(replay.reason);

  if (ctx.executorIdentity !== signed.executorIdentity) return fail('wrong_executor_identity');
  if (ctx.repoCanonicalPath !== signed.repoCanonicalPath) return fail('wrong_repository');
  if (ctx.baseHead !== signed.baseHead) return fail('base_head_mismatch');

  if (ctx.candidatePath !== undefined) {
    if (isSensitivePath(ctx.candidatePath)) return fail('path_forbidden');
    if (matchesAnyGlob(ctx.candidatePath, signed.forbiddenPaths)) return fail('path_forbidden');
    if (signed.allowedPaths.length > 0 && !matchesAnyGlob(ctx.candidatePath, signed.allowedPaths)) {
      return fail('path_out_of_scope');
    }
  }

  if (ctx.action !== undefined && signed.forbiddenActions.includes(ctx.action)) {
    return fail('action_forbidden');
  }

  if (
    ctx.commandClass !== undefined &&
    signed.allowedCommandClasses.length > 0 &&
    !signed.allowedCommandClasses.includes(ctx.commandClass)
  ) {
    return fail('command_class_forbidden');
  }

  if (ctx.attemptNumber > signed.maxAttempts) return fail('attempts_exhausted');
  if (ctx.elapsedWallClockMs > signed.maxWallClockMs) return fail('wall_clock_exhausted');

  return { ok: true };
}
