/**
 * Atlas model router — cost-ordered fallback with role-based selection.
 *
 * Tries providers in cost order: free/local first, paid last.
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
  | 'cerebras'
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
    provider: 'ollama',
    modelId: 'qwen3:8b',
    costTier: 0,
    roles: ['FAST', 'WORKER'],
  },
  {
    provider: 'cerebras',
    modelId: 'qwen-3-235b-a22b-instruct-2507',
    costTier: 0,
    roles: ['FAST'],
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
    cerebras: 'CEREBRAS_API_KEY',
    nvidia: 'NVIDIA_API_KEY',
    openai: 'OPENAI_API_KEY',
    openrouter: 'OPENROUTER_API_KEY',
    anthropic: 'ANTHROPIC_API_KEY',
  };
  return process.env[map[provider]];
}

function isAvailable(provider: ProviderName): boolean {
  if (provider === 'ollama') {
    return !!process.env['OLLAMA_URL'] || !!process.env['OLLAMA_HOST'];
  }
  return !!getEnvKey(provider);
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function createModel(config: ModelConfig): any {
  switch (config.provider) {
    case 'ollama':
      return ollama(config.modelId);

    case 'cerebras':
      return createCerebras({
        apiKey: process.env['CEREBRAS_API_KEY'],
      })(config.modelId);

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
}

export function routeModel(opts: RouterOptions = {}): RouteResult {
  const envPref = process.env['ATLAS_PREFERRED_PROVIDER'] as ProviderName | undefined;
  const { role = 'WORKER', maxCostTier = 3, preferredProvider = envPref } = opts;

  const candidates = MODEL_REGISTRY.filter(
    (m) =>
      m.roles.includes(role) &&
      m.costTier <= maxCostTier &&
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

export function listAvailableModels(): ModelConfig[] {
  return MODEL_REGISTRY.filter((m) => isAvailable(m.provider));
}
