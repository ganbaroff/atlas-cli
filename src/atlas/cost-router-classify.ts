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
  | 'route_disabled';

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
 * Classify, then gate on availability. Still pure/offline: no model call,
 * no provider call, no durable-state read or write.
 */
export function resolveRoute(
  task: RouteTaskInput,
  availability: RouteAvailability = DEFAULT_ROUTE_AVAILABILITY,
): RouteMatch {
  const match = classifyRoute(task);
  checkRouteAvailability(match.route, availability);
  return match;
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
