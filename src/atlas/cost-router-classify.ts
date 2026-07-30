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

import { createHmac, randomUUID } from 'node:crypto';
import { join } from 'node:path';

import {
  acquirePremiumOwner,
  assertCostRouterReceipt,
  NOT_APPLICABLE,
  recordClearanceException,
  recordRetryEvent,
  T3_TRIGGERS,
  type CostRouterReceipt,
  type DurableGoalRouterRecord,
  type GoalRouterStateOptions,
  type PremiumOwner,
  type ProviderClass,
  type RetentionTerm,
  type T3Trigger,
} from './cost-router-state.js';
import { createNonceLedger, type NonceLedger } from './queue-auth.js';
import { resolveStateDir } from './state-root.js';
import { resolveTrustedTables } from './cost-router-test-seam.js';

export type RouteTier = 'T0' | 'T1' | 'T2' | 'T3';

export { T3_TRIGGERS };
export type { T3Trigger, ProviderClass, RetentionTerm };

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
    /**
     * M2D repair: a refusal is exactly the outcome that most needs a
     * receipt, so every `RouteRefusalError` carries one from construction —
     * never optional, never attached after the fact.
     */
    readonly receipt: CostRouterReceipt,
  ) {
    super(message);
    assertCostRouterReceipt(receipt);
    this.name = 'RouteRefusalError';
  }
}

/**
 * M2D repair: elapsed time for a refusal built outside `executeRoutedAttempt`
 * (where `startedAt` is already in scope). Genuinely measured from function
 * entry to throw, never fabricated — usually near-zero since these are pure
 * checks, but it is a real `Date.now()` delta, not a hardcoded value.
 */
function elapsedSince(startedAt: number): number {
  return Math.max(0, Date.now() - startedAt);
}

/**
 * M2D repair: the single receipt builder for every refusal this module
 * throws. Reuses `assertCostRouterReceipt` — the exact same validator the
 * success path in `executeRoutedAttempt` uses — so a refusal receipt can
 * never be a second, laxer shape. Fields the caller does not pass default to
 * `NOT_APPLICABLE` (or the zero-retries object, which is always accurate for
 * a refusal: no attempt was made, so no retry could have happened).
 */
function buildRefusalReceipt(args: {
  provider?: CostRouterReceipt['provider'];
  sources?: CostRouterReceipt['sources'];
  privacyDecision?: CostRouterReceipt['privacyDecision'];
  costClass?: CostRouterReceipt['costClass'];
  elapsedMs: number;
  blocker: string;
  nextAction: string;
}): CostRouterReceipt {
  const receipt: CostRouterReceipt = {
    provider: args.provider ?? NOT_APPLICABLE,
    elapsedMs: args.elapsedMs,
    sources: args.sources ?? NOT_APPLICABLE,
    retries: { transportRetries: 0, providerFailovers: 0 },
    privacyDecision: args.privacyDecision ?? NOT_APPLICABLE,
    costClass: args.costClass ?? NOT_APPLICABLE,
    verifierStatus: NOT_APPLICABLE,
    blocker: args.blocker,
    nextAction: args.nextAction,
  };
  assertCostRouterReceipt(receipt);
  return receipt;
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
  const startedAt = Date.now();
  for (const predicate of ROUTE_PREDICATES) {
    if (!predicate.test(task)) continue;

    if (predicate.route === 'T3') {
      if (!task.trigger || !T3_TRIGGER_SET.has(task.trigger)) {
        const message = `task ${task.taskId} routed T3 without one of the mandatory triggers: ${T3_TRIGGERS.join(', ')}`;
        throw new RouteRefusalError(
          't3_trigger_missing',
          'T3',
          message,
          buildRefusalReceipt({
            elapsedMs: elapsedSince(startedAt),
            blocker: `t3_trigger_missing: ${message}`,
            nextAction:
              'supply one of the mandatory T3 triggers on the task before retrying',
          }),
        );
      }
      return { route: 'T3', predicate: predicate.name, trigger: task.trigger };
    }

    return { route: predicate.route, predicate: predicate.name };
  }

  const message = `task ${task.taskId} matched no route predicate; refusing rather than defaulting`;
  throw new RouteRefusalError(
    'unclassifiable',
    undefined,
    message,
    buildRefusalReceipt({
      elapsedMs: elapsedSince(startedAt),
      blocker: `unclassifiable: ${message}`,
      nextAction:
        'set one objective capability flag (deterministicTool/needsWebResearch/needsLocalWorker/needsPremiumReasoning) that matches a route predicate before retrying',
    }),
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
  const startedAt = Date.now();
  if (!availability[route]) {
    const message = `route ${route} is disabled or its provider is unavailable; refusing rather than falling through to another route`;
    throw new RouteRefusalError(
      'route_disabled',
      route,
      message,
      buildRefusalReceipt({
        elapsedMs: elapsedSince(startedAt),
        blocker: `route_disabled: ${message}`,
        nextAction:
          'wait for the route to become available, or route this task to a different available tier',
      }),
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
    const startedAt = Date.now();
    const message = 'route was not obtained from resolveRoute(); availability was never checked';
    throw new RouteRefusalError(
      'availability_not_checked',
      (route as RouteMatch | undefined)?.route,
      message,
      buildRefusalReceipt({
        elapsedMs: elapsedSince(startedAt),
        blocker: `availability_not_checked: ${message}`,
        nextAction:
          'call resolveRoute() to obtain a genuinely availability-checked route before spending a provider attempt',
      }),
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
  const startedAt = Date.now();
  const match = resolveRoute(task, availability);
  if (match.route !== 'T3') {
    const message = `task ${task.taskId} did not classify to T3 (got ${match.route}); refusing premium acquisition`;
    throw new RouteRefusalError(
      'unclassifiable',
      match.route,
      message,
      buildRefusalReceipt({
        elapsedMs: elapsedSince(startedAt),
        blocker: `unclassifiable: ${message}`,
        nextAction:
          'route this task through the tier it actually classified to, or supply flags that classify it to T3 before requesting premium ownership',
      }),
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

/**
 * M2C: destination-bound clearance.
 *
 * Clearance is bound to the destination actually used, not to the message.
 * Every provider carries a declared `ProviderClass` (three objective
 * fields). A brief is cleared for a specific class; sending it to a
 * destination of a weaker class is refused, never silently downgraded —
 * whether that destination is the current provider or a failover target.
 */
const RETENTION_RANK: Record<RetentionTerm, number> = {
  none: 0,
  session: 1,
  bounded: 2,
  indefinite: 3,
};

/** Higher rank = weaker clearance class (more identity/retention/agency risk). */
function clearanceRank(providerClass: ProviderClass): number {
  return (
    RETENTION_RANK[providerClass.retentionTerm] +
    (providerClass.identityBearing ? 4 : 0) +
    (providerClass.canActBeyondBrief ? 8 : 0)
  );
}

/**
 * True when `candidate` is a weaker clearance class than `required`.
 * All-else-equal, a destination able to act beyond its brief is always
 * weaker than one that cannot: `canActBeyondBrief` carries the largest
 * weight, so it alone can never be outweighed by the other two fields.
 */
export function isWeakerClass(candidate: ProviderClass, required: ProviderClass): boolean {
  return clearanceRank(candidate) > clearanceRank(required);
}

export type ClearanceRefusalReason =
  | 'destination_class_unknown'
  | 'destination_class_too_weak'
  /** M2C repair: exception carried no sig/ts/nonce. */
  | 'exception_unsigned'
  /** M2C repair: signature did not match the canonical fields. */
  | 'exception_signature_mismatch'
  /** M2C repair: signature is older than the accepted window. */
  | 'exception_signature_expired'
  /** M2C repair: this exception's nonce was already spent. */
  | 'exception_signature_replayed'
  /** M2C repair: no operator key configured — fail closed, never permit. */
  | 'exception_signing_key_not_configured';

export class ClearanceRefusalError extends Error {
  constructor(
    readonly reason: ClearanceRefusalReason,
    readonly requiredClass: ProviderClass,
    readonly actualClass: ProviderClass | undefined,
    message: string,
    /** M2D repair: same guarantee as `RouteRefusalError.receipt` — never optional. */
    readonly receipt: CostRouterReceipt,
  ) {
    super(message);
    assertCostRouterReceipt(receipt);
    this.name = 'ClearanceRefusalError';
  }
}

/** M2D repair: concrete next step per signature-verification refusal reason. */
function clearanceVerificationNextAction(reason: ClearanceRefusalReason): string {
  switch (reason) {
    case 'exception_unsigned':
      return 'sign the clearance exception with the operator-held key before retrying';
    case 'exception_signature_mismatch':
      return 're-sign the clearance exception; the signature did not match its canonical fields';
    case 'exception_signature_expired':
      return 'issue a fresh clearance exception; the previous signature is older than the accepted window';
    case 'exception_signature_replayed':
      return 'issue a fresh clearance exception; this nonce was already spent';
    case 'exception_signing_key_not_configured':
      return 'configure ATLAS_CLEARANCE_SIGNING_KEY before permitting any cross-class clearance exception';
    default:
      return 'escalate for manual review of the clearance exception';
  }
}

/**
 * Explicit operator exception: when present, the brief may be sent to a
 * destination as weak as `permittedClass` instead of the class the brief
 * was originally cleared for. Recorded on the durable record (via
 * `recordClearanceException`) only when it actually lets a cross-class send
 * proceed.
 */
export interface ClearanceException {
  readonly reason: string;
  readonly approvedBy: string;
  readonly permittedClass: ProviderClass;
  /**
   * M2C repair: HMAC-SHA256 signature over this exception's own canonical
   * fields (see `signClearanceException`), verified with the operator-held
   * key before the exception is trusted. Absent `sig`/`ts`/`nonce` means
   * unsigned — refused, never treated as a real operator grant.
   */
  readonly sig?: string;
  readonly ts?: string;
  readonly nonce?: string;
}

/**
 * M2C repair: signed operator clearance exceptions.
 *
 * `ClearanceException` used to be plain data — any caller could write
 * `approvedBy: 'the-calling-code-itself'` and nothing distinguished a real
 * operator grant from one the code wrote for itself. This reuses the exact
 * mechanism `queue-auth.ts` already proved for work-order authenticity:
 * HMAC-SHA256 over a canonical JSON payload, keyed by an env var read by
 * NAME only (`ATLAS_CLEARANCE_SIGNING_KEY` — value is operator-set, never a
 * literal in code/tests/logs/reports), plus `queue-auth`'s own
 * `createNonceLedger` so a signed exception cannot be replayed. Same scheme,
 * not a second one.
 */
const CLEARANCE_SIGNING_KEY_ENV = 'ATLAS_CLEARANCE_SIGNING_KEY';
const CLEARANCE_SIGNATURE_MAX_AGE_MS = 24 * 60 * 60 * 1000;

/** Reads the operator-held clearance-signing key from the environment by name only. */
export function getClearanceSigningKey(): string | undefined {
  return process.env[CLEARANCE_SIGNING_KEY_ENV] || undefined;
}

function canonicalizeClearanceException(
  reason: string,
  approvedBy: string,
  permittedClass: ProviderClass,
  ts: string,
  nonce: string,
): string {
  return JSON.stringify({
    reason,
    approvedBy,
    permittedClass: {
      identityBearing: permittedClass.identityBearing,
      retentionTerm: permittedClass.retentionTerm,
      canActBeyondBrief: permittedClass.canActBeyondBrief,
    },
    ts,
    nonce,
  });
}

function computeClearanceHmac(
  reason: string,
  approvedBy: string,
  permittedClass: ProviderClass,
  ts: string,
  nonce: string,
  key: string,
): string {
  return createHmac('sha256', key)
    .update(canonicalizeClearanceException(reason, approvedBy, permittedClass, ts, nonce))
    .digest('hex');
}

/** Signs a clearance exception with the operator-held key. The signer must already hold the key — this does not grant one. */
export function signClearanceException(
  fields: { reason: string; approvedBy: string; permittedClass: ProviderClass },
  key: string,
): ClearanceException {
  const ts = new Date().toISOString();
  const nonce = randomUUID();
  const sig = computeClearanceHmac(
    fields.reason,
    fields.approvedBy,
    fields.permittedClass,
    ts,
    nonce,
    key,
  );
  return { ...fields, sig, ts, nonce };
}

function verifyClearanceExceptionSignature(
  exception: ClearanceException,
  key: string | undefined,
  ledger: NonceLedger,
): { ok: true } | { ok: false; reason: ClearanceRefusalReason } {
  if (!key) {
    // Fail closed: verification unavailable must never mean "permitted".
    return { ok: false, reason: 'exception_signing_key_not_configured' };
  }
  if (!exception.sig || !exception.ts || !exception.nonce) {
    return { ok: false, reason: 'exception_unsigned' };
  }
  const expected = computeClearanceHmac(
    exception.reason,
    exception.approvedBy,
    exception.permittedClass,
    exception.ts,
    exception.nonce,
    key,
  );
  if (expected !== exception.sig) {
    return { ok: false, reason: 'exception_signature_mismatch' };
  }
  const tsMs = Date.parse(exception.ts);
  if (!Number.isFinite(tsMs) || Date.now() - tsMs > CLEARANCE_SIGNATURE_MAX_AGE_MS) {
    return { ok: false, reason: 'exception_signature_expired' };
  }
  if (!ledger.recordIfFresh(exception.nonce)) {
    return { ok: false, reason: 'exception_signature_replayed' };
  }
  return { ok: true };
}

/**
 * Pure clearance gate. Refuses — never downgrades silently — when the
 * destination's declared class is weaker than the brief's cleared class,
 * unless an explicit operator exception names a permitted class the
 * destination still meets. A destination with no declared class is refused
 * rather than assumed safe.
 */
export function assertDestinationClearance(
  required: ProviderClass,
  destination: ProviderClass | undefined,
  exception?: ClearanceException,
): void {
  const startedAt = Date.now();
  if (!destination) {
    const message = 'destination declared no provider class; refusing rather than assuming clearance';
    throw new ClearanceRefusalError(
      'destination_class_unknown',
      required,
      undefined,
      message,
      buildRefusalReceipt({
        elapsedMs: elapsedSince(startedAt),
        blocker: `destination_class_unknown: ${message}`,
        nextAction:
          'declare the destination provider class in the provider-class table before routing to it',
      }),
    );
  }

  const effectiveRequired = exception ? exception.permittedClass : required;
  if (!isWeakerClass(destination, effectiveRequired)) return;

  const message = 'destination class is weaker than the brief was cleared for; refusing rather than sending silently';
  throw new ClearanceRefusalError(
    'destination_class_too_weak',
    required,
    destination,
    message,
    buildRefusalReceipt({
      elapsedMs: elapsedSince(startedAt),
      blocker: `destination_class_too_weak: ${message}`,
      nextAction:
        'obtain a signed operator clearance exception permitting this destination class, or route to a destination that meets the required class',
    }),
  );
}

/** Table of providerId -> declared ProviderClass, consulted internally when resolving a routed attempt. */
export type ProviderClassTable = Readonly<Record<string, ProviderClass>>;

/**
 * M2C module-owned trusted source for provider classes — the single table
 * `runTrustedRoutedAttempt` resolves internally. Extend as new providers are
 * onboarded (mirrors `DEFAULT_ROUTE_AVAILABILITY`'s role for routes). A
 * providerId absent from this table has no declared class and is refused
 * (`destination_class_unknown`) rather than assumed safe.
 */
export const DEFAULT_PROVIDER_CLASS_TABLE: ProviderClassTable = Object.freeze({
  'trusted-keyed-1': Object.freeze({
    identityBearing: false,
    retentionTerm: 'none',
    canActBeyondBrief: false,
  }),
  'trusted-identity-1': Object.freeze({
    identityBearing: true,
    retentionTerm: 'indefinite',
    canActBeyondBrief: true,
  }),
});

/**
 * M2D: `sources` is additive and optional so every pre-M2D caller
 * constructing `{ ok: true }` keeps type-checking unchanged. Only a
 * research-style fake provider (T1) populates it; `executeRoutedAttempt`
 * carries it straight onto the receipt's `sources` field when present, and
 * uses `NOT_APPLICABLE` when it is not.
 */
export type ProviderAttemptResult =
  | { ok: true; sources?: readonly string[] }
  | { ok: false; failure: FailureInput };

/**
 * M2C repair, third refutation: not exported. The only caller that
 * constructs one is `runTrustedRoutedAttempt` below, which always resolves
 * `availability`/`providerClasses` through `resolveTrustedTables()`
 * (`cost-router-test-seam.ts`) before calling in — both fields are
 * mandatory here because there is no longer a caller that would need them
 * optional. There is no reachable path from outside this module to this
 * type at all.
 */
interface RouteAttemptExecutionParams {
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
   * live rather than replaying a stale grant. Always the value
   * `runTrustedRoutedAttempt` resolved via `resolveTrustedTables()`.
   */
  availability: RouteAvailability;
  /** M2C: the provider class this brief is cleared for. */
  briefClearance?: ProviderClass;
  /**
   * M2C: table resolving providerId -> declared ProviderClass, consulted
   * only when `briefClearance` is set. Always the value
   * `runTrustedRoutedAttempt` resolved via `resolveTrustedTables()` — the
   * only way to make this anything other than
   * `DEFAULT_PROVIDER_CLASS_TABLE` is `withTrustedTables()` in
   * `cost-router-test-seam.ts`, reachable only by a caller that imports
   * that file directly, never by a caller that imports only this module.
   */
  providerClasses: ProviderClassTable;
  /** M2C: explicit operator exception permitting a specific weaker class for this send. */
  clearanceException?: ClearanceException;
}

export interface RoutedAttemptResult {
  status: 'succeeded' | 'failed';
  /** Absent only on success. */
  bucket?: ErrorBucket;
  providerCalls: number;
  callsByProvider: Record<string, number>;
  finalProviderId?: string;
  /**
   * M2C: the class of the destination actually used, read live from the
   * provider-class table at send time — never the class assumed when the
   * brief was composed. Present only when `briefClearance` was set.
   */
  finalProviderClass?: ProviderClass;
  /**
   * M2D: the complete, fully-populated receipt for this terminal outcome —
   * see `CostRouterReceipt` in `cost-router-state.ts`. Always present,
   * always passes `assertCostRouterReceipt` before this result is returned.
   */
  receipt: CostRouterReceipt;
}

/**
 * M2C repair, third refutation: the only implementation that spends a
 * provider attempt against a resolved route. Not exported — its sole
 * caller is `runTrustedRoutedAttempt` below, which always resolves
 * `availability`/`providerClasses` through `resolveTrustedTables()`
 * (`cost-router-test-seam.ts`) before calling in, so there is no parameter
 * on any exported function through which a caller could hand this
 * mandatory table pair a substitute. Requires an `AvailableRoute`
 * (unreachable except via `resolveRoute`), classifies any failure into
 * exactly one bucket via `classifyFailure`, and applies the bucket's retry
 * rule against the M1 durable retry ledger (`recordRetryEvent`) rather than
 * a second, parallel counter:
 *
 *  - `denial` / `unknown`  -> one attempt, zero retries, ledger `denial`.
 *  - `async-expired`       -> zero provider calls, no ledger write.
 *  - `transport`           -> one same-provider retry (ledger
 *                             `transport_retry`), then at most one failover
 *                             to a non-premium candidate (ledger
 *                             `provider_failover`). No premium failover, no
 *                             third attempt on any provider.
 */
async function executeRoutedAttempt(
  params: RouteAttemptExecutionParams,
): Promise<RoutedAttemptResult> {
  // M2D: measured across the whole attempt, including durable-state I/O —
  // start before the availability re-check so a receipt built later (if
  // any) reflects the true wall time of this call.
  const startedAt = Date.now();

  assertRouteAvailabilityChecked(params.route);
  // Defence-in-depth #2: re-check live availability even for a genuinely
  // branded route, so a token minted before an availability change cannot
  // be replayed to spend a provider call after the route was disabled.
  checkRouteAvailability(params.route.route, params.availability);

  const providerClasses = params.providerClasses;
  const classOf = (provider: ProviderCandidate): ProviderClass | undefined =>
    providerClasses[provider.providerId];

  // M2C repair: an operator exception is only ever trusted after it verifies
  // — a real signature from the operator-held key over its own canonical
  // fields, checked once per attempt (not per destination, so the same
  // signed exception covering both the primary provider and one failover
  // within a single attempt is not mistaken for a replay). Verification
  // failure (including "no key configured") refuses before any provider
  // call is made — never silently falls back to "no exception".
  let verifiedClearanceException: ClearanceException | undefined;
  if (params.briefClearance && params.clearanceException) {
    const ledgerDir = join(
      params.options?.rootDir ?? resolveStateDir('cost-router'),
      'clearance-nonces',
    );
    const verification = verifyClearanceExceptionSignature(
      params.clearanceException,
      getClearanceSigningKey(),
      createNonceLedger(ledgerDir),
    );
    if (!verification.ok) {
      const message = `clearance exception for task ${params.taskId} failed signature verification: ${verification.reason}`;
      throw new ClearanceRefusalError(
        verification.reason,
        params.briefClearance,
        undefined,
        message,
        buildRefusalReceipt({
          elapsedMs: elapsedSince(startedAt),
          blocker: `${verification.reason}: ${message}`,
          nextAction: clearanceVerificationNextAction(verification.reason),
        }),
      );
    }
    verifiedClearanceException = params.clearanceException;
  }

  // M2C: refuses (throws) before any attempt is made against `provider` when
  // its declared class is weaker than the brief's cleared class. Records the
  // operator exception on the durable record the first time it is what
  // actually let a cross-class send proceed — never for an unused exception.
  let clearanceExceptionRecorded = false;
  const guardClearance = async (provider: ProviderCandidate): Promise<void> => {
    if (!params.briefClearance) return;
    const destinationClass = classOf(provider);
    assertDestinationClearance(params.briefClearance, destinationClass, verifiedClearanceException);
    if (
      !clearanceExceptionRecorded &&
      verifiedClearanceException &&
      destinationClass &&
      isWeakerClass(destinationClass, params.briefClearance)
    ) {
      clearanceExceptionRecorded = true;
      await recordClearanceException(
        params.goalId,
        params.taskId,
        verifiedClearanceException,
        params.now,
        params.options,
      );
    }
  };

  const callsByProvider: Record<string, number> = {};
  const call = (provider: ProviderCandidate): ProviderAttemptResult => {
    callsByProvider[provider.providerId] = (callsByProvider[provider.providerId] ?? 0) + 1;
    return params.attempt(provider);
  };
  const totalCalls = () =>
    Object.values(callsByProvider).reduce((sum, count) => sum + count, 0);
  const withFinalClass = (
    result: RoutedAttemptResult,
    provider: ProviderCandidate,
  ): RoutedAttemptResult =>
    params.briefClearance ? { ...result, finalProviderClass: classOf(provider) } : result;

  // M2D: how the M2C clearance gate resolved for `provider`, the destination
  // actually used for this terminal outcome. Only ever called after
  // `guardClearance(provider)` has already returned without throwing, so
  // "weaker but exception-covered" and "at or above the required class" are
  // the only two live cases here — a genuine refusal never reaches a receipt.
  const privacyDecisionFor = (provider: ProviderCandidate): string => {
    if (!params.briefClearance) return NOT_APPLICABLE;
    const destinationClass = classOf(provider);
    if (
      destinationClass &&
      verifiedClearanceException &&
      isWeakerClass(destinationClass, params.briefClearance)
    ) {
      return `exception_applied:${verifiedClearanceException.approvedBy}`;
    }
    return 'cleared';
  };

  // M2D: assembles and validates the complete nine-field receipt for one
  // terminal outcome. `finalProvider` absent means zero provider calls were
  // made (the async-expired short-circuit) — every provider-derived field
  // then carries the explicit NOT_APPLICABLE marker instead of being guessed
  // at or omitted.
  const buildReceipt = (args: {
    finalProvider?: ProviderCandidate;
    transportRetries: 0 | 1;
    providerFailovers: 0 | 1;
    sources: CostRouterReceipt['sources'];
    blocker: CostRouterReceipt['blocker'];
    nextAction: string;
  }): CostRouterReceipt => {
    const receipt: CostRouterReceipt = {
      provider: args.finalProvider ? args.finalProvider.providerId : NOT_APPLICABLE,
      elapsedMs: Date.now() - startedAt,
      sources: args.sources,
      retries: {
        transportRetries: args.transportRetries,
        providerFailovers: args.providerFailovers,
      },
      privacyDecision: args.finalProvider ? privacyDecisionFor(args.finalProvider) : NOT_APPLICABLE,
      costClass: args.finalProvider ? args.finalProvider.tier : NOT_APPLICABLE,
      // M2D wires fake providers only; the deterministic-verifier stage is a
      // separate module not yet integrated into this call.
      verifierStatus: NOT_APPLICABLE,
      blocker: args.blocker,
      nextAction: args.nextAction,
    };
    assertCostRouterReceipt(receipt);
    return receipt;
  };

  if (params.isAsyncExpired) {
    const bucket = classifyFailure({ isAsyncExpired: true });
    return {
      status: 'failed',
      bucket,
      providerCalls: 0,
      callsByProvider: {},
      receipt: buildReceipt({
        transportRetries: 0,
        providerFailovers: 0,
        sources: NOT_APPLICABLE,
        blocker: 'async research handle already expired',
        nextAction: 'resubmit the async research job as a new handle',
      }),
    };
  }

  await guardClearance(params.currentProvider);

  const first = call(params.currentProvider);
  if (first.ok) {
    return withFinalClass(
      {
        status: 'succeeded',
        providerCalls: totalCalls(),
        callsByProvider,
        finalProviderId: params.currentProvider.providerId,
        receipt: buildReceipt({
          finalProvider: params.currentProvider,
          transportRetries: 0,
          providerFailovers: 0,
          sources: first.sources ?? NOT_APPLICABLE,
          blocker: NOT_APPLICABLE,
          nextAction: 'deliver result to caller',
        }),
      },
      params.currentProvider,
    );
  }

  const bucket = classifyFailure(first.failure);
  if (bucket !== 'transport') {
    await recordRetryEvent(params.goalId, params.taskId, 'denial', params.now, params.options);
    return {
      status: 'failed',
      bucket,
      providerCalls: totalCalls(),
      callsByProvider,
      receipt: buildReceipt({
        finalProvider: params.currentProvider,
        transportRetries: 0,
        providerFailovers: 0,
        sources: NOT_APPLICABLE,
        blocker:
          bucket === 'denial'
            ? 'provider denial'
            : 'unclassified failure treated as denial (fail-closed)',
        nextAction: 'escalate for manual review; no automatic retry permitted for this bucket',
      }),
    };
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
    return withFinalClass(
      {
        status: 'succeeded',
        providerCalls: totalCalls(),
        callsByProvider,
        finalProviderId: params.currentProvider.providerId,
        receipt: buildReceipt({
          finalProvider: params.currentProvider,
          transportRetries: 1,
          providerFailovers: 0,
          sources: retry.sources ?? NOT_APPLICABLE,
          blocker: NOT_APPLICABLE,
          nextAction: 'deliver result to caller',
        }),
      },
      params.currentProvider,
    );
  }

  const candidate = selectFailoverProvider(params.failoverCandidates ?? []);
  if (!candidate) {
    return {
      status: 'failed',
      bucket: 'transport',
      providerCalls: totalCalls(),
      callsByProvider,
      receipt: buildReceipt({
        finalProvider: params.currentProvider,
        transportRetries: 1,
        providerFailovers: 0,
        sources: NOT_APPLICABLE,
        blocker:
          'transport failure persisted after retry; no eligible non-premium failover candidate',
        nextAction: 'escalate for manual review or provider-health remediation',
      }),
    };
  }

  // M2C: the failover path must apply the same clearance check — a cheaper
  // failover target of a weaker class is refused before it is ever called,
  // rather than taken silently.
  await guardClearance(candidate);

  await recordRetryEvent(
    params.goalId,
    params.taskId,
    'provider_failover',
    params.now,
    params.options,
  );
  const failover = call(candidate);
  return withFinalClass(
    {
      status: failover.ok ? 'succeeded' : 'failed',
      bucket: failover.ok ? undefined : 'transport',
      providerCalls: totalCalls(),
      callsByProvider,
      finalProviderId: candidate.providerId,
      receipt: buildReceipt({
        finalProvider: candidate,
        transportRetries: 1,
        providerFailovers: 1,
        sources: failover.ok ? failover.sources ?? NOT_APPLICABLE : NOT_APPLICABLE,
        blocker: failover.ok
          ? NOT_APPLICABLE
          : 'transport failure persisted after retry and failover; failover exhausted',
        nextAction: failover.ok
          ? 'deliver result to caller'
          : 'escalate for manual review; failover exhausted',
      }),
    },
    candidate,
  );
}

/**
 * M2C: the only supported entry point for running routed work from outside
 * this module — and, after the third M2C repair, the only exported
 * function in this module that can spend a provider attempt at all. This
 * parameter type carries no `availability` and no `providerClasses` field —
 * there is no reachable way to hand it a substitute table.
 *
 * This is the same technique `resolveRoute`/`RESOLVED_ROUTES` uses to make a
 * forged `AvailableRoute` unreachable: the unsafe path (an injectable table)
 * simply does not exist on this call's type, rather than being a documented
 * rule callers are trusted to follow. Two earlier attempts at this same fix
 * kept an injectable-table entry point exported anyway — first behind a
 * comment, then behind a `process.env.VITEST === 'true'` runtime check —
 * and both were refuted: a comment enforces nothing, and an environment
 * variable is caller-controlled data a plain script can set on itself, not
 * an authenticated signal. This repair removes that entry point from the
 * module's exports entirely (see `executeRoutedAttempt` above, which is not
 * exported). The tables this function resolves come from
 * `resolveTrustedTables()` in `cost-router-test-seam.ts` — the only
 * function that can make that resolution return anything other than this
 * module's own `DEFAULT_ROUTE_AVAILABILITY` / `DEFAULT_PROVIDER_CLASS_TABLE`
 * is `withTrustedTables()`, exported only from that seam file, which this
 * module does not import or re-export. A caller that imports only
 * `cost-router-classify.ts` — the entire public surface — has no path to an
 * injectable table: not a parameter, not an environment variable, not a
 * cast.
 */
export interface TrustedRoutedAttemptParams {
  route: AvailableRoute;
  goalId: string;
  taskId: string;
  now: string;
  currentProvider: ProviderCandidate;
  failoverCandidates?: readonly ProviderCandidate[];
  isAsyncExpired?: boolean;
  attempt: (provider: ProviderCandidate) => ProviderAttemptResult;
  options?: GoalRouterStateOptions;
  /** Mandatory here — unlike the pure function, there is no pre-M2C caller to stay compatible with. */
  briefClearance: ProviderClass;
  clearanceException?: ClearanceException;
}

export async function runTrustedRoutedAttempt(
  params: TrustedRoutedAttemptParams,
): Promise<RoutedAttemptResult> {
  const { availability, providerClasses } = resolveTrustedTables({
    availability: DEFAULT_ROUTE_AVAILABILITY,
    providerClasses: DEFAULT_PROVIDER_CLASS_TABLE,
  });
  return executeRoutedAttempt({
    route: params.route,
    goalId: params.goalId,
    taskId: params.taskId,
    now: params.now,
    currentProvider: params.currentProvider,
    failoverCandidates: params.failoverCandidates,
    isAsyncExpired: params.isAsyncExpired,
    attempt: params.attempt,
    options: params.options,
    briefClearance: params.briefClearance,
    clearanceException: params.clearanceException,
    availability,
    providerClasses,
  });
}
