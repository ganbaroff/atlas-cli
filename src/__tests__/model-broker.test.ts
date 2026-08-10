/**
 * model-broker.test.ts — C5A model-call broker (continuation of C5A).
 *
 * ALL via loopback only: broker + mock upstream both bind 127.0.0.1 on
 * ephemeral ports, evidence/replay state lives under per-test temp dirs
 * (ATLAS_EVIDENCE_DIR override + createWorkOrderReplayStore(tempDir)). No
 * real network call is ever made — the only "upstream" reachable from this
 * file is the in-process mock-upstream.ts server. TEST_KEY is an obviously
 * fake string, never a real secret.
 */

import {
  afterEach, beforeEach, describe, expect, it,
} from 'vitest';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createServer as createNetServer } from 'node:net';
import { createServer as createHttpServer, type Server } from 'node:http';

import { hmacSigner, canonicalizeWorkOrder } from '../atlas/work-order/sign.js';
import { WORK_ORDER_SIGNATURE_ALGORITHM } from '../atlas/work-order/types.js';
import { createWorkOrderReplayStore, type WorkOrderReplayStore } from '../atlas/work-order/replay.js';

import { createBrokerServer } from '../atlas/model-broker/server.js';
import { createMockUpstream, type MockUpstream } from '../atlas/model-broker/mock-upstream.js';
import { assertLoopbackUpstream, UpstreamNotLoopbackError } from '../atlas/model-broker/upstream-policy.js';
import type { BrokerConfig, ModelWorkOrder } from '../atlas/model-broker/types.js';
import { readLedgerEntries } from '../evidence/ledger.js';

const TEST_KEY = 'test-fake-model-broker-signing-key-not-real-do-not-use';
const signer = hmacSigner(TEST_KEY);
const APPROVED_PROVIDER = 'atlas-test-provider';
const APPROVED_MODEL = 'atlas-test-model';

type EnvelopeInput = Omit<ModelWorkOrder, 'integrity'>;

function baseEnvelope(overrides: Partial<EnvelopeInput> = {}): EnvelopeInput {
  const now = Date.now();
  return {
    workOrderId: `wo_test-${randomUUID()}`,
    nonce: `nonce-${randomUUID()}`,
    issuedAt: new Date(now).toISOString(),
    expiresAt: new Date(now + 60_000).toISOString(),
    provider: APPROVED_PROVIDER,
    model: APPROVED_MODEL,
    operation: 'chat.completions',
    requestId: `req-${randomUUID()}`,
    ...overrides,
  };
}

/**
 * Signs via the same canonicalizeWorkOrder used by work-order/sign.ts —
 * content-agnostic (sorted-key stringify), so it works over ModelWorkOrder's
 * shape too (see authorize.ts's checkModelWorkOrderSignature comment for why
 * this cross-type reuse is safe). The `as any` mirrors that same narrow,
 * explained cast rather than reimplementing canonicalization here.
 */
function signEnvelope(order: EnvelopeInput, signFn: (payload: string) => string = signer): ModelWorkOrder {
  const canonicalPayload = canonicalizeWorkOrder(order as any);
  const signature = signFn(canonicalPayload);
  return { ...order, integrity: { algorithm: WORK_ORDER_SIGNATURE_ALGORITHM, signature } };
}

function encodeHeader(order: ModelWorkOrder | Record<string, unknown>): string {
  return Buffer.from(JSON.stringify(order), 'utf8').toString('base64');
}

/**
 * C5A-R3: the live x-atlas-request-id header must equal the signed
 * envelope's own requestId for authorization to reach ALLOW. Bundles both
 * headers so existing call sites keep exercising the same ALLOW/DENY
 * property they exercised before R3 landed, rather than newly failing on
 * missing_request_id for reasons unrelated to what each test asserts.
 */
function authorizedHeaders(envelope: ModelWorkOrder, extra: Record<string, string> = {}): Record<string, string> {
  return { 'x-atlas-work-order': encodeHeader(envelope), 'x-atlas-request-id': envelope.requestId, ...extra };
}

function getFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createNetServer();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const address = srv.address();
      const port = address && typeof address === 'object' ? address.port : 0;
      srv.close(() => resolve(port));
    });
  });
}

function waitForListening(server: Server): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once('listening', () => {
      const address = server.address();
      if (address && typeof address === 'object') resolve(address.port);
      else reject(new Error('server address unavailable'));
    });
    server.once('error', reject);
  });
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve) => server.close(() => resolve()));
}

interface StatusServer {
  readonly server: Server;
  readonly url: string;
  hits(): number;
}

/**
 * C5A-R1 regression fixture: a loopback HTTP server that always answers with
 * a fixed status (and optional headers, e.g. Location) and counts its own
 * hits. mock-upstream.ts is fixed at 200 and deliberately not modified for
 * this wave, so 3xx-upstream scenarios are built inline here instead.
 */
function createStatusServer(status: number, headers: Record<string, string> = {}): Promise<StatusServer> {
  return new Promise((resolve) => {
    let hitCount = 0;
    const server = createHttpServer((req, res) => {
      hitCount += 1;
      const chunks: Buffer[] = [];
      req.on('data', (chunk: Buffer) => chunks.push(chunk));
      req.on('end', () => {
        res.writeHead(status, headers);
        res.end(JSON.stringify({ mocked: true, status }));
      });
    });
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = address && typeof address === 'object' ? address.port : 0;
      resolve({ server, url: `http://127.0.0.1:${port}/v1/chat/completions`, hits: () => hitCount });
    });
  });
}

interface SendOptions {
  readonly headers?: Record<string, string>;
  readonly body?: unknown;
  readonly path?: string;
  readonly method?: string;
  readonly rawBody?: string;
}

async function sendChatCompletion(port: number, opts: SendOptions = {}): Promise<{ status: number; json: unknown }> {
  const method = opts.method ?? 'POST';
  const res = await fetch(`http://127.0.0.1:${port}${opts.path ?? '/v1/chat/completions'}`, {
    method,
    headers: { 'content-type': 'application/json', ...opts.headers },
    body: method === 'GET' ? undefined : (opts.rawBody ?? JSON.stringify(opts.body ?? {})),
  });
  const json = await res.json().catch(() => undefined);
  return { status: res.status, json };
}

describe('model-broker (C5A)', () => {
  let cleanups: Array<() => Promise<void> | void>;
  let priorEvidenceDir: string | undefined;
  let priorSigningKey: string | undefined;
  let evidenceDir: string;

  beforeEach(() => {
    cleanups = [];
    priorEvidenceDir = process.env['ATLAS_EVIDENCE_DIR'];
    priorSigningKey = process.env['ATLAS_WORK_ORDER_SIGNING_KEY'];
    process.env['ATLAS_WORK_ORDER_SIGNING_KEY'] = TEST_KEY;
    evidenceDir = mkdtempSync(join(tmpdir(), 'model-broker-evidence-'));
    process.env['ATLAS_EVIDENCE_DIR'] = evidenceDir;
  });

  afterEach(async () => {
    for (const fn of cleanups.splice(0).reverse()) {
      await fn();
    }
    rmSync(evidenceDir, { recursive: true, force: true });
    if (priorEvidenceDir === undefined) delete process.env['ATLAS_EVIDENCE_DIR'];
    else process.env['ATLAS_EVIDENCE_DIR'] = priorEvidenceDir;
    if (priorSigningKey === undefined) delete process.env['ATLAS_WORK_ORDER_SIGNING_KEY'];
    else process.env['ATLAS_WORK_ORDER_SIGNING_KEY'] = priorSigningKey;
  });

  async function newReplayStore(): Promise<WorkOrderReplayStore> {
    const dir = mkdtempSync(join(tmpdir(), 'model-broker-replay-'));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    return createWorkOrderReplayStore(dir);
  }

  async function newMock(): Promise<MockUpstream> {
    const mock = await createMockUpstream();
    cleanups.push(() => new Promise<void>((resolve) => mock.server.close(() => resolve())));
    return mock;
  }

  async function startBroker(overrides: Partial<BrokerConfig>): Promise<{ server: Server; port: number }> {
    const replayStore = await newReplayStore();
    const config: BrokerConfig = {
      host: '127.0.0.1',
      port: 0,
      upstreamUrl: 'http://127.0.0.1:1/v1/chat/completions',
      approvedProvider: APPROVED_PROVIDER,
      approvedModel: APPROVED_MODEL,
      mode: 'C5A_MOCK_ONLY',
      ...overrides,
    };
    const server = createBrokerServer(config, { replayStore });
    cleanups.push(() => closeServer(server));
    const port = await waitForListening(server);
    return { server, port };
  }

  it('T1 valid authorized request -> mock reached exactly once -> 200 + mock payload', async () => {
    const mock = await newMock();
    const { port } = await startBroker({ upstreamUrl: mock.url });
    const envelope = signEnvelope(baseEnvelope());
    const { status, json } = await sendChatCompletion(port, {
      headers: authorizedHeaders(envelope),
      body: { model: APPROVED_MODEL, messages: [{ role: 'user', content: 'hi' }] },
    });
    expect(status).toBe(200);
    expect(json).toMatchObject({ id: 'mock-completion', object: 'chat.completion' });
    expect(mock.hits()).toBe(1);
  });

  it('T2 missing x-atlas-work-order header -> DENY missing_authorization -> mock hits 0', async () => {
    const mock = await newMock();
    const { port } = await startBroker({ upstreamUrl: mock.url });
    const { status, json } = await sendChatCompletion(port, { body: { model: APPROVED_MODEL } });
    expect(status).toBe(403);
    expect(json).toMatchObject({ error: { code: 'missing_authorization' } });
    expect(mock.hits()).toBe(0);
  });

  it('T3a tampered signature -> DENY invalid_signature -> mock hits 0', async () => {
    const mock = await newMock();
    const { port } = await startBroker({ upstreamUrl: mock.url });
    const envelope = signEnvelope(baseEnvelope());
    const tampered = { ...envelope, workOrderId: `${envelope.workOrderId}-tampered` };
    const { status, json } = await sendChatCompletion(port, {
      headers: { 'x-atlas-work-order': encodeHeader(tampered) },
      body: { model: APPROVED_MODEL },
    });
    expect(status).toBe(403);
    expect(json).toMatchObject({ error: { code: 'invalid_signature' } });
    expect(mock.hits()).toBe(0);
  });

  it('T3b malformed (non-JSON) envelope -> DENY malformed_authorization -> mock hits 0', async () => {
    const mock = await newMock();
    const { port } = await startBroker({ upstreamUrl: mock.url });
    const headerValue = Buffer.from('not-json-at-all', 'utf8').toString('base64');
    const { status, json } = await sendChatCompletion(port, {
      headers: { 'x-atlas-work-order': headerValue },
      body: { model: APPROVED_MODEL },
    });
    expect(status).toBe(403);
    expect(json).toMatchObject({ error: { code: 'malformed_authorization' } });
    expect(mock.hits()).toBe(0);
  });

  it('T3c wrong-shape (missing required fields) envelope -> DENY malformed_authorization -> mock hits 0', async () => {
    const mock = await newMock();
    const { port } = await startBroker({ upstreamUrl: mock.url });
    const { status, json } = await sendChatCompletion(port, {
      headers: { 'x-atlas-work-order': encodeHeader({ foo: 'bar' }) },
      body: { model: APPROVED_MODEL },
    });
    expect(status).toBe(403);
    expect(json).toMatchObject({ error: { code: 'malformed_authorization' } });
    expect(mock.hits()).toBe(0);
  });

  it('T4 provider mismatch -> DENY provider_mismatch -> mock hits 0', async () => {
    const mock = await newMock();
    const { port } = await startBroker({ upstreamUrl: mock.url });
    const envelope = signEnvelope(baseEnvelope({ provider: 'some-other-provider' }));
    const { status, json } = await sendChatCompletion(port, {
      headers: authorizedHeaders(envelope),
      body: { model: APPROVED_MODEL },
    });
    expect(status).toBe(403);
    expect(json).toMatchObject({ error: { code: 'provider_mismatch' } });
    expect(mock.hits()).toBe(0);
  });

  it('T5a envelope model != approved model -> DENY model_mismatch -> mock hits 0', async () => {
    const mock = await newMock();
    const { port } = await startBroker({ upstreamUrl: mock.url });
    const envelope = signEnvelope(baseEnvelope({ model: 'some-other-model' }));
    const { status, json } = await sendChatCompletion(port, {
      headers: authorizedHeaders(envelope),
      body: { model: APPROVED_MODEL },
    });
    expect(status).toBe(403);
    expect(json).toMatchObject({ error: { code: 'model_mismatch' } });
    expect(mock.hits()).toBe(0);
  });

  it('T5b request-body model != authorized model -> DENY model_mismatch -> mock hits 0', async () => {
    const mock = await newMock();
    const { port } = await startBroker({ upstreamUrl: mock.url });
    const envelope = signEnvelope(baseEnvelope());
    const { status, json } = await sendChatCompletion(port, {
      headers: authorizedHeaders(envelope),
      body: { model: 'body-says-different-model' },
    });
    expect(status).toBe(403);
    expect(json).toMatchObject({ error: { code: 'model_mismatch' } });
    expect(mock.hits()).toBe(0);
  });

  it('T6a wrong path -> 404 DENY unknown_operation -> mock hits 0', async () => {
    const mock = await newMock();
    const { port } = await startBroker({ upstreamUrl: mock.url });
    const envelope = signEnvelope(baseEnvelope());
    const { status, json } = await sendChatCompletion(port, {
      path: '/v1/embeddings',
      headers: { 'x-atlas-work-order': encodeHeader(envelope) },
      body: { model: APPROVED_MODEL },
    });
    expect(status).toBe(404);
    expect(json).toMatchObject({ error: { code: 'unknown_operation' } });
    expect(mock.hits()).toBe(0);
  });

  it('T6b wrong method (GET) -> 404 DENY unknown_operation -> mock hits 0', async () => {
    const mock = await newMock();
    const { port } = await startBroker({ upstreamUrl: mock.url });
    const { status, json } = await sendChatCompletion(port, { method: 'GET' });
    expect(status).toBe(404);
    expect(json).toMatchObject({ error: { code: 'unknown_operation' } });
    expect(mock.hits()).toBe(0);
  });

  it('T7 mock upstream closed before request -> FAILS CLOSED with upstream_unavailable, 5xx, no alternate path', async () => {
    const mock = await newMock();
    const { port } = await startBroker({ upstreamUrl: mock.url });
    await new Promise<void>((resolve) => mock.server.close(() => resolve()));
    const envelope = signEnvelope(baseEnvelope());
    const { status, json } = await sendChatCompletion(port, {
      headers: authorizedHeaders(envelope),
      body: { model: APPROVED_MODEL },
    });
    expect(status).toBeGreaterThanOrEqual(500);
    expect(status).toBeLessThan(600);
    expect(json).toMatchObject({ error: { code: 'upstream_unavailable' } });
    expect(mock.hits()).toBe(0);
  });

  it('T8 host 0.0.0.0 must throw and never bind a listener', async () => {
    const port = await getFreePort();
    const replayStore = await newReplayStore();
    const badConfig: BrokerConfig = {
      host: '0.0.0.0' as never,
      port,
      upstreamUrl: 'http://127.0.0.1:1/v1/chat/completions',
      approvedProvider: APPROVED_PROVIDER,
      approvedModel: APPROVED_MODEL,
      mode: 'C5A_MOCK_ONLY',
    };
    expect(() => createBrokerServer(badConfig, { replayStore })).toThrow();
    await expect(
      fetch(`http://127.0.0.1:${port}/v1/chat/completions`, { method: 'POST', body: '{}' }),
    ).rejects.toThrow();
  });

  it('T9 a receipt/evidence entry exists for both ALLOW and DENY', async () => {
    const mock = await newMock();
    const { port } = await startBroker({ upstreamUrl: mock.url });
    const envelope = signEnvelope(baseEnvelope({ requestId: 't9-allow' }));
    await sendChatCompletion(port, {
      headers: { 'x-atlas-work-order': encodeHeader(envelope), 'x-atlas-request-id': 't9-allow' },
      body: { model: APPROVED_MODEL },
    });
    await sendChatCompletion(port, {
      headers: { 'x-atlas-request-id': 't9-deny' },
      body: { model: APPROVED_MODEL },
    });
    const entries = readLedgerEntries();
    const claims = entries.map((e) => JSON.parse(e.claim.claim as unknown as string));
    const allowEntry = claims.find((c) => c.brokerRequestId === 't9-allow');
    const denyEntry = claims.find((c) => c.brokerRequestId === 't9-deny');
    expect(allowEntry).toMatchObject({ decision: 'ALLOW' });
    expect(denyEntry).toMatchObject({ decision: 'DENY', reason: 'missing_authorization' });
  });

  it('T10 receipt contains no prompt/response body and no header values (sentinel check)', async () => {
    const mock = await newMock();
    const { port } = await startBroker({ upstreamUrl: mock.url });
    const envelope = signEnvelope(baseEnvelope());
    await sendChatCompletion(port, {
      headers: authorizedHeaders(envelope, {
        'x-sentinel-test-header': 'SENTINEL-HEADER-VALUE-DO-NOT-LOG',
      }),
      body: {
        model: APPROVED_MODEL,
        messages: [{ role: 'user', content: 'SENTINEL-PROMPT-DO-NOT-LOG' }],
      },
    });
    const entries = readLedgerEntries();
    const serialized = JSON.stringify(entries);
    expect(serialized).not.toContain('SENTINEL-PROMPT-DO-NOT-LOG');
    expect(serialized).not.toContain('SENTINEL-HEADER-VALUE-DO-NOT-LOG');
    expect(serialized.length).toBeGreaterThan(0);
  });

  it('T11 non-loopback upstream rejected at config-validation time, before any socket', async () => {
    expect(() => assertLoopbackUpstream('https://api.example.com/v1')).toThrow(UpstreamNotLoopbackError);

    const port = await getFreePort();
    const replayStore = await newReplayStore();
    const badConfig: BrokerConfig = {
      host: '127.0.0.1',
      port,
      upstreamUrl: 'https://api.example.com/v1',
      approvedProvider: APPROVED_PROVIDER,
      approvedModel: APPROVED_MODEL,
      mode: 'C5A_MOCK_ONLY',
    };
    expect(() => createBrokerServer(badConfig, { replayStore })).toThrow(UpstreamNotLoopbackError);
    await expect(
      fetch(`http://127.0.0.1:${port}/v1/chat/completions`, { method: 'POST', body: '{}' }),
    ).rejects.toThrow();
  });

  it('T12 no direct-provider fallback exists (structural source check)', () => {
    const rawSource = readFileSync(new URL('../atlas/model-broker/server.ts', import.meta.url), 'utf8');
    // Strip block/line comments before structural checks: the file's own doc
    // comment quotes the real assignment line verbatim for documentation
    // purposes, which otherwise false-positives a naive code-shape regex.
    const source = rawSource
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/(^|[^:])\/\/.*$/gm, '$1');

    const fetchCallSites = source.match(/fetch\(/g) ?? [];
    expect(fetchCallSites.length).toBe(1);

    expect(source).toContain('config.upstreamUrl');
    const configUpstreamAssignments = source.match(/=\s*config\.upstreamUrl/g) ?? [];
    expect(configUpstreamAssignments.length).toBe(1);

    const handlerStart = source.indexOf('async function handleRequest');
    expect(handlerStart).toBeGreaterThan(-1);
    const handlerBody = source.slice(handlerStart);
    expect(handlerBody).not.toContain('process.env');
  });

  // --- C5A-R1: redirect: 'manual' + fail-closed on any 3xx, Location never read. ---

  it('R1a upstream 302 with Location -> DENY upstream_redirect, 502, redirect never followed (A hits 1, B hits 0)', async () => {
    const b = await createStatusServer(200);
    cleanups.push(() => closeServer(b.server));
    const a = await createStatusServer(302, { Location: b.url });
    cleanups.push(() => closeServer(a.server));
    const { port } = await startBroker({ upstreamUrl: a.url });
    const envelope = signEnvelope(baseEnvelope());
    const { status, json } = await sendChatCompletion(port, {
      headers: authorizedHeaders(envelope),
      body: { model: APPROVED_MODEL },
    });
    expect(status).toBe(502);
    expect(json).toMatchObject({ error: { code: 'upstream_redirect' } });
    expect(a.hits()).toBe(1);
    expect(b.hits()).toBe(0);
  });

  it.each([301, 302, 307, 308])('R1b upstream %i with Location -> DENY upstream_redirect, B hits 0', async (redirectStatus) => {
    const b = await createStatusServer(200);
    cleanups.push(() => closeServer(b.server));
    const a = await createStatusServer(redirectStatus, { Location: b.url });
    cleanups.push(() => closeServer(a.server));
    const { port } = await startBroker({ upstreamUrl: a.url });
    const envelope = signEnvelope(baseEnvelope());
    const { status, json } = await sendChatCompletion(port, {
      headers: authorizedHeaders(envelope),
      body: { model: APPROVED_MODEL },
    });
    expect(status).toBe(502);
    expect(json).toMatchObject({ error: { code: 'upstream_redirect' } });
    expect(a.hits()).toBe(1);
    expect(b.hits()).toBe(0);
  });

  // --- C5A-R2: expiry enforced between signature check and provider check. ---

  it('R2a expired authority -> DENY expired, mock hits 0', async () => {
    const mock = await newMock();
    const { port } = await startBroker({ upstreamUrl: mock.url });
    const envelope = signEnvelope(baseEnvelope({ expiresAt: new Date(Date.now() - 60_000).toISOString() }));
    const { status, json } = await sendChatCompletion(port, {
      headers: authorizedHeaders(envelope),
      body: { model: APPROVED_MODEL },
    });
    expect(status).toBe(403);
    expect(json).toMatchObject({ error: { code: 'expired' } });
    expect(mock.hits()).toBe(0);
  });

  it.each(['not-a-date', '2027-01-01T00:00:00'])('R2b malformed expiry %s -> DENY expiry_malformed, mock hits 0', async (expiresAt) => {
    const mock = await newMock();
    const { port } = await startBroker({ upstreamUrl: mock.url });
    const envelope = signEnvelope(baseEnvelope({ expiresAt }));
    const { status, json } = await sendChatCompletion(port, {
      headers: authorizedHeaders(envelope),
      body: { model: APPROVED_MODEL },
    });
    expect(status).toBe(403);
    expect(json).toMatchObject({ error: { code: 'expiry_malformed' } });
    expect(mock.hits()).toBe(0);
  });

  it('R2c valid future expiry -> ALLOW, mock hits 1', async () => {
    const mock = await newMock();
    const { port } = await startBroker({ upstreamUrl: mock.url });
    const envelope = signEnvelope(baseEnvelope({ expiresAt: new Date(Date.now() + 60_000).toISOString() }));
    const { status, json } = await sendChatCompletion(port, {
      headers: authorizedHeaders(envelope),
      body: { model: APPROVED_MODEL },
    });
    expect(status).toBe(200);
    expect(mock.hits()).toBe(1);
  });

  // --- C5A-R3: live x-atlas-request-id header must match the signed envelope's requestId. ---

  it('R3a missing x-atlas-request-id header -> DENY missing_request_id, mock hits 0', async () => {
    const mock = await newMock();
    const { port } = await startBroker({ upstreamUrl: mock.url });
    const envelope = signEnvelope(baseEnvelope());
    const { status, json } = await sendChatCompletion(port, {
      headers: { 'x-atlas-work-order': encodeHeader(envelope) },
      body: { model: APPROVED_MODEL },
    });
    expect(status).toBe(403);
    expect(json).toMatchObject({ error: { code: 'missing_request_id' } });
    expect(mock.hits()).toBe(0);
  });

  it('R3b x-atlas-request-id != envelope requestId -> DENY request_id_mismatch, mock hits 0', async () => {
    const mock = await newMock();
    const { port } = await startBroker({ upstreamUrl: mock.url });
    const envelope = signEnvelope(baseEnvelope());
    const { status, json } = await sendChatCompletion(port, {
      headers: { 'x-atlas-work-order': encodeHeader(envelope), 'x-atlas-request-id': `${envelope.requestId}-different` },
      body: { model: APPROVED_MODEL },
    });
    expect(status).toBe(403);
    expect(json).toMatchObject({ error: { code: 'request_id_mismatch' } });
    expect(mock.hits()).toBe(0);
  });

  it('R3c x-atlas-request-id == envelope requestId -> ALLOW, mock hits 1', async () => {
    const mock = await newMock();
    const { port } = await startBroker({ upstreamUrl: mock.url });
    const envelope = signEnvelope(baseEnvelope());
    const { status, json } = await sendChatCompletion(port, {
      headers: authorizedHeaders(envelope),
      body: { model: APPROVED_MODEL },
    });
    expect(status).toBe(200);
    expect(mock.hits()).toBe(1);
  });
});
