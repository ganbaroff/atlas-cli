/**
 * Durable, fail-closed state for the Atlas Cost Router.
 *
 * This module owns local persistence only. It never invokes a model, provider,
 * browser, scheduler, or network route.
 */

import { randomUUID } from 'node:crypto';
import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, isAbsolute, join } from 'node:path';
import { z } from 'zod';

import { resolveStateDir } from './state-root.js';

const GOAL_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const TASK_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const DEFAULT_LOCK_WAIT_MS = 10_000;
const STALE_LOCK_MS = 30_000;

/**
 * Closed set of objective triggers that may justify a T3 premium-reasoning
 * escalation (M2A). Owned here because it is part of the durable premium
 * owner record; the model-free route classifier imports it from this module
 * rather than redefining it.
 */
export const T3_TRIGGERS = [
  'architecture',
  'conflict-resolution',
  'critical-implementation',
  'independent-verification',
] as const;
export type T3Trigger = (typeof T3_TRIGGERS)[number];

/**
 * M2C: closed set of retention terms a destination may declare. Owned here
 * (durable schema) for the same reason T3_TRIGGERS is: the model-free
 * clearance gate in cost-router-classify.ts imports it rather than
 * redefining it.
 */
export const RETENTION_TERMS = ['none', 'session', 'bounded', 'indefinite'] as const;
export type RetentionTerm = (typeof RETENTION_TERMS)[number];

/**
 * M2C: declared class of a destination — three explicit, objective fields,
 * never inferred from message content:
 *  - identityBearing: true for a signed-in subscription/browser session,
 *    false for a keyed service call.
 *  - retentionTerm: how long the destination is declared to retain what it
 *    is sent.
 *  - canActBeyondBrief: true if the destination can act beyond the brief it
 *    was handed (e.g. an agentic session with its own tool access).
 */
export const providerClassSchema = z.object({
  identityBearing: z.boolean(),
  retentionTerm: z.enum(RETENTION_TERMS),
  canActBeyondBrief: z.boolean(),
}).strict();
export type ProviderClass = z.infer<typeof providerClassSchema>;

const timestampSchema = z.string().datetime();
const nonNegativeIntegerSchema = z.number().int().nonnegative();
const boundedAttemptSchema = z.number().int().min(0).max(1);

export const premiumOwnerSchema = z.object({
  phaseId: z.string().min(1),
  taskId: z.string().min(1),
  seat: z.enum(['fable', 'opus', 'codex-sol']),
  acquiredAt: timestampSchema,
  expiresAt: timestampSchema,
  /** Objective T3 trigger accepted for this escalation (M2A). Optional so
   *  pre-M2A callers/fixtures that never claimed a trigger keep validating. */
  trigger: z.enum(T3_TRIGGERS).optional(),
}).strict();

export const asyncResearchHandleSchema = z.object({
  handleId: z.string().min(1),
  goalId: z.string().regex(GOAL_ID_PATTERN),
  taskId: z.string().min(1),
  phaseId: z.string().min(1),
  providerId: z.string().min(1),
  providerProfileHash: z.string().min(1),
  remoteJobId: z.string().min(1).optional(),
  remoteUrl: z.string().url().optional(),
  submittedAt: timestampSchema,
  expiresAt: timestampSchema,
  nextResumeAt: timestampSchema,
  resumeClaimedAt: timestampSchema.optional(),
  inspectionCount: nonNegativeIntegerSchema,
  maxInspections: nonNegativeIntegerSchema,
  outputRef: z.string().min(1),
  state: z.enum(['submitted', 'scheduled', 'completed', 'failed', 'expired']),
}).strict();

const goalRouterBudgetSchema = z.object({
  maxLocalSlices: nonNegativeIntegerSchema,
  usedLocalSlices: nonNegativeIntegerSchema,
  maxResearchJobs: nonNegativeIntegerSchema,
  usedResearchJobs: nonNegativeIntegerSchema,
  maxPremiumEscalations: nonNegativeIntegerSchema,
  usedPremiumEscalations: nonNegativeIntegerSchema,
  meteredSpendLimitUsd: z.literal(0),
}).strict();

const retryLedgerEntrySchema = z.object({
  denialAttempts: boundedAttemptSchema,
  transportRetries: boundedAttemptSchema,
  providerFailovers: boundedAttemptSchema,
}).strict();

/**
 * M2C: durable record of one operator exception that let a brief be sent to
 * a destination weaker than the class it was cleared for. `permittedClass`
 * is the floor the operator explicitly authorized for this task, not the
 * brief's original clearance.
 */
const clearanceExceptionRecordSchema = z.object({
  reason: z.string().min(1),
  approvedBy: z.string().min(1),
  permittedClass: providerClassSchema,
  recordedAt: timestampSchema,
}).strict();
export type ClearanceExceptionRecord = z.infer<typeof clearanceExceptionRecordSchema>;

export const durableGoalRouterRecordSchema = z.object({
  schemaVersion: z.literal(1),
  goalId: z.string().regex(GOAL_ID_PATTERN),
  revision: nonNegativeIntegerSchema,
  activePremiumOwner: premiumOwnerSchema.optional(),
  escalationLedger: z.record(
    z.string().min(1),
    z.union([z.literal(0), z.literal(1)])
  ),
  budget: goalRouterBudgetSchema,
  retryLedger: z.record(z.string().min(1), retryLedgerEntrySchema),
  openAsyncHandles: z.array(asyncResearchHandleSchema),
  /** M2C: per-task operator clearance exceptions. Optional (no `.default`)
   *  so records persisted before M2C keep validating and keep round-tripping
   *  through cold reads with no key added — see cost-router-state.test.ts
   *  full-record assertions, which must not regress. */
  clearanceLedger: z.record(z.string().min(1), clearanceExceptionRecordSchema).optional(),
  updatedAt: timestampSchema,
}).strict().superRefine((record, ctx) => {
  const pairs: Array<[number, number, string]> = [
    [record.budget.usedLocalSlices, record.budget.maxLocalSlices, 'usedLocalSlices'],
    [record.budget.usedResearchJobs, record.budget.maxResearchJobs, 'usedResearchJobs'],
    [
      record.budget.usedPremiumEscalations,
      record.budget.maxPremiumEscalations,
      'usedPremiumEscalations',
    ],
  ];

  for (const [used, maximum, path] of pairs) {
    if (used > maximum) {
      ctx.addIssue({
        code: 'custom',
        path: ['budget', path],
        message: `${path} exceeds its configured ceiling`,
      });
    }
  }

  const consumedEscalations = Object.values(record.escalationLedger)
    .filter((value) => value === 1).length;
  if (record.budget.usedPremiumEscalations !== consumedEscalations) {
    ctx.addIssue({
      code: 'custom',
      path: ['budget', 'usedPremiumEscalations'],
      message: 'premium escalation count does not match its ledger',
    });
  }

  if (record.activePremiumOwner) {
    if (record.escalationLedger[record.activePremiumOwner.taskId] !== 1) {
      ctx.addIssue({
        code: 'custom',
        path: ['activePremiumOwner', 'taskId'],
        message: 'active premium owner has no consumed task escalation',
      });
    }
    if (
      Date.parse(record.activePremiumOwner.expiresAt) <=
      Date.parse(record.activePremiumOwner.acquiredAt)
    ) {
      ctx.addIssue({
        code: 'custom',
        path: ['activePremiumOwner', 'expiresAt'],
        message: 'premium owner expiry must follow acquisition',
      });
    }
  }

  if (record.budget.usedResearchJobs < record.openAsyncHandles.length) {
    ctx.addIssue({
      code: 'custom',
      path: ['budget', 'usedResearchJobs'],
      message: 'research count is below the number of persisted handles',
    });
  }

  const handleIds = new Set<string>();
  record.openAsyncHandles.forEach((handle, index) => {
    if (handle.goalId !== record.goalId) {
      ctx.addIssue({
        code: 'custom',
        path: ['openAsyncHandles', index, 'goalId'],
        message: 'asynchronous handle belongs to another goal',
      });
    }
    if (handleIds.has(handle.handleId)) {
      ctx.addIssue({
        code: 'custom',
        path: ['openAsyncHandles', index, 'handleId'],
        message: 'asynchronous handle id is duplicated',
      });
    }
    handleIds.add(handle.handleId);

    if (
      Date.parse(handle.nextResumeAt) < Date.parse(handle.submittedAt) ||
      Date.parse(handle.nextResumeAt) > Date.parse(handle.expiresAt) ||
      Date.parse(handle.expiresAt) <= Date.parse(handle.submittedAt) ||
      (
        handle.resumeClaimedAt !== undefined &&
        (
          Date.parse(handle.resumeClaimedAt) < Date.parse(handle.nextResumeAt) ||
          Date.parse(handle.resumeClaimedAt) > Date.parse(handle.expiresAt) ||
          handle.inspectionCount < 1
        )
      ) ||
      handle.inspectionCount > handle.maxInspections ||
      handle.maxInspections < 1
    ) {
      ctx.addIssue({
        code: 'custom',
        path: ['openAsyncHandles', index],
        message: 'asynchronous handle lifecycle is inconsistent',
      });
    }
  });
});

export type PremiumOwner = z.infer<typeof premiumOwnerSchema>;
export type AsyncResearchHandle = z.infer<typeof asyncResearchHandleSchema>;
export type DurableGoalRouterRecord = z.infer<typeof durableGoalRouterRecordSchema>;

/**
 * M2D: single shared marker for "this field of the receipt is genuinely not
 * applicable to this terminal outcome" — used instead of omitting the field,
 * so every receipt always carries all nine required keys and a reader never
 * has to guess whether an absent key means "not applicable" or "forgot to
 * populate it".
 */
export const NOT_APPLICABLE = 'not-applicable' as const;
export type NotApplicable = typeof NOT_APPLICABLE;
export type MaybeNotApplicable<T> = T | NotApplicable;

const notApplicableSchema = z.literal(NOT_APPLICABLE);
const maybeNotApplicableStringSchema = z.union([z.string().min(1), notApplicableSchema]);

/**
 * M2D: the complete-receipt shape the approved Cost Router design requires
 * on every terminal outcome (success, refusal, and failure alike) of a
 * routed provider attempt. Owned here — the one durable-state module — for
 * the same reason `T3_TRIGGERS`/`ProviderClass` are: `cost-router-classify.ts`
 * imports and populates this shape, it does not redefine it.
 *
 * All nine fields are non-optional, so a caller building a `CostRouterReceipt`
 * literal gets a TypeScript error for a field it forgot rather than a
 * silently-absent key. A field that is genuinely not applicable to a given
 * outcome (e.g. `sources` when the route never touched web research, or
 * `provider` when zero provider calls were made) still carries the explicit
 * `NOT_APPLICABLE` marker rather than being left out. `assertCostRouterReceipt`
 * is the runtime half of that guarantee: it fails closed on an
 * empty-but-required field (e.g. `provider: ''`) that would otherwise satisfy
 * the type checker but carry no real information.
 */
export const costRouterReceiptSchema = z.object({
  /** Provider id actually used for the terminal outcome, or NOT_APPLICABLE when zero provider calls were made. */
  provider: maybeNotApplicableStringSchema,
  /** Wall-clock milliseconds spent executing the routed attempt. Always applicable, including 0 for zero-call outcomes. */
  elapsedMs: nonNegativeIntegerSchema,
  /** Sources returned by a research-style provider, or NOT_APPLICABLE for routes/providers that never return sources. An empty array is invalid — a route with zero sources must use NOT_APPLICABLE, never `[]`, so a reader never has to guess whether an empty array means "checked, found nothing" or "never populated". */
  sources: z.union([z.array(z.string().min(1)).min(1), notApplicableSchema]),
  /** Same-provider transport retries and non-premium provider failovers actually spent on this attempt. Always applicable. */
  retries: z
    .object({
      transportRetries: boundedAttemptSchema,
      providerFailovers: boundedAttemptSchema,
    })
    .strict(),
  /** How the M2C clearance gate resolved for the destination actually used, or NOT_APPLICABLE when no destination was ever checked. */
  privacyDecision: maybeNotApplicableStringSchema,
  /** Declared cost tier of the destination actually used, or NOT_APPLICABLE when no destination was ever used. */
  costClass: maybeNotApplicableStringSchema,
  /** Deterministic-verifier outcome for this attempt, or NOT_APPLICABLE — M2D wires fake providers only, not the verifier stage. */
  verifierStatus: maybeNotApplicableStringSchema,
  /** Human-readable blocker naming why the outcome was not a clean success, or NOT_APPLICABLE on success. */
  blocker: maybeNotApplicableStringSchema,
  /** Exact next action for whoever reads this receipt. Always required — even a success has one (e.g. "deliver result to caller"). */
  nextAction: z.string().min(1),
}).strict();

/**
 * Declared explicitly (not `z.infer`) so `sources` can be `readonly string[]`
 * — matching `ProviderAttemptResult['sources']` in `cost-router-classify.ts`
 * — without an assignability mismatch against zod's mutable-array inference.
 * `readonly` is compile-time only; `assertCostRouterReceipt` validates the
 * same runtime values either way.
 */
export interface CostRouterReceipt {
  readonly provider: MaybeNotApplicable<string>;
  readonly elapsedMs: number;
  readonly sources: MaybeNotApplicable<readonly string[]>;
  readonly retries: {
    readonly transportRetries: 0 | 1;
    readonly providerFailovers: 0 | 1;
  };
  readonly privacyDecision: MaybeNotApplicable<string>;
  readonly costClass: MaybeNotApplicable<string>;
  readonly verifierStatus: MaybeNotApplicable<string>;
  readonly blocker: MaybeNotApplicable<string>;
  readonly nextAction: string;
}

/**
 * Runtime half of the "fully populated" guarantee: throws
 * `GoalRouterStateError('cost_router_receipt_invalid')` when any field is
 * missing, wrongly typed, or an empty string masquerading as populated (e.g.
 * `provider: ''`). The type-level guarantee (no field can be omitted from a
 * `CostRouterReceipt` literal without a compiler error) and this assertion
 * together are what "fully populated on every terminal outcome" means in
 * practice — one static, one dynamic.
 */
export function assertCostRouterReceipt(receipt: CostRouterReceipt): void {
  const parsed = costRouterReceiptSchema.safeParse(receipt);
  if (!parsed.success) {
    throw new GoalRouterStateError(
      'cost_router_receipt_invalid',
      `Cost Router receipt failed validation: ${parsed.error.issues
        .map((issue) => `${issue.path.join('.')}: ${issue.message}`)
        .join('; ')}`
    );
  }
}

export interface GoalRouterStateOptions {
  /** Absolute Cost Router store directory. Production defaults to resolveStateDir('cost-router'). */
  rootDir?: string;
  lockWaitMs?: number;
}

export type GoalRouterStateErrorCode =
  | 'goal_id_invalid'
  | 'goal_exists'
  | 'goal_state_missing'
  | 'goal_state_corrupt'
  | 'goal_state_unreadable'
  | 'goal_state_unwritable'
  | 'state_root_invalid'
  | 'state_lock_timeout'
  | 'timestamp_invalid'
  | 'premium_owner_invalid'
  | 'premium_owner_expired'
  | 'premium_owner_active'
  | 'premium_owner_mismatch'
  | 'task_escalation_exhausted'
  | 'goal_premium_budget_exhausted'
  | 'async_handle_invalid'
  | 'async_handle_goal_mismatch'
  | 'async_handle_exists'
  | 'async_handle_expired'
  | 'goal_research_budget_exhausted'
  | 'async_resume_not_scheduled'
  | 'async_resume_not_due'
  | 'async_resume_already_claimed'
  | 'goal_local_slice_budget_exhausted'
  | 'task_id_invalid'
  | 'retry_event_invalid'
  | 'denial_already_recorded'
  | 'retry_after_denial_refused'
  | 'transport_retry_exhausted'
  | 'provider_failover_before_retry'
  | 'provider_failover_exhausted'
  | 'clearance_exception_invalid'
  | 'cost_router_receipt_invalid';

export class GoalRouterStateError extends Error {
  constructor(
    readonly code: GoalRouterStateErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'GoalRouterStateError';
  }
}

export const DEFAULT_GOAL_ROUTER_BUDGET = Object.freeze({
  maxLocalSlices: 4,
  usedLocalSlices: 0,
  maxResearchJobs: 2,
  usedResearchJobs: 0,
  maxPremiumEscalations: 1,
  usedPremiumEscalations: 0,
  meteredSpendLimitUsd: 0 as const,
});

function assertGoalId(goalId: string): void {
  if (!GOAL_ID_PATTERN.test(goalId)) {
    throw new GoalRouterStateError(
      'goal_id_invalid',
      `unsafe Cost Router goal id: ${JSON.stringify(goalId)}`
    );
  }
}

function assertTaskId(taskId: string): void {
  if (!TASK_ID_PATTERN.test(taskId)) {
    throw new GoalRouterStateError(
      'task_id_invalid',
      `unsafe Cost Router task id: ${JSON.stringify(taskId)}`
    );
  }
}

function assertTimestamp(value: string): void {
  if (!timestampSchema.safeParse(value).success) {
    throw new GoalRouterStateError(
      'timestamp_invalid',
      `invalid ISO timestamp: ${JSON.stringify(value)}`
    );
  }
}

function resolveStoreRoot(options?: GoalRouterStateOptions): string {
  const rootDir = options?.rootDir ?? resolveStateDir('cost-router');
  if (!isAbsolute(rootDir)) {
    throw new GoalRouterStateError(
      'state_root_invalid',
      'Cost Router state root must be absolute'
    );
  }
  return rootDir;
}

function resolveGoalPath(
  goalId: string,
  options?: GoalRouterStateOptions,
): string {
  assertGoalId(goalId);
  return join(resolveStoreRoot(options), 'goals', `${goalId}.json`);
}

function readRecordAtPath(
  path: string,
  expectedGoalId: string,
): DurableGoalRouterRecord {
  let body: string;
  try {
    body = readFileSync(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new GoalRouterStateError(
        'goal_state_missing',
        `Cost Router state is missing for ${expectedGoalId}`
      );
    }
    throw new GoalRouterStateError(
      'goal_state_unreadable',
      `Cost Router state is unreadable for ${expectedGoalId}`
    );
  }

  try {
    const record = durableGoalRouterRecordSchema.parse(JSON.parse(body));
    if (record.goalId !== expectedGoalId) {
      throw new Error('goal id does not match path');
    }
    return record;
  } catch {
    throw new GoalRouterStateError(
      'goal_state_corrupt',
      `Cost Router state is corrupt for ${expectedGoalId}`
    );
  }
}

function writeRecordAtomically(
  path: string,
  record: DurableGoalRouterRecord,
): void {
  const validated = durableGoalRouterRecordSchema.parse(record);
  mkdirSync(dirname(path), { recursive: true });
  const temporaryPath = `${path}.${process.pid}.${randomUUID()}.tmp`;
  let descriptor: number | undefined;

  try {
    descriptor = openSync(temporaryPath, 'wx');
    writeFileSync(descriptor, `${JSON.stringify(validated, null, 2)}\n`, 'utf8');
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = undefined;
    renameSync(temporaryPath, path);
  } catch {
    throw new GoalRouterStateError(
      'goal_state_unwritable',
      `Cost Router state is unwritable for ${record.goalId}`
    );
  } finally {
    if (descriptor !== undefined) {
      try {
        closeSync(descriptor);
      } catch {
        /* descriptor cleanup is best effort */
      }
    }
    try {
      if (existsSync(temporaryPath)) unlinkSync(temporaryPath);
    } catch {
      /* temporary-file cleanup is best effort */
    }
  }
}

function removeStaleLock(lockPath: string): void {
  if (!existsSync(lockPath)) return;
  try {
    if (Date.now() - statSync(lockPath).mtimeMs > STALE_LOCK_MS) {
      unlinkSync(lockPath);
    }
  } catch {
    /* stale-lock cleanup is best effort */
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function withGoalLock<T>(
  goalPath: string,
  fn: () => T | Promise<T>,
  waitMs = DEFAULT_LOCK_WAIT_MS,
): Promise<T> {
  mkdirSync(dirname(goalPath), { recursive: true });
  const lockPath = `${goalPath}.lock`;
  const deadline = Date.now() + waitMs;
  let descriptor: number | undefined;

  while (descriptor === undefined) {
    try {
      descriptor = openSync(lockPath, 'wx');
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== 'EEXIST' && code !== 'EPERM' && code !== 'EACCES') {
        throw error;
      }
      removeStaleLock(lockPath);
      if (Date.now() >= deadline) {
        throw new GoalRouterStateError(
          'state_lock_timeout',
          `Cost Router state lock timed out: ${lockPath}`
        );
      }
      await sleep(15);
    }
  }

  try {
    return await fn();
  } finally {
    try {
      closeSync(descriptor);
    } finally {
      try {
        if (existsSync(lockPath)) unlinkSync(lockPath);
      } catch {
        /* lock cleanup is best effort */
      }
    }
  }
}

export async function createGoalRouterRecord(
  goalId: string,
  now: string,
  options?: GoalRouterStateOptions,
): Promise<DurableGoalRouterRecord> {
  assertTimestamp(now);
  const path = resolveGoalPath(goalId, options);

  return withGoalLock(path, () => {
    if (existsSync(path)) {
      throw new GoalRouterStateError(
        'goal_exists',
        `Cost Router state already exists for ${goalId}`
      );
    }

    const record = durableGoalRouterRecordSchema.parse({
      schemaVersion: 1,
      goalId,
      revision: 0,
      escalationLedger: {},
      budget: { ...DEFAULT_GOAL_ROUTER_BUDGET },
      retryLedger: {},
      openAsyncHandles: [],
      clearanceLedger: {},
      updatedAt: now,
    });
    writeRecordAtomically(path, record);
    return record;
  }, options?.lockWaitMs);
}

export function loadGoalRouterRecord(
  goalId: string,
  options?: GoalRouterStateOptions,
): DurableGoalRouterRecord {
  const path = resolveGoalPath(goalId, options);
  return readRecordAtPath(path, goalId);
}

async function mutateGoalRouterRecord(
  goalId: string,
  now: string,
  options: GoalRouterStateOptions | undefined,
  mutation: (current: DurableGoalRouterRecord) => DurableGoalRouterRecord,
): Promise<DurableGoalRouterRecord> {
  assertTimestamp(now);
  const path = resolveGoalPath(goalId, options);

  return withGoalLock(path, () => {
    const current = readRecordAtPath(path, goalId);
    const mutated = mutation(current);
    const next = durableGoalRouterRecordSchema.parse({
      ...mutated,
      revision: current.revision + 1,
      updatedAt: now,
    });
    writeRecordAtomically(path, next);
    return next;
  }, options?.lockWaitMs);
}

export async function acquirePremiumOwner(
  goalId: string,
  owner: PremiumOwner,
  now: string,
  options?: GoalRouterStateOptions,
): Promise<DurableGoalRouterRecord> {
  const parsedOwner = premiumOwnerSchema.safeParse(owner);
  if (!parsedOwner.success || Date.parse(owner.acquiredAt) > Date.parse(now)) {
    throw new GoalRouterStateError(
      'premium_owner_invalid',
      'premium owner is invalid or acquired in the future'
    );
  }
  if (Date.parse(owner.expiresAt) <= Date.parse(now)) {
    throw new GoalRouterStateError(
      'premium_owner_expired',
      'premium owner expiry must be after acquisition'
    );
  }

  return mutateGoalRouterRecord(goalId, now, options, (current) => {
    if (
      current.activePremiumOwner &&
      Date.parse(current.activePremiumOwner.expiresAt) > Date.parse(now)
    ) {
      throw new GoalRouterStateError(
        'premium_owner_active',
        `goal ${goalId} already has an active premium owner`
      );
    }

    if (current.escalationLedger[owner.taskId] === 1) {
      throw new GoalRouterStateError(
        'task_escalation_exhausted',
        `task ${owner.taskId} already consumed its premium escalation`
      );
    }

    if (
      current.budget.usedPremiumEscalations >=
      current.budget.maxPremiumEscalations
    ) {
      throw new GoalRouterStateError(
        'goal_premium_budget_exhausted',
        `goal ${goalId} exhausted its premium escalation ceiling`
      );
    }

    return {
      ...current,
      activePremiumOwner: parsedOwner.data,
      escalationLedger: {
        ...current.escalationLedger,
        [owner.taskId]: 1,
      },
      budget: {
        ...current.budget,
        usedPremiumEscalations:
          current.budget.usedPremiumEscalations + 1,
      },
    };
  });
}

export async function releasePremiumOwner(
  goalId: string,
  phaseId: string,
  now: string,
  options?: GoalRouterStateOptions,
): Promise<DurableGoalRouterRecord> {
  return mutateGoalRouterRecord(goalId, now, options, (current) => {
    if (current.activePremiumOwner?.phaseId !== phaseId) {
      throw new GoalRouterStateError(
        'premium_owner_mismatch',
        `phase ${phaseId} does not own goal ${goalId}`
      );
    }

    const {
      activePremiumOwner: _releasedOwner,
      ...withoutOwner
    } = current;
    return withoutOwner;
  });
}

export async function registerAsyncResearchHandle(
  goalId: string,
  handle: AsyncResearchHandle,
  now: string,
  options?: GoalRouterStateOptions,
): Promise<DurableGoalRouterRecord> {
  assertTimestamp(now);
  const parsedHandle = asyncResearchHandleSchema.safeParse(handle);
  if (!parsedHandle.success) {
    throw new GoalRouterStateError(
      'async_handle_invalid',
      'asynchronous research handle failed schema validation'
    );
  }

  if (handle.goalId !== goalId) {
    throw new GoalRouterStateError(
      'async_handle_goal_mismatch',
      `handle ${handle.handleId} does not belong to goal ${goalId}`
    );
  }

  const submittedAt = Date.parse(handle.submittedAt);
  const expiresAt = Date.parse(handle.expiresAt);
  const nextResumeAt = Date.parse(handle.nextResumeAt);
  const observedAt = Date.parse(now);
  if (
    submittedAt > observedAt ||
    nextResumeAt < submittedAt ||
    nextResumeAt > expiresAt ||
    handle.resumeClaimedAt !== undefined ||
    handle.maxInspections < 1 ||
    (handle.state !== 'submitted' && handle.state !== 'scheduled')
  ) {
    throw new GoalRouterStateError(
      'async_handle_invalid',
      `handle ${handle.handleId} has an invalid lifecycle`
    );
  }
  if (expiresAt <= observedAt) {
    throw new GoalRouterStateError(
      'async_handle_expired',
      `handle ${handle.handleId} is already expired`
    );
  }

  return mutateGoalRouterRecord(goalId, now, options, (current) => {
    if (
      current.openAsyncHandles.some(
        (candidate) => candidate.handleId === handle.handleId
      )
    ) {
      throw new GoalRouterStateError(
        'async_handle_exists',
        `handle ${handle.handleId} already exists`
      );
    }

    if (
      current.budget.usedResearchJobs >=
      current.budget.maxResearchJobs
    ) {
      throw new GoalRouterStateError(
        'goal_research_budget_exhausted',
        `goal ${goalId} exhausted its research-job ceiling`
      );
    }

    return {
      ...current,
      budget: {
        ...current.budget,
        usedResearchJobs: current.budget.usedResearchJobs + 1,
      },
      openAsyncHandles: [
        ...current.openAsyncHandles,
        parsedHandle.data,
      ],
    };
  });
}

export type AsyncResumeClaimResult =
  | {
      status: 'claimed';
      handle: AsyncResearchHandle;
      record: DurableGoalRouterRecord;
    }
  | {
      status: 'async_expired';
      reason: 'unknown' | 'expired' | 'inspection_budget_exhausted';
      handleId: string;
      record: DurableGoalRouterRecord;
    };

export async function claimScheduledAsyncResume(
  goalId: string,
  handleId: string,
  now: string,
  options?: GoalRouterStateOptions,
): Promise<AsyncResumeClaimResult> {
  assertTimestamp(now);
  if (!handleId.trim()) {
    throw new GoalRouterStateError(
      'async_handle_invalid',
      'asynchronous handle id must not be empty'
    );
  }

  const path = resolveGoalPath(goalId, options);
  return withGoalLock(path, () => {
    const current = readRecordAtPath(path, goalId);
    const handleIndex = current.openAsyncHandles.findIndex(
      (candidate) => candidate.handleId === handleId
    );
    if (handleIndex < 0) {
      return {
        status: 'async_expired' as const,
        reason: 'unknown' as const,
        handleId,
        record: current,
      };
    }

    const handle = current.openAsyncHandles[handleIndex];
    const persistTerminal = (
      state: 'expired' | 'failed',
      reason: 'expired' | 'inspection_budget_exhausted',
    ): AsyncResumeClaimResult => {
      if (handle.state === state) {
        return {
          status: 'async_expired',
          reason,
          handleId,
          record: current,
        };
      }

      const {
        resumeClaimedAt: _claimedAt,
        ...withoutClaim
      } = handle;
      const terminalHandle: AsyncResearchHandle = {
        ...withoutClaim,
        state,
      };
      const openAsyncHandles = [...current.openAsyncHandles];
      openAsyncHandles[handleIndex] = terminalHandle;
      const record = durableGoalRouterRecordSchema.parse({
        ...current,
        openAsyncHandles,
        revision: current.revision + 1,
        updatedAt: now,
      });
      writeRecordAtomically(path, record);
      return {
        status: 'async_expired',
        reason,
        handleId,
        record,
      };
    };

    if (handle.state === 'expired') {
      return persistTerminal('expired', 'expired');
    }
    if (
      handle.state === 'failed' &&
      handle.inspectionCount >= handle.maxInspections
    ) {
      return persistTerminal('failed', 'inspection_budget_exhausted');
    }
    if (Date.parse(now) >= Date.parse(handle.expiresAt)) {
      return persistTerminal('expired', 'expired');
    }
    if (handle.state !== 'scheduled') {
      throw new GoalRouterStateError(
        'async_resume_not_scheduled',
        `handle ${handleId} has no scheduled resume`
      );
    }
    if (handle.resumeClaimedAt !== undefined) {
      throw new GoalRouterStateError(
        'async_resume_already_claimed',
        `handle ${handleId} already claimed this resume event`
      );
    }
    if (Date.parse(now) < Date.parse(handle.nextResumeAt)) {
      throw new GoalRouterStateError(
        'async_resume_not_due',
        `handle ${handleId} is not due until ${handle.nextResumeAt}`
      );
    }
    if (handle.inspectionCount >= handle.maxInspections) {
      return persistTerminal('failed', 'inspection_budget_exhausted');
    }

    const claimedHandle: AsyncResearchHandle = {
      ...handle,
      resumeClaimedAt: now,
      inspectionCount: handle.inspectionCount + 1,
    };
    const openAsyncHandles = [...current.openAsyncHandles];
    openAsyncHandles[handleIndex] = claimedHandle;
    const record = durableGoalRouterRecordSchema.parse({
      ...current,
      openAsyncHandles,
      revision: current.revision + 1,
      updatedAt: now,
    });
    writeRecordAtomically(path, record);

    return {
      status: 'claimed' as const,
      handle: claimedHandle,
      record,
    };
  }, options?.lockWaitMs);
}

export async function consumeLocalSlice(
  goalId: string,
  now: string,
  options?: GoalRouterStateOptions,
): Promise<DurableGoalRouterRecord> {
  return mutateGoalRouterRecord(goalId, now, options, (current) => {
    if (current.budget.usedLocalSlices >= current.budget.maxLocalSlices) {
      throw new GoalRouterStateError(
        'goal_local_slice_budget_exhausted',
        `goal ${goalId} exhausted its local-slice ceiling`
      );
    }

    return {
      ...current,
      budget: {
        ...current.budget,
        usedLocalSlices: current.budget.usedLocalSlices + 1,
      },
    };
  });
}

export type RetryEvent =
  | 'denial'
  | 'transport_retry'
  | 'provider_failover';

export async function recordRetryEvent(
  goalId: string,
  taskId: string,
  event: RetryEvent,
  now: string,
  options?: GoalRouterStateOptions,
): Promise<DurableGoalRouterRecord> {
  assertTaskId(taskId);
  if (
    event !== 'denial' &&
    event !== 'transport_retry' &&
    event !== 'provider_failover'
  ) {
    throw new GoalRouterStateError(
      'retry_event_invalid',
      `unsupported retry event: ${JSON.stringify(event)}`
    );
  }

  return mutateGoalRouterRecord(goalId, now, options, (current) => {
    const previous = current.retryLedger[taskId] ?? {
      denialAttempts: 0,
      transportRetries: 0,
      providerFailovers: 0,
    };
    let next = { ...previous };

    if (event === 'denial') {
      if (previous.denialAttempts >= 1) {
        throw new GoalRouterStateError(
          'denial_already_recorded',
          `task ${taskId} already recorded a terminal denial`
        );
      }
      next.denialAttempts = 1;
    } else {
      if (previous.denialAttempts >= 1) {
        throw new GoalRouterStateError(
          'retry_after_denial_refused',
          `task ${taskId} cannot retry after a denial`
        );
      }

      if (event === 'transport_retry') {
        if (previous.transportRetries >= 1) {
          throw new GoalRouterStateError(
            'transport_retry_exhausted',
            `task ${taskId} exhausted its transport retry`
          );
        }
        next.transportRetries = 1;
      } else {
        if (previous.providerFailovers >= 1) {
          throw new GoalRouterStateError(
            'provider_failover_exhausted',
            `task ${taskId} exhausted its provider failover`
          );
        }
        if (previous.transportRetries !== 1) {
          throw new GoalRouterStateError(
            'provider_failover_before_retry',
            `task ${taskId} must consume its transport retry before failover`
          );
        }
        next.providerFailovers = 1;
      }
    }

    return {
      ...current,
      retryLedger: {
        ...current.retryLedger,
        [taskId]: next,
      },
    };
  });
}

/**
 * M2C: persists one operator clearance exception against the goal's durable
 * record. Called only when an exception actually let a cross-class send
 * proceed (see `runRoutedAttempt` in cost-router-classify.ts) — never for an
 * exception that was present but not needed, so the ledger reflects only
 * exceptions that were exercised.
 */
export async function recordClearanceException(
  goalId: string,
  taskId: string,
  exception: { reason: string; approvedBy: string; permittedClass: ProviderClass },
  now: string,
  options?: GoalRouterStateOptions,
): Promise<DurableGoalRouterRecord> {
  assertTaskId(taskId);
  const parsed = clearanceExceptionRecordSchema.safeParse({
    reason: exception.reason,
    approvedBy: exception.approvedBy,
    permittedClass: exception.permittedClass,
    recordedAt: now,
  });
  if (!parsed.success) {
    throw new GoalRouterStateError(
      'clearance_exception_invalid',
      `clearance exception for task ${taskId} failed validation`
    );
  }

  return mutateGoalRouterRecord(goalId, now, options, (current) => ({
    ...current,
    clearanceLedger: {
      ...(current.clearanceLedger ?? {}),
      [taskId]: parsed.data,
    },
  }));
}
