/**
 * atlas/model-broker/upstream-policy.ts — C5A no-fallback upstream guard.
 *
 * Pure string/URL parsing only — no DNS lookup, no socket opened here. Must
 * run at CONFIG VALIDATION time (server.ts's createBrokerServer calls
 * assertLoopbackUpstream before it ever listens), so a misconfigured
 * non-loopback upstream is refused before the broker accepts a single
 * connection.
 */

export class UpstreamNotLoopbackError extends Error {
  constructor(url: string) {
    super(`model-broker: refusing non-loopback upstream url: ${url}`);
    this.name = 'UpstreamNotLoopbackError';
  }
}

const LOOPBACK_HOSTNAMES = new Set(['127.0.0.1', '::1', 'localhost']);

/** Pure check — never throws, never touches the network or DNS. */
export function isLoopbackUpstream(url: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  const hostname = parsed.hostname.toLowerCase();
  // URL keeps IPv6 hosts bracketed ("[::1]") — strip brackets before the set check.
  const bareHostname = hostname.startsWith('[') && hostname.endsWith(']')
    ? hostname.slice(1, -1)
    : hostname;
  return LOOPBACK_HOSTNAMES.has(bareHostname);
}

/** Throws UpstreamNotLoopbackError unless the url's hostname is exactly 127.0.0.1, ::1, or localhost. */
export function assertLoopbackUpstream(url: string): void {
  if (!isLoopbackUpstream(url)) {
    throw new UpstreamNotLoopbackError(url);
  }
}
