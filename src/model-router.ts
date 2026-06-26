/**
 * Atlas model router — cost-ordered routing with role-based selection.
 *
 * Selects one provider in cost order: free/local first, paid last.
 * Skips providers without API keys configured.
 */

import { createOpenRouter } from '@openrouter/ai-sdk-provider';
import { createAnthropic } from '@ai-sdk/anthropic';
import { createCerebras } from '@ai-sdk/cerebras';
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import { ollama } from 'ollama-ai-provider';
import { createOpenAI } from '@ai-sdk/openai';

export type ModelRole = 'FAST' | 'WORKER' | 'JUDGE' | 'CRITICAL';

export type ProviderName =
  | 'ollama'
  | 'freellmapi'
  | 'cerebras'
  | 'groq'
  | 'nvidia'
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
    // Free Gemini gateway (8 models behind one OpenAI-compatible endpoint).
    // Listed BEFORE ollama: registry order breaks costTier ties, and OLLAMA_URL
    // defaults to localhost even when no Ollama is running — putting the gateway
    // first saves a guaranteed-failed attempt per message on machines without Ollama.
    provider: 'freellmapi',
    modelId: 'gemini-2.5-flash',
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
    provider: 'cerebras',
    modelId: 'qwen-3-235b-a22b-instruct-2507',
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
    provider: 'nvidia',
    modelId: 'meta/llama-3.3-70b-instruct',
    costTier: 0,
    roles: ['WORKER'],
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
    roles: ['WORKER', 'JUDGE', 'CRITICAL'],
  },
];

function getEnvKey(provider: ProviderName): string | undefined {
  const map: Record<ProviderName, string> = {
    ollama: 'OLLAMA_URL',
    freellmapi: 'FREELLMAPI_API_KEY',
    cerebras: 'CEREBRAS_API_KEY',
    groq: 'GROQ_API_KEY',
    nvidia: 'NVIDIA_API_KEY',
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
  // Check if provider was marked dead recently
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
  if (provider === 'freellmapi') {
    return !!process.env['FREELLMAPI_API_KEY'] && !!process.env['FREELLMAPI_BASE_URL'];
  }
  return !!getEnvKey(provider);
}

/** Mark a provider as dead after a real call failure. Auto-recovers after DEAD_TTL_MS. */
export function markProviderDead(provider: ProviderName): void {
  deadProviders.add(provider);
  deadTimestamps.set(provider, Date.now());
  console.log(`[router] ${provider} marked dead — skipping for ${DEAD_TTL_MS / 1000}s`);
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

    case 'cerebras':
      return createCerebras({
        apiKey: process.env['CEREBRAS_API_KEY'],
      })(config.modelId);

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
  /** Providers the swarm must never use (canon: "never Claude as swarm agent"). */
  excludeProviders?: ProviderName[];
}

export function routeModel(opts: RouterOptions = {}): RouteResult {
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
      markProviderDead(config.provider);
      // Continue to next provider
    }
  }

  throw new Error(
    `All ${candidates.length} providers failed for role=${role}: ${JSON.stringify(errors)}`,
  );
}

export function listAvailableModels(): ModelConfig[] {
  return MODEL_REGISTRY.filter((m) => isAvailable(m.provider));
}
