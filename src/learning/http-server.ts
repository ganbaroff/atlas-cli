/**
 * Sprint 3 — HTTP learning API for Cloud Run (replaces file exchange).
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { randomUUID } from 'node:crypto';
import { LearningAuthError, verifyLearningApiAuth } from './auth.js';
import { resolveLearningStateDir } from './state-dir.js';
import {
  LearningRequestParseError,
  formatLearningRequestError,
  parseLearningRequest,
  type LearningRequest,
} from './contracts.js';
import { processLearningRequest, resetLearningRequestSeenForTests } from './request-port.js';

export interface LearningHttpServerOptions {
  port?: number;
  host?: string;
  /** Max request body bytes (default 64 KiB). */
  maxBodyBytes?: number;
  /** Handler timeout ms (default 30_000). */
  requestTimeoutMs?: number;
  /** Inject state dir (tests). */
  stateDir?: string;
}

export interface LearningHttpHealth {
  ok: boolean;
  service: 'atlas-learning-api';
  version: 'v1';
}

function readJsonBody(req: IncomingMessage, maxBytes: number): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > maxBytes) {
        reject(new Error('request body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw.trim()) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(raw));
      } catch (err) {
        reject(err);
      }
    });
    req.on('error', reject);
  });
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) => {
      setTimeout(() => reject(new Error('request timeout')), ms);
    }),
  ]);
}

const ENVELOPE_KEYS = new Set([
  'schemaVersion', 'kind', 'requestId', 'idempotencyKey', 'createdAt', 'issuedBy', 'correlationId', 'payload',
]);

function extractPayload(body: Record<string, unknown>): Record<string, unknown> {
  if (body.payload && typeof body.payload === 'object' && !Array.isArray(body.payload)) {
    return body.payload as Record<string, unknown>;
  }
  return Object.fromEntries(
    Object.entries(body).filter(([key]) => !ENVELOPE_KEYS.has(key)),
  );
}

function buildLearningRequest(
  body: Record<string, unknown>,
  kind: 'decide' | 'outcome',
  idempotencyKey?: string,
): LearningRequest {
  const resolvedKey = idempotencyKey ?? (typeof body.idempotencyKey === 'string' ? body.idempotencyKey : undefined);
  if (body.kind === kind && body.payload) {
    return parseLearningRequest({
      ...body,
      idempotencyKey: resolvedKey ?? body.idempotencyKey,
    });
  }
  const now = new Date().toISOString();
  return parseLearningRequest({
    schemaVersion: '1.0',
    kind,
    requestId: body.requestId ?? `req_${randomUUID().replace(/-/g, '').slice(0, 12)}`,
    idempotencyKey: resolvedKey ?? body.idempotencyKey,
    createdAt: body.createdAt ?? now,
    issuedBy: body.issuedBy ?? 'volaura',
    payload: extractPayload(body),
  });
}

export function createLearningHttpHandler(opts?: LearningHttpServerOptions) {
  const maxBody = opts?.maxBodyBytes ?? 65_536;
  const timeoutMs = opts?.requestTimeoutMs ?? 30_000;
  const stateDir = () => resolveLearningStateDir(opts?.stateDir);

  return async function handler(req: IncomingMessage, res: ServerResponse): Promise<void> {
    try {
      const url = new URL(req.url ?? '/', 'http://localhost');
      const path = url.pathname;

      if (req.method === 'GET' && (path === '/health' || path === '/v1/health')) {
        const health: LearningHttpHealth = { ok: true, service: 'atlas-learning-api', version: 'v1' };
        sendJson(res, 200, health);
        return;
      }

      if (req.method !== 'POST') {
        sendJson(res, 405, { error: 'method not allowed' });
        return;
      }

      verifyLearningApiAuth(req);

      let body: Record<string, unknown>;
      try {
        body = (await readJsonBody(req, maxBody)) as Record<string, unknown>;
      } catch (err) {
        sendJson(res, 400, {
          error: 'invalid JSON body',
          details: formatLearningRequestError(err),
        });
        return;
      }

      const idempotencyKey = (
        req.headers['idempotency-key']
        ?? req.headers['x-idempotency-key']
        ?? body.idempotencyKey
      ) as string | undefined;

      let learningReq: LearningRequest;
      if (path === '/v1/learning/decide') {
        learningReq = buildLearningRequest(body, 'decide', idempotencyKey);
      } else if (path === '/v1/learning/outcome') {
        learningReq = buildLearningRequest(body, 'outcome', idempotencyKey);
      } else {
        sendJson(res, 404, { error: 'not found' });
        return;
      }

      const receipt = await withTimeout(
        processLearningRequest(learningReq, { exchangeDir: stateDir() }),
        timeoutMs,
      );

      const status = receipt.status === 'completed' ? 200
        : receipt.status === 'duplicate' ? 409
          : receipt.status === 'rejected' ? 409
            : receipt.status === 'readonly' ? 503
              : 502;
      sendJson(res, status, receipt);
    } catch (err) {
      if (err instanceof LearningAuthError) {
        sendJson(res, 401, { error: err.message });
        return;
      }
      if (err instanceof LearningRequestParseError) {
        sendJson(res, 400, { error: err.message, details: err.details });
        return;
      }
      if (err instanceof Error && err.message.includes('timeout')) {
        sendJson(res, 504, { error: 'gateway timeout' });
        return;
      }
      sendJson(res, 500, { error: 'internal error' });
    }
  };
}

export function startLearningHttpServer(opts?: LearningHttpServerOptions): Server {
  const port = opts?.port ?? Number(process.env.PORT ?? 8080);
  const host = opts?.host ?? '0.0.0.0';
  const handler = createLearningHttpHandler(opts);
  const server = createServer((req, res) => {
    void handler(req, res);
  });
  server.listen(port, host);
  return server;
}

export { resetLearningRequestSeenForTests };
