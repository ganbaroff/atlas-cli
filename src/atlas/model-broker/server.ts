/**
 * atlas/model-broker/server.ts — C5A local model-call broker (mock upstream
 * only; see BrokerConfig.mode === 'C5A_MOCK_ONLY').
 *
 * C5A no-fallback invariant: there is exactly ONE upstream target for the
 * lifetime of a broker instance — config.upstreamUrl, read once at
 * construction (assertLoopbackUpstream validates it before the server ever
 * listens) and read again, unchanged, at the single forwarding call site
 * below. There is no retry-on-another-host, no reading a base_url from the
 * incoming request, and no environment-provided override read at request
 * time — the `const upstreamUrl = config.upstreamUrl;` line inside
 * handleRequest is the sole upstream target for every request this server
 * ever forwards.
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { randomUUID } from 'node:crypto';
import { assertLoopbackUpstream } from './upstream-policy.js';
import { authorizeModelRequest, type AuthorizationOutcome } from './authorize.js';
import { recordBrokerDecision } from './receipt.js';
import {
  createProductionWorkOrderReplayStore,
  type WorkOrderReplayStore,
} from '../work-order/replay.js';
import type { BrokerConfig, BrokerDecision } from './types.js';

const MAX_BODY_BYTES = 65_536;

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

/**
 * unknown_operation (bad route, or an envelope authorizing a different
 * operation) is the one 404; upstream_redirect is a 502 (broker-side upstream
 * failure, not a client authorization defect); every other deny — including
 * the C5A-R2/R3 expiry and request-id reasons — is 403, the same class as
 * the other authorization denials.
 */
function statusForDeny(reason: AuthorizationOutcome['reason']): number {
  if (reason === 'unknown_operation') return 404;
  if (reason === 'upstream_redirect') return 502;
  return 403;
}

function resolveBrokerRequestId(req: IncomingMessage): string {
  const header = req.headers['x-atlas-request-id'];
  return typeof header === 'string' && header.length > 0 ? header : randomUUID();
}

/** Raw `x-atlas-request-id` header, read separately from resolveBrokerRequestId (which may fall back to a server-generated id) — C5A-R3 needs the literal header-or-absent value. */
function resolveLiveRequestId(req: IncomingMessage): string | undefined {
  const header = req.headers['x-atlas-request-id'];
  return typeof header === 'string' ? header : undefined;
}

export interface CreateBrokerServerOptions {
  /** Injectable for tests; defaults to the production file-backed store shared with repo Work Orders. */
  readonly replayStore?: WorkOrderReplayStore;
}

export function createBrokerServer(config: BrokerConfig, options?: CreateBrokerServerOptions): Server {
  // Config validation happens here, at construction, before any socket opens.
  assertLoopbackUpstream(config.upstreamUrl);
  if (config.host !== '127.0.0.1' && config.host !== '::1') {
    throw new Error(`model-broker: refusing non-loopback host: ${config.host}`);
  }
  if (config.mode !== 'C5A_MOCK_ONLY') {
    throw new Error(`model-broker: refusing unsupported mode: ${String(config.mode)}`);
  }

  const replayStore = options?.replayStore ?? createProductionWorkOrderReplayStore();

  const server = createServer((req, res) => {
    void handleRequest(req, res, config, replayStore);
  });
  // Host is mandatory on every listen() call — never bind 0.0.0.0.
  server.listen(config.port, config.host);
  return server;
}

async function handleRequest(
  req: IncomingMessage,
  res: ServerResponse,
  config: BrokerConfig,
  replayStore: WorkOrderReplayStore,
): Promise<void> {
  const startedAt = Date.now();
  const url = new URL(req.url ?? '/', 'http://localhost');
  const path = url.pathname;
  const brokerRequestId = resolveBrokerRequestId(req);

  const isChatCompletionsRoute = req.method === 'POST'
    && (path === '/chat/completions' || path === '/v1/chat/completions');
  if (!isChatCompletionsRoute) {
    const decision: BrokerDecision = {
      decision: 'DENY',
      reason: 'unknown_operation',
      brokerRequestId,
      workOrderId: null,
      workOrderHash: null,
      provider: null,
      model: null,
      upstreamClass: 'local_mock',
      status: 404,
      latencyMs: Date.now() - startedAt,
    };
    recordBrokerDecision(decision);
    sendJson(res, 404, { error: { code: decision.reason } });
    return;
  }

  let requestBody: unknown;
  try {
    requestBody = await readJsonBody(req, MAX_BODY_BYTES);
  } catch {
    // Unparseable/oversized body carries no extractable `model` — authorizeModelRequest
    // denies it naturally via model_mismatch; no separate reason code is invented here.
    requestBody = undefined;
  }

  const headerValue = req.headers['x-atlas-work-order'];
  const authorizationHeader = typeof headerValue === 'string' ? headerValue : undefined;
  const rawRequestIdHeader = resolveLiveRequestId(req);

  const outcome = authorizeModelRequest({
    authorizationHeader,
    requestBody,
    config,
    replayStore,
    brokerRequestId,
    liveRequestId: rawRequestIdHeader,
  });

  if (outcome.decision === 'DENY') {
    const status = statusForDeny(outcome.reason);
    const decision: BrokerDecision = { ...outcome, status, latencyMs: Date.now() - startedAt };
    recordBrokerDecision(decision);
    sendJson(res, status, { error: { code: outcome.reason } });
    return;
  }

  // --- C5A no-fallback invariant: the ONE upstream target, read once, right here. ---
  const upstreamUrl = config.upstreamUrl;
  let upstreamResponse: Response;
  try {
    // C5A-R1 no-redirect invariant: the broker never follows a 3xx from its
    // one approved upstream — `redirect: 'manual'` stops Node from chasing
    // it, and any 3xx status is treated as a broker failure below, generic
    // across every redirect code, without ever reading the Location header.
    upstreamResponse = await fetch(upstreamUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(requestBody),
      redirect: 'manual',
    });
  } catch {
    const decision: BrokerDecision = {
      ...outcome,
      decision: 'DENY',
      reason: 'upstream_unavailable',
      status: 502,
      latencyMs: Date.now() - startedAt,
    };
    recordBrokerDecision(decision);
    sendJson(res, 502, { error: { code: 'upstream_unavailable' } });
    return;
  }

  // C5A-R1 no-redirect invariant (continued): fail closed on ANY 3xx before
  // ever parsing the body — no code is special-cased and the Location header
  // is never read, logged, or forwarded.
  if (upstreamResponse.status >= 300 && upstreamResponse.status < 400) {
    const decision: BrokerDecision = {
      ...outcome,
      decision: 'DENY',
      reason: 'upstream_redirect',
      status: 502,
      latencyMs: Date.now() - startedAt,
    };
    recordBrokerDecision(decision);
    sendJson(res, 502, { error: { code: 'upstream_redirect' } });
    return;
  }

  let upstreamJson: unknown;
  try {
    upstreamJson = await upstreamResponse.json();
  } catch {
    const decision: BrokerDecision = {
      ...outcome,
      decision: 'DENY',
      reason: 'upstream_bad_response',
      status: 502,
      latencyMs: Date.now() - startedAt,
    };
    recordBrokerDecision(decision);
    sendJson(res, 502, { error: { code: 'upstream_bad_response' } });
    return;
  }

  const decision: BrokerDecision = { ...outcome, status: upstreamResponse.status, latencyMs: Date.now() - startedAt };
  recordBrokerDecision(decision);
  sendJson(res, upstreamResponse.status, upstreamJson);
}
