/**
 * Sprint 3 — durable learning receipt store (file local, GCS Cloud Run).
 * Atomic claim on idempotencyKey prevents duplicate side-effects across instances.
 */

import {
  existsSync, mkdirSync, readFileSync, writeFileSync, renameSync, unlinkSync,
} from 'node:fs';
import { join } from 'node:path';
import type { LearningReceipt, LearningRequest } from './contracts.js';
import { LEARNING_SCHEMA_VERSION } from './contracts.js';
import { resolveRequestCorrelationId } from './contracts.js';

export interface LearningReceiptStore {
  readCompleted(idempotencyKey: string): Promise<LearningReceipt | null>;
  /** Returns true if this caller won the claim; false if another worker owns or completed it. */
  tryClaim(req: LearningRequest, now: string): Promise<boolean>;
  writeCompleted(receipt: LearningReceipt): Promise<void>;
  /** Release in-flight claim after crash so safe retry can proceed. */
  releaseClaim(idempotencyKey: string): Promise<void>;
}

function sanitizeFileKey(key: string): string {
  return key.replace(/[^a-zA-Z0-9._-]/g, '_');
}

function receiptPath(dir: string, idempotencyKey: string): string {
  return join(dir, 'receipts', `${sanitizeFileKey(idempotencyKey)}.json`);
}

function lockPath(dir: string, idempotencyKey: string): string {
  return join(dir, 'receipts', `${sanitizeFileKey(idempotencyKey)}.lock`);
}

function pendingReceipt(req: LearningRequest, now: string): LearningReceipt {
  return {
    schemaVersion: LEARNING_SCHEMA_VERSION,
    requestId: req.requestId,
    idempotencyKey: req.idempotencyKey,
    createdAt: req.createdAt,
    correlationId: resolveRequestCorrelationId(req),
    kind: req.kind,
    status: 'duplicate',
    updatedAt: now,
    error: 'processing',
  };
}

export class FileLearningReceiptStore implements LearningReceiptStore {
  constructor(private readonly dir: string) {
    mkdirSync(join(dir, 'receipts'), { recursive: true });
  }

  async readCompleted(idempotencyKey: string): Promise<LearningReceipt | null> {
    const path = receiptPath(this.dir, idempotencyKey);
    if (!existsSync(path)) return null;
    const receipt = JSON.parse(readFileSync(path, 'utf8')) as LearningReceipt;
    if (receipt.status === 'completed') return receipt;
    return null;
  }

  async tryClaim(req: LearningRequest, now: string): Promise<boolean> {
    const lock = lockPath(this.dir, req.idempotencyKey);
    try {
      writeFileSync(lock, now, { flag: 'wx' });
      return true;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'EEXIST') return false;
      throw err;
    }
  }

  async writeCompleted(receipt: LearningReceipt): Promise<void> {
    mkdirSync(join(this.dir, 'receipts'), { recursive: true });
    const dest = receiptPath(this.dir, receipt.idempotencyKey);
    const tmp = `${dest}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(receipt, null, 2), 'utf8');
    renameSync(tmp, dest);
    await this.releaseClaim(receipt.idempotencyKey);
  }

  async releaseClaim(idempotencyKey: string): Promise<void> {
    const lock = lockPath(this.dir, idempotencyKey);
    if (existsSync(lock)) {
      try { unlinkSync(lock); } catch { /* ignore */ }
    }
  }
}

export class GcsLearningReceiptStore implements LearningReceiptStore {
  private bucket: import('@google-cloud/storage').Bucket | null = null;

  constructor(private readonly bucketName: string) {}

  private async getBucket(): Promise<import('@google-cloud/storage').Bucket> {
    if (!this.bucket) {
      const { Storage } = await import('@google-cloud/storage');
      this.bucket = new Storage().bucket(this.bucketName);
    }
    return this.bucket;
  }

  private objectPath(idempotencyKey: string): string {
    return `receipts/${sanitizeFileKey(idempotencyKey)}.json`;
  }

  async readCompleted(idempotencyKey: string): Promise<LearningReceipt | null> {
    const bucket = await this.getBucket();
    const file = bucket.file(this.objectPath(idempotencyKey));
    const [exists] = await file.exists();
    if (!exists) return null;
    const [buf] = await file.download();
    const receipt = JSON.parse(buf.toString('utf8')) as LearningReceipt;
    if (receipt.status === 'completed') return receipt;
    return null;
  }

  async tryClaim(req: LearningRequest, now: string): Promise<boolean> {
    const bucket = await this.getBucket();
    const file = bucket.file(this.objectPath(req.idempotencyKey));
    const [exists] = await file.exists();
    if (exists) return false;
    const stub = pendingReceipt(req, now);
    try {
      await file.save(JSON.stringify(stub), {
        resumable: false,
        contentType: 'application/json',
        preconditionOpts: { ifGenerationMatch: 0 },
      });
      return true;
    } catch (err) {
      const code = (err as { code?: number }).code;
      if (code === 412) return false;
      throw err;
    }
  }

  async writeCompleted(receipt: LearningReceipt): Promise<void> {
    const bucket = await this.getBucket();
    const file = bucket.file(this.objectPath(receipt.idempotencyKey));
    await file.save(JSON.stringify(receipt, null, 2), {
      resumable: false,
      contentType: 'application/json',
    });
  }

  async releaseClaim(idempotencyKey: string): Promise<void> {
    const bucket = await this.getBucket();
    const file = bucket.file(this.objectPath(idempotencyKey));
    const [exists] = await file.exists();
    if (!exists) return;
    const [buf] = await file.download();
    const receipt = JSON.parse(buf.toString('utf8')) as LearningReceipt;
    if (receipt.status !== 'completed') {
      await file.delete({ ignoreNotFound: true });
    }
  }
}

/** File store for dev/CI; GCS when ATLAS_LEARNING_RECEIPTS_BUCKET is set (Cloud Run). */
export function createLearningReceiptStore(exchangeDir: string): LearningReceiptStore {
  const bucket = process.env.ATLAS_LEARNING_RECEIPTS_BUCKET?.trim();
  if (bucket) return new GcsLearningReceiptStore(bucket);
  return new FileLearningReceiptStore(exchangeDir);
}
