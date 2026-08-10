/**
 * atlas/model-egress — C5A-2 loopback egress leg.
 *
 * Public surface only. `ResolvedProvider.authToken` is intentionally part of
 * the ladder's return value and nothing else: no export here hands a provider
 * secret to a caller that did not resolve it itself.
 */

export type {
  EgressConfig,
  EgressDecision,
  EgressDenyReason,
  EgressProviderSpec,
  EgressTier,
  SpendCapLimits,
  SpendSnapshot,
} from './types.js';
export {
  PROVIDER_LADDER,
  NoProviderConfiguredError,
  OutboundUrlNotAllowedError,
  assertOutboundProviderUrl,
  resolveProvider,
  type ResolvedProvider,
} from './provider-ladder.js';
export { SpendCap, readTotalTokens } from './spend-cap.js';
export { createEgressServer, type CreateEgressServerOptions } from './server.js';
export { projectEgressReceipt, recordEgressDecision } from './receipt.js';
