/**
 * atlas/model-egress/provider-ladder.ts — C5A-2 credits ladder.
 *
 * Pure resolution: no socket, no DNS, no filesystem. Selects ONE provider once,
 * at startup, and that choice is frozen for the life of the process — the same
 * no-fallback discipline the broker applies to its upstream. A runtime fallback
 * chain is deliberately NOT implemented: silently sliding from a credited
 * provider to a paid one on an error is exactly how a burn happens (ADR-013,
 * Cerebras $7.25).
 *
 * A provider counts as available only when its auth env var is present AND
 * non-empty after trimming. This module reads that variable to test presence
 * and to hand the value to the caller's closure; it never logs it, never
 * returns it inside a spec, and never puts it in an error message.
 */

import type { EgressProviderSpec } from './types.js';

/** CEO standing directive: NVIDIA -> Vertex -> Azure -> free tiers -> paid last. */
export const PROVIDER_LADDER: readonly EgressProviderSpec[] = [
  {
    id: 'nvidia-inception',
    chatCompletionsUrl: 'https://integrate.api.nvidia.com/v1/chat/completions',
    authEnvVar: 'NVIDIA_API_KEY',
    tier: 'credits',
    rank: 1,
  },
  // Vertex (rank 2) and Azure (rank 3) are deliberately ABSENT from v0 rather
  // than present with a guessed url. Vertex's OpenAI-compatible endpoint embeds
  // the project and location in its path
  // (https://{LOCATION}-aiplatform.googleapis.com/v1/projects/{PROJECT}/locations/{LOCATION}/endpoints/openapi/chat/completions),
  // and the Azure endpoint is per-resource, so neither can be a static constant.
  // Adding them means adding a config source, not a line here. Their ranks stay
  // reserved so the ladder order below never has to shift.
  {
    id: 'groq',
    chatCompletionsUrl: 'https://api.groq.com/openai/v1/chat/completions',
    authEnvVar: 'GROQ_API_KEY',
    tier: 'free',
    rank: 4,
  },
  {
    id: 'gemini',
    chatCompletionsUrl: 'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions',
    authEnvVar: 'GEMINI_API_KEY',
    tier: 'free',
    rank: 5,
  },
];

export class NoProviderConfiguredError extends Error {
  constructor(checked: readonly string[]) {
    // Variable NAMES only — never a value, never a length, never a prefix.
    super(`model-egress: no provider configured; checked in ladder order: ${checked.join(', ')}`);
    this.name = 'NoProviderConfiguredError';
  }
}

export class OutboundUrlNotAllowedError extends Error {
  constructor(url: string, why: string) {
    super(`model-egress: refusing provider url (${why}): ${url}`);
    this.name = 'OutboundUrlNotAllowedError';
  }
}

const LOOPBACK_HOSTNAMES = new Set(['127.0.0.1', '::1', 'localhost']);

/**
 * Inverse of the broker's guard. The broker must point INWARD (loopback only);
 * this leg must point OUTWARD. A loopback provider url would either loop the
 * egress leg back into the broker or silently turn a "live" chat into a mock,
 * so it is refused at config time, before anything listens.
 */
export function assertOutboundProviderUrl(url: string): void {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new OutboundUrlNotAllowedError(url, 'unparseable');
  }
  if (parsed.protocol !== 'https:') {
    throw new OutboundUrlNotAllowedError(url, 'not https');
  }
  const hostname = parsed.hostname.toLowerCase();
  const bare = hostname.startsWith('[') && hostname.endsWith(']') ? hostname.slice(1, -1) : hostname;
  if (LOOPBACK_HOSTNAMES.has(bare)) {
    throw new OutboundUrlNotAllowedError(url, 'loopback is not an egress target');
  }
}

export interface ResolvedProvider {
  readonly spec: EgressProviderSpec;
  /**
   * The auth value, handed to the caller exactly once so it can live in a
   * closure. Never place this on EgressConfig, in a receipt, or in a log line.
   */
  readonly authToken: string;
}

/**
 * First ladder entry whose auth variable is present and non-empty wins. Reads
 * the environment ONCE; the caller is expected to call this at startup and hold
 * the result for the process lifetime.
 */
export function resolveProvider(
  env: NodeJS.ProcessEnv,
  ladder: readonly EgressProviderSpec[] = PROVIDER_LADDER,
): ResolvedProvider {
  const ordered = [...ladder].sort((a, b) => a.rank - b.rank);
  for (const spec of ordered) {
    const raw = env[spec.authEnvVar];
    if (typeof raw === 'string' && raw.trim().length > 0) {
      assertOutboundProviderUrl(spec.chatCompletionsUrl);
      return { spec, authToken: raw.trim() };
    }
  }
  throw new NoProviderConfiguredError(ordered.map((spec) => spec.authEnvVar));
}
