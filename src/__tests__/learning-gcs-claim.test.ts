/**
 * GcsLearningClaimStore — atomic read + precondition tests (mocked Storage).
 */

import { describe, expect, it, vi } from 'vitest';
import { GCS_CLAIM_READ_RETRIES, GcsLearningClaimStore, readGcsClaimObject } from '../learning/claim-store.js';
import { LEARNING_SCHEMA_VERSION } from '../learning/contracts.js';
import type { LearningOperationClaim } from '../learning/claim-contract.js';

function sampleClaim(generation = '100'): LearningOperationClaim {
  return {
    schemaVersion: LEARNING_SCHEMA_VERSION,
    idempotencyKey: 'idem_gcs_mock',
    kind: 'decide',
    state: 'processing',
    owner: 'rev-1:uuid-a',
    requestHash: 'abc',
    leaseUntil: '2099-01-01T00:00:00.000Z',
    generation,
    attempt: 1,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
}

type MockFile = {
  exists: ReturnType<typeof vi.fn>;
  getMetadata: ReturnType<typeof vi.fn>;
  download: ReturnType<typeof vi.fn>;
  save: ReturnType<typeof vi.fn>;
};

function injectMockBucket(store: GcsLearningClaimStore, file: MockFile): void {
  (store as unknown as { bucket: { file: () => MockFile } }).bucket = { file: () => file };
}

describe('readGcsClaimObject', () => {
  it('retries when metadata generation advances between read and verify', async () => {
    const goodBody = JSON.stringify(sampleClaim('200'));
    const staleBody = JSON.stringify({ ...sampleClaim('200'), state: 'failed' });
    let metaReads = 0;
    let downloads = 0;

    const file: MockFile & { bucket: { file: ReturnType<typeof vi.fn> }; name: string } = {
      name: 'claims/idem_gcs_mock.json',
      bucket: { file: vi.fn(function fileRef() { return file; }) },
      exists: vi.fn(async () => [true]),
      getMetadata: vi.fn(async () => {
        metaReads += 1;
        if (metaReads === 1) return [{ generation: '200' }];
        if (metaReads === 2) return [{ generation: '201' }];
        return [{ generation: '200' }];
      }),
      download: vi.fn(async () => {
        downloads += 1;
        return [Buffer.from(downloads === 1 ? staleBody : goodBody)];
      }),
      save: vi.fn(async () => undefined),
    };

    const pair = await readGcsClaimObject(file as unknown as import('@google-cloud/storage').File, 3);
    expect(pair?.generation).toBe('200');
    expect(pair?.claim.state).toBe('processing');
    expect(file.download).toHaveBeenCalledTimes(2);
  });

  it('returns null after exhausting retries on perpetual generation churn', async () => {
    let metaReads = 0;
    const file: MockFile & { bucket: { file: ReturnType<typeof vi.fn> }; name: string } = {
      name: 'claims/idem_gcs_mock.json',
      bucket: { file: vi.fn(() => file) },
      exists: vi.fn(async () => [true]),
      getMetadata: vi.fn(async () => {
        metaReads += 1;
        return [{ generation: String(metaReads) }];
      }),
      download: vi.fn(async () => [Buffer.from(JSON.stringify(sampleClaim('1')))]),
      save: vi.fn(async () => undefined),
    };

    const pair = await readGcsClaimObject(file as unknown as import('@google-cloud/storage').File, 2);
    expect(pair).toBeNull();
  });
});

describe('GcsLearningClaimStore preconditions', () => {
  it('casClaim uses opaque string generation in ifGenerationMatch', async () => {
    const bigGen = '9007199254740992';
    let generation = bigGen;
    const file: MockFile & { bucket: { file: ReturnType<typeof vi.fn> }; name: string } = {
      name: 'claims/idem_gcs_mock.json',
      bucket: { file: vi.fn(() => file) },
      exists: vi.fn(async () => [true]),
      getMetadata: vi.fn(async () => [{ generation }]),
      download: vi.fn(async () => [Buffer.from(JSON.stringify(sampleClaim(generation)))]),
      save: vi.fn(async (_data: string, opts?: { preconditionOpts?: { ifGenerationMatch?: string | number } }) => {
        expect(String(opts?.preconditionOpts?.ifGenerationMatch)).toBe(bigGen);
        generation = String(BigInt(generation) + 1n);
      }),
    };

    const store = new GcsLearningClaimStore('test-bucket');
    injectMockBucket(store, file);

    const result = await (store as unknown as {
      casClaim: (
        key: string,
        gen: string,
        next: LearningOperationClaim,
      ) => Promise<LearningOperationClaim | null>;
    }).casClaim('idem_gcs_mock', bigGen, sampleClaim(bigGen));

    expect(result?.generation).toBe(String(BigInt(bigGen) + 1n));
  });

  it('readClaim pairs body with metadata generation', async () => {
    const file: MockFile & { bucket: { file: ReturnType<typeof vi.fn> }; name: string } = {
      name: 'claims/idem_gcs_mock.json',
      bucket: { file: vi.fn(() => file) },
      exists: vi.fn(async () => [true]),
      getMetadata: vi.fn(async () => [{ generation: '500' }]),
      download: vi.fn(async () => [Buffer.from(JSON.stringify(sampleClaim('500')))]),
      save: vi.fn(async () => undefined),
    };

    const store = new GcsLearningClaimStore('test-bucket');
    injectMockBucket(store, file);

    const claim = await (store as unknown as {
      readClaim: (key: string) => Promise<LearningOperationClaim | null>;
    }).readClaim('idem_gcs_mock');

    expect(claim?.generation).toBe('500');
    expect(claim?.state).toBe('processing');
  });
});

describe('GCS_CLAIM_READ_RETRIES', () => {
  it('defaults to 3 attempts', () => {
    expect(GCS_CLAIM_READ_RETRIES).toBe(3);
  });
});
