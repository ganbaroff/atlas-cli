/**
 * Sprint 3 — GCS generation CAS claim store (+ file mirror for CI/dev).
 */

import {
  existsSync, mkdirSync, readFileSync, writeFileSync, renameSync,
} from 'node:fs';
import { join } from 'node:path';
import type { LearningProofBundle, LearningReceipt, LearningRequest } from './contracts.js';
import {
  type ClaimBeginOutcome,
  type ClaimCompleteOutcome,
  type LearningClaimStore,
  type LearningOperationClaim,
  buildProcessingClaim,
  extendLease,
  hashLearningRequest,
  nextFileGeneration,
} from './claim-contract.js';
import { withClaimFileLock } from './claim-file-lock.js';

export const GCS_CLAIM_READ_RETRIES = 3;

function sanitizeFileKey(key: string): string {
  return key.replace(/[^a-zA-Z0-9._-]/g, '_');
}

function claimPath(root: string, idempotencyKey: string): string {
  mkdirSync(join(root, 'claims'), { recursive: true });
  return join(root, 'claims', `${sanitizeFileKey(idempotencyKey)}.json`);
}

function parseClaim(raw: string): LearningOperationClaim {
  return JSON.parse(raw) as LearningOperationClaim;
}

function leaseExpired(claim: LearningOperationClaim, now: string): boolean {
  return new Date(claim.leaseUntil).getTime() <= new Date(now).getTime();
}

function receiptFromProof(proof: LearningProofBundle): LearningReceipt {
  return { ...proof.receipt, proof, status: 'completed' };
}

function gcsPreconditionGeneration(generation: string): string | number {
  const asNumber = Number(generation);
  if (Number.isSafeInteger(asNumber)) return asNumber;
  return generation;
}

function isRetryableGcsReadError(err: unknown): boolean {
  const code = (err as { code?: number }).code;
  return code === 404 || code === 412;
}

/** Read GCS object body + generation as one consistent pair (retry on race). */
export async function readGcsClaimObject(
  file: import('@google-cloud/storage').File,
  maxAttempts = GCS_CLAIM_READ_RETRIES,
): Promise<{ claim: LearningOperationClaim; generation: string } | null> {
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    let generation = '';
    try {
      const [meta] = await file.getMetadata();
      generation = String(meta.generation ?? '');
      if (!generation) return null;

      const versioned = file.bucket.file(file.name, {
        generation: gcsPreconditionGeneration(generation),
      });
      const [buf] = await versioned.download();
      const parsed = parseClaim(buf.toString('utf8'));

      const [verifyMeta] = await file.getMetadata();
      const verifyGeneration = String(verifyMeta.generation ?? '');
      if (verifyGeneration !== generation) continue;

      return { claim: { ...parsed, generation }, generation };
    } catch (err) {
      if (isRetryableGcsReadError(err)) continue;
      throw err;
    }
  }
  return null;
}

abstract class BaseClaimStore implements LearningClaimStore {
  protected abstract readClaim(idempotencyKey: string): Promise<LearningOperationClaim | null>;
  protected abstract createClaim(claim: LearningOperationClaim): Promise<LearningOperationClaim | null>;
  protected abstract casClaim(
    idempotencyKey: string,
    expectedGeneration: string,
    next: LearningOperationClaim,
  ): Promise<LearningOperationClaim | null>;

  async beginOperation(req: LearningRequest, owner: string, now: string): Promise<ClaimBeginOutcome> {
    const requestHash = hashLearningRequest(req);
    const existing = await this.readClaim(req.idempotencyKey);

    if (!existing) {
      const claim = buildProcessingClaim(req, owner, requestHash, now, 1, '1');
      const created = await this.createClaim(claim);
      if (!created) return this.beginOperation(req, owner, now);
      return { outcome: 'proceed', claim: created, generation: created.generation };
    }

    if (existing.requestHash !== requestHash) {
      return { outcome: 'conflict', message: 'idempotencyKey reused with different payload' };
    }

    if (existing.state === 'completed' && existing.proof) {
      return {
        outcome: 'completed',
        proof: existing.proof,
        receipt: receiptFromProof(existing.proof),
      };
    }

    if (existing.state === 'processing') {
      if (existing.owner === owner) {
        const refreshed: LearningOperationClaim = {
          ...existing,
          leaseUntil: extendLease(now),
          updatedAt: now,
        };
        const updated = await this.casClaim(req.idempotencyKey, existing.generation, refreshed);
        if (!updated) return this.beginOperation(req, owner, now);
        return { outcome: 'proceed', claim: updated, generation: updated.generation };
      }
      if (!leaseExpired(existing, now)) {
        return { outcome: 'in_flight', claim: existing };
      }
      const takeover = buildProcessingClaim(
        req,
        owner,
        requestHash,
        now,
        existing.attempt + 1,
        existing.generation,
      );
      const updated = await this.casClaim(req.idempotencyKey, existing.generation, takeover);
      if (!updated) return this.beginOperation(req, owner, now);
      return { outcome: 'proceed', claim: updated, generation: updated.generation };
    }

    if (existing.state === 'failed') {
      const retry = buildProcessingClaim(
        req,
        owner,
        requestHash,
        now,
        existing.attempt + 1,
        existing.generation,
      );
      retry.retryMetadata = {
        lastRequestId: existing.retryMetadata?.lastRequestId ?? req.requestId,
        failedAt: existing.updatedAt,
        priorAttempt: existing.attempt,
      };
      const updated = await this.casClaim(req.idempotencyKey, existing.generation, retry);
      if (!updated) return this.beginOperation(req, owner, now);
      return { outcome: 'proceed', claim: updated, generation: updated.generation };
    }

    return { outcome: 'in_flight', claim: existing };
  }

  async completeOperation(
    idempotencyKey: string,
    owner: string,
    generation: string,
    proof: LearningProofBundle,
    now: string,
  ): Promise<ClaimCompleteOutcome> {
    const existing = await this.readClaim(idempotencyKey);
    if (!existing) return 'cas_lost';
    if (existing.owner !== owner) return 'stale_owner';
    if (existing.generation !== generation) return 'cas_lost';
    if (existing.state !== 'processing') return 'cas_lost';

    const next: LearningOperationClaim = {
      ...existing,
      state: 'completed',
      proof,
      updatedAt: now,
    };
    const updated = await this.casClaim(idempotencyKey, generation, next);
    if (!updated) return 'cas_lost';
    return 'ok';
  }

  async failOperation(
    idempotencyKey: string,
    owner: string,
    generation: string,
    reason: string,
    requestId: string,
    now: string,
  ): Promise<ClaimCompleteOutcome> {
    const existing = await this.readClaim(idempotencyKey);
    if (!existing) return 'cas_lost';
    if (existing.owner !== owner) return 'stale_owner';
    if (existing.generation !== generation) return 'cas_lost';
    if (existing.state !== 'processing') return 'cas_lost';

    const next: LearningOperationClaim = {
      ...existing,
      state: 'failed',
      failureReason: reason.slice(0, 500),
      updatedAt: now,
      retryMetadata: {
        lastRequestId: requestId,
        failedAt: now,
        priorAttempt: existing.attempt,
      },
    };
    const updated = await this.casClaim(idempotencyKey, generation, next);
    if (!updated) return 'cas_lost';
    return 'ok';
  }

  async readProof(idempotencyKey: string): Promise<LearningProofBundle | null> {
    const claim = await this.readClaim(idempotencyKey);
    if (!claim || claim.state !== 'completed' || !claim.proof) return null;
    return claim.proof;
  }
}

export class FileLearningClaimStore extends BaseClaimStore {
  constructor(private readonly root: string) {
    super();
    mkdirSync(join(root, 'claims'), { recursive: true });
  }

  protected async readClaim(idempotencyKey: string): Promise<LearningOperationClaim | null> {
    const path = claimPath(this.root, idempotencyKey);
    if (!existsSync(path)) return null;
    return parseClaim(readFileSync(path, 'utf8'));
  }

  protected async createClaim(claim: LearningOperationClaim): Promise<LearningOperationClaim | null> {
    const path = claimPath(this.root, claim.idempotencyKey);
    return withClaimFileLock(path, () => {
      try {
        writeFileSync(path, JSON.stringify(claim), { flag: 'wx' });
        return claim;
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'EEXIST') return null;
        throw err;
      }
    });
  }

  protected async casClaim(
    idempotencyKey: string,
    expectedGeneration: string,
    next: LearningOperationClaim,
  ): Promise<LearningOperationClaim | null> {
    const path = claimPath(this.root, idempotencyKey);
    return withClaimFileLock(path, () => {
      if (!existsSync(path)) return null;
      const current = parseClaim(readFileSync(path, 'utf8'));
      if (current.generation !== expectedGeneration) return null;
      const updated: LearningOperationClaim = {
        ...next,
        generation: nextFileGeneration(expectedGeneration),
      };
      const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
      writeFileSync(tmp, JSON.stringify(updated), 'utf8');
      renameSync(tmp, path);
      const verified = parseClaim(readFileSync(path, 'utf8'));
      if (verified.generation !== updated.generation) return null;
      return updated;
    });
  }
}

export class GcsLearningClaimStore extends BaseClaimStore {
  private bucket: import('@google-cloud/storage').Bucket | null = null;

  constructor(private readonly bucketName: string) {
    super();
  }

  private async getBucket(): Promise<import('@google-cloud/storage').Bucket> {
    if (!this.bucket) {
      const { Storage } = await import('@google-cloud/storage');
      this.bucket = new Storage().bucket(this.bucketName);
    }
    return this.bucket;
  }

  private objectPath(idempotencyKey: string): string {
    return `claims/${sanitizeFileKey(idempotencyKey)}.json`;
  }

  protected async readClaim(idempotencyKey: string): Promise<LearningOperationClaim | null> {
    const bucket = await this.getBucket();
    const file = bucket.file(this.objectPath(idempotencyKey));
    const [exists] = await file.exists();
    if (!exists) return null;
    const pair = await readGcsClaimObject(file);
    return pair?.claim ?? null;
  }

  protected async createClaim(claim: LearningOperationClaim): Promise<LearningOperationClaim | null> {
    const bucket = await this.getBucket();
    const file = bucket.file(this.objectPath(claim.idempotencyKey));
    try {
      await file.save(JSON.stringify(claim), {
        resumable: false,
        contentType: 'application/json',
        preconditionOpts: { ifGenerationMatch: 0 },
      });
      const [meta] = await file.getMetadata();
      return { ...claim, generation: String(meta.generation ?? '1') };
    } catch (err) {
      if ((err as { code?: number }).code === 412) return null;
      throw err;
    }
  }

  protected async casClaim(
    idempotencyKey: string,
    expectedGeneration: string,
    next: LearningOperationClaim,
  ): Promise<LearningOperationClaim | null> {
    const bucket = await this.getBucket();
    const file = bucket.file(this.objectPath(idempotencyKey));
    const body: LearningOperationClaim = { ...next, generation: expectedGeneration };
    try {
      await file.save(JSON.stringify(body), {
        resumable: false,
        contentType: 'application/json',
        preconditionOpts: { ifGenerationMatch: gcsPreconditionGeneration(expectedGeneration) },
      });
      const [meta] = await file.getMetadata();
      return { ...body, generation: String(meta.generation ?? expectedGeneration) };
    } catch (err) {
      if ((err as { code?: number }).code === 412) return null;
      throw err;
    }
  }
}

export function createLearningClaimStore(rootDir: string): LearningClaimStore {
  const bucket = process.env.ATLAS_LEARNING_RECEIPTS_BUCKET?.trim();
  if (bucket) return new GcsLearningClaimStore(bucket);
  return new FileLearningClaimStore(rootDir);
}

/** @deprecated use createLearningClaimStore */
export function createLearningReceiptStore(rootDir: string): LearningClaimStore {
  return createLearningClaimStore(rootDir);
}

export { extendLease } from './claim-contract.js';
export { defaultLeaseMs } from './claim-contract.js';
