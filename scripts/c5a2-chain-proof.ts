/**
 * c5a2-chain-proof.ts — live local proof of the FULL chain:
 *
 *   client (Hermes-shaped)  ->  C5A broker  ->  C5A-2 egress leg  ->  provider
 *
 * The two halves were each green in isolation and had never been wired
 * together; separate green suites are not a proven path. Everything here is
 * loopback: the broker and the egress leg bind 127.0.0.1 on ephemeral ports and
 * talk over real sockets. The provider is an injected function, because
 * provider-ladder.ts refuses a loopback provider url by design — so the one
 * thing this proof still does NOT cover is a real provider's wire format. That
 * gap is stated in the receipt, not hidden.
 *
 * FAKE_TOKEN is an obviously fake string. C1 asserts it never reaches the
 * evidence ledger.
 */

import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { mkdtempSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import type { Server } from 'node:http';

import { hmacSigner, canonicalizeWorkOrder } from '../src/atlas/work-order/sign.js';
import { WORK_ORDER_SIGNATURE_ALGORITHM } from '../src/atlas/work-order/types.js';
import { createWorkOrderReplayStore } from '../src/atlas/work-order/replay.js';
import { createBrokerServer } from '../src/atlas/model-broker/server.js';
import type { BrokerConfig, ModelWorkOrder } from '../src/atlas/model-broker/types.js';
import { createEgressServer } from '../src/atlas/model-egress/server.js';
import { SpendCap } from '../src/atlas/model-egress/spend-cap.js';
import { PROVIDER_LADDER } from '../src/atlas/model-egress/provider-ladder.js';
import type { EgressConfig } from '../src/atlas/model-egress/types.js';

process.env.ATLAS_WORK_ORDER_SIGNING_KEY = `c5a2-proof-key-${randomUUID()}`;
const evidenceDir = mkdtempSync(join(tmpdir(), 'c5a2-proof-evidence-'));
process.env.ATLAS_EVIDENCE_DIR = evidenceDir;

const signer = hmacSigner(process.env.ATLAS_WORK_ORDER_SIGNING_KEY as string);
const APPROVED_PROVIDER = 'nvidia-inception';
const APPROVED_MODEL = 'meta/llama-3.1-70b-instruct';
const FAKE_TOKEN = 'FAKE-CHAIN-TOKEN-do-not-ship-8a13';
const REDIRECT_TARGET = 'https://attacker.example.com/v1/chat/completions';

type EnvelopeInput = Omit<ModelWorkOrder, 'integrity'>;

function baseEnvelope(overrides: Partial<EnvelopeInput> = {}): EnvelopeInput {
  const now = Date.now();
  return {
    workOrderId: `wo_c5a2proof-${randomUUID()}`,
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
  return {
    ...order,
    integrity: { algorithm: WORK_ORDER_SIGNATURE_ALGORITHM, signature: signer(canonicalPayload) },
  } as ModelWorkOrder;
}

function authorizedHeaders(envelope: ModelWorkOrder): Record<string, string> {
  return {
    'x-atlas-work-order': Buffer.from(JSON.stringify(envelope), 'utf8').toString('base64'),
    'x-atlas-request-id': envelope.requestId,
  };
}

function waitForListening(server: Server): Promise<number> {
  return new Promise((resolve, reject) => {
    const fromAddress = () => {
      const address = server.address();
      if (address && typeof address === 'object') resolve(address.port);
      else reject(new Error('server address unavailable'));
    };
    if (server.listening) { fromAddress(); return; }
    server.once('listening', fromAddress);
    server.once('error', reject);
  });
}

function closeServer(server: Server | undefined): Promise<void> {
  return new Promise((resolve) => {
    if (!server) { resolve(); return; }
    server.close(() => resolve());
  });
}

function assertTrue(cond: boolean, msg: string): void {
  if (!cond) throw new Error(`ASSERTION FAILED: ${msg}`);
}

function ledgerText(): string {
  const path = join(evidenceDir, 'ledger.jsonl');
  return existsSync(path) ? readFileSync(path, 'utf8') : '';
}

async function callChain(port: number, headers: Record<string, string>) {
  const res = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify({ model: APPROVED_MODEL, messages: [{ role: 'user', content: 'ping' }] }),
  });
  const json = await res.json().catch(() => undefined);
  return { status: res.status, json: json as any };
}

// --- the stand-in provider: counts calls, and can be switched to answer 3xx ---
let providerHits = 0;
let redirectTargetHits = 0;
let providerMode: 'ok' | 'redirect' = 'ok';

const providerFetch = (async (input: Parameters<typeof fetch>[0]) => {
  const url = String(input);
  if (url === REDIRECT_TARGET) { redirectTargetHits += 1; }
  providerHits += 1;
  if (providerMode === 'redirect') {
    return new Response('', { status: 302, headers: { location: REDIRECT_TARGET } });
  }
  return new Response(JSON.stringify({
    id: 'cmpl-chain',
    object: 'chat.completion',
    model: APPROVED_MODEL,
    choices: [{ index: 0, message: { role: 'assistant', content: 'pong' }, finish_reason: 'stop' }],
    usage: { total_tokens: 17 },
  }), { status: 200, headers: { 'content-type': 'application/json' } });
}) as typeof fetch;

const nvidiaSpec = PROVIDER_LADDER.find((entry) => entry.id === APPROVED_PROVIDER);
if (!nvidiaSpec) throw new Error('ladder lost its first entry');

let egressServer: Server | undefined;
let brokerServer: Server | undefined;

async function main(): Promise<void> {
  const replayStore = createWorkOrderReplayStore(mkdtempSync(join(tmpdir(), 'c5a2-proof-replay-')));
  const spendCap = new SpendCap({ maxRequests: 3, maxTotalTokens: 100_000, unknownUsageCharge: 500 });

  const egressConfig: EgressConfig = {
    host: '127.0.0.1',
    port: 0,
    provider: nvidiaSpec,
    approvedModel: APPROVED_MODEL,
    spendCap: { maxRequests: 3, maxTotalTokens: 100_000, unknownUsageCharge: 500 },
  };
  egressServer = createEgressServer(egressConfig, { spec: nvidiaSpec, authToken: FAKE_TOKEN }, {
    fetchImpl: providerFetch,
    spendCap,
  });
  const egressPort = await waitForListening(egressServer);

  const brokerConfig: BrokerConfig = {
    host: '127.0.0.1',
    port: 0,
    upstreamUrl: `http://127.0.0.1:${egressPort}/v1/chat/completions`,
    approvedProvider: APPROVED_PROVIDER,
    approvedModel: APPROVED_MODEL,
    mode: 'C5A_MOCK_ONLY',
  };
  brokerServer = createBrokerServer(brokerConfig, { replayStore });
  const brokerPort = await waitForListening(brokerServer);

  // --- C1: the whole chain carries one authorized call end to end ---
  const c1 = await callChain(brokerPort, authorizedHeaders(signEnvelope(baseEnvelope())));
  assertTrue(c1.status === 200, `C1: expected 200, got ${c1.status}`);
  assertTrue(c1.json?.choices?.[0]?.message?.content === 'pong', 'C1: model content did not survive the chain');
  assertTrue(providerHits === 1, `C1: expected provider hits 1, got ${providerHits}`);
  assertTrue(ledgerText().includes('model-broker-decision'), 'C1: no broker receipt in the ledger');
  assertTrue(ledgerText().includes('model-egress-decision'), 'C1: no egress receipt in the ledger');
  assertTrue(!ledgerText().includes(FAKE_TOKEN), 'C1: provider auth reached the evidence ledger');
  console.log(`C1 PASS  chain 200, provider hits ${providerHits}, both receipts present, no auth in ledger`);

  // --- C2: an expired authority is refused BEFORE any spend leaves the machine ---
  const expired = signEnvelope(baseEnvelope({
    issuedAt: new Date(Date.now() - 120_000).toISOString(),
    expiresAt: new Date(Date.now() - 60_000).toISOString(),
  }));
  const c2 = await callChain(brokerPort, authorizedHeaders(expired));
  assertTrue(c2.status === 403, `C2: expected 403, got ${c2.status}`);
  assertTrue(c2.json?.error?.code === 'expired', `C2: expected expired, got ${c2.json?.error?.code}`);
  assertTrue(providerHits === 1, `C2: provider was called on a denied authority (hits ${providerHits})`);
  console.log(`C2 PASS  expired authority denied at the broker, provider hits still ${providerHits}`);

  // --- C3: a 3xx from the provider fails closed at the egress and never gets followed ---
  providerMode = 'redirect';
  const c3 = await callChain(brokerPort, authorizedHeaders(signEnvelope(baseEnvelope())));
  assertTrue(c3.status === 502, `C3: expected 502, got ${c3.status}`);
  assertTrue(c3.json?.error?.code === 'upstream_redirect', `C3: expected upstream_redirect, got ${c3.json?.error?.code}`);
  assertTrue(providerHits === 2, `C3: expected provider hits 2, got ${providerHits}`);
  assertTrue(redirectTargetHits === 0, `C3: redirect target was fetched ${redirectTargetHits} times`);
  console.log(`C3 PASS  302 failed closed, redirect target hits ${redirectTargetHits}`);
  providerMode = 'ok';

  // --- C4: the spend cap stops the chain, and the refusal reaches the client ---
  // cap is 3 requests; C1 and C3 charged two. One more forwards, the next is refused.
  const c4a = await callChain(brokerPort, authorizedHeaders(signEnvelope(baseEnvelope())));
  assertTrue(c4a.status === 200, `C4: expected the third call to still pass, got ${c4a.status}`);
  const hitsBeforeCap = providerHits;
  const c4b = await callChain(brokerPort, authorizedHeaders(signEnvelope(baseEnvelope())));
  assertTrue(c4b.status === 429, `C4: expected 429 once the cap is spent, got ${c4b.status}`);
  assertTrue(c4b.json?.error?.code === 'spend_cap_exhausted', `C4: expected spend_cap_exhausted, got ${c4b.json?.error?.code}`);
  assertTrue(providerHits === hitsBeforeCap, `C4: provider was called past the cap (${providerHits} vs ${hitsBeforeCap})`);
  console.log(`C4 PASS  cap refused the 4th call, provider hits held at ${providerHits}`);

  // --- C5: with the egress leg down there is no path at all — no fallback, no silent direct call ---
  await closeServer(egressServer);
  egressServer = undefined;
  const c5 = await callChain(brokerPort, authorizedHeaders(signEnvelope(baseEnvelope())));
  assertTrue(c5.status === 502, `C5: expected 502, got ${c5.status}`);
  assertTrue(c5.json?.error?.code === 'upstream_unavailable', `C5: expected upstream_unavailable, got ${c5.json?.error?.code}`);
  assertTrue(providerHits === hitsBeforeCap, `C5: something reached the provider with the egress leg down`);
  console.log(`C5 PASS  egress down -> connection refused, provider hits still ${providerHits}`);

  console.log('\nC5A-2 CHAIN PROOF: 5/5 PASS');
  console.log(`evidence dir: ${evidenceDir}`);
}

main()
  .then(async () => {
    await closeServer(brokerServer);
    await closeServer(egressServer);
    process.exit(0);
  })
  .catch(async (err) => {
    console.error(err instanceof Error ? err.message : String(err));
    await closeServer(brokerServer);
    await closeServer(egressServer);
    process.exit(1);
  });
