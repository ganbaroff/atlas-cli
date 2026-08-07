/**
 * Wave 3 acceptance: no approved Atlas spend decision, no model invocation.
 *
 * The point of these tests is the fail-closed direction. `spend-policy.ts`
 * classifies by an allowlist of PAID providers, so an unrecognised name reads
 * as free there; at the executor boundary that would be a silent bypass. Every
 * refusal below must happen before a credential is resolved and before any
 * evidence is written.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { parseTypedClaim } from '../evidence/claim.js';

import {
  approveProvider,
  ProviderNotApprovedError,
  PROVIDER_REGISTRY,
  type ProviderRefusalReason,
} from '../atlas/executor/provider-authority.js';

const SECRETS: Record<string, string> = {
  CEREBRAS_API_KEY: 'cerebras-test-value',
  NVIDIA_API_KEY: 'nvidia-test-value',
  FREELLMAPI_API_KEY: 'free-test-value',
  ANTHROPIC_API_KEY: 'anthropic-test-value',
};

let secretLookups: string[] = [];
let recordedClaims: unknown[] = [];
const savedEnv: Record<string, string | undefined> = {};

function resolveSecret(name: string): string | undefined {
  secretLookups.push(name);
  return SECRETS[name];
}

// Validates through the REAL schema before recording. A permissive mock here is
// what let a schema violation reach the first live run: audit-finding requires
// auditVerdict and sourceRef, and a plain push accepted a claim the ledger
// would have rejected.
const recordClaim = ((claim: unknown) => {
  const parsed = parseTypedClaim(claim);
  recordedClaims.push(parsed);
  return { prevHash: null, entryHash: 'test', claim: parsed } as never;
}) as never;

function approve(overrides: Record<string, unknown> = {}) {
  return approveProvider({
    providerId: 'nvidia',
    modelId: 'meta/llama-3.3-70b-instruct',
    missionId: 'mission-1',
    workOrderId: 'wo-1',
    caller: 'executor-test',
    resolveSecret,
    recordClaim,
    now: () => new Date('2026-08-07T00:00:00.000Z'),
    ...overrides,
  } as never);
}

function expectRefusal(fn: () => unknown, reason: ProviderRefusalReason) {
  try {
    fn();
  } catch (err) {
    expect(err).toBeInstanceOf(ProviderNotApprovedError);
    expect((err as ProviderNotApprovedError).reason).toBe(reason);
    return;
  }
  throw new Error(`expected refusal '${reason}' but the call succeeded`);
}

beforeEach(() => {
  secretLookups = [];
  recordedClaims = [];
  for (const key of ['ATLAS_ALLOW_PAID', 'ATLAS_PAUSE']) {
    savedEnv[key] = process.env[key];
    delete process.env[key];
  }
});

afterEach(() => {
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

describe('provider registry', () => {
  it('classifies every entry and never leaves funding implicit', () => {
    for (const [id, entry] of Object.entries(PROVIDER_REGISTRY)) {
      expect(['free', 'credited', 'paid']).toContain(entry.funding);
      expect(entry.credentialEnvVar).toMatch(/^[A-Z][A-Z0-9_]+$/);
      expect(entry.models.length).toBeGreaterThan(0);
      expect(id).not.toBe('');
    }
  });

  it('puts credited and free capacity ahead of paid, per the standing credits-first rule', () => {
    expect(PROVIDER_REGISTRY.nvidia.funding).toBe('credited');
    expect(PROVIDER_REGISTRY['openai-compatible'].funding).toBe('free');
    expect(PROVIDER_REGISTRY.anthropic.funding).toBe('paid');
  });
});

describe('approveProvider — fail-closed refusals', () => {
  it('refuses an unknown provider without touching the secret store', () => {
    expectRefusal(() => approve({ providerId: 'shadow-gateway' }), 'provider_unknown');
    expect(secretLookups).toEqual([]);
    expect(recordedClaims).toEqual([]);
  });

  it('refuses an unpriced model on a known provider', () => {
    expectRefusal(() => approve({ modelId: 'some/unlisted-model' }), 'model_unpriced');
    expect(secretLookups).toEqual([]);
    expect(recordedClaims).toEqual([]);
  });

  it('refuses when the credential is unavailable', () => {
    expectRefusal(() => approve({ resolveSecret: () => undefined }), 'credential_missing');
    expect(recordedClaims).toEqual([]);
  });

  it('refuses an empty credential the same as a missing one', () => {
    expectRefusal(() => approve({ resolveSecret: () => '   ' }), 'credential_missing');
    expect(recordedClaims).toEqual([]);
  });

  it('refuses a paid provider while ATLAS_ALLOW_PAID is unset', () => {
    expectRefusal(
      () => approve({ providerId: 'anthropic', modelId: 'claude-sonnet-5' }),
      'spend_blocked',
    );
    expect(secretLookups).toEqual([]);
    expect(recordedClaims).toEqual([]);
  });

  it('refuses everything while Atlas is paused', () => {
    process.env.ATLAS_PAUSE = '1';
    expectRefusal(() => approve(), 'atlas_paused');
    expect(secretLookups).toEqual([]);
    expect(recordedClaims).toEqual([]);
  });
});

describe('approveProvider — approval path', () => {
  it('mints a credited provider, records one evidence claim, and reports funding', () => {
    const approved = approve();
    expect(approved.providerId).toBe('nvidia');
    expect(approved.modelId).toBe('meta/llama-3.3-70b-instruct');
    expect(approved.baseUrl).toBe('https://integrate.api.nvidia.com/v1');
    expect(approved.paid).toBe(false);
    expect(approved.spendClaimId).toMatch(/^clm_[a-z0-9][a-z0-9._-]{1,80}$/);
    expect(recordedClaims).toHaveLength(1);
  });

  it('mints the free gateway without a baseUrl override', () => {
    const approved = approve({ providerId: 'openai-compatible', modelId: 'gemini-2.5-flash' });
    expect(approved.paid).toBe(false);
    expect(approved.baseUrl).toBeUndefined();
    expect(approved.apiKey).toBe(SECRETS.FREELLMAPI_API_KEY);
  });

  it('never writes the credential, or anything derived from it, into evidence', () => {
    const approved = approve();
    const serialized = JSON.stringify(recordedClaims);
    expect(serialized).not.toContain(approved.apiKey);
    // No partial leak either: no 8-char window of the credential may appear.
    // (A bare length check would false-positive against the claim timestamp.)
    for (let i = 0; i + 8 <= approved.apiKey.length; i += 1) {
      expect(serialized).not.toContain(approved.apiKey.slice(i, i + 8));
    }
    expect(serialized).toContain('provider=nvidia');
    expect(serialized).toContain('funding=credited');
  });

  it('allows a paid provider once ATLAS_ALLOW_PAID is explicitly set', () => {
    process.env.ATLAS_ALLOW_PAID = '1';
    const approved = approve({ providerId: 'anthropic', modelId: 'claude-sonnet-5' });
    expect(approved.paid).toBe(true);
    expect(recordedClaims).toHaveLength(1);
  });
});

describe('cerebras lane — the only non-Google option', () => {
  // The free gateway proxies every model through the Google API, so Gemini and
  // Gemma alike fail multi-turn tool calling with a missing thought_signature.
  // Cerebras is OpenAI-compatible and has no such requirement — but it also
  // carries the ADR-013 $7.25 burn scar, and Atlas cannot verify its price from
  // here. Unknown price fails closed.
  it('is refused while ATLAS_ALLOW_PAID is unset, before any credential lookup', () => {
    expectRefusal(() => approve({ providerId: 'cerebras', modelId: 'gpt-oss-120b' }), 'spend_blocked');
    expect(secretLookups).toEqual([]);
    expect(recordedClaims).toEqual([]);
  });

  it('is classified paid, never free', () => {
    expect(PROVIDER_REGISTRY.cerebras.funding).toBe('paid');
    expect(PROVIDER_REGISTRY.cerebras.baseUrl).toBe('https://api.cerebras.ai/v1');
  });

  it('still refuses an unpriced cerebras model even once paid spend is allowed', () => {
    process.env.ATLAS_ALLOW_PAID = '1';
    expectRefusal(() => approve({ providerId: 'cerebras', modelId: 'some-unlisted' }), 'model_unpriced');
  });

  it('mints a cerebras provider only with explicit paid authorization', () => {
    process.env.ATLAS_ALLOW_PAID = '1';
    const approved = approve({ providerId: 'cerebras', modelId: 'gpt-oss-120b' });
    expect(approved.paid).toBe(true);
    expect(approved.baseUrl).toBe('https://api.cerebras.ai/v1');
  });
});
