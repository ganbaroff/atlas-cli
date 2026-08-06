/**
 * atlas/work-order/executor-gate.ts — the single pre-mutation gate (P1-A
 * wave 2 step 2).
 *
 * runExecutorGate() is the ONE place an executor asks "am I allowed to make
 * this specific mutation right now?" before it touches the filesystem. It
 * composes wave 1's envelope checks (checkWorkOrderScope / claimWorkOrder)
 * with two things wave 1 deliberately left out: an independently-observed
 * view of reality (the worktree's actual canonical path and actual git
 * HEAD — never the caller's claim about them) and the wave-2
 * RepoWriterLease (mutual exclusion across concurrent executors). Any
 * failure returns BEFORE the caller does any mutation and is recorded as a
 * deterministic REJECT claim in the existing M8 evidence ledger
 * (src/evidence/ledger.ts + claim.ts) — no second evidence system.
 *
 * Structural non-substitution: `expectedIssuerIdentity` and
 * `expectedExecutorIdentity` must come from the caller's OWN independent
 * configuration (e.g. "who am I, who do I trust as the planner") — this
 * module never reads `signed.issuerIdentity` / `signed.executorIdentity` to
 * populate the value it compares AGAINST. A caller that mirrors the
 * envelope's own claimed identities back at the gate is not exploiting a
 * gap in the gate — it is a caller bug producing a tautological check; the
 * gate itself always compares two independently-sourced values. See
 * work-order-gate.test.ts's "caller cannot replace issuer/verifier
 * identity" case, which proves a mismatched independent expectation is
 * still enforced even against a validly-signed envelope.
 *
 * Ordering note: the checklist in the wave-2 spec lists "(3) not expired,
 * not replayed" before "(4) repository/HEAD reality" and "(5) lease held".
 * This gate checks expiry as part of checkWorkOrderScope early, but
 * deliberately performs the one-shot nonce CLAIM last, after every other
 * check has passed — so a request that would fail for an unrelated reason
 * (HEAD moved, lease busy, path out of scope, ...) never burns the
 * envelope's single accept token. A legitimate retry of the exact same
 * signed Work Order can still succeed once the blocking condition clears.
 */

import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { appendClaim, hashPayload } from '../../evidence/ledger.js';
import type { SignedWorkOrder, WorkOrderValidationFailureReason } from './types.js';
import {
  checkWorkOrderScope,
  claimWorkOrder,
} from './validate.js';
import type { WorkOrderReplayStore } from './replay.js';
import {
  checkWorkOrderSignature,
  resolveWorkOrderVerifier,
  type WorkOrderVerifier,
} from './sign.js';
import {
  canonicalizeRepoPath,
  getRepoWriterLeaseInfo,
} from './repo-writer-lock.js';

export type ExecutorGateFailureReason =
  | WorkOrderValidationFailureReason
  | 'issuer_identity_mismatch'
  | 'lease_not_held'
  | 'reality_check_failed'
  | 'lease_lost_before_mutation'
  | 'work_order_hash_mismatch';

export type ExecutorGateVerdict =
  | { readonly ok: true; readonly workOrderHash: string }
  | {
      readonly ok: false;
      readonly reason: ExecutorGateFailureReason;
      readonly receiptClaimId: string;
      readonly workOrderHash: string;
    };

export interface ExecutorGateRequest {
  readonly signed: SignedWorkOrder;
  /** Independently-known identity this executor trusts as the issuer — NEVER derived from `signed`. */
  readonly expectedIssuerIdentity: string;
  /** Independently-known identity of this executor process — NEVER derived from `signed`. */
  readonly expectedExecutorIdentity: string;
  /** Filesystem path of the worktree the executor is actually standing in — used to derive reality, not trusted as-is. */
  readonly worktreeRoot: string;
  /** Repo-relative path of the single file this call is about to mutate. */
  readonly candidatePath: string;
  readonly action: string;
  readonly commandClass: string;
  readonly attemptNumber: number;
  readonly elapsedWallClockMs: number;
  /** Mission identity bound to the RepoWriterLease this executor must already hold. */
  readonly missionId: string;
  readonly replayStore: WorkOrderReplayStore;
  /** Caller-selected evidence pack directory — REJECT claims are appended here, never to the shared ledger implicitly. */
  readonly evidenceDir: string;
  readonly now?: Date;
  readonly verifier?: WorkOrderVerifier;
}

function readRealGitHead(worktreeRoot: string, hashLength: number): string {
  const useShort = hashLength > 0 && hashLength < 40;
  const args = useShort
    ? ['-C', worktreeRoot, 'rev-parse', `--short=${hashLength}`, 'HEAD']
    : ['-C', worktreeRoot, 'rev-parse', 'HEAD'];
  return execFileSync('git', args, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
    windowsHide: true,
  }).trim();
}

function makeReceiptClaimId(): string {
  return `clm_wogate-${randomUUID().replace(/-/g, '').slice(0, 20)}`;
}

/**
 * Append a deterministic REJECT claim bound to the exact signed envelope
 * (via hashPayload over the full SignedWorkOrder, including its signature)
 * into the evidence ledger rooted at evidenceDir. Reuses
 * evidence/ledger.ts's appendClaim/claim.ts's 'narrative' claim type — no
 * new evidence schema or storage mechanism.
 */
function emitRejectEvidence(
  signed: SignedWorkOrder,
  reason: ExecutorGateFailureReason,
  evidenceDir: string,
  detail: Record<string, unknown> = {},
): { claimId: string; workOrderHash: string } {
  const claimId = makeReceiptClaimId();
  const workOrderHash = hashPayload(signed);
  appendClaim(
    {
      claimId,
      claim: JSON.stringify({
        kind: 'work-order-gate-reject',
        verdict: 'REJECT',
        reason,
        workOrderId: signed.workOrderId,
        workOrderHash,
        detail,
      }),
      type: 'narrative',
      path: `work-order://${signed.workOrderId}`,
      confidence: 0,
      source: 'work-order-executor-gate',
      sourceRef: signed.workOrderId,
      ts: new Date().toISOString(),
    },
    evidenceDir,
  );
  return { claimId, workOrderHash };
}

/**
 * The single pre-mutation entry point. Call this once, immediately before
 * the one mutation it authorizes. Every failure path returns before any
 * caller-side filesystem write and leaves a REJECT receipt behind.
 */
export function runExecutorGate(request: ExecutorGateRequest): ExecutorGateVerdict {
  const { signed } = request;
  const now = request.now ?? new Date();
  const verifier = request.verifier ?? resolveWorkOrderVerifier();

  const reject = (
    reason: ExecutorGateFailureReason,
    detail?: Record<string, unknown>,
  ): ExecutorGateVerdict => {
    const { claimId, workOrderHash } = emitRejectEvidence(signed, reason, request.evidenceDir, detail);
    return { ok: false, reason, receiptClaimId: claimId, workOrderHash };
  };

  // (1) signature/integrity — checked first; nothing else about `signed` is trustworthy until this passes.
  const signatureCheck = checkWorkOrderSignature(signed, verifier);
  if (signatureCheck === 'missing') return reject('signature_missing');
  if (signatureCheck === 'invalid') return reject('signature_invalid');

  // (2) issuer + executor identity — independent expected values, never mirrored from `signed`.
  if (request.expectedIssuerIdentity !== signed.issuerIdentity) return reject('issuer_identity_mismatch');
  if (request.expectedExecutorIdentity !== signed.executorIdentity) return reject('wrong_executor_identity');

  // (4) repository canonical path + base HEAD — read from REALITY via git, never trust the caller's claim.
  let realCanonicalPath: string;
  let realBaseHead: string;
  try {
    realCanonicalPath = canonicalizeRepoPath(request.worktreeRoot);
    realBaseHead = readRealGitHead(request.worktreeRoot, signed.baseHead.length);
  } catch (error) {
    return reject('reality_check_failed', {
      error: error instanceof Error ? error.message : String(error),
    });
  }

  // (5) RepoWriterLease held by THIS mission — read-only check; acquisition is a separate, explicit step.
  const lease = getRepoWriterLeaseInfo(request.worktreeRoot);
  if (
    !lease
    || lease.status !== 'held'
    || lease.owner.missionId !== request.missionId
    || lease.owner.workOrderId !== signed.workOrderId
  ) {
    return reject('lease_not_held');
  }

  // (3-partial: expiry) + (4: reality-fed) + (6) + (7) + (8) — everything checkWorkOrderScope covers.
  const scope = checkWorkOrderScope(signed, {
    now,
    verifier,
    executorIdentity: request.expectedExecutorIdentity,
    repoCanonicalPath: realCanonicalPath,
    baseHead: realBaseHead,
    candidatePath: request.candidatePath,
    action: request.action,
    commandClass: request.commandClass,
    attemptNumber: request.attemptNumber,
    elapsedWallClockMs: request.elapsedWallClockMs,
  });
  if (!scope.ok) return reject(scope.reason);

  // (3: replay) — the one-shot claim, deliberately last (see module header).
  const claim = claimWorkOrder(signed, request.replayStore);
  if (!claim.ok) return reject(claim.reason);

  return { ok: true, workOrderHash: hashPayload(signed) };
}

// ── P1-DEBT-01 close (2026-08-06) — lease-to-mutation binding ─────────────
//
// The wave-2 handoff (CURSOR-HANDOFF.md, risk #2) already named this gap:
// runExecutorGate() proves a lease is held AT THE MOMENT IT RUNS, but the
// actual filesystem mutation is a SEPARATE call the caller makes afterwards.
// Nothing structurally prevented the lease from being released, replaced by
// another mission's stale-recovery, or (a pre-existing separate gap) simply
// expiring in between — runExecutorGate()'s own lease check never compared
// leaseExpiresAt against `now` at all, only `status === 'held'` and owner.
//
// runExecutorGateMutation() closes both gaps at once: it is the ONLY
// sanctioned way to perform the mutation an authorized Work Order describes.
// The caller passes the `mutate` callback itself, so the fresh, uncached
// getRepoWriterLeaseInfo() read below and the call to `mutate()` are two
// statements in the SAME synchronous function — no caller-controlled code
// can run in the gap, and Node's single-threaded execution model means
// nothing else in THIS process can interleave either. (A different OS
// process could still, in principle, mutate the lease file in the
// microseconds between this read and the caller's own fs write inside
// `mutate()`; closing that residual window completely would require this
// function to hold repo-writer-lock.ts's own file lock across the caller's
// arbitrary mutation, which is the redesign this fix deliberately avoids —
// see CURSOR-HANDOFF.md residual risks.)
//
// No `leaseHeld` boolean or any other caller-supplied "trust me" parameter
// exists anywhere in this module — this function always re-derives the
// answer itself, from disk, every time.

export interface ExecutorGateMutationRequest {
  /** The exact signed envelope that was authorized by an earlier runExecutorGate() call. */
  readonly signed: SignedWorkOrder;
  /** Independently-known identity of this executor process — NEVER derived from `signed`; re-checked here, not trusted from the earlier call. */
  readonly expectedExecutorIdentity: string;
  /** Filesystem path of the worktree the executor is actually standing in RIGHT NOW — re-derived, never cached from authorization time. */
  readonly worktreeRoot: string;
  /** Mission identity bound to the RepoWriterLease this executor must STILL hold. */
  readonly missionId: string;
  /** The workOrderHash returned by the runExecutorGate() call that authorized this mutation — binds this call to that exact authorization and refuses any attempt to swap in a different envelope between authorization and mutation. */
  readonly authorizedWorkOrderHash: string;
  /** Caller-selected evidence pack directory — REJECT claims are appended here, same as runExecutorGate(). */
  readonly evidenceDir: string;
  readonly now?: Date;
}

export type ExecutorGateMutationVerdict<T> =
  | { readonly ok: true; readonly workOrderHash: string; readonly mutationResult: T }
  | {
      readonly ok: false;
      readonly reason: ExecutorGateFailureReason;
      readonly receiptClaimId: string;
      readonly workOrderHash: string;
    };

/**
 * Re-validate lease ownership from disk — workOrderId, missionId, executor
 * identity, and repository canonical path, ALL checked against ground
 * truth, plus (unlike runExecutorGate()'s own lease check) an explicit
 * leaseExpiresAt comparison against `now` — and ONLY THEN call `mutate()`.
 * Any failure returns before `mutate()` is ever invoked and leaves a
 * deterministic REJECT receipt in the same evidence spine as
 * runExecutorGate(). Call this once, immediately in place of the mutation
 * itself — there is no other approved place to perform it.
 */
export function runExecutorGateMutation<T>(
  request: ExecutorGateMutationRequest,
  mutate: () => T,
): ExecutorGateMutationVerdict<T> {
  const { signed } = request;
  const now = request.now ?? new Date();

  const reject = (
    reason: ExecutorGateFailureReason,
    detail?: Record<string, unknown>,
  ): ExecutorGateMutationVerdict<T> => {
    const { claimId, workOrderHash } = emitRejectEvidence(signed, reason, request.evidenceDir, detail);
    return { ok: false, reason, receiptClaimId: claimId, workOrderHash };
  };

  const currentHash = hashPayload(signed);
  if (currentHash !== request.authorizedWorkOrderHash) {
    return reject('work_order_hash_mismatch', {
      authorizedWorkOrderHash: request.authorizedWorkOrderHash,
      currentHash,
    });
  }

  if (request.expectedExecutorIdentity !== signed.executorIdentity) {
    return reject('wrong_executor_identity');
  }

  let realCanonicalPath: string;
  try {
    realCanonicalPath = canonicalizeRepoPath(request.worktreeRoot);
  } catch (error) {
    return reject('reality_check_failed', {
      error: error instanceof Error ? error.message : String(error),
    });
  }

  // Fresh, uncached read — the very next statement is `mutate()`. Nothing
  // caller-controlled runs between this line and the mutation it gates.
  const lease = getRepoWriterLeaseInfo(request.worktreeRoot);
  const leaseExpiresAtMs = lease ? Date.parse(lease.leaseExpiresAt) : NaN;
  const leaseStillValid = (
    !!lease
    && lease.status === 'held'
    && lease.owner.missionId === request.missionId
    && lease.owner.workOrderId === signed.workOrderId
    && lease.repoCanonicalPath === realCanonicalPath
    && Number.isFinite(leaseExpiresAtMs)
    && leaseExpiresAtMs > now.getTime()
  );
  if (!leaseStillValid) {
    return reject('lease_lost_before_mutation', {
      missionId: request.missionId,
      workOrderId: signed.workOrderId,
      leaseSnapshot: lease
        ? {
            status: lease.status,
            owner: lease.owner,
            repoCanonicalPath: lease.repoCanonicalPath,
            leaseExpiresAt: lease.leaseExpiresAt,
          }
        : null,
    });
  }

  const mutationResult = mutate();
  return { ok: true, workOrderHash: currentHash, mutationResult };
}
