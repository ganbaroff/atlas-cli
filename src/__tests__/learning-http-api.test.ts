/**
 * Sprint 3 — HTTP learning API tests (auth, decide, outcome, idempotency).
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { AddressInfo } from 'node:net';
import { createServer } from 'node:http';
import {
  createLearningHttpHandler,
  resetLearningRequestSeenForTests,
} from '../learning/http-server.js';

describe('learning HTTP API', () => {
  let stateDir: string;
  let baseUrl: string;
  let server: ReturnType<typeof createServer>;
  const apiKey = 'test-learning-key';

  beforeEach(async () => {
    stateDir = mkdtempSync(join(tmpdir(), 'atlas-learning-http-'));
    process.env.ATLAS_LEARNING_API_KEY = apiKey;
    process.env.NODE_ENV = 'test';
    resetLearningRequestSeenForTests();

    const handler = createLearningHttpHandler({ stateDir });
    server = createServer((req, res) => {
      void handler(req, res);
    });
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

  async function post(path: string, body: unknown, headers: Record<string, string> = {}) {
    const res = await fetch(`${baseUrl}${path}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
        ...headers,
      },
      body: JSON.stringify(body),
    });
    const json = await res.json();
    return { status: res.status, json };
  }

  it('GET /health returns ok', async () => {
    const res = await fetch(`${baseUrl}/health`);
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json).toEqual({ ok: true, service: 'atlas-learning-api', version: 'v1' });
  });

  it('rejects missing auth when API key configured', async () => {
    const res = await fetch(`${baseUrl}/v1/learning/decide`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(401);
  });

  it('POST /v1/learning/decide returns sigmoid fixture decision', async () => {
    const { status, json } = await post('/v1/learning/decide', {
      idempotencyKey: 'idem_http_sigmoid_1',
      payload: {
        learnerId: '123',
        concept: 'sigmoid',
        mastery: 0.35,
        lastAnswers: [false, true, false],
        responseTimeSec: 28,
        energy: 'medium',
      },
    });
    expect(status).toBe(200);
    expect(json.status).toBe('completed');
    expect(json.decision?.action).toBe('VISUAL_EXPLANATION');
    expect(json.decision?.decisionScore).toBe(0.78);
    expect(json.decisionId).toBeTruthy();
    expect(json.goalId).toBeTruthy();
  });

  it('idempotent decide retry returns same decisionId', async () => {
    const body = {
      idempotencyKey: 'idem_http_sigmoid_retry',
      payload: {
        learnerId: '123',
        concept: 'sigmoid',
        mastery: 0.35,
        lastAnswers: [false, true, false],
        responseTimeSec: 28,
        energy: 'medium',
      },
    };
    const first = await post('/v1/learning/decide', body);
    const second = await post('/v1/learning/decide', body);
    expect(first.json.decisionId).toBe(second.json.decisionId);
  });

  it('POST /v1/learning/outcome records audit receipt', async () => {
    const { status, json } = await post('/v1/learning/outcome', {
      idempotencyKey: 'idem_http_outcome_1',
      payload: {
        learnerId: '123',
        concept: 'sigmoid',
        decisionCorrelationId: 'idem_http_sigmoid_1',
        completed: true,
        correct: true,
        responseTimeSec: 12,
      },
    });
    expect(status).toBe(200);
    expect(json.status).toBe('completed');
    expect(json.evidenceClaimId).toBeTruthy();
  });
});
