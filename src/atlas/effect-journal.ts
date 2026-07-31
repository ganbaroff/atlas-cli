/**
 * Shared durable effect journal (M3D-C).
 *
 * Exact-once here means **no automatic duplicate**, not pretending an
 * unknowable outcome is known.
 *
 * State machine:
 *   prepared -> started -> succeeded|failed|outcome_unknown -> reconciled
 *
 * Rules:
 *   - flush `started` before invoking the effect;
 *   - flush a terminal receipt before closing queue/graph state;
 *   - `started` without a terminal receipt becomes `outcome_unknown` on
 *     restart consultation and refuses automatic replay;
 *   - a stale queue reclaim consults this journal before re-execution.
 *
 * Persistence is local only. This module never invokes a provider, browser,
 * shell, or network route.
 */

import { createHash, randomUUID } from 'node:crypto';
import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, isAbsolute, join } from 'node:path';
import { z } from 'zod';

import { resolveStateDir } from './state-root.js';

export type EffectJournalStatus =
  | 'prepared'
  | 'started'
  | 'succeeded'
  | 'failed'
  | 'outcome_unknown'
  | 'reconciled';

export type EffectIdentity =
  | { kind: 'queue-command'; commandId: string }
  | { kind: 'task-effect'; taskId: string; effectKey: string };

export type EffectReplayDecision =
  | { action: 'execute' }
  | {
      action: 'resume';
      status: 'succeeded' | 'failed';
      receipt?: unknown;
      error?: string;
    }
  | { action: 'block'; code: 'outcome_unknown'; message: string };

export type EffectJournalErrorCode =
  | 'outcome_unknown'
  | 'operation_id_invalid'
  | 'journal_corrupt'
  | 'journal_unwritable'
  | 'state_root_invalid';

export class EffectJournalError extends Error {
  constructor(
    readonly code: EffectJournalErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'EffectJournalError';
  }
}

const timestampSchema = z.string().datetime();
const operationIdSchema = z
  .string()
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,200}$/);

const identitySchema = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('queue-command'),
      commandId: z.string().min(1),
    })
    .strict(),
  z
    .object({
      kind: z.literal('task-effect'),
      taskId: z.string().min(1),
      effectKey: z.string().min(1),
    })
    .strict(),
]);

const effectJournalRecordSchema = z
  .object({
    schemaVersion: z.literal(1),
    operationId: operationIdSchema,
    status: z.enum([
      'prepared',
      'started',
      'succeeded',
      'failed',
      'outcome_unknown',
      'reconciled',
    ]),
    identity: identitySchema,
    preparedAt: timestampSchema,
    startedAt: timestampSchema.optional(),
    terminalAt: timestampSchema.optional(),
    receipt: z.unknown().optional(),
    error: z.string().optional(),
    revision: z.number().int().nonnegative(),
  })
  .strict();

export type EffectJournalRecord = z.infer<typeof effectJournalRecordSchema>;

export interface EffectJournalOptions {
  /** Absolute effect-journal store directory. Defaults to resolveStateDir. */
  rootDir?: string;
  now?: () => string;
}

function nowIso(options?: EffectJournalOptions): string {
  return options?.now?.() ?? new Date().toISOString();
}

function assertOperationId(operationId: string): string {
  const parsed = operationIdSchema.safeParse(operationId);
  if (!parsed.success) {
    throw new EffectJournalError(
      'operation_id_invalid',
      `invalid effect-journal operation id: ${operationId}`,
    );
  }
  return parsed.data;
}

function resolveStoreRoot(options?: EffectJournalOptions): string {
  const rootDir = options?.rootDir ?? resolveStateDir('effect-journal');
  if (!isAbsolute(rootDir)) {
    throw new EffectJournalError(
      'state_root_invalid',
      'effect-journal root must be absolute',
    );
  }
  return rootDir;
}

function operationPath(operationId: string, options?: EffectJournalOptions): string {
  const safe = assertOperationId(operationId);
  // Hash the id for the leaf name so colon-bearing ids stay one path segment
  // on every platform while remaining deterministic.
  const leaf = createHash('sha256').update(safe).digest('hex').slice(0, 40);
  return join(resolveStoreRoot(options), 'ops', `${leaf}.json`);
}

function writeRecordAtomically(
  path: string,
  record: EffectJournalRecord,
): void {
  const validated = effectJournalRecordSchema.parse(record);
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
  } catch (error) {
    throw new EffectJournalError(
      'journal_unwritable',
      `effect-journal is unwritable for ${record.operationId}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  } finally {
    if (descriptor !== undefined) {
      try {
        closeSync(descriptor);
      } catch {
        /* best effort */
      }
    }
    try {
      if (existsSync(temporaryPath)) unlinkSync(temporaryPath);
    } catch {
      /* best effort */
    }
  }
}

function readRecordAtPath(path: string): EffectJournalRecord | null {
  let body: string;
  try {
    body = readFileSync(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw new EffectJournalError(
      'journal_corrupt',
      `effect-journal is unreadable at ${path}`,
    );
  }

  try {
    return effectJournalRecordSchema.parse(JSON.parse(body));
  } catch {
    throw new EffectJournalError(
      'journal_corrupt',
      `effect-journal is corrupt at ${path}`,
    );
  }
}

function loadMutable(
  operationId: string,
  options?: EffectJournalOptions,
): { path: string; record: EffectJournalRecord | null } {
  const path = operationPath(operationId, options);
  return { path, record: readRecordAtPath(path) };
}

/** Stable operation id for a queue command row. */
export function deriveQueueOperationId(commandId: string): string {
  if (!commandId.trim()) {
    throw new EffectJournalError(
      'operation_id_invalid',
      'queue command id must be non-empty',
    );
  }
  return `queue:${commandId.trim()}`;
}

/** Stable operation id for a goal-runner / hand effect. */
export function deriveTaskEffectOperationId(
  taskId: string,
  effectKey: string,
): string {
  if (!taskId.trim() || !effectKey.trim()) {
    throw new EffectJournalError(
      'operation_id_invalid',
      'task id and effect key must be non-empty',
    );
  }
  const digest = createHash('sha256')
    .update(`${taskId.trim()}\0${effectKey.trim()}`)
    .digest('hex')
    .slice(0, 24);
  return `task:${taskId.trim()}:fx:${digest}`;
}

export function prepareOperation(
  operationId: string,
  args: {
    identity: EffectIdentity;
    rootDir?: string;
    now?: () => string;
  },
): EffectJournalRecord {
  const options: EffectJournalOptions = {
    rootDir: args.rootDir,
    now: args.now,
  };
  const { path, record } = loadMutable(operationId, options);
  if (record) return record;

  const next: EffectJournalRecord = {
    schemaVersion: 1,
    operationId: assertOperationId(operationId),
    status: 'prepared',
    identity: args.identity,
    preparedAt: nowIso(options),
    revision: 0,
  };
  writeRecordAtomically(path, next);
  return next;
}

export function markStarted(
  operationId: string,
  options?: EffectJournalOptions,
): EffectJournalRecord {
  const { path, record } = loadMutable(operationId, options);
  if (!record) {
    throw new EffectJournalError(
      'journal_corrupt',
      `cannot markStarted: missing record for ${operationId}`,
    );
  }
  if (
    record.status === 'succeeded' ||
    record.status === 'failed' ||
    record.status === 'outcome_unknown' ||
    record.status === 'reconciled'
  ) {
    return record;
  }
  const next: EffectJournalRecord = {
    ...record,
    status: 'started',
    startedAt: record.startedAt ?? nowIso(options),
    revision: record.revision + 1,
  };
  writeRecordAtomically(path, next);
  return next;
}

export function markSucceeded(
  operationId: string,
  receipt: unknown,
  options?: EffectJournalOptions,
): EffectJournalRecord {
  const { path, record } = loadMutable(operationId, options);
  if (!record) {
    throw new EffectJournalError(
      'journal_corrupt',
      `cannot markSucceeded: missing record for ${operationId}`,
    );
  }
  if (record.status === 'succeeded') return record;
  if (record.status === 'outcome_unknown' || record.status === 'reconciled') {
    throw new EffectJournalError(
      'outcome_unknown',
      `cannot overwrite ${record.status} with succeeded for ${operationId}`,
    );
  }
  const next: EffectJournalRecord = {
    ...record,
    status: 'succeeded',
    startedAt: record.startedAt ?? nowIso(options),
    terminalAt: nowIso(options),
    receipt,
    error: undefined,
    revision: record.revision + 1,
  };
  writeRecordAtomically(path, next);
  return next;
}

export function markFailed(
  operationId: string,
  error: string,
  options?: EffectJournalOptions,
): EffectJournalRecord {
  const { path, record } = loadMutable(operationId, options);
  if (!record) {
    throw new EffectJournalError(
      'journal_corrupt',
      `cannot markFailed: missing record for ${operationId}`,
    );
  }
  if (record.status === 'failed') return record;
  if (record.status === 'outcome_unknown' || record.status === 'reconciled') {
    throw new EffectJournalError(
      'outcome_unknown',
      `cannot overwrite ${record.status} with failed for ${operationId}`,
    );
  }
  const next: EffectJournalRecord = {
    ...record,
    status: 'failed',
    startedAt: record.startedAt ?? nowIso(options),
    terminalAt: nowIso(options),
    error: error.slice(0, 2000),
    revision: record.revision + 1,
  };
  writeRecordAtomically(path, next);
  return next;
}

function promoteOutcomeUnknown(
  path: string,
  record: EffectJournalRecord,
  options?: EffectJournalOptions,
): EffectJournalRecord {
  if (record.status === 'outcome_unknown') return record;
  const next: EffectJournalRecord = {
    ...record,
    status: 'outcome_unknown',
    terminalAt: nowIso(options),
    revision: record.revision + 1,
  };
  writeRecordAtomically(path, next);
  return next;
}

export function loadOperation(
  operationId: string,
  options?: EffectJournalOptions,
): EffectJournalRecord | null {
  return loadMutable(operationId, options).record;
}

/**
 * Consult the journal for automatic replay authorization.
 * A `started` row without a terminal receipt is promoted to `outcome_unknown`
 * and blocked — never automatically replayed.
 */
export function decideReplay(
  operationId: string,
  options?: EffectJournalOptions,
): EffectReplayDecision {
  const { path, record } = loadMutable(operationId, options);
  if (!record || record.status === 'prepared') {
    return { action: 'execute' };
  }
  if (record.status === 'succeeded') {
    return {
      action: 'resume',
      status: 'succeeded',
      receipt: record.receipt,
    };
  }
  if (record.status === 'failed') {
    return {
      action: 'resume',
      status: 'failed',
      error: record.error,
      receipt: record.receipt,
    };
  }
  if (record.status === 'started' || record.status === 'outcome_unknown') {
    const blocked =
      record.status === 'started'
        ? promoteOutcomeUnknown(path, record, options)
        : record;
    return {
      action: 'block',
      code: 'outcome_unknown',
      message: `effect ${blocked.operationId} is outcome_unknown; refuse automatic replay`,
    };
  }
  // reconciled — treat as a named blocker until an explicit operator path
  // reopens it; automatic replay remains forbidden.
  return {
    action: 'block',
    code: 'outcome_unknown',
    message: `effect ${record.operationId} is ${record.status}; refuse automatic replay`,
  };
}

/** Stale queue reclaim must consult the shared journal for the command id. */
export function decideStaleClaim(
  commandId: string,
  options?: EffectJournalOptions,
): EffectReplayDecision {
  return decideReplay(deriveQueueOperationId(commandId), options);
}

export interface ExecuteOnceResult<T> {
  outcome: 'executed' | 'resumed';
  result: T;
  record: EffectJournalRecord;
}

/**
 * Shared execute-once helper for queue and goal-runner paths.
 * Flushes `started` before invoking `effect`, then a terminal receipt after.
 */
export async function executeOnce<T>(
  operationId: string,
  identity: EffectIdentity,
  effect: () => Promise<T>,
  options?: EffectJournalOptions,
): Promise<ExecuteOnceResult<T>> {
  const decision = decideReplay(operationId, options);
  if (decision.action === 'block') {
    throw new EffectJournalError(decision.code, decision.message);
  }
  if (decision.action === 'resume') {
    if (decision.status === 'failed') {
      throw new EffectJournalError(
        'journal_corrupt',
        decision.error ?? `effect ${operationId} previously failed`,
      );
    }
    const record = loadOperation(operationId, options);
    if (!record) {
      throw new EffectJournalError(
        'journal_corrupt',
        `missing terminal record for ${operationId}`,
      );
    }
    return {
      outcome: 'resumed',
      result: decision.receipt as T,
      record,
    };
  }

  prepareOperation(operationId, { identity, ...options });
  markStarted(operationId, options);

  try {
    const result = await effect();
    const record = markSucceeded(operationId, result, options);
    return { outcome: 'executed', result, record };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    markFailed(operationId, message, options);
    throw error;
  }
}
