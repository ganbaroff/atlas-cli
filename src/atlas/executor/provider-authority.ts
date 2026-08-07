/**
 * atlas/executor/provider-authority.ts — no approved decision, no model call.
 *
 * An `ApprovedProvider` is the ONLY thing an ExecutorAdapter will accept to
 * reach a model, and this module is the only place one can be minted. The
 * adapter cannot construct one, so an executor cannot route around Atlas spend
 * authority by choosing its own provider.
 *
 * Fail-closed by construction. `spend-policy.ts` classifies spend with
 * `PAID_PROVIDERS`, an allowlist of paid names — which means an unrecognised
 * provider reads as free there and would slip through. That is fine for its own
 * callers, which only ever pass known names, but it is the wrong default at an
 * executor boundary where the provider id can originate from a mission. Here an
 * unknown provider, an unknown model, or a missing credential is refused before
 * any network call, rather than assumed free.
 *
 * This is not a second spend ledger. Cost accounting stays in spend-tracker;
 * the paid path still goes through `enforceSpendPolicy`, and the decision is
 * recorded in the existing M8 evidence ledger, not a new one.
 */

import { appendClaim } from '../../evidence/ledger.js';
import { enforceSpendPolicy, isPaused, paidAllowed, SpendBlockedError } from '../spend-policy.js';
import type { ApprovedProvider } from './adapter.js';

/** How a provider is funded. `paid` is the only class that can cost cash. */
export type ProviderFunding = 'free' | 'credited' | 'paid';

export interface ProviderRegistryEntry {
  readonly funding: ProviderFunding;
  /** Env var holding the credential. Its VALUE is never logged or persisted. */
  readonly credentialEnvVar: string;
  readonly baseUrl?: string;
  /** Models Atlas has priced. An unpriced model fails closed. */
  readonly models: readonly string[];
}

/**
 * The closed registry. Credits-first ordering is a CEO standing rule
 * (NVIDIA Inception -> Vertex -> Azure -> free tiers -> paid last), so the
 * credited and free entries come first and the paid ones exist only so that
 * `enforceSpendPolicy` has something to refuse when `ATLAS_ALLOW_PAID` is unset.
 */
export const PROVIDER_REGISTRY: Readonly<Record<string, ProviderRegistryEntry>> = Object.freeze({
  nvidia: {
    funding: 'credited',
    credentialEnvVar: 'NVIDIA_API_KEY',
    baseUrl: 'https://integrate.api.nvidia.com/v1',
    models: ['meta/llama-3.3-70b-instruct', 'qwen/qwen2.5-coder-32b-instruct', 'deepseek-ai/deepseek-v4-flash'],
  },
  'openai-compatible': {
    funding: 'free',
    credentialEnvVar: 'FREELLMAPI_API_KEY',
    models: [
      'gemini-3.5-flash',
      'gemini-3-flash-preview',
      'gemini-3.1-flash-lite-preview',
      'gemini-2.5-flash',
      'gemini-2.5-flash-lite',
      'gemma-4-31b-it',
      'gemma-4-26b-a4b-it',
    ],
  },
  /**
   * The only non-Google lane reachable from this machine. It matters because
   * the free gateway proxies EVERY model through the Google API, so all of its
   * models — Gemini and Gemma alike — fail multi-turn tool calling with
   * "Function call is missing a thought_signature". Cerebras is
   * OpenAI-compatible and has no such requirement.
   *
   * Classified `paid` deliberately, not because Cerebras has no free tier, but
   * because Atlas cannot verify the price of a call from here and this provider
   * carries a scar: a $7.25 burn recorded in ADR-013. Unknown price fails
   * closed, so using it needs ATLAS_ALLOW_PAID — a CEO spend decision, exactly
   * as the rule requires.
   */
  cerebras: {
    funding: 'paid',
    credentialEnvVar: 'CEREBRAS_API_KEY',
    baseUrl: 'https://api.cerebras.ai/v1',
    models: ['gpt-oss-120b', 'zai-glm-4.7', 'gemma-4-31b'],
  },
  anthropic: {
    funding: 'paid',
    credentialEnvVar: 'ANTHROPIC_API_KEY',
    models: ['claude-sonnet-5', 'claude-opus-5', 'claude-haiku-4-5-20251001'],
  },
});

export type ProviderRefusalReason =
  | 'provider_unknown'
  | 'model_unpriced'
  | 'credential_missing'
  | 'atlas_paused'
  | 'spend_blocked';

export class ProviderNotApprovedError extends Error {
  constructor(
    readonly reason: ProviderRefusalReason,
    detail: string,
  ) {
    super(`provider refused (${reason}): ${detail}`);
    this.name = 'ProviderNotApprovedError';
  }
}

export interface ApproveProviderRequest {
  readonly providerId: string;
  readonly modelId: string;
  readonly missionId: string;
  readonly workOrderId: string;
  /** Who is asking — recorded in the spend evidence, never derived from the executor. */
  readonly caller: string;
  /** Atlas-owned secret lookup. Returns the value; the value never leaves this call. */
  readonly resolveSecret: (envVarName: string) => string | undefined;
  /** Injected in tests. Defaults to the real M8 ledger. */
  readonly recordClaim?: typeof appendClaim;
  readonly evidenceDir?: string;
  readonly now?: () => Date;
}

function claimIdFor(missionId: string, providerId: string, at: Date): string {
  const slug = `${missionId}-${providerId}-${at.getTime()}`
    .toLowerCase()
    .replace(/[^a-z0-9._-]/g, '-')
    .slice(0, 78);
  return `clm_${slug}`;
}

/**
 * Mints an ApprovedProvider or throws. Order matters: identity checks run
 * before the credential is resolved, so an unknown provider never causes a
 * secret lookup, and the pause/spend gates run before anything is recorded.
 */
export function approveProvider(request: ApproveProviderRequest): ApprovedProvider {
  const at = (request.now ?? (() => new Date()))();

  const entry = PROVIDER_REGISTRY[request.providerId];
  if (!entry) {
    throw new ProviderNotApprovedError(
      'provider_unknown',
      `'${request.providerId}' is not in the Atlas provider registry`,
    );
  }

  if (!entry.models.includes(request.modelId)) {
    throw new ProviderNotApprovedError(
      'model_unpriced',
      `'${request.modelId}' has no Atlas price on provider '${request.providerId}'`,
    );
  }

  if (isPaused()) {
    throw new ProviderNotApprovedError('atlas_paused', 'Atlas is paused; no model may be invoked');
  }

  const paid = entry.funding === 'paid';

  // The registry's own classification is authoritative HERE. spend-policy's
  // PAID_PROVIDERS is a separate allowlist that does not know about every lane
  // this registry carries — cerebras is classified paid here and absent there,
  // so relying on enforceSpendPolicy alone let a paid lane through. Both gates
  // now run, and this one runs first.
  if (paid && !paidAllowed()) {
    throw new ProviderNotApprovedError(
      'spend_blocked',
      `provider '${request.providerId}' is classified paid in the Atlas registry and ATLAS_ALLOW_PAID is not set`,
    );
  }

  try {
    enforceSpendPolicy(request.providerId, request.caller);
  } catch (err) {
    if (err instanceof SpendBlockedError) {
      throw new ProviderNotApprovedError('spend_blocked', err.message);
    }
    throw err;
  }

  const apiKey = request.resolveSecret(entry.credentialEnvVar);
  if (!apiKey || apiKey.trim() === '') {
    throw new ProviderNotApprovedError(
      'credential_missing',
      `${entry.credentialEnvVar} is not available from the Atlas secret provider`,
    );
  }

  const record = request.recordClaim ?? appendClaim;
  const claimId = claimIdFor(request.missionId, request.providerId, at);
  // Never include the credential, its length, or any derivative of it.
  record(
    {
      claimId,
      claim:
        `spend approved: mission=${request.missionId} workOrder=${request.workOrderId} ` +
        `provider=${request.providerId} model=${request.modelId} funding=${entry.funding} caller=${request.caller}`,
      type: 'audit-finding',
      path: `mission/${request.missionId}`,
      confidence: 1,
      source: 'atlas/executor/provider-authority.approveProvider',
      // The M8 schema requires both on an audit-finding: the verdict makes the
      // claim falsifiable, and sourceRef names what an auditor must re-check.
      // Mocking appendClaim in the unit tests hid this — the first live run
      // failed on it immediately.
      auditVerdict: 'confirmed',
      sourceRef: `workOrder:${request.workOrderId}#provider=${request.providerId}&model=${request.modelId}&funding=${entry.funding}`,
      ts: at.toISOString(),
    },
    request.evidenceDir,
  );

  return {
    providerId: request.providerId,
    modelId: request.modelId,
    baseUrl: entry.baseUrl,
    apiKey,
    paid,
    spendClaimId: claimId,
  };
}
