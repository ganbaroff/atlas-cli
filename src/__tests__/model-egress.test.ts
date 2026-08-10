/**
 * model-egress.test.ts — C5A-2 loopback egress leg.
 *
 * NO REAL NETWORK CALL IS EVER MADE. The egress server binds 127.0.0.1 on an
 * ephemeral port and every outbound call goes through an injected fetchImpl, so
 * the "provider" in this file is always a function in this process. Evidence
 * lands in a per-test temp dir via the ATLAS_EVIDENCE_DIR override.
 *
 * FAKE_TOKEN is an obviously fake string. One test asserts that it never
 * appears anywhere in the evidence ledger — that assertion is the point of the
 * constant, so it must stay a literal that would be unmistakable if it leaked.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer as createNetServer, type AddressInfo } from 'node:net';
import type { Server } from 'node:http';

import {
  PROVIDER_LADDER,
  NoProviderConfiguredError,
  OutboundUrlNotAllowedError,
  assertOutboundProviderUrl,
  resolveProvider,
} from '../atlas/model-egress/provider-ladder.js';
import { SpendCap, readTotalTokens } from '../atlas/model-egress/spend-cap.js';
import { createEgressServer } from '../atlas/model-egress/server.js';
import { projectEgressReceipt } from '../atlas/model-egress/receipt.js';
import type { EgressConfig, EgressDecision } from '../atlas/model-egress/types.js';

const FAKE_TOKEN = 'FAKE-EGRESS-TOKEN-do-not-ship-2f9c';
const APPROVED_MODEL = 'meta/llama-3.1-70b-instruct';

function getFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createNetServer();
    probe.on('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const port = (probe.address() as AddressInfo).port;
      probe.close(() => resolve(port));
    });
  });
}

function waitForListening(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    if (server.listening) { resolve(); return; }
    server.once('listening', () => resolve());
    server.once('error', reject);
  });
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve) => server.close(() => resolve()));
}

function nvidiaSpec() {
  const spec = PROVIDER_LADDER.find((entry) => entry.id === 'nvidia-inception');
  if (!spec) throw new Error('ladder lost its first entry');
  return spec;
}

async function baseConfig(overrides: Partial<EgressConfig> = {}): Promise<EgressConfig> {
  return {
    host: '127.0.0.1',
    port: await getFreePort(),
    provider: nvidiaSpec(),
    approvedModel: APPROVED_MODEL,
    spendCap: { maxRequests: 5, maxTotalTokens: 10_000, unknownUsageCharge: 500 },
    ...overrides,
  };
}

function okResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function chatBody(model: string = APPROVED_MODEL): Record<string, unknown> {
  return { model, messages: [{ role: 'user', content: 'ping' }] };
}

describe('C5A-2 provider ladder', () => {
  it('picks the first configured provider in ladder order, not the first in the object', () => {
    const resolved = resolveProvider({ GROQ_API_KEY: 'g', NVIDIA_API_KEY: 'n' } as NodeJS.ProcessEnv);
    expect(resolved.spec.id).toBe('nvidia-inception');
    expect(resolved.spec.tier).toBe('credits');
  });

  it('falls to a free tier only when every credited tier is absent', () => {
    const resolved = resolveProvider({ GROQ_API_KEY: 'g' } as NodeJS.ProcessEnv);
    expect(resolved.spec.id).toBe('groq');
    expect(resolved.spec.tier).toBe('free');
  });

  it('treats a whitespace-only variable as absent', () => {
    const resolved = resolveProvider({ NVIDIA_API_KEY: '   ', GROQ_API_KEY: 'g' } as NodeJS.ProcessEnv);
    expect(resolved.spec.id).toBe('groq');
  });

  it('trims the token it hands back', () => {
    const resolved = resolveProvider({ NVIDIA_API_KEY: '  n  ' } as NodeJS.ProcessEnv);
    expect(resolved.authToken).toBe('n');
  });

  it('throws naming only the variables, never a value, when nothing is configured', () => {
    let thrown: unknown;
    try {
      resolveProvider({ SOMETHING_ELSE: 'secret-value-xyz' } as NodeJS.ProcessEnv);
    } catch (err) { thrown = err; }
    expect(thrown).toBeInstanceOf(NoProviderConfiguredError);
    const message = (thrown as Error).message;
    expect(message).toContain('NVIDIA_API_KEY');
    expect(message).toContain('GROQ_API_KEY');
    expect(message).not.toContain('secret-value-xyz');
  });

  it('keeps the ladder ranks unique so the order is total', () => {
    const ranks = PROVIDER_LADDER.map((entry) => entry.rank);
    expect(new Set(ranks).size).toBe(ranks.length);
  });

  it('orders credited tiers ahead of every free tier', () => {
    const worstCredits = Math.max(...PROVIDER_LADDER.filter((e) => e.tier === 'credits').map((e) => e.rank));
    const bestFree = Math.min(...PROVIDER_LADDER.filter((e) => e.tier === 'free').map((e) => e.rank));
    expect(worstCredits).toBeLessThan(bestFree);
  });
});

describe('C5A-2 outbound url guard (inverse of the broker guard)', () => {
  it('accepts an https provider host', () => {
    expect(() => assertOutboundProviderUrl('https://integrate.api.nvidia.com/v1/chat/completions')).not.toThrow();
  });

  it('refuses plain http', () => {
    expect(() => assertOutboundProviderUrl('http://api.example.com/v1')).toThrow(OutboundUrlNotAllowedError);
  });

  it('refuses loopback, which would loop the egress leg back inward', () => {
    expect(() => assertOutboundProviderUrl('https://127.0.0.1/v1')).toThrow(OutboundUrlNotAllowedError);
    expect(() => assertOutboundProviderUrl('https://localhost/v1')).toThrow(OutboundUrlNotAllowedError);
    expect(() => assertOutboundProviderUrl('https://[::1]/v1')).toThrow(OutboundUrlNotAllowedError);
  });

  it('refuses an unparseable url', () => {
    expect(() => assertOutboundProviderUrl('not a url')).toThrow(OutboundUrlNotAllowedError);
  });

  it('every shipped ladder entry passes its own guard', () => {
    for (const spec of PROVIDER_LADDER) {
      expect(() => assertOutboundProviderUrl(spec.chatCompletionsUrl)).not.toThrow();
    }
  });
});

describe('C5A-2 spend cap', () => {
  it('refuses a non-positive limit on either axis', () => {
    expect(() => new SpendCap({ maxRequests: 0, maxTotalTokens: 10, unknownUsageCharge: 1 })).toThrow();
    expect(() => new SpendCap({ maxRequests: 1, maxTotalTokens: 0, unknownUsageCharge: 1 })).toThrow();
    expect(() => new SpendCap({ maxRequests: 1, maxTotalTokens: 10, unknownUsageCharge: 0 })).toThrow();
  });

  it('charges the unknown rate rather than zero when usage is unreadable', () => {
    const cap = new SpendCap({ maxRequests: 5, maxTotalTokens: 1000, unknownUsageCharge: 250 });
    expect(cap.charge(null)).toBe(250);
    expect(cap.snapshot().totalTokens).toBe(250);
  });

  it('charges the unknown rate for a hostile negative usage value', () => {
    const cap = new SpendCap({ maxRequests: 5, maxTotalTokens: 1000, unknownUsageCharge: 250 });
    expect(cap.charge(-9_000_000)).toBe(250);
  });

  it('stops on the request axis', () => {
    const cap = new SpendCap({ maxRequests: 2, maxTotalTokens: 1_000_000, unknownUsageCharge: 1 });
    cap.charge(1); cap.charge(1);
    expect(cap.canSpend()).toBe(false);
  });

  it('stops on the token axis', () => {
    const cap = new SpendCap({ maxRequests: 100, maxTotalTokens: 100, unknownUsageCharge: 1 });
    cap.charge(100);
    expect(cap.canSpend()).toBe(false);
  });

  it('reads total_tokens, falls back to prompt+completion, and rejects the rest', () => {
    expect(readTotalTokens({ usage: { total_tokens: 42 } })).toBe(42);
    expect(readTotalTokens({ usage: { prompt_tokens: 10, completion_tokens: 5 } })).toBe(15);
    expect(readTotalTokens({ usage: { total_tokens: 'lots' } })).toBeNull();
    expect(readTotalTokens({ usage: null })).toBeNull();
    expect(readTotalTokens('not an object')).toBeNull();
  });
});

describe('C5A-2 egress server', () => {
  let evidenceDir: string;
  let priorEvidenceDir: string | undefined;
  let server: Server | null = null;
  let calls: Array<{ url: string; headers: Record<string, string>; body: string }>;

  beforeEach(() => {
    evidenceDir = mkdtempSync(join(tmpdir(), 'atlas-egress-evidence-'));
    priorEvidenceDir = process.env['ATLAS_EVIDENCE_DIR'];
    process.env['ATLAS_EVIDENCE_DIR'] = evidenceDir;
    calls = [];
  });

  afterEach(async () => {
    if (server) { await closeServer(server); server = null; }
    if (priorEvidenceDir === undefined) delete process.env['ATLAS_EVIDENCE_DIR'];
    else process.env['ATLAS_EVIDENCE_DIR'] = priorEvidenceDir;
    rmSync(evidenceDir, { recursive: true, force: true });
  });

  function recordingFetch(respond: (body: string) => Response | Promise<Response>): typeof fetch {
    return (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const body = typeof init?.body === 'string' ? init.body : '';
      calls.push({
        url: String(input),
        headers: (init?.headers ?? {}) as Record<string, string>,
        body,
      });
      return respond(body);
    }) as typeof fetch;
  }

  async function start(
    config: EgressConfig,
    fetchImpl: typeof fetch,
    spendCap?: SpendCap,
  ): Promise<string> {
    server = createEgressServer(config, { spec: config.provider, authToken: FAKE_TOKEN }, { fetchImpl, spendCap });
    await waitForListening(server);
    return `http://127.0.0.1:${config.port}/v1/chat/completions`;
  }

  function ledgerText(): string {
    const path = join(evidenceDir, 'ledger.jsonl');
    return existsSync(path) ? readFileSync(path, 'utf8') : '';
  }

  it('refuses to construct with a non-loopback bind host', async () => {
    const config = await baseConfig({ host: '0.0.0.0' as unknown as '127.0.0.1' });
    expect(() => createEgressServer(config, { spec: config.provider, authToken: FAKE_TOKEN }, {
      fetchImpl: recordingFetch(() => okResponse({})),
    })).toThrow(/non-loopback bind host/);
  });

  it('refuses to construct when the resolved provider is not the configured one', async () => {
    const config = await baseConfig();
    const other = PROVIDER_LADDER.find((entry) => entry.id === 'groq');
    expect(other).toBeDefined();
    expect(() => createEgressServer(config, { spec: other!, authToken: FAKE_TOKEN }, {
      fetchImpl: recordingFetch(() => okResponse({})),
    })).toThrow(/does not match configured provider/);
  });

  it('forwards an approved call and returns the provider body', async () => {
    const url = await start(await baseConfig(), recordingFetch(() => okResponse({
      id: 'cmpl-1',
      choices: [{ index: 0, message: { role: 'assistant', content: 'pong' }, finish_reason: 'stop' }],
      usage: { total_tokens: 31 },
    })));
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(chatBody()),
    });
    expect(res.status).toBe(200);
    const json = await res.json() as { choices: Array<{ message: { content: string } }> };
    expect(json.choices[0]!.message.content).toBe('pong');
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe(nvidiaSpec().chatCompletionsUrl);
  });

  it('attaches the auth token to the outbound call and to nothing else', async () => {
    const url = await start(await baseConfig(), recordingFetch(() => okResponse({ usage: { total_tokens: 5 } })));
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(chatBody()),
    });
    expect(res.status).toBe(200);
    expect(calls[0]!.headers['authorization']).toBe(`Bearer ${FAKE_TOKEN}`);
    // The response the caller sees, and the evidence on disk, must be clean.
    expect(JSON.stringify(await res.json())).not.toContain(FAKE_TOKEN);
    expect(ledgerText()).not.toContain(FAKE_TOKEN);
    expect(ledgerText()).toContain('model-egress-decision');
  });

  it('never writes the prompt into the evidence ledger', async () => {
    const url = await start(await baseConfig(), recordingFetch(() => okResponse({ usage: { total_tokens: 5 } })));
    await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: APPROVED_MODEL, messages: [{ role: 'user', content: 'SENSITIVE-PROMPT-TEXT' }] }),
    });
    expect(ledgerText()).not.toContain('SENSITIVE-PROMPT-TEXT');
  });

  it('refuses a model other than the approved one and does not call out', async () => {
    const url = await start(await baseConfig(), recordingFetch(() => okResponse({})));
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(chatBody('some/other-model')),
    });
    expect(res.status).toBe(400);
    expect((await res.json() as { error: { code: string } }).error.code).toBe('model_mismatch');
    expect(calls).toHaveLength(0);
  });

  it('refuses a malformed body without calling out', async () => {
    const url = await start(await baseConfig(), recordingFetch(() => okResponse({})));
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: 'not json',
    });
    expect(res.status).toBe(400);
    expect(calls).toHaveLength(0);
  });

  it('refuses a non-POST method', async () => {
    const config = await baseConfig();
    await start(config, recordingFetch(() => okResponse({})));
    const res = await fetch(`http://127.0.0.1:${config.port}/v1/chat/completions`);
    expect(res.status).toBe(400);
    expect(calls).toHaveLength(0);
  });

  it('checks the cap BEFORE opening a socket', async () => {
    const cap = new SpendCap({ maxRequests: 1, maxTotalTokens: 10_000, unknownUsageCharge: 100 });
    cap.charge(1); // exhaust the request axis
    const url = await start(await baseConfig(), recordingFetch(() => okResponse({})), cap);
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(chatBody()),
    });
    expect(res.status).toBe(429);
    expect((await res.json() as { error: { code: string } }).error.code).toBe('spend_cap_exhausted');
    expect(calls).toHaveLength(0);
  });

  it('stops forwarding once the configured budget is spent', async () => {
    const config = await baseConfig({ spendCap: { maxRequests: 2, maxTotalTokens: 10_000, unknownUsageCharge: 100 } });
    const url = await start(config, recordingFetch(() => okResponse({ usage: { total_tokens: 10 } })));
    const send = () => fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(chatBody()),
    });
    expect((await send()).status).toBe(200);
    expect((await send()).status).toBe(200);
    expect((await send()).status).toBe(429);
    expect(calls).toHaveLength(2);
  });

  it('fails closed on any 3xx and never reads Location', async () => {
    for (const status of [301, 302, 307, 308]) {
      calls = [];
      const config = await baseConfig();
      const redirectTarget = 'https://attacker.example.com/v1/chat/completions';
      const url = await start(config, recordingFetch(() => new Response('', {
        status,
        headers: { location: redirectTarget },
      })));
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(chatBody()),
      });
      expect(res.status).toBe(502);
      expect((await res.json() as { error: { code: string } }).error.code).toBe('upstream_redirect');
      // Exactly one outbound call: the approved provider. The redirect target was never fetched.
      expect(calls).toHaveLength(1);
      expect(calls.every((call) => call.url !== redirectTarget)).toBe(true);
      await closeServer(server!);
      server = null;
    }
  });

  it('charges budget even when the upstream is unreachable', async () => {
    const cap = new SpendCap({ maxRequests: 5, maxTotalTokens: 10_000, unknownUsageCharge: 400 });
    const url = await start(await baseConfig(), (() => { throw new Error('socket refused'); }) as unknown as typeof fetch, cap);
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(chatBody()),
    });
    expect(res.status).toBe(502);
    expect((await res.json() as { error: { code: string } }).error.code).toBe('upstream_unavailable');
    expect(cap.snapshot().totalTokens).toBe(400);
    expect(cap.snapshot().requests).toBe(1);
  });

  it('charges budget when the provider returns unparseable json', async () => {
    const cap = new SpendCap({ maxRequests: 5, maxTotalTokens: 10_000, unknownUsageCharge: 400 });
    const url = await start(await baseConfig(), recordingFetch(() => new Response('<html>gateway</html>', {
      status: 200,
      headers: { 'content-type': 'text/html' },
    })), cap);
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(chatBody()),
    });
    expect(res.status).toBe(502);
    expect((await res.json() as { error: { code: string } }).error.code).toBe('upstream_bad_response');
    expect(cap.snapshot().totalTokens).toBe(400);
  });

  it('reports an upstream 4xx as upstream_error and still charges it', async () => {
    const cap = new SpendCap({ maxRequests: 5, maxTotalTokens: 10_000, unknownUsageCharge: 400 });
    const url = await start(await baseConfig(), recordingFetch(() => okResponse({ error: 'nope' }, 401)), cap);
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(chatBody()),
    });
    expect(res.status).toBe(401);
    expect((await res.json() as { error: { code: string } }).error.code).toBe('upstream_error');
    expect(cap.snapshot().requests).toBe(1);
  });

  it('charges the unknown rate when the provider omits usage', async () => {
    const cap = new SpendCap({ maxRequests: 5, maxTotalTokens: 10_000, unknownUsageCharge: 777 });
    const url = await start(await baseConfig(), recordingFetch(() => okResponse({ choices: [] })), cap);
    await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(chatBody()),
    });
    expect(cap.snapshot().totalTokens).toBe(777);
  });
});

describe('C5A-2 receipt projection', () => {
  it('emits only the named fields and drops anything smuggled onto the decision', () => {
    const decision = {
      decision: 'FORWARD',
      egressRequestId: 'egr_test',
      providerId: 'nvidia-inception',
      tier: 'credits',
      model: APPROVED_MODEL,
      status: 200,
      latencyMs: 12,
      tokensCharged: 31,
      requestsRemaining: 4,
      tokensRemaining: 9_969,
      authorization: `Bearer ${FAKE_TOKEN}`,
      messages: [{ role: 'user', content: 'SENSITIVE-PROMPT-TEXT' }],
    } as unknown as EgressDecision;

    const projected = projectEgressReceipt(decision);
    const serialized = JSON.stringify(projected);
    expect(serialized).not.toContain(FAKE_TOKEN);
    expect(serialized).not.toContain('SENSITIVE-PROMPT-TEXT');
    expect(Object.keys(projected).sort()).toEqual([
      'decision', 'egressRequestId', 'kind', 'latencyMs', 'model', 'providerId',
      'reason', 'requestsRemaining', 'status', 'tier', 'tokensCharged', 'tokensRemaining',
    ]);
  });
});
