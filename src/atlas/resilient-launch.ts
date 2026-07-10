// ── Resilient launch retry ──────────────────────────────────────────
// Railway does zero-downtime deploys: the old + new container run together
// briefly, so the new container's long-poll launch() can hit Telegram 409
// Conflict while the old poller is still attached. Exiting on that (the old
// behavior) kills the new container before Railway's healthcheck ever sees
// it healthy, so the deploy fails and the old container stays forever.
//
// This module keeps retrying launch() with backoff instead of dying, so the
// process (and its independent /health server) stays alive long enough for
// Railway to mark the new container healthy, retire the old one, and let the
// retry connect cleanly. Pure + side-effect-injectable so it's unit-testable
// without touching the real bot or process.exit.

export interface LaunchWithRetryOptions {
  /** Max attempts before giving up and re-throwing the last error. Default 120 (~10 min at 5s each). */
  maxTries?: number;
  /** Delay between attempts in ms. Default 5000. */
  delayMs?: number;
  /** Called after each failed attempt, before the delay. */
  onRetry?: (attempt: number, err: unknown) => void;
  /** Injectable sleep — defaults to a real timer; tests pass a no-op. */
  sleep?: (ms: number) => Promise<void>;
}

const defaultSleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * Calls `launch()`. On rejection, invokes `onRetry` and waits `delayMs`
 * before trying again, up to `maxTries` attempts total. Only after every
 * attempt has failed does it re-throw the last error — it never calls
 * process.exit itself; that decision belongs to the caller.
 */
export async function launchWithRetry(
  launch: () => Promise<void>,
  opts?: LaunchWithRetryOptions,
): Promise<void> {
  const maxTries = opts?.maxTries ?? 120;
  const delayMs = opts?.delayMs ?? 5000;
  const onRetry = opts?.onRetry;
  const sleep = opts?.sleep ?? defaultSleep;

  let lastErr: unknown;
  for (let attempt = 1; attempt <= maxTries; attempt++) {
    try {
      await launch();
      return;
    } catch (err) {
      lastErr = err;
      if (attempt >= maxTries) break;
      onRetry?.(attempt, err);
      await sleep(delayMs);
    }
  }
  throw lastErr;
}
