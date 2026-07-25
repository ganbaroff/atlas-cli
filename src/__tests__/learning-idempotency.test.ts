/**
 * Sprint 3 — idempotency hardening: concurrent claims, header envelope, restart.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { AddressInfo } from 'node:net';
import { createServer } from 'node:http';
import { LEARNING_SCHEMA_VERSION, type LearningReceipt, type LearningRequest } from '../learning/contracts.js';
import { processLearningRequest, resetLearningRequestSeenForTests } from '../learning/request-port.js';
import {
  createLearningHttpHandler,
  resetLearningRequestSeenForTests as resetHttpSeen,
} from '../learning/http-server.js';

const NOW = '2026-07-25T12:00:00.000Z';

function decideReq(partial: Partial<Extract<LearningRequest, { kind: 'decide' }>> = {}): LearningRequest {
  return {
    schemaVersion: LEARNING_SCHEMA_VERSION,
    requestId: partial.requestId ?? 'req_concurrent_001',
    idempotencyKey: partial.idempotencyKey ?? 'idem_concurrent_abc',
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

describe('learning idempotency hardening', () => {
  let stateDir: string;

  beforeEach(() => {
    stateDir = mkdtempSync(join(tmpdir(), 'atlas-idem-'));
    resetLearningRequestSeenForTests();
  });

  afterEach(() => {
    rmSync(stateDir, { recursive: true, force: true });
  });

  it('parallel requests with same idempotencyKey return same decisionId', async () => {
    const req = decideReq();
    const results = await Promise.all([
      processLearningRequest(req, { exchangeDir: stateDir }),
      processLearningRequest({ ...req, requestId: 'req_retry_2' }, { exchangeDir: stateDir }),
      processLearningRequest({ ...req, requestId: 'req_retry_3' }, { exchangeDir: stateDir }),
    ]);
    const completed = results.filter((r) => r.status === 'completed');
    expect(completed.length).toBeGreaterThanOrEqual(1);
    const decisionIds = completed.map((r) => r.decisionId).filter(Boolean);
    expect(new Set(decisionIds).size).toBe(1);
  });

  it('restart simulation: second call after first completed returns same decisionId', async () => {
    const req = decideReq({ idempotencyKey: 'idem_restart_xyz' });
    const first = await processLearningRequest(req, { exchangeDir: stateDir });
    resetLearningRequestSeenForTests();
    const second = await processLearningRequest(
      { ...req, requestId: 'req_after_restart' },
      { exchangeDir: stateDir },
    );
    expect(first.status).toBe('completed');
    expect(second.status).toBe('completed');
    expect(second.decisionId).toBe(first.decisionId);
  });
});

describe('learning HTTP header idempotency', () => {
  let stateDir: string;
  let baseUrl: string;
  let server: ReturnType<typeof createServer>;
  const apiKey = 'test-learning-key';

  beforeEach(async () => {
    stateDir = mkdtempSync(join(tmpdir(), 'atlas-http-idem-'));
    process.env.ATLAS_LEARNING_API_KEY = apiKey;
    process.env.NODE_ENV = 'test';
    resetHttpSeen();

    const handler = createLearningHttpHandler({ stateDir });
    server = createServer((req, res) => { void handler(req, res); });
    await new Promise<void>((resolve) => {
      server.listen(0, '127.0.0.1', () => resolve());
    });
    const { port } = server.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${port}`;
  });

  afterEach(async () => {
    await new Promise<void>((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()));
    });
    rmSync(stateDir, { recursive: true, force: true });
    delete process.env.ATLAS_LEARNING_API_KEY;
  });

  it('accepts Idempotency-Key header on full envelope without body idempotencyKey', async () => {
    const res = await fetch(`${baseUrl}/v1/learning/decide`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
        'Idempotency-Key': 'idem_header_envelope_only',
      },
      body: JSON.stringify({
        schemaVersion: '1.0',
        kind: 'decide',
        requestId: 'req_header_env',
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
      }),
    });
    expect(res.status).toBe(200);
    const json = (await res.json()) as LearningReceipt;
    expect(json.status).toBe('completed');
    expect(json.idempotencyKey).toBe('idem_header_envelope_only');
  });
});
