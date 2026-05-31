/**
 * PostHog analytics for Atlas CLI.
 * Tracks command usage and session events to help improve the product.
 * All data is anonymous — distinctId is derived from hostname.
 */

import { hostname } from 'node:os';
import { PostHog } from 'posthog-node';

let _client: PostHog | null = null;

function getClient(): PostHog | null {
  if (_client) return _client;

  const apiKey = process.env['POSTHOG_API_KEY'];
  const host = process.env['POSTHOG_HOST'];
  if (!apiKey) return null;

  try {
    _client = new PostHog(apiKey, { host });
  } catch {
    // init failed — analytics disabled silently
  }
  return _client;
}

/** Stable per-machine anonymous identifier. */
function getDistinctId(): string {
  return `atlas-cli:${hostname()}`;
}

/**
 * Capture a PostHog event. Never throws — failures are silently ignored.
 */
export function capture(event: string, properties?: Record<string, unknown>): void {
  try {
    const client = getClient();
    if (!client) return;
    client.capture({ distinctId: getDistinctId(), event, properties });
  } catch {
    // silent — analytics must never break the CLI
  }
}

/**
 * Flush and shut down the PostHog client. Call before process exits.
 */
export async function shutdown(): Promise<void> {
  try {
    if (_client) await _client.shutdown();
  } catch {
    // silent
  }
}
