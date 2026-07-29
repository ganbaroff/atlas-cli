/**
 * Model-free route classifier for the Atlas Cost Router (M2A).
 *
 * `classifyRoute` and `checkRouteAvailability` are PURE: no model call, no
 * provider call, no network I/O, no filesystem I/O, no durable-state read.
 * They decide, from objective fields on the task input alone, which of the
 * four routes a task belongs to and whether that route may be entered right
 * now. Same input -> same output, every time.
 *
 * `acquireT3RouteOwner` is the one function in this module that is NOT pure:
 * it composes the pure classifier with the M1 durable record
 * (`./cost-router-state.js`) so a T3 escalation is both classified and
 * counted against the goal's one-escalation-per-task ceiling in a single
 * call. It still never calls a model or provider.
 */

import {
  acquirePremiumOwner,
  recordRetryEvent,
  T3_TRIGGERS,
  type DurableGoalRouterRecord,
  type GoalRouterStateOptions,
  type PremiumOwner,
  type T3Trigger,
} from './cost-router-state.js';

export type RouteTier = 'T0' | 'T1' | 'T2' | 'T3';

export { T3_TRIGGERS };
export type { T3Trigger };

/**
 * Objective, caller-declared capability flags for one task. These are not
 * inferred from free text — the caller (planner/action-router) states them
 * explicitly, which is what keeps every predicate below objective rather
 * than a keyword guess.
 */
export interface RouteTaskInput {
  /** Stable task id; also the M1 escalation-ledger key for T3 tasks. */
  taskId: string;
  /** Exact name of a deterministic tool that can satisfy this task alone. */
  deterministicTool?: string;
  /** Task's only unmet need is sanitized public web research. */
  needsWebResearch?: boolean;
  /** Task fits a bounded local-worker slice (no premium reasoning needed). */
  needsLocalWorker?: boolean;
  /** Task explicitly requires premium reasoning. */
  needsPremiumReasoning?: boolean;
  /** Objective trigger claimed for a premium-reasoning task. */
  trigger?: T3Trigger;
}

export interface RouteMatch {
  route: RouteTier;
  /** Stable name of the predicate table entry that matched. */
  predicate: string;
  /** Present only for a matched T3 route. */
  trigger?: T3Trigger;
}

export type RouteRefusalReason =
  | 'unclassifiable'
  | 't3_trigger_missing'
  | 'route_disabled'
  /** M2B: a value claiming to be an `AvailableRoute` never actually passed
   *  through `resolveRoute`'s availability check (brand missing/forged). */
  | 'availability_not_checked';

export class RouteRefusalError extends Error {
  constructor(
    readonly reason: RouteRefusalReason,
    readonly route: RouteTier | undefined,
    message: string,
  ) {
    super(message);
    this.name = 'RouteRefusalError';
  }
}

interface RoutePredicate {
  name: string;
  route: RouteTier;
  test: (task: RouteTaskInput) => boolean;
}

/**
 * Ordered predicate table. First match wins. Cheapest routes are checked
 * first so malformed input that sets more than one flag resolves to the
 * cheaper route rather than escalating toward T3.
 */
const ROUTE_PREDICATES: readonly RoutePredicate[] = Object.freeze([
  {
    name: 't0-deterministic-tool-named',
    route: 'T0',
    test: (task) =>
      typeof task.deterministicTool === 'string' &&
      task.deterministicTool.trim().length > 0,
  },
  {
    name: 't1-sanitized-web-research-only',
    route: 'T1',
    test: (task) => task.needsWebResearch === true,
  },
  {
    name: 't2-bounded-local-worker',
    route: 'T2',
    test: (task) => task.needsLocalWorker === true,
  },
  {
    name: 't3-premium-reasoning-requested',
    route: 'T3',
    test: (task) => task.needsPremiumReasoning === true,
  },
]);

const T3_TRIGGER_SET: ReadonlySet<string> = new Set(T3_TRIGGERS);

/**
 * Pure route classifier. Throws RouteRefusalError('unclassifiable') when no
 * predicate matches, and RouteRefusalError('t3_trigger_missing') when the
 * matched route is T3 but the task did not carry one of the four closed-set
 * objective triggers. Never returns a route it cannot justify.
 */
export function classifyRoute(task: RouteTaskInput): RouteMatch {
  for (const predicate of ROUTE_PREDICATES) {
    if (!predicate.test(task)) continue;

    if (predicate.route === 'T3') {
      if (!task.trigger || !T3_TRIGGER_SET.has(task.trigger)) {
        throw new RouteRefusalError(
          't3_trigger_missing',
          'T3',
          `task ${task.taskId} routed T3 without one of the mandatory triggers: ${T3_TRIGGERS.join(', ')}`,
        );
      }
      return { route: 'T3', predicate: predicate.name, trigger: task.trigger };
    }

    return { route: predicate.route, predicate: predicate.name };
  }

  throw new RouteRefusalError(
    'unclassifiable',
    undefined,
    `task ${task.taskId} matched no route predicate; refusing rather than defaulting`,
  );
}

/** Per-route enablement. Provider-unavailable states fold into the same flag: M2A is offline-only, so "disabled" and "provider unavailable" are one signal until the live gates in M5/M6 land. */
export interface RouteAvailability {
  T0: boolean;
  T1: boolean;
  T2: boolean;
  T3: boolean;
}

export const DEFAULT_ROUTE_AVAILABILITY: RouteAvailability = Object.freeze({
  T0: true,
  T1: false, // sanitized public web research stays off until its live gate (M5).
  T2: true,
  T3: true,
});

/**
 * Refuses (never downgrades) when a route is disabled or its provider is
 * unavailable. Pure: takes the availability table as an argument instead of
 * reading live provider health.
 */
export function checkRouteAvailability(
  route: RouteTier,
  availability: RouteAvailability = DEFAULT_ROUTE_AVAILABILITY,
): void {
  if (!availability[route]) {
    throw new RouteRefusalError(
      'route_disabled',
      route,
      `route ${route} is disabled or its provider is unavailable; refusing rather than falling through to another route`,
    );
  }
}

/**
 * M2B structural fix, v2. The M2A independent review flagged that nothing
 * stopped a caller from taking a bare `classifyRoute()` result and acting on
 * it directly, skipping `checkRouteAvailability`. The first fix branded the
 * result with an own enumerable symbol property (`{ ...match, [SYM]: true }`
 * under `Object.freeze`). An independent reviewer then broke that: own
 * enumerable symbol properties survive object spread and `Object.assign`
 * (`Object.freeze` only stops mutation of the frozen object itself, not
 * copying its properties onto a fresh one), so a caller could mint one real
 * `AvailableRoute` for an available route (e.g. T0) and spread it over a
 * disabled route's `RouteMatch` to forge a passing brand with zero
 * availability check on the disabled route.
 *
 * The replacement is identity-based, not property-based: `RESOLVED_ROUTES`
 * is a module-private `WeakSet` populated only inside `resolveRoute`, and
 * `assertRouteAvailabilityChecked` checks *object-reference* membership in
 * that set. Spreading or `Object.assign`-ing a real `AvailableRoute`
 * produces a brand-new object, which was never added to the set, so it is
 * rejected. A structural clone (`JSON.parse(JSON.stringify(...))`) is a new
 * object too, for the same reason. `AvailableRoute` keeps a type-only
 * phantom brand (a `declare const unique symbol` that has no runtime value)
 * purely so the compiler still flags an accidental bare `RouteMatch` being
 * passed where an `AvailableRoute` is required — constructing one still
 * requires an `as unknown as AvailableRoute` cast, but that cast alone no
 * longer produces an object this module will accept as checked.
 */
const RESOLVED_ROUTES = new WeakSet<object>();

declare const ROUTE_AVAILABILITY_CHECKED_BRAND: unique symbol;

export type AvailableRoute = RouteMatch & {
  readonly [ROUTE_AVAILABILITY_CHECKED_BRAND]: true;
};

/**
 * Classify, then gate on availability. Still pure/offline: no model call,
 * no provider call, no durable-state read or write. This is the only
 * supported way to obtain an `AvailableRoute` — see the comment above.
 */
export function resolveRoute(
  task: RouteTaskInput,
  availability: RouteAvailability = DEFAULT_ROUTE_AVAILABILITY,
): AvailableRoute {
  const match = classifyRoute(task);
  checkRouteAvailability(match.route, availability);
  const resolved = Object.freeze({ ...match }) as unknown as AvailableRoute;
  RESOLVED_ROUTES.add(resolved);
  return resolved;
}

/**
 * Runtime companion to the type-level brand above. Every function in this
 * module that spends a provider attempt against a route must call this
 * first. Throws `RouteRefusalError('availability_not_checked')` for any
 * value whose object identity was not genuinely added to `RESOLVED_ROUTES`
 * by `resolveRoute` — including a type-cast forgery, a spread/`Object.assign`
 * copy of a real one, or a structural clone, since none of those share
 * object identity with the one `resolveRoute` returned.
 */
function assertRouteAvailabilityChecked(
  route: AvailableRoute,
): asserts route is AvailableRoute {
  if (!route || typeof route !== 'object' || !RESOLVED_ROUTES.has(route)) {
    throw new RouteRefusalError(
      'availability_not_checked',
      (route as RouteMatch | undefined)?.route,
      'route was not obtained from resolveRoute(); availability was never checked',
    );
  }
}

export interface T3OwnerMeta {
  phaseId: string;
  seat: PremiumOwner['seat'];
  acquiredAt: string;
  expiresAt: string;
}

/**
 * Composes the pure T3 classification with the M1 durable record: resolves
 * the route (refusing on a missing/invalid trigger or a disabled route),
 * then calls the existing `acquirePremiumOwner`, which is what actually
 * enforces the one-escalation-per-task ceiling (`task_escalation_exhausted`)
 * and the goal-level premium ceiling. This function adds no new ceiling
 * logic — it only wires the classifier's accepted trigger onto the M1
 * record it already persists.
 */
export async function acquireT3RouteOwner(
  goalId: string,
  task: RouteTaskInput,
  ownerMeta: T3OwnerMeta,
  now: string,
  availability: RouteAvailability = DEFAULT_ROUTE_AVAILABILITY,
  options?: GoalRouterStateOptions,
): Promise<{ match: RouteMatch; record: DurableGoalRouterRecord }> {
  const match = resolveRoute(task, availability);
  if (match.route !== 'T3') {
    throw new RouteRefusalError(
      'unclassifiable',
      match.route,
      `task ${task.taskId} did not classify to T3 (got ${match.route}); refusing premium acquisition`,
    );
  }

  const owner: PremiumOwner = {
    phaseId: ownerMeta.phaseId,
    taskId: task.taskId,
    seat: ownerMeta.seat,
    acquiredAt: ownerMeta.acquiredAt,
    expiresAt: ownerMeta.expiresAt,
    trigger: match.trigger,
  };

  const record = await acquirePremiumOwner(goalId, owner, now, options);
  return { match, record };
}

/**
 * M2B: error bucketing and availability-enforced routing.
 *
 * `classifyFailure` is a single PURE function: given the caller's objective
 * description of one failed attempt, it returns exactly one bucket, and the
 * bucket alone decides what `runRoutedAttempt` below is allowed to do next.
 * Nothing else — not the error message, not a heuristic guess — influences
 * the retry behaviour.
 */
export type ErrorBucket = 'denial' | 'transport' | 'async-expired' | 'unknown';

/**
 * Objective, caller-declared description of one failed provider attempt.
 * Like `RouteTaskInput`, these flags are stated by the caller (the provider
 * adapter or async-resume poller), never inferred from free text, so
 * `classifyFailure` stays a closed-set lookup rather than a heuristic.
 */
export interface FailureInput {
  /** Policy/permission/seat/capability/invariant refusal. */
  isDenial?: boolean;
  /** Network/timeout/5xx-style transport failure. */
  isTransportFailure?: boolean;
  /** This failure is an async job handle whose expiry has already passed. */
  isAsyncExpired?: boolean;
}

const ERROR_BUCKET_PREDICATES: ReadonlyArray<{
  bucket: ErrorBucket;
  test: (failure: FailureInput) => boolean;
}> = Object.freeze([
  { bucket: 'denial', test: (f) => f.isDenial === true },
  { bucket: 'async-expired', test: (f) => f.isAsyncExpired === true },
  { bucket: 'transport', test: (f) => f.isTransportFailure === true },
]);

/**
 * Pure error-bucket classifier. First matching predicate wins. A failure
 * that matches none of the closed-set predicates buckets as `unknown` —
 * deliberately fail-closed: `runRoutedAttempt` treats `unknown` exactly
 * like `denial` (zero retries), never leniently like `transport`.
 */
export function classifyFailure(failure: FailureInput): ErrorBucket {
  for (const { bucket, test } of ERROR_BUCKET_PREDICATES) {
    if (test(failure)) return bucket;
  }
  return 'unknown';
}

/**
 * Explicit provider cost tier. Making this a closed set (rather than a
 * convention like "never pick the expensive one") is what lets
 * `selectFailoverProvider` make "never fail over to premium" a checkable
 * invariant instead of a comment.
 */
export type ProviderTier = 'free' | 'cheap' | 'premium';

export interface ProviderCandidate {
  readonly providerId: string;
  readonly tier: ProviderTier;
}

/**
 * Picks the first candidate that is not `premium`. Never returns a premium
 * candidate, even if every candidate given is premium — callers must treat
 * an `undefined` result as "no eligible failover", not "try harder".
 */
export function selectFailoverProvider(
  candidates: readonly ProviderCandidate[],
): ProviderCandidate | undefined {
  return candidates.find((candidate) => candidate.tier !== 'premium');
}

export type ProviderAttemptResult = { ok: true } | { ok: false; failure: FailureInput };

export interface RunRoutedAttemptParams {
  /** Must come from `resolveRoute` — see `assertRouteAvailabilityChecked`. */
  route: AvailableRoute;
  goalId: string;
  taskId: string;
  now: string;
  currentProvider: ProviderCandidate;
  /** Ordered failover candidates; premium entries are always skipped. */
  failoverCandidates?: readonly ProviderCandidate[];
  /** Caller-declared: this is an async job handle already past its expiry. */
  isAsyncExpired?: boolean;
  /** Injected provider call. Never invoked by this module for real I/O. */
  attempt: (provider: ProviderCandidate) => ProviderAttemptResult;
  options?: GoalRouterStateOptions;
  /**
   * M2B defence-in-depth #2: re-checked against this table before the first
   * provider call, even for a genuinely branded `route`. A carried
   * `AvailableRoute` token alone is not trusted forever — availability can
   * change between `resolveRoute` and this call, so this call re-validates
   * live rather than replaying a stale grant. Defaults to the same table
   * `resolveRoute` defaults to.
   */
  availability?: RouteAvailability;
}

export interface RoutedAttemptResult {
  status: 'succeeded' | 'failed';
  /** Absent only on success. */
  bucket?: ErrorBucket;
  providerCalls: number;
  callsByProvider: Record<string, number>;
  finalProviderId?: string;
}

/**
 * The only supported way to spend a provider attempt against a resolved
 * route. Requires an `AvailableRoute` (unreachable except via
 * `resolveRoute`), classifies any failure into exactly one bucket via
 * `classifyFailure`, and applies the bucket's retry rule against the M1
 * durable retry ledger (`recordRetryEvent`) rather than a second,
 * parallel counter:
 *
 *  - `denial` / `unknown`  -> one attempt, zero retries, ledger `denial`.
 *  - `async-expired`       -> zero provider calls, no ledger write.
 *  - `transport`           -> one same-provider retry (ledger
 *                             `transport_retry`), then at most one failover
 *                             to a non-premium candidate (ledger
 *                             `provider_failover`). No premium failover, no
 *                             third attempt on any provider.
 */
export async function runRoutedAttempt(
  params: RunRoutedAttemptParams,
): Promise<RoutedAttemptResult> {
  assertRouteAvailabilityChecked(params.route);
  // Defence-in-depth #2: re-check live availability even for a genuinely
  // branded route, so a token minted before an availability change cannot
  // be replayed to spend a provider call after the route was disabled.
  checkRouteAvailability(params.route.route, params.availability ?? DEFAULT_ROUTE_AVAILABILITY);

  const callsByProvider: Record<string, number> = {};
  const call = (provider: ProviderCandidate): ProviderAttemptResult => {
    callsByProvider[provider.providerId] = (callsByProvider[provider.providerId] ?? 0) + 1;
    return params.attempt(provider);
  };
  const totalCalls = () =>
    Object.values(callsByProvider).reduce((sum, count) => sum + count, 0);

  if (params.isAsyncExpired) {
    const bucket = classifyFailure({ isAsyncExpired: true });
    return { status: 'failed', bucket, providerCalls: 0, callsByProvider: {} };
  }

  const first = call(params.currentProvider);
  if (first.ok) {
    return {
      status: 'succeeded',
      providerCalls: totalCalls(),
      callsByProvider,
      finalProviderId: params.currentProvider.providerId,
    };
  }

  const bucket = classifyFailure(first.failure);
  if (bucket !== 'transport') {
    await recordRetryEvent(params.goalId, params.taskId, 'denial', params.now, params.options);
    return { status: 'failed', bucket, providerCalls: totalCalls(), callsByProvider };
  }

  await recordRetryEvent(
    params.goalId,
    params.taskId,
    'transport_retry',
    params.now,
    params.options,
  );
  const retry = call(params.currentProvider);
  if (retry.ok) {
    return {
      status: 'succeeded',
      providerCalls: totalCalls(),
      callsByProvider,
      finalProviderId: params.currentProvider.providerId,
    };
  }

  const candidate = selectFailoverProvider(params.failoverCandidates ?? []);
  if (!candidate) {
    return { status: 'failed', bucket: 'transport', providerCalls: totalCalls(), callsByProvider };
  }

  await recordRetryEvent(
    params.goalId,
    params.taskId,
    'provider_failover',
    params.now,
    params.options,
  );
  const failover = call(candidate);
  return {
    status: failover.ok ? 'succeeded' : 'failed',
    bucket: failover.ok ? undefined : 'transport',
    providerCalls: totalCalls(),
    callsByProvider,
    finalProviderId: candidate.providerId,
  };
}
