/**
 * Pure inbound-auth predicate for the Telegram bot — CEO-only gate.
 *
 * Lives outside telegram.ts on purpose: telegram.ts constructs a live
 * Telegraf bot and calls boot() (real polling, HTTP health server, Supabase
 * writes) at module import time, so it can never be imported from a unit
 * test. This leaf module has zero side effects and is safe to import
 * directly for testing; telegram.ts imports + re-exports the same symbol
 * so the middleware and the test both use one source of truth.
 */
export function isAuthorizedChat(senderId: number | undefined, allowedId: number): boolean {
  return typeof senderId === 'number' && !Number.isNaN(allowedId) && senderId === allowedId;
}
