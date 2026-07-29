/**
 * M2C repair, third refutation: the substitution seam for the cost
 * router's trusted table source.
 *
 * Two earlier attempts tried to keep an injectable-table entry point
 * ("gates must stay testable against fixtures") reachable from
 * `cost-router-classify.ts` while claiming production code could not reach
 * it:
 *
 *   1. First attempt: the entry point stayed exported next to
 *      `runTrustedRoutedAttempt` with a comment asking callers to prefer
 *      the trusted one. An independent review imported it directly and
 *      forged a route into a disabled tier — a comment enforces nothing.
 *   2. Second attempt: the entry point refused to run unless
 *      `process.env.VITEST === 'true'`. A plain `npx tsx` script set that
 *      variable itself and reached the same hole — an environment variable
 *      is caller-controlled data, not an authenticated signal, so it can
 *      never be what stands between production code and an injectable
 *      table.
 *
 * This third repair removes the injectable-table entry point from
 * `cost-router-classify.ts` entirely. `runTrustedRoutedAttempt` always
 * resolves its `availability`/`providerClasses` tables by calling
 * `resolveTrustedTables()` below, passing this module's own trusted
 * defaults (`DEFAULT_ROUTE_AVAILABILITY`, `DEFAULT_PROVIDER_CLASS_TABLE`) as
 * the `defaults` argument. In production `resolveTrustedTables` always
 * hands those exact defaults back unchanged — this file owns no trusted
 * data of its own and imports none.
 *
 * The ONLY way to change what `resolveTrustedTables` returns is
 * `withTrustedTables` below, and THIS FILE is the only place that function
 * is exported from. A caller that imports only `cost-router-classify.ts` —
 * the entire public surface production code is expected to depend on — has
 * no import path to `withTrustedTables` at all: not a parameter on any
 * exported function, not an environment variable, not a type cast. Reaching
 * the override requires an explicit `import ... from
 * './cost-router-test-seam.js'`, which is what marks a caller as test code
 * — a fact about the module graph, not a promise a caller makes about
 * itself.
 */

export interface TrustedTables<Availability = unknown, ProviderClasses = unknown> {
  readonly availability: Availability;
  readonly providerClasses: ProviderClasses;
}

let override: TrustedTables | undefined;

/**
 * Called by `runTrustedRoutedAttempt` on every invocation, passing its own
 * trusted defaults. Returns the installed `override` when a test has called
 * `withTrustedTables`; otherwise returns `defaults` — the caller's real
 * trusted constants — completely unchanged.
 */
export function resolveTrustedTables<T extends TrustedTables>(defaults: T): T {
  return (override as T | undefined) ?? defaults;
}

/**
 * The only supported way to substitute the tables `runTrustedRoutedAttempt`
 * resolves. Installs `tables` for the duration of `fn`, then restores
 * whatever was installed before (normally `undefined`, i.e. real defaults)
 * in a `finally` — so a substitution can never leak into a later call, even
 * if `fn` throws or a test forgets to clean up. Not reachable from
 * `cost-router-classify.ts`'s own exports.
 */
export async function withTrustedTables<T>(
  tables: TrustedTables,
  fn: () => Promise<T> | T,
): Promise<T> {
  const previous = override;
  override = tables;
  try {
    return await fn();
  } finally {
    override = previous;
  }
}
