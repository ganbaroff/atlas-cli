/**
 * Sprint 3 — adversarial claim state machine tests (crash-safe idempotency).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { AddressInfo } from 'node:net';
import { createServer } from 'node:http';
import { LEARNING_SCHEMA_VERSION, type LearningReceipt, type LearningRequest } from '../learning/contracts.js';
import { FileLearningClaimStore } from '../learning/claim-store.js';
import { buildProofBundle, hashLearningRequest } from '../learning/claim-contract.js';
import { processLearningRequest, resetLearningRequestSeenForTests } from '../learning/request-port.js';
import { createLearningHttpHandler } from '../learning/http-server.js';
import { isolateLearningTestEnv } from '../learning/test-isolation.js';
import { readLedgerEntries } from '../evidence/ledger.js';
import { readGraph } from '../exec-graph/ledger.js';

const NOW = '2026-07-25T12:00:00.000Z';

function decideReq(partial: Partial<Extract<LearningRequest, { kind: 'decide' }>> = {}): LearningRequest {
  return {
    schemaVersion: LEARNING_SCHEMA_VERSION,
    requestId: partial.requestId ?? 'req_adv_001',
    idempotencyKey: partial.idempotencyKey ?? 'idem_adv_default',
    createdAt: partial.createdAt ?? NOW,
    issuedBy: 'volaura',
    kind: 'decide',
    payload: {
      learnerId: '123',
      concept: 'sigmoid',
      mastery: 0.35,
      lastAnswers: [false, true, false],
      responseTimeSec: 28,
      energy: 'medium',
    },
    ...partial,
  };
}

describe('learning claim adversarial', () => {
  let stateDir: string;

  beforeEach(() => {
    stateDir = mkdtempSync(join(tmpdir(), 'atlas-claim-adv-'));
    isolateLearningTestEnv(stateDir);
    process.env.SUPABASE_URL = '';
    process.env.SUPABASE_SERVICE_ROLE_KEY = '';
    delete process.env.ATLAS_READONLY;
    resetLearningRequestSeenForTests();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    delete process.env.ATLAS_LEARNING_CLAIM_LEASE_MS;
    delete process.env.K_REVISION;
    delete process.env.HOSTNAME;
    rmSync(stateDir, { recursive: true, force: true });
  });

  it('parallel same request → one decisionId, one completed proof', async () => {
    const req = decideReq({ idempotencyKey: 'idem_parallel_same' });
    const results = await Promise.all(
      Array.from({ length: 8 }, (_, i) =>
        processLearningRequest(
          { ...req, requestId: `req_parallel_${i}` },
          { exchangeDir: stateDir, owner: `owner-${i}` },
        ),
      ),
    );
    const completed = results.filter((r) => r.status === 'completed');
    expect(completed.length).toBeGreaterThanOrEqual(1);
    const decisionIds = completed.map((r) => r.decisionId).filter(Boolean);
    expect(new Set(decisionIds).size).toBe(1);
    const proof = await new FileLearningClaimStore(stateDir).readProof(req.idempotencyKey);
    expect(proof?.receipt.decisionId).toBe(decisionIds[0]);
  });

  it('same idempotencyKey with different payload → rejected (409 via HTTP)', async () => {
    const first = await processLearningRequest(
      decideReq({ idempotencyKey: 'idem_payload_mismatch' }),
      { exchangeDir: stateDir },
    );
    expect(first.status).toBe('completed');

    const conflict = await processLearningRequest(
      decideReq({
        idempotencyKey: 'idem_payload_mismatch',
        requestId: 'req_conflict_body',
        payload: {
          learnerId: '123',
          concept: 'sigmoid',
          mastery: 0.99,
          lastAnswers: [false, true, false],
          responseTimeSec: 28,
          energy: 'medium',
        },
      }),
      { exchangeDir: stateDir },
    );
    expect(conflict.status).toBe('rejected');
    expect(conflict.error).toMatch(/different payload/i);

    const claim = JSON.parse(
      readFileSync(join(stateDir, 'claims', 'idem_payload_mismatch.json'), 'utf8'),
    );
    expect(claim.state).toBe('completed');
    expect(claim.proof).toBeTruthy();
  });

  it('crash after claim → failed state retained, retry succeeds with proof', async () => {
    const genMod = await import('../learning/candidate-generator.js');
    const realGenerate = genMod.generateCandidates;
    const genSpy = vi.spyOn(genMod, 'generateCandidates')
      .mockImplementationOnce(async () => {
        throw new Error('crash after claim');
      })
      .mockImplementation((input, opts) => realGenerate(input, opts));

    const req = decideReq({ idempotencyKey: 'idem_crash_after_claim' });
    const crashed = await processLearningRequest(req, { exchangeDir: stateDir, owner: 'crash-owner' });
    expect(crashed.status).toBe('failed');

    const claimPath = join(stateDir, 'claims', 'idem_crash_after_claim.json');
    const failed = JSON.parse(readFileSync(claimPath, 'utf8'));
    expect(failed.state).toBe('failed');
    expect(failed.failureReason).toMatch(/crash after claim/);
    expect(failed.retryMetadata?.lastRequestId).toBe(req.requestId);

    genSpy.mockRestore();
    resetLearningRequestSeenForTests();

    const recovered = await processLearningRequest(
      { ...req, requestId: 'req_crash_retry' },
      { exchangeDir: stateDir, owner: 'recovery-owner' },
    );
    expect(recovered.status).toBe('completed');
    expect(recovered.proof?.requestHash).toBe(hashLearningRequest(req));
  });

  it('expired lease allows takeover; stale owner cannot complete', async () => {
    process.env.ATLAS_LEARNING_CLAIM_LEASE_MS = '1000';
    const store = new FileLearningClaimStore(stateDir);
    const req = decideReq({ idempotencyKey: 'idem_lease_takeover' });
    const t0 = '2026-01-01T00:00:00.000Z';
    const tExpired = '2026-01-01T00:00:05.000Z';

    const beginA = await store.beginOperation(req, 'owner-a', t0);
    expect(beginA.outcome).toBe('proceed');
    if (beginA.outcome !== 'proceed') return;

    const beginB = await store.beginOperation(req, 'owner-b', tExpired);
    expect(beginB.outcome).toBe('proceed');
    if (beginB.outcome !== 'proceed') return;
    expect(beginB.claim.owner).toBe('owner-b');
    expect(beginB.claim.attempt).toBe(2);

    const staleComplete = await store.completeOperation(
      req.idempotencyKey,
      'owner-a',
      beginA.generation,
      buildProofBundle(
        req,
        {
          schemaVersion: LEARNING_SCHEMA_VERSION,
          requestId: req.requestId,
          idempotencyKey: req.idempotencyKey,
          createdAt: req.createdAt,
          correlationId: req.idempotencyKey,
          kind: 'decide',
          status: 'completed',
          updatedAt: tExpired,
          decisionId: 'dec_stale',
        },
        {},
        {},
        t0,
      ),
      tExpired,
    );
    expect(staleComplete).toBe('stale_owner');
  });

  it('restart after completion returns same decisionId from durable proof', async () => {
    const req = decideReq({ idempotencyKey: 'idem_restart_proof' });
    const first = await processLearningRequest(req, { exchangeDir: stateDir, owner: 'inst-1' });
    expect(first.status).toBe('completed');
    expect(first.proof?.requestHash).toBeTruthy();

    resetLearningRequestSeenForTests();
    const second = await processLearningRequest(
      { ...req, requestId: 'req_after_restart' },
      { exchangeDir: stateDir, owner: 'inst-2-after-restart' },
    );
    expect(second.status).toBe('completed');
    expect(second.decisionId).toBe(first.decisionId);
    expect(second.proof?.requestHash).toBe(first.proof?.requestHash);

    const claim = JSON.parse(
      readFileSync(join(stateDir, 'claims', 'idem_restart_proof.json'), 'utf8'),
    );
    expect(claim.state).toBe('completed');
    expect(claim.proof.receipt.decisionId).toBe(first.decisionId);
  });

  it('proof bundle survives restart without local receipt projection', async () => {
    const req = decideReq({ idempotencyKey: 'idem_proof_only' });
    await processLearningRequest(req, { exchangeDir: stateDir });

    rmSync(join(stateDir, 'receipts'), { recursive: true, force: true });
    expect(existsSync(join(stateDir, 'receipts'))).toBe(false);

    const proof = await new FileLearningClaimStore(stateDir).readProof(req.idempotencyKey);
    expect(proof).toBeTruthy();
    expect(proof!.receipt.decisionId).toMatch(/^dec_/);
    expect(proof!.evidencePayload.kind).toBe('learning-nba-decision');
    expect(Object.keys(proof!.artifactHashes).length).toBeGreaterThan(0);
  });

  it('shared K_REVISION prefix — concurrent requests cannot both proceed', async () => {
    process.env.K_REVISION = 'atlas-learning-rev-001';
    delete process.env.HOSTNAME;
    const req = decideReq({ idempotencyKey: 'idem_krev_concurrent' });
    const genMod = await import('../learning/candidate-generator.js');
    const realGenerate = genMod.generateCandidates;
    vi.spyOn(genMod, 'generateCandidates').mockImplementation(async (input, opts) => {
      await new Promise((r) => setTimeout(r, 40));
      return realGenerate(input, opts);
    });

    const results = await Promise.all([
      processLearningRequest({ ...req, requestId: 'krev_a' }, { exchangeDir: stateDir }),
      processLearningRequest({ ...req, requestId: 'krev_b' }, { exchangeDir: stateDir }),
    ]);
    expect(results.filter((r) => r.status === 'completed').length).toBe(1);
    expect(results.some((r) => r.status === 'duplicate')).toBe(true);
  });

  it('stale worker after lease takeover does not duplicate local projections', async () => {
    process.env.ATLAS_LEARNING_CLAIM_LEASE_MS = '50';
    process.env.K_REVISION = 'rev-shared';
    const req = decideReq({ idempotencyKey: 'idem_stale_projections' });
    const genMod = await import('../learning/candidate-generator.js');
    const realGenerate = genMod.generateCandidates;
    let invocations = 0;
    vi.spyOn(genMod, 'generateCandidates').mockImplementation(async (input, opts) => {
      invocations += 1;
      if (invocations === 1) await new Promise((r) => setTimeout(r, 120));
      return realGenerate(input, opts);
    });

    const slowPromise = processLearningRequest(
      { ...req, requestId: 'slow_worker' },
      { exchangeDir: stateDir, owner: 'rev-shared:slow-worker' },
    );
    await new Promise((r) => setTimeout(r, 70));
    const fast = await processLearningRequest(
      { ...req, requestId: 'fast_worker' },
      { exchangeDir: stateDir, owner: 'rev-shared:fast-worker' },
    );
    const slow = await slowPromise;

    expect(fast.status).toBe('completed');
    expect(slow.status).toBe('completed');
    expect(slow.decisionId).toBe(fast.decisionId);
    expect(Object.keys(readGraph().goals).length).toBe(1);
    expect(readLedgerEntries(join(stateDir, 'evidence')).length).toBe(1);
  });

  it('receipt projection failure still returns durable completed proof', async () => {
    const req = decideReq({ idempotencyKey: 'idem_receipt_proj_fail' });
    const receipt = await processLearningRequest(req, {
      exchangeDir: stateDir,
      receiptWriter: () => {
        throw new Error('disk full');
      },
    });
    expect(receipt.status).toBe('completed');
    expect(receipt.proof?.requestHash).toBeTruthy();
    expect(existsSync(join(stateDir, 'claims', 'idem_receipt_proj_fail.json'))).toBe(true);
  });
});

describe('learning claim HTTP adversarial', () => {
  let stateDir: string;
  let baseUrl: string;
  let server: ReturnType<typeof createServer>;
  const apiKey = 'test-adv-key';

  beforeEach(async () => {
    stateDir = mkdtempSync(join(tmpdir(), 'atlas-claim-http-'));
    isolateLearningTestEnv(stateDir);
    process.env.ATLAS_LEARNING_API_KEY = apiKey;
    process.env.NODE_ENV = 'test';

    const handler = createLearningHttpHandler({ stateDir });
    server = createServer((req, res) => { void handler(req, res); });
    await new Promise<void>((resolve) => {
      server.listen(0, '127.0.0.1', () => resolve());
    });
    const { port } = server.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${port}`;
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await new Promise<void>((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()));
    });
    rmSync(stateDir, { recursive: true, force: true });
    delete process.env.ATLAS_LEARNING_API_KEY;
  });

  it('payload mismatch returns HTTP 409', async () => {
    const body = {
      schemaVersion: '1.0',
      kind: 'decide',
      requestId: 'req_http_conflict_a',
      idempotencyKey: 'idem_http_conflict',
      createdAt: NOW,
      issuedBy: 'volaura',
      payload: {
        learnerId: '123',
        concept: 'sigmoid',
        mastery: 0.35,
        lastAnswers: [false, true, false],
        responseTimeSec: 28,
        energy: 'medium',
      },
    };
    const ok = await fetch(`${baseUrl}/v1/learning/decide`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify(body),
    });
    expect(ok.status).toBe(200);

    const conflict = await fetch(`${baseUrl}/v1/learning/decide`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        ...body,
        requestId: 'req_http_conflict_b',
        payload: { ...body.payload, mastery: 0.91 },
      }),
    });
    expect(conflict.status).toBe(409);
    const json = (await conflict.json()) as LearningReceipt;
    expect(json.status).toBe('rejected');
  });
});

describe.each(Array.from({ length: 10 }, (_, i) => i))(
  'learning claim stability run %i',
  (runIndex) => {
    let stateDir: string;

    beforeEach(() => {
      stateDir = mkdtempSync(join(tmpdir(), `atlas-claim-stab-${runIndex}-`));
      isolateLearningTestEnv(stateDir);
      process.env.SUPABASE_URL = '';
      delete process.env.ATLAS_READONLY;
    });

    afterEach(() => {
      vi.restoreAllMocks();
      rmSync(stateDir, { recursive: true, force: true });
    });

    it('parallel idempotency is stable', async () => {
      const key = `idem_stab_${runIndex}`;
      const req = decideReq({ idempotencyKey: key, requestId: `req_stab_${runIndex}` });
      const results = await Promise.all(
        Array.from({ length: 5 }, (_, i) =>
          processLearningRequest(
            { ...req, requestId: `${req.requestId}_${i}` },
            { exchangeDir: stateDir, owner: `stab-${runIndex}-${i}` },
          ),
        ),
      );
      const completed = results.filter((r) => r.status === 'completed');
      expect(completed.length).toBeGreaterThanOrEqual(1);
      const ids = completed.map((r) => r.decisionId);
      expect(new Set(ids).size).toBe(1);
    });
  },
);
