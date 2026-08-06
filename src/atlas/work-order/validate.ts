/**
 * atlas/work-order/validate.ts — the deterministic Work Order verdict gate.
 *
 * Given the same signed envelope, the same explicit runtime context, and the
 * same replay-store/verifier state, this always returns the same verdict.
 * The only state mutation is the one it is explicitly handed — the injected
 * WorkOrderReplayStore — mirroring atlas/queue-auth.ts's
 * verifyPayload(row, key, ledger) shape exactly.
 *
 * P1-A wave-2 carry-over fix (2026-08-06): wave 1 shipped a single
 * validateWorkOrder() that consumed the envelope's nonce on EVERY call,
 * which made it impossible to re-check scope per action inside one claimed
 * Work Order (an executor gate needs to re-prove path/action/budget scope
 * before EACH mutation, not just once). Split in two:
 *   - checkWorkOrderScope(signed, ctx) — PURE and REPEATABLE. Signature,
 *     expiry, future-dating, executor identity, repo, base HEAD, path
 *     scope, forbidden action, command class, attempts, wall clock. Never
 *     touches the replay store, so calling it many times against the same
 *     envelope is safe and produces the same verdict for the same inputs.
 *   - claimWorkOrder(signed, replayStore) — the ONE-SHOT nonce/workOrderId
 *     consumption, split out so it can be called exactly once (at
 *     acceptance) independently of how many times scope is re-checked.
 * validateWorkOrder() remains as a convenience composition of the two
 * (scope check, then claim) for callers that only need single-call
 * accept-or-reject semantics — its checks run in the same fixed order as
 * wave 1 from a caller's perspective and it still consumes the replay store
 * exactly once per call, so all 18 wave-1 tests keep their original
 * expected verdicts unchanged (re-pointed to compose the two new
 * primitives, not weakened).
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

/**
 * Everything checkWorkOrderScope needs. Deliberately has NO replayStore
 * field — scope checking never touches the replay ledger, which is what
 * makes it safe to call more than once per envelope.
 */
export interface WorkOrderScopeCheckContext {
  /** Wall clock the check runs against. Defaults to `new Date()`. */
  now?: Date;
  /** Signature verifier; defaults to resolveWorkOrderVerifier() (env-key-backed, fails closed when unset). */
  verifier?: WorkOrderVerifier;
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

/** Full validateWorkOrder() context — WorkOrderScopeCheckContext plus the one-shot replay store. */
export interface WorkOrderValidationContext extends WorkOrderScopeCheckContext {
  /** Durable replay store — required; there is no in-memory-only default (replay protection must be durable). */
  replayStore: WorkOrderReplayStore;
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
 * PURE and REPEATABLE — every check EXCEPT nonce/workOrderId replay. Safe to
 * call many times for the same signed envelope (e.g. once per action inside
 * one claimed Work Order); never mutates the replay store. Checks run in a
 * fixed order and the first failing check wins — callers get exactly one
 * reason per verdict, never a list.
 */
export function checkWorkOrderScope(
  signed: SignedWorkOrder,
  ctx: WorkOrderScopeCheckContext,
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

/**
 * ONE-SHOT — consumes the envelope's (workOrderId, nonce) pair exactly
 * once. Call this precisely once, at the moment a Work Order is accepted
 * for execution (after checkWorkOrderScope has already passed) — not once
 * per file touched or per retry.
 */
export function claimWorkOrder(
  signed: SignedWorkOrder,
  replayStore: WorkOrderReplayStore,
): WorkOrderValidationVerdict {
  const replay = replayStore.consumeIfFresh(signed.workOrderId, signed.nonce);
  if (!replay.ok) return fail(replay.reason);
  return { ok: true };
}

/**
 * Convenience composition of checkWorkOrderScope + claimWorkOrder for
 * callers that only need single-call accept-or-reject semantics. Still a
 * ONE-TIME claim gate — calling it twice for the same envelope will fail
 * the second time on replay, exactly like wave 1. Prefer the split
 * primitives directly when scope needs to be re-checked more than once per
 * envelope (e.g. inside executor-gate.ts, once per action).
 */
export function validateWorkOrder(
  signed: SignedWorkOrder,
  ctx: WorkOrderValidationContext,
): WorkOrderValidationVerdict {
  const scope = checkWorkOrderScope(signed, ctx);
  if (!scope.ok) return scope;
  return claimWorkOrder(signed, ctx.replayStore);
}
