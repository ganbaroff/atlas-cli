/**
 * Sprint 3 — crash-safe operation claim contract (GCS CAS state machine).
 */

import { createHash, randomUUID } from 'node:crypto';
import type {
  LearningProofBundle,
  LearningReceipt,
  LearningRequest,
  LearningRequestKind,
} from './contracts.js';
import { LEARNING_SCHEMA_VERSION } from './contracts.js';

export type ClaimState = 'processing' | 'completed' | 'failed';

export interface LearningOperationClaim {
  schemaVersion: typeof LEARNING_SCHEMA_VERSION;
  idempotencyKey: string;
  kind: LearningRequestKind;
  state: ClaimState;
  owner: string;
  requestHash: string;
  leaseUntil: string;
  /** Opaque CAS generation — mirrors GCS object generation when on GCS. */
  generation: string;
  attempt: number;
  createdAt: string;
  updatedAt: string;
  proof?: LearningProofBundle;
  failureReason?: string;
  retryMetadata?: {
    lastRequestId: string;
    failedAt: string;
    priorAttempt: number;
  };
}

export type ClaimBeginOutcome =
  | { outcome: 'proceed'; claim: LearningOperationClaim; generation: string }
  | { outcome: 'completed'; proof: LearningProofBundle; receipt: LearningReceipt }
  | { outcome: 'conflict'; message: string }
  | { outcome: 'in_flight'; claim: LearningOperationClaim }
  | { outcome: 'stale_owner' };

export type ClaimCompleteOutcome = 'ok' | 'stale_owner' | 'cas_lost';

/** Observability prefix (revision / hostname) — NOT a unique operation owner. */
export function resolveOperationOwnerPrefix(): string {
  return process.env.K_REVISION
    ?? process.env.HOSTNAME
    ?? `local-${process.pid}`;
}

/** Unique owner per processLearningRequest invocation. */
export function newOperationOwner(): string {
  return `${resolveOperationOwnerPrefix()}:${randomUUID()}`;
}

/** @deprecated use newOperationOwner — kept for tests overriding owner explicitly */
export function resolveOperationOwner(): string {
  return newOperationOwner();
}

export function hashLearningRequest(req: LearningRequest): string {
  const canonical = JSON.stringify({ kind: req.kind, payload: req.payload });
  return createHash('sha256').update(canonical).digest('hex');
}

export function defaultLeaseMs(): number {
  return Number(process.env.ATLAS_LEARNING_CLAIM_LEASE_MS ?? 60_000);
}

export function extendLease(fromIso: string, leaseMs = defaultLeaseMs()): string {
  return new Date(new Date(fromIso).getTime() + leaseMs).toISOString();
}

export function nextFileGeneration(current: string): string {
  const n = BigInt(current);
  return String(n + 1n);
}

export function buildProcessingClaim(
  req: LearningRequest,
  owner: string,
  requestHash: string,
  now: string,
  attempt: number,
  generation: string,
): LearningOperationClaim {
  return {
    schemaVersion: LEARNING_SCHEMA_VERSION,
    idempotencyKey: req.idempotencyKey,
    kind: req.kind,
    state: 'processing',
    owner,
    requestHash,
    leaseUntil: extendLease(now),
    generation,
    attempt,
    createdAt: now,
    updatedAt: now,
  };
}

export function buildProofBundle(
  req: LearningRequest,
  receipt: LearningReceipt,
  evidencePayload: Record<string, unknown>,
  artifactHashes: Record<string, string>,
  claimedAt: string,
): LearningProofBundle {
  return {
    requestHash: hashLearningRequest(req),
    requestId: req.requestId,
    receipt,
    evidencePayload,
    artifactHashes,
    timestamps: { claimedAt, completedAt: receipt.updatedAt },
  };
}

export interface LearningClaimStore {
  beginOperation(req: LearningRequest, owner: string, now: string): Promise<ClaimBeginOutcome>;
  completeOperation(
    idempotencyKey: string,
    owner: string,
    generation: string,
    proof: LearningProofBundle,
    now: string,
  ): Promise<ClaimCompleteOutcome>;
  failOperation(
    idempotencyKey: string,
    owner: string,
    generation: string,
    reason: string,
    requestId: string,
    now: string,
  ): Promise<ClaimCompleteOutcome>;
  readProof(idempotencyKey: string): Promise<LearningProofBundle | null>;
}
