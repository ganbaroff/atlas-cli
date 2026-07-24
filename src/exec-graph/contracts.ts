/**
 * exec-graph/contracts.ts — zod schemas + types for EB-0, the single machine
 * execution authority for new Atlas-managed work.
 *
 * WHAT THIS IS: the data contracts for a goal/task ledger with an explicit
 * 11-state task lifecycle. A Task is immutable-by-id and moves through
 * states only via recorded Transition entries (see ./transitions.ts for the
 * legal-edge table + the pure state-machine function, ./ledger.ts for the
 * append-only event log these get persisted through).
 *
 * DESIGN CONTRACTS (mirrors src/operator/contracts.ts's style):
 *   - Every id has an immutable, human-legible prefix ('gol_'/'tsk_') so a
 *     raw string can be told apart in logs/CLI output without a lookup.
 *   - superRefine() enforces cross-field invariants that a plain shape check
 *     cannot: a task resting in 'verified'/'closed' must carry evidence, and
 *     the two transitions that are supposed to be evidence-bearing
 *     ('evidence-submitted', 'verified') must actually cite evidenceRefs on
 *     the transition itself. These are DoD requirements, not style
 *     preferences — this module is the one place a task can be
 *     mis-recorded as verified without ever having produced proof.
 *   - actor is z.string().min(1) directly on Transition — "always non-empty"
 *     is a schema-level guarantee, not a runtime convention.
 */

import { z } from 'zod';

// ── Task lifecycle ─────────────────────────────────────────────────────────

export const taskStatusSchema = z.enum([
  'proposed',
  'accepted',
  'planned',
  'delegated',
  'in-progress',
  'blocked',
  'evidence-submitted',
  'verified',
  'rejected',
  'closed',
  'escalated',
]);
export type TaskStatus = z.infer<typeof taskStatusSchema>;
export const TASK_STATUSES = taskStatusSchema.options;

export const riskClassSchema = z.enum(['low', 'medium', 'high', 'irreversible']);
export type RiskClass = z.infer<typeof riskClassSchema>;

export const sourceKindSchema = z.enum([
  'exec-graph',
  'external-cto-brief',
  'ceo-chat',
  'volaura-work-queue',
  'operator-tasks',
  'supabase-queue',
  'telegram-spawner',
]);
export type SourceKind = z.infer<typeof sourceKindSchema>;

export const sourceRefSchema = z.object({
  kind: sourceKindSchema,
  ref: z.string().min(1),
});
export type SourceRef = z.infer<typeof sourceRefSchema>;

// ── Evidence ────────────────────────────────────────────────────────────────

export const evidenceKindSchema = z.enum(['commit', 'test-output', 'file', 'url', 'tool-receipt', 'other']);
export type EvidenceKind = z.infer<typeof evidenceKindSchema>;

export const evidenceSchema = z.object({
  /** path / URL / commit SHA / test-output ref. */
  ref: z.string().min(1),
  kind: evidenceKindSchema,
  note: z.string().min(1).optional(),
});
export type Evidence = z.infer<typeof evidenceSchema>;

// ── Transition ──────────────────────────────────────────────────────────────

export const transitionSchema = z.object({
  /** null only for the creation transition (no prior status). */
  from: taskStatusSchema.nullable(),
  to: taskStatusSchema,
  ts: z.string().datetime(),
  /** Required, non-empty. e.g. 'atlas' | 'ceo' | 'external-cto' | 'hand:<id>'. */
  actor: z.string().min(1),
  evidenceRefs: z.array(z.string().min(1)).optional(),
  note: z.string().min(1).optional(),
}).superRefine((t, ctx) => {
  if (t.to === 'verified' && (!t.evidenceRefs || t.evidenceRefs.length === 0)) {
    ctx.addIssue({
      code: 'custom',
      path: ['evidenceRefs'],
      message: "transition to 'verified' must carry >=1 evidenceRefs",
    });
  }
  if (t.to === 'evidence-submitted' && (!t.evidenceRefs || t.evidenceRefs.length === 0)) {
    ctx.addIssue({
      code: 'custom',
      path: ['evidenceRefs'],
      message: "transition to 'evidence-submitted' must carry >=1 evidenceRefs",
    });
  }
});
export type Transition = z.infer<typeof transitionSchema>;

// ── Goal ────────────────────────────────────────────────────────────────────

export const goalIdSchema = z.string().regex(/^gol_[a-z0-9][a-z0-9._-]{1,80}$/, 'goal id must match ^gol_[a-z0-9][a-z0-9._-]{1,80}$');
export const taskIdSchema = z.string().regex(/^tsk_[a-z0-9][a-z0-9._-]{1,80}$/, 'task id must match ^tsk_[a-z0-9][a-z0-9._-]{1,80}$');

export const goalSchema = z.object({
  id: goalIdSchema,
  title: z.string().min(1),
  source: sourceRefSchema,
  status: z.enum(['open', 'closed']),
  createdAt: z.string().datetime(),
});
export type Goal = z.infer<typeof goalSchema>;

// ── Task ────────────────────────────────────────────────────────────────────

export const taskSchema = z.object({
  id: taskIdSchema,
  goalId: goalIdSchema,
  title: z.string().min(1),
  source: sourceRefSchema,
  owner: z.string().min(1),
  status: taskStatusSchema,
  riskClass: riskClassSchema,
  /**
   * Required, unique across the ledger. For imports, derive deterministically
   * as `${source.kind}:${source.ref}` — this is what lets ledger.appendEvent()
   * dedupe a re-import of the same legacy ref into the SAME task instead of a
   * second active one (the EB-0 reconciliation guarantee).
   */
  idempotencyKey: z.string().min(1),
  evidence: z.array(evidenceSchema),
  createdAt: z.string().datetime(),
  transitions: z.array(transitionSchema),
}).superRefine((task, ctx) => {
  if ((task.status === 'verified' || task.status === 'closed') && task.evidence.length === 0) {
    ctx.addIssue({
      code: 'custom',
      path: ['evidence'],
      message: `task in status '${task.status}' must have >=1 evidence entry`,
    });
  }
});
export type Task = z.infer<typeof taskSchema>;

export function parseGoal(input: unknown): Goal {
  return goalSchema.parse(input);
}

export function parseTask(input: unknown): Task {
  return taskSchema.parse(input);
}

export function parseTransition(input: unknown): Transition {
  return transitionSchema.parse(input);
}

// ── Ledger events ───────────────────────────────────────────────────────────
//
// The ledger (see ./ledger.ts) is an append-only JSONL log of these events.
// Each event carries the MINIMAL delta (a whole Goal only at creation; a
// single Transition or a single Evidence entry thereafter) — snapshots are a
// pure fold over the full event sequence, never re-derived from a
// re-embedded whole-Task payload, so the fold in ledger.ts is the one and
// only place lifecycle state is assembled from history.

export const goalCreatedPayloadSchema = z.object({ goal: goalSchema });
export const taskCreatedPayloadSchema = z.object({ task: taskSchema });
export const transitionPayloadSchema = z.object({ taskId: taskIdSchema, transition: transitionSchema });
export const evidenceAddedPayloadSchema = z.object({ taskId: taskIdSchema, evidence: evidenceSchema });
/**
 * 'owner-reassigned' — the owner-reassignment primitive. Append-only audit
 * trail entry; does NOT carry/imply a status change (see ledger.ts's fold —
 * it updates task.owner only, never task.status/transitions). `from` mirrors
 * whatever the task's owner was at reassignment time (in practice always
 * non-empty, since taskSchema requires owner min(1)); `to`/`actor`/`reason`
 * are required non-empty per exec-graph/api.ts's reassignOwner().
 */
export const ownerReassignedPayloadSchema = z.object({
  taskId: taskIdSchema,
  from: z.string(),
  to: z.string().min(1),
  actor: z.string().min(1),
  reason: z.string().min(1),
  ts: z.string().datetime(),
});

export const ledgerEventSchema = z.discriminatedUnion('kind', [
  z.object({
    eventId: z.string().min(1),
    kind: z.literal('goal-created'),
    ts: z.string().datetime(),
    actor: z.string().min(1),
    payload: goalCreatedPayloadSchema,
  }),
  z.object({
    eventId: z.string().min(1),
    kind: z.literal('task-created'),
    ts: z.string().datetime(),
    actor: z.string().min(1),
    payload: taskCreatedPayloadSchema,
  }),
  z.object({
    eventId: z.string().min(1),
    kind: z.literal('transition'),
    ts: z.string().datetime(),
    actor: z.string().min(1),
    payload: transitionPayloadSchema,
  }),
  z.object({
    eventId: z.string().min(1),
    kind: z.literal('evidence-added'),
    ts: z.string().datetime(),
    actor: z.string().min(1),
    payload: evidenceAddedPayloadSchema,
  }),
  z.object({
    eventId: z.string().min(1),
    kind: z.literal('owner-reassigned'),
    ts: z.string().datetime(),
    actor: z.string().min(1),
    payload: ownerReassignedPayloadSchema,
  }),
]);
export type LedgerEvent = z.infer<typeof ledgerEventSchema>;
export type LedgerEventKind = LedgerEvent['kind'];

/** A LedgerEvent before eventId assignment — what callers hand to ledger.appendEvent(). */
export type NewLedgerEvent =
  | { kind: 'goal-created'; ts: string; actor: string; payload: z.infer<typeof goalCreatedPayloadSchema> }
  | { kind: 'task-created'; ts: string; actor: string; payload: z.infer<typeof taskCreatedPayloadSchema> }
  | { kind: 'transition'; ts: string; actor: string; payload: z.infer<typeof transitionPayloadSchema> }
  | { kind: 'evidence-added'; ts: string; actor: string; payload: z.infer<typeof evidenceAddedPayloadSchema> }
  | { kind: 'owner-reassigned'; ts: string; actor: string; payload: z.infer<typeof ownerReassignedPayloadSchema> };

export function parseLedgerEvent(input: unknown): LedgerEvent {
  return ledgerEventSchema.parse(input);
}

// ── Snapshot (on-disk shape; see ledger.ts for the in-memory Record form) ──

export const graphSnapshotFileSchema = z.object({
  goals: z.array(goalSchema),
  tasks: z.array(taskSchema),
});
export type GraphSnapshotFile = z.infer<typeof graphSnapshotFileSchema>;
