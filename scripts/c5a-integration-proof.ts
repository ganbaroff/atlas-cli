/**
 * c5a-integration-proof.ts — live local integration proof for the C5A
 * model-call broker, covering the R1 wave (redirect fail-closed, expiry
 * enforcement, live request-id binding). Everything loopback-only: broker +
 * mock upstream A + forbidden-redirect-target B all bind 127.0.0.1 on
 * ephemeral ports; evidence/replay state lives under a fresh os.tmpdir()
 * dir for this run. No real network call is ever made — the only
 * "upstreams" reachable are the in-process servers started below.
 */

import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import { hmacSigner, canonicalizeWorkOrder } from '../src/atlas/work-order/sign.js';
import { WORK_ORDER_SIGNATURE_ALGORITHM } from '../src/atlas/work-order/types.js';
import { createWorkOrderReplayStore } from '../src/atlas/work-order/replay.js';
import { createBrokerServer } from '../src/atlas/model-broker/server.js';
import { createMockUpstream, type MockUpstream } from '../src/atlas/model-broker/mock-upstream.js';
import { UpstreamNotLoopbackError } from '../src/atlas/model-broker/upstream-policy.js';
import type { BrokerConfig, ModelWorkOrder } from '../src/atlas/model-broker/types.js';
import { readLedgerEntries } from '../src/evidence/ledger.js';

process.env.ATLAS_WORK_ORDER_SIGNING_KEY = `c5a-proof-key-${randomUUID()}`;
const evidenceDir = mkdtempSync(join(tmpdir(), 'c5a-proof-evidence-'));
process.env.ATLAS_EVIDENCE_DIR = evidenceDir;

const signer = hmacSigner(process.env.ATLAS_WORK_ORDER_SIGNING_KEY as string);
const APPROVED_PROVIDER = 'local-mock';
const APPROVED_MODEL = 'mock-model-1';
const PROOF_SENTINEL = 'C5A-R1-PROOF-SENTINEL-DO-NOT-LOG';

type EnvelopeInput = Omit<ModelWorkOrder, 'integrity'>;

function baseEnvelope(overrides: Partial<EnvelopeInput> = {}): EnvelopeInput {
  const now = Date.now();
  return {
    workOrderId: `wo_c5aproof-${randomUUID()}`,
    nonce: `nonce-${randomUUID()}`,
    issuedAt: new Date(now).toISOString(),
    expiresAt: new Date(now + 60_000).toISOString(),
    provider: APPROVED_PROVIDER,
    model: APPROVED_MODEL,
    operation: 'chat.completions',
    requestId: `req-${randomUUID()}`,
    ...overrides,
  } as EnvelopeInput;
}

function signEnvelope(order: EnvelopeInput): ModelWorkOrder {
  const canonicalPayload = canonicalizeWorkOrder(order as any);
  const signature = signer(canonicalPayload);
  return { ...order, integrity: { algorithm: WORK_ORDER_SIGNATURE_ALGORITHM, signature } } as ModelWorkOrder;
}

function encodeHeader(order: ModelWorkOrder): string {
  return Buffer.from(JSON.stringify(order), 'utf8').toString('base64');
}

/** Matches src/__tests__/model-broker.test.ts's authorizedHeaders() idiom. */
function authorizedHeaders(envelope: ModelWorkOrder, extra: Record<string, string> = {}): Record<string, string> {
  return { 'x-atlas-work-order': encodeHeader(envelope), 'x-atlas-request-id': envelope.requestId, ...extra };
}

function waitForListening(server: Server): Promise<number> {
  return new Promise((resolve, reject) => {
    const resolveFromAddress = () => {
      const address = server.address();
      if (address && typeof address === 'object') resolve(address.port);
      else reject(new Error('server address unavailable'));
    };
    if (server.listening) { resolveFromAddress(); return; }
    server.once('listening', resolveFromAddress);
    server.once('error', reject);
  });
}

function closeServer(server: Server | undefined): Promise<void> {
  return new Promise((resolve) => {
    if (!server) { resolve(); return; }
    server.close(() => resolve());
  });
}

async function sendChatCompletion(port: number, opts: { headers?: Record<string, string>; body?: unknown }) {
  const res = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...opts.headers },
    body: JSON.stringify(opts.body ?? {}),
  });
  const json = await res.json().catch(() => undefined);
  return { status: res.status, json };
}

function assertTrue(cond: boolean, msg: string): void {
  if (!cond) throw new Error(`ASSERTION FAILED: ${msg}`);
}

interface FlexibleUpstream {
  readonly server: Server;
  readonly url: string;
  hits(): number;
  /** undefined -> normal 200 chat-completion reply; set -> 302 with Location. */
  setRedirectTo(location: string | undefined): void;
}

/**
 * "Mock upstream A": behaves like mock-upstream.ts's createMockUpstream()
 * (fixed 200 chat-completion body) by default, but can be switched into a
 * redirect responder for the P4 upstream_redirect scenario — same server
 * instance, so its hit counter stays a single continuous ground truth
 * across all four scenarios.
 */
function createFlexibleUpstream(): Promise<FlexibleUpstream> {
  return new Promise((resolve) => {
    let hitCount = 0;
    let redirectLocation: string | undefined;
    const server = createServer((req, res) => {
      hitCount += 1;
      const chunks: Buffer[] = [];
      req.on('data', (chunk: Buffer) => chunks.push(chunk));
      req.on('end', () => {
        if (redirectLocation) {
          res.writeHead(302, { Location: redirectLocation });
          res.end(JSON.stringify({ mocked: true, redirect: true }));
          return;
        }
        res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({
          id: 'mock-completion',
          object: 'chat.completion',
          created: Math.floor(Date.now() / 1000),
          model: 'mock-model',
          choices: [
            { index: 0, message: { role: 'assistant', content: 'mock response' }, finish_reason: 'stop' },
          ],
        }));
      });
    });
    server.listen(0, '127.0.0.1', () => {
      const address = server.address() as AddressInfo;
      resolve({
        server,
        url: `http://127.0.0.1:${address.port}/v1/chat/completions`,
        hits: () => hitCount,
        setRedirectTo: (loc) => { redirectLocation = loc; },
      });
    });
  });
}

let a: FlexibleUpstream | undefined;
let b: MockUpstream | undefined;
let brokerServer: Server | undefined;

async function main() {
  const result: Record<string, unknown> = {};

  a = await createFlexibleUpstream();
  const aAddress = a.server.address();
  const mockPort = aAddress && typeof aAddress === 'object' ? aAddress.port : undefined;

  b = await createMockUpstream();
  const bAddress = b.server.address();
  const redirectTargetPort = bAddress && typeof bAddress === 'object' ? bAddress.port : undefined;

  const replayStore = await createWorkOrderReplayStore(
    mkdtempSync(join(tmpdir(), 'c5a-proof-replay-')),
  );

  const config: BrokerConfig = {
    host: '127.0.0.1',
    port: 0,
    upstreamUrl: a.url,
    approvedProvider: APPROVED_PROVIDER,
    approvedModel: APPROVED_MODEL,
    mode: 'C5A_MOCK_ONLY',
  };
  brokerServer = createBrokerServer(config, { replayStore });
  const brokerPort = await waitForListening(brokerServer);

  const requestBody = { model: APPROVED_MODEL, messages: [{ role: 'user', content: PROOF_SENTINEL }] };

  // --- P1: valid unexpired authority + matching x-atlas-request-id -> ALLOW ---
  const p1Envelope = signEnvelope(baseEnvelope());
  const p1Resp = await sendChatCompletion(brokerPort, {
    headers: authorizedHeaders(p1Envelope),
    body: requestBody,
  });
  const p1AHits = a.hits();
  assertTrue(p1Resp.status === 200, `P1: expected 200, got ${p1Resp.status}`);
  assertTrue(p1AHits === 1, `P1: expected A hits 0->1, got ${p1AHits}`);

  // --- P2: expired authority + matching header -> DENY expired, A unchanged ---
  const p2Envelope = signEnvelope(baseEnvelope({ expiresAt: new Date(Date.now() - 60_000).toISOString() }));
  const p2Resp = await sendChatCompletion(brokerPort, {
    headers: authorizedHeaders(p2Envelope),
    body: requestBody,
  });
  const p2AHits = a.hits();
  const p2Reason = (p2Resp.json as any)?.error?.code;
  assertTrue(p2Resp.status === 403, `P2: expected 403, got ${p2Resp.status}`);
  assertTrue(p2Reason === 'expired', `P2: expected reason expired, got ${p2Reason}`);
  assertTrue(p2AHits === p1AHits, `P2: expected A hits unchanged at ${p1AHits}, got ${p2AHits}`);

  // --- P3: valid unexpired authority + mismatched x-atlas-request-id -> DENY request_id_mismatch, A unchanged ---
  const p3Envelope = signEnvelope(baseEnvelope());
  const p3Resp = await sendChatCompletion(brokerPort, {
    headers: authorizedHeaders(p3Envelope, { 'x-atlas-request-id': `${p3Envelope.requestId}-different` }),
    body: requestBody,
  });
  const p3AHits = a.hits();
  const p3Reason = (p3Resp.json as any)?.error?.code;
  assertTrue(p3Resp.status === 403, `P3: expected 403, got ${p3Resp.status}`);
  assertTrue(p3Reason === 'request_id_mismatch', `P3: expected reason request_id_mismatch, got ${p3Reason}`);
  assertTrue(p3AHits === p2AHits, `P3: expected A hits unchanged at ${p2AHits}, got ${p3AHits}`);

  // --- P4: valid authority + matching header, but A answers 302 -> Location: B -> DENY upstream_redirect, A +1, B +0 ---
  a.setRedirectTo(b.url);
  const p4Envelope = signEnvelope(baseEnvelope());
  const p4Resp = await sendChatCompletion(brokerPort, {
    headers: authorizedHeaders(p4Envelope),
    body: requestBody,
  });
  const p4AHits = a.hits();
  const p4BHits = b.hits();
  const p4Reason = (p4Resp.json as any)?.error?.code;
  assertTrue(p4Resp.status === 502, `P4: expected 502, got ${p4Resp.status}`);
  assertTrue(p4Reason === 'upstream_redirect', `P4: expected reason upstream_redirect, got ${p4Reason}`);
  assertTrue(p4AHits === p3AHits + 1, `P4: expected A hits exactly +1 from ${p3AHits}, got ${p4AHits}`);
  assertTrue(p4BHits === 0, `P4: expected B hits 0 (redirect never followed), got ${p4BHits}`);

  // non-loopback upstream must throw at validation time, never dial
  let nonLoopbackRejected = false;
  let nonLoopbackError = '';
  try {
    const badConfig: BrokerConfig = {
      host: '127.0.0.1',
      port: 0,
      upstreamUrl: 'https://api.example.com/v1',
      approvedProvider: APPROVED_PROVIDER,
      approvedModel: APPROVED_MODEL,
      mode: 'C5A_MOCK_ONLY',
    };
    createBrokerServer(badConfig, { replayStore });
  } catch (err) {
    nonLoopbackRejected = err instanceof UpstreamNotLoopbackError;
    nonLoopbackError = err instanceof Error ? err.message : String(err);
  }
  assertTrue(nonLoopbackRejected, 'expected non-loopback upstreamUrl to throw UpstreamNotLoopbackError at validation time');
  assertTrue(nonLoopbackError.length >= 0, 'nonLoopbackError should be a string');

  const ledgerEntries = readLedgerEntries();

  result.p1Status = p1Resp.status;
  result.p1AHits = p1AHits;
  result.p2Status = p2Resp.status;
  result.p2Reason = p2Reason;
  result.p2AHits = p2AHits;
  result.p3Status = p3Resp.status;
  result.p3Reason = p3Reason;
  result.p3AHits = p3AHits;
  result.p4Status = p4Resp.status;
  result.p4Reason = p4Reason;
  result.p4AHits = p4AHits;
  result.p4BHits = p4BHits;
  result.nonLoopbackRejected = nonLoopbackRejected;
  result.evidenceDir = evidenceDir;
  result.receiptEntryCount = ledgerEntries.length;
  result.brokerPort = brokerPort;
  result.mockPort = mockPort;
  result.redirectTargetPort = redirectTargetPort;

  console.log(JSON.stringify(result));
}

(async () => {
  let failed = false;
  try {
    await main();
  } catch (err) {
    failed = true;
    console.error(err instanceof Error ? err.stack ?? err.message : String(err));
  } finally {
    // Close every server exactly once, success or failure, per task spec.
    await Promise.allSettled([closeServer(brokerServer), closeServer(a?.server), closeServer(b?.server)]);
    // Give libuv time to fully settle those closes before process teardown
    // (observed: an immediate process.exit() right after a close can hit a
    // native "!(handle->flags & UV_HANDLE_CLOSING)" assertion on Windows).
    await new Promise((resolve) => { setTimeout(resolve, 300); });
  }
  process.exit(failed ? 1 : 0);
})();
