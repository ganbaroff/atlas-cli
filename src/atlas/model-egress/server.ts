/**
 * atlas/model-egress/server.ts — C5A-2 loopback egress leg.
 *
 * The ONE process on this machine allowed to carry provider auth and leave the
 * network. It binds loopback so it is a legal upstream for the C5A broker
 * (whose upstream-policy.ts refuses anything else), and forwards to exactly one
 * real provider chosen by the credits ladder at startup.
 *
 * Invariants, each of which is a test in model-egress.test.ts:
 *   1. NO-FALLBACK   — one provider, resolved once, read at the single call
 *                      site below. An upstream failure is a failure, never a
 *                      slide to the next provider.
 *   2. NO-REDIRECT   — `redirect: 'manual'`; any 3xx fails closed before the
 *                      body is parsed and the Location header is never read.
 *                      (The defect C5A-V found on the broker; not repeated.)
 *   3. CAP-FIRST     — the spend cap is consulted BEFORE the fetch, and charged
 *                      after every outcome including errors.
 *   4. MODEL-PINNED  — a request for a model other than the approved one is
 *                      refused, never rewritten.
 *   5. AUTH-CONTAINED— the auth token exists only in this module's closure and
 *                      appears only in the outbound Authorization header. It is
 *                      never logged, never put on a config object, never
 *                      returned in an error, and never reaches receipt.ts.
 *   6. LOOPBACK-BIND — listen() is always given an explicit loopback host, so
 *                      the process holding provider auth is never reachable
 *                      from the network.
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { randomUUID } from 'node:crypto';
import { assertOutboundProviderUrl, type ResolvedProvider } from './provider-ladder.js';
import { SpendCap, readTotalTokens } from './spend-cap.js';
import { recordEgressDecision } from './receipt.js';
import type { EgressConfig, EgressDecision, EgressDenyReason } from './types.js';

const MAX_BODY_BYTES = 1_000_000;

export interface CreateEgressServerOptions {
  /** Test seam. Defaults to global fetch. Never used to reach a second provider. */
  readonly fetchImpl?: typeof fetch;
  /** Test seam so cap behaviour can be exercised without a real budget. */
  readonly spendCap?: SpendCap;
}

function statusForDeny(reason: EgressDenyReason | undefined): number {
  switch (reason) {
    case 'malformed_request':
    case 'model_mismatch':
      return 400;
    case 'spend_cap_exhausted':
      return 429;
    case 'no_provider_configured':
      return 503;
    default:
      return 502;
  }
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  res.end(payload);
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error('body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

/**
 * Binds loopback and returns the server. `resolved` carries the auth token; it
 * is captured here and never stored on `config`, so nothing downstream — least
 * of all the receipt projection — can reach it.
 */
export function createEgressServer(
  config: EgressConfig,
  resolved: ResolvedProvider,
  options?: CreateEgressServerOptions,
): Server {
  // Config-time refusals, before a single connection is accepted.
  assertOutboundProviderUrl(resolved.spec.chatCompletionsUrl);
  if (config.host !== '127.0.0.1' && config.host !== '::1') {
    throw new Error(`model-egress: refusing non-loopback bind host: ${String(config.host)}`);
  }
  if (resolved.spec.id !== config.provider.id) {
    throw new Error('model-egress: resolved provider does not match configured provider');
  }

  const fetchImpl = options?.fetchImpl ?? fetch;
  const spendCap = options?.spendCap ?? new SpendCap(config.spendCap);
  const authToken = resolved.authToken;

  const server = createServer((req, res) => {
    void handleRequest(req, res, config, authToken, fetchImpl, spendCap);
  });
  // Host is mandatory on every listen() call — never bind 0.0.0.0.
  server.listen(config.port, config.host);
  return server;
}

async function handleRequest(
  req: IncomingMessage,
  res: ServerResponse,
  config: EgressConfig,
  authToken: string,
  fetchImpl: typeof fetch,
  spendCap: SpendCap,
): Promise<void> {
  const startedAt = Date.now();
  const egressRequestId = `egr_${randomUUID().replace(/-/g, '').slice(0, 20)}`;

  const deny = (reason: EgressDenyReason, tokensCharged = 0): void => {
    const snapshot = spendCap.snapshot();
    const decision: EgressDecision = {
      decision: 'DENY',
      reason,
      egressRequestId,
      providerId: config.provider.id,
      tier: config.provider.tier,
      model: config.approvedModel,
      status: statusForDeny(reason),
      latencyMs: Date.now() - startedAt,
      tokensCharged,
      requestsRemaining: snapshot.requestsRemaining,
      tokensRemaining: snapshot.tokensRemaining,
    };
    recordEgressDecision(decision);
    sendJson(res, decision.status, { error: { code: reason } });
  };

  if (req.method !== 'POST') {
    deny('malformed_request');
    return;
  }

  let requestBody: Record<string, unknown>;
  try {
    const raw = await readBody(req);
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      deny('malformed_request');
      return;
    }
    requestBody = parsed as Record<string, unknown>;
  } catch {
    deny('malformed_request');
    return;
  }

  // MODEL-PINNED: refuse, never rewrite. A silently corrected model is a silently
  // different bill and a silently different capability.
  if (requestBody.model !== config.approvedModel) {
    deny('model_mismatch');
    return;
  }

  // CAP-FIRST: consulted before the socket is opened, so an exhausted budget
  // cannot spend anything at all.
  if (!spendCap.canSpend()) {
    deny('spend_cap_exhausted');
    return;
  }

  // --- The single outbound call site. AUTH-CONTAINED: the only place the token
  // is read, and it is read straight into the header it belongs in. ---
  let upstreamResponse: Response;
  try {
    upstreamResponse = await fetchImpl(config.provider.chatCompletionsUrl, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${authToken}`,
      },
      body: JSON.stringify(requestBody),
      // NO-REDIRECT: never chase a 3xx off the approved provider.
      redirect: 'manual',
    });
  } catch {
    // An attempt that reached the network still consumes budget.
    const charged = spendCap.charge(null);
    deny('upstream_unavailable', charged);
    return;
  }

  // NO-REDIRECT (continued): fail closed on ANY 3xx before parsing a body, with
  // no special case per code and without ever reading Location.
  if (upstreamResponse.status >= 300 && upstreamResponse.status < 400) {
    const charged = spendCap.charge(null);
    deny('upstream_redirect', charged);
    return;
  }

  let upstreamJson: unknown;
  try {
    upstreamJson = await upstreamResponse.json();
  } catch {
    const charged = spendCap.charge(null);
    deny('upstream_bad_response', charged);
    return;
  }

  const charged = spendCap.charge(readTotalTokens(upstreamJson));
  const snapshot = spendCap.snapshot();

  if (upstreamResponse.status >= 400) {
    const decision: EgressDecision = {
      decision: 'DENY',
      reason: 'upstream_error',
      egressRequestId,
      providerId: config.provider.id,
      tier: config.provider.tier,
      model: config.approvedModel,
      status: upstreamResponse.status,
      latencyMs: Date.now() - startedAt,
      tokensCharged: charged,
      requestsRemaining: snapshot.requestsRemaining,
      tokensRemaining: snapshot.tokensRemaining,
    };
    recordEgressDecision(decision);
    sendJson(res, upstreamResponse.status, { error: { code: 'upstream_error' } });
    return;
  }

  const decision: EgressDecision = {
    decision: 'FORWARD',
    egressRequestId,
    providerId: config.provider.id,
    tier: config.provider.tier,
    model: config.approvedModel,
    status: upstreamResponse.status,
    latencyMs: Date.now() - startedAt,
    tokensCharged: charged,
    requestsRemaining: snapshot.requestsRemaining,
    tokensRemaining: snapshot.tokensRemaining,
  };
  recordEgressDecision(decision);
  sendJson(res, upstreamResponse.status, upstreamJson);
}
