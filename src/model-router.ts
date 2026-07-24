/**
 * Atlas model router — cost-ordered routing with role-based selection.
 *
 * Selects one provider in cost order: free/local first, paid last.
 * Skips providers without API keys configured.
 */

import { createOpenRouter } from '@openrouter/ai-sdk-provider';
import { createAnthropic } from '@ai-sdk/anthropic';
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import { ollama } from 'ollama-ai-provider';
import { createOpenAI } from '@ai-sdk/openai';
import {
  isProviderHealthyForRouting,
  markProviderDead as persistMarkDead,
  recordProviderFailure,
} from './atlas/provider-health.js';

export type ModelRole = 'FAST' | 'WORKER' | 'JUDGE' | 'CRITICAL';

export type ProviderName =
  | 'ollama'
  | 'freellmapi'
  | 'gemini'
  | 'groq'
  | 'nvidia'
  | 'azure'
  | 'openai'
  | 'openrouter'
  | 'anthropic';

export interface ModelConfig {
  provider: ProviderName;
  modelId: string;
  costTier: number;
  roles: ModelRole[];
}

export interface RouteResult {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  model: any;
  provider: ProviderName;
  modelId: string;
  costTier: number;
}

const MODEL_REGISTRY: ModelConfig[] = [
  {
    // Canon provider order (CLAUDE.md): NVIDIA first, then local/free, paid last.
    // NVIDIA NIM — free tier, first per Constitution provider hierarchy.
    provider: 'nvidia',
    modelId: 'meta/llama-3.3-70b-instruct',
    costTier: 0,
    roles: ['WORKER'],
  },
  {
    // Azure OpenAI — credit-tier, third per Constitution (NVIDIA → Vertex → Azure).
    // Requires AZURE_OPENAI_API_KEY + AZURE_OPENAI_ENDPOINT (both checked in isAvailable).
    provider: 'azure',
    modelId: 'gpt-4o-mini',
    costTier: 0,
    roles: ['FAST', 'WORKER', 'JUDGE'],
  },
  {
    provider: 'ollama',
    modelId: 'qwen3:8b',
    costTier: 0,
    roles: ['FAST', 'WORKER'],
  },
  {
    // Free Gemini gateway (8 models behind one OpenAI-compatible endpoint).
    // Only selected when FREELLMAPI_BASE_URL is set (isAvailable gate), so it
    // never costs a guaranteed-failed attempt on machines without the gateway.
    provider: 'freellmapi',
    modelId: 'gemini-2.5-flash',
    costTier: 0,
    roles: ['FAST', 'WORKER', 'JUDGE'],
  },
  {
    // Gemini direct API — openai-compatible endpoint at generativelanguage.googleapis.com.
    // Selected when GEMINI_API_KEY is set; endpoint is fixed (no GEMINI_BASE_URL needed).
    provider: 'gemini',
    modelId: 'gemini-2.5-flash',
    costTier: 0,
    roles: ['FAST', 'WORKER', 'JUDGE'],
  },
  {
    provider: 'groq',
    modelId: 'llama-3.3-70b-versatile',
    costTier: 0,
    roles: ['FAST', 'WORKER', 'JUDGE'],
  },
  {
    provider: 'openai',
    modelId: 'gpt-4o-mini',
    costTier: 1,
    roles: ['WORKER', 'JUDGE'],
  },
  {
    provider: 'openrouter',
    modelId: 'x-ai/grok-3-mini',
    costTier: 1,
    roles: ['WORKER', 'JUDGE'],
  },
  {
    provider: 'anthropic',
    modelId: 'claude-sonnet-4-20250514',
    costTier: 2,
    roles: ['JUDGE', 'CRITICAL'],
  },
];

function getEnvKey(provider: ProviderName): string | undefined {
  const map: Record<ProviderName, string> = {
    ollama: 'OLLAMA_URL',
    freellmapi: 'FREELLMAPI_API_KEY',
    gemini: 'GEMINI_API_KEY',
    groq: 'GROQ_API_KEY',
    nvidia: 'NVIDIA_API_KEY',
    azure: 'AZURE_OPENAI_API_KEY',
    openai: 'OPENAI_API_KEY',
    openrouter: 'OPENROUTER_API_KEY',
    anthropic: 'ANTHROPIC_API_KEY',
  };
  return process.env[map[provider]];
}

// Live health state — providers marked dead after a real call failure.
// routeModelWithFallback already does runtime failover, but this prevents
// wasting time on known-dead providers at the start of each request.
const deadProviders = new Set<ProviderName>();
const deadTimestamps = new Map<ProviderName, number>();
const DEAD_TTL_MS = 5 * 60 * 1000; // retry dead provider after 5 min

function isAvailable(provider: ProviderName): boolean {
  // Durable health store (M6) — dead/cooldown providers never selected.
  if (!isProviderHealthyForRouting(provider)) return false;
  // Legacy in-memory dead set (kept for process-local fast path).
  if (deadProviders.has(provider)) {
    const deadSince = deadTimestamps.get(provider) ?? 0;
    if (Date.now() - deadSince < DEAD_TTL_MS) return false;
    // TTL expired — give it another chance
    deadProviders.delete(provider);
    deadTimestamps.delete(provider);
  }
  if (provider === 'ollama') {
    return !!process.env['OLLAMA_URL'] || !!process.env['OLLAMA_HOST'];
  }
  // freellmapi requires an EXPLICIT endpoint (FREELLMAPI_BASE_URL) — no hardcoded host in
  // source (cross-instance security review). No env → provider simply absent from the pool.
  if (provider === 'freellmapi') {
    return !!process.env['FREELLMAPI_API_KEY'] && !!process.env['FREELLMAPI_BASE_URL'];
  }
  // azure requires both the API key and the resource endpoint (no default endpoint).
  if (provider === 'azure') {
    return !!process.env['AZURE_OPENAI_API_KEY'] && !!process.env['AZURE_OPENAI_ENDPOINT'];
  }
  return !!getEnvKey(provider);
}

/** Mark a provider as dead after a real call failure. Auto-recovers after DEAD_TTL_MS. */
export function markProviderDead(provider: ProviderName, reason = 'runtime failure'): void {
  deadProviders.add(provider);
  deadTimestamps.set(provider, Date.now());
  persistMarkDead(provider, reason);
  console.log(`[router] ${provider} marked dead — skipping for ${DEAD_TTL_MS / 1000}s`);
}

/** Record a classified failure into durable health + in-memory dead set when warranted. */
export function noteProviderFailure(provider: ProviderName, error: string): void {
  const state = recordProviderFailure(provider, error);
  if (state === 'dead') {
    deadProviders.add(provider);
    deadTimestamps.set(provider, Date.now());
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function createModel(config: ModelConfig): any {
  switch (config.provider) {
    case 'ollama':
      return ollama(config.modelId);

    case 'freellmapi': {
      // Endpoint comes ONLY from env — no plaintext host in source (cross-instance security
      // review). isAvailable() already gates selection on this; the guard is defensive.
      const baseURL = process.env['FREELLMAPI_BASE_URL'];
      if (!baseURL) throw new Error('FREELLMAPI_BASE_URL not set — set it in .env (gateway endpoint)');
      return createOpenAICompatible({
        name: 'freellmapi',
        baseURL,
        headers: {
          Authorization: `Bearer ${process.env['FREELLMAPI_API_KEY']}`,
        },
      }).languageModel(config.modelId);
    }

    case 'gemini':
      return createOpenAICompatible({
        name: 'gemini',
        baseURL: 'https://generativelanguage.googleapis.com/v1beta/openai/',
        headers: {
          Authorization: `Bearer ${process.env['GEMINI_API_KEY']}`,
        },
      }).languageModel(config.modelId);

    case 'azure': {
      // Endpoint comes ONLY from env — no hardcoded resource URL in source.
      // isAvailable() already gates selection on this; the guard is defensive.
      const azureBaseURL = process.env['AZURE_OPENAI_ENDPOINT'];
      if (!azureBaseURL) throw new Error('AZURE_OPENAI_ENDPOINT not set — set it in .env (e.g. https://<resource>.openai.azure.com/openai)');
      return createOpenAICompatible({
        name: 'azure',
        baseURL: azureBaseURL,
        headers: {
          'api-key': process.env['AZURE_OPENAI_API_KEY'] ?? '',
        },
      }).languageModel(config.modelId);
    }

    case 'groq':
      return createOpenAICompatible({
        name: 'groq',
        baseURL: 'https://api.groq.com/openai/v1',
        headers: {
          Authorization: `Bearer ${process.env['GROQ_API_KEY']}`,
        },
      }).languageModel(config.modelId);

    case 'nvidia':
      return createOpenAICompatible({
        name: 'nvidia',
        baseURL: 'https://integrate.api.nvidia.com/v1',
        headers: {
          Authorization: `Bearer ${process.env['NVIDIA_API_KEY']}`,
        },
      }).languageModel(config.modelId);

    case 'openai':
      return createOpenAI({
        apiKey: process.env['OPENAI_API_KEY'],
      })(config.modelId);

    case 'openrouter':
      return createOpenRouter({
        apiKey: process.env['OPENROUTER_API_KEY'],
      })(config.modelId);

    case 'anthropic':
      return createAnthropic({
        apiKey: process.env['ANTHROPIC_API_KEY'],
      })(config.modelId);
  }
}

export interface RouterOptions {
  role?: ModelRole;
  maxCostTier?: number;
  preferredProvider?: ProviderName;
  /** When true, ATLAS_PREFERRED_PROVIDER env is ignored (research-swarm workers). */
  ignoreEnvPreference?: boolean;
  /** Providers the swarm must never use (canon: "never Claude as swarm agent"). */
  excludeProviders?: ProviderName[];
}

export function routeModel(opts: RouterOptions = {}): RouteResult {
  const envPref = process.env['ATLAS_PREFERRED_PROVIDER'] as ProviderName | undefined;
  const {
    role = 'WORKER',
    maxCostTier = 3,
    preferredProvider: explicitPref,
    ignoreEnvPreference = false,
    excludeProviders,
  } = opts;
  const preferredProvider = ignoreEnvPreference ? explicitPref : (explicitPref ?? envPref);

  const candidates = MODEL_REGISTRY.filter(
    (m) =>
      m.roles.includes(role) &&
      m.costTier <= maxCostTier &&
      !(excludeProviders?.includes(m.provider)) &&
      isAvailable(m.provider),
  ).sort((a, b) => {
    if (preferredProvider) {
      if (a.provider === preferredProvider && b.provider !== preferredProvider)
        return -1;
      if (b.provider === preferredProvider && a.provider !== preferredProvider)
        return 1;
    }
    return a.costTier - b.costTier;
  });

  if (candidates.length === 0) {
    throw new Error(
      `No model available for role=${role} maxCost=${maxCostTier}. Set API keys in env.`,
    );
  }

  const config = candidates[0];
  return {
    model: createModel(config),
    provider: config.provider,
    modelId: config.modelId,
    costTier: config.costTier,
  };
}

/**
 * Route with runtime fallback — tries each candidate in cost order.
 * If a provider fails (quota, rate limit, network), moves to next.
 * Returns the first successful result.
 *
 * Codex P0: "if chosen provider is alive by key but falls by quota,
 * agent dies instead of falling back to next."
 */
export async function routeModelWithFallback(
  opts: RouterOptions = {},
  callFn: (route: RouteResult) => Promise<unknown>,
): Promise<{ result: unknown; route: RouteResult }> {
  const envPref = process.env['ATLAS_PREFERRED_PROVIDER'] as ProviderName | undefined;
  const { role = 'WORKER', maxCostTier = 3, preferredProvider = envPref, excludeProviders } = opts;

  const candidates = MODEL_REGISTRY.filter(
    (m) =>
      m.roles.includes(role) &&
      m.costTier <= maxCostTier &&
      !(excludeProviders?.includes(m.provider)) &&
      isAvailable(m.provider),
  ).sort((a, b) => {
    if (preferredProvider) {
      if (a.provider === preferredProvider && b.provider !== preferredProvider)
        return -1;
      if (b.provider === preferredProvider && a.provider !== preferredProvider)
        return 1;
    }
    return a.costTier - b.costTier;
  });

  if (candidates.length === 0) {
    throw new Error(
      `No model available for role=${role} maxCost=${maxCostTier}. Set API keys in env.`,
    );
  }

  const errors: Array<{ provider: ProviderName; error: string }> = [];

  for (const config of candidates) {
    try {
      const route: RouteResult = {
        model: createModel(config),
        provider: config.provider,
        modelId: config.modelId,
        costTier: config.costTier,
      };
      const result = await callFn(route);
      return { result, route };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      errors.push({ provider: config.provider, error: msg.slice(0, 200) });
      // M6: classify into durable health (dead/degraded) + in-memory skip.
      noteProviderFailure(config.provider, msg);
    }
  }

  throw new Error(
    `All ${candidates.length} providers failed for role=${role}: ${JSON.stringify(errors)}`,
  );
}

export function listAvailableModels(): ModelConfig[] {
  return MODEL_REGISTRY.filter((m) => isAvailable(m.provider));
}

export function isKnownProvider(name: string): name is ProviderName {
  return MODEL_REGISTRY.some((m) => m.provider === name);
}

export function isProviderConfigured(provider: ProviderName): boolean {
  return isAvailable(provider);
}

export function providerSupportsWorkerRole(provider: ProviderName): boolean {
  return MODEL_REGISTRY.some((m) => m.provider === provider && m.roles.includes('WORKER'));
}

/** Distinct WORKER providers that pass isAvailable() right now. */
export function listAvailableWorkerProviders(): ProviderName[] {
  const seen = new Set<ProviderName>();
  for (const m of MODEL_REGISTRY) {
    if (m.roles.includes('WORKER') && isAvailable(m.provider)) seen.add(m.provider);
  }
  return [...seen];
}
