/**
 * exec-graph/ledger.ts — append-only event log + derived snapshot for EB-0.
 *
 * WHAT THIS IS: the persistence layer. Two files under resolveExecGraphDir()
 * (default `<repo-root>/state/exec-graph/`, override via
 * ATLAS_EXEC_GRAPH_DIR — same "cwd first, module-walk fallback" resolution
 * style as ../atlas/policy.ts's resolvePolicyPath()):
 *   - ledger.jsonl — source of truth. One JSON LedgerEvent per line, append-only.
 *   - graph.json   — a derived, disposable read-cache: `{ goals: Goal[], tasks: Task[] }`.
 *     Arrays, not id-keyed objects, specifically so the on-disk shape can
 *     never smuggle a `__proto__`/`constructor`/`prototype` key into a
 *     bracket-assignment when it's loaded back in (defense in depth on top
 *     of the fact that goalIdSchema/taskIdSchema's `gol_`/`tsk_` prefix
 *     requirement already makes those literal ids unparseable).
 *
 * FOLD: applyEventToSnapshot() is the ONE place lifecycle state is assembled
 * from history — foldEvents()/rebuildSnapshot() are just `reduce` over it,
 * and withExecGraphMutation()'s incremental snapshot update calls the exact
 * same function on each new event. That equality (incremental update ==
 * full rebuild) is what makes `atlas graph verify` meaningful.
 *
 * FAILURE BEHAVIOR (matches ../atlas/autonomy-loop.ts's writeAlertState /
 * readAlertState lesson, revised for the M3D single-transaction cutover):
 *   - Legacy reads (readLedgerEvents/rebuildSnapshot/readGraph) stay
 *     fail-safe: a missing/corrupt graph.json falls back to a full ledger
 *     rebuild, a malformed JSONL line is skipped + console.error'd, the rest
 *     of the ledger still loads. These never throw — `atlas graph verify`
 *     depends on that to be able to diagnose corruption instead of crashing
 *     on it.
 *   - Every WRITE path (withExecGraphMutation(), and appendEvent() as its
 *     thin wrapper) is strict and transactional: it takes an exclusive
 *     cross-process file lock, re-reads the ledger with the STRICT reader
 *     (readLedgerEventsStrict — throws ExecGraphLedgerCorruptError on the
 *     first malformed line instead of silently skipping it), and throws
 *     ExecGraphPersistError if the append itself fails. A caller can no
 *     longer observe a "success" that didn't actually persist. Only the
 *     best-effort graph.json cache write after a successful append stays
 *     loud-but-non-fatal (console.error, never throws) — a stale snapshot
 *     cache is always recoverable via readLedgerEvents()+rebuildSnapshot();
 *     the ledger itself is the only thing that must never lie.
 *
 * IDEMPOTENCY / RECONCILIATION: appendEvent() special-cases 'task-created' —
 * if a task with the same idempotencyKey already exists in the current
 * graph, NO new event is written; the existing task's id is returned
 * instead. This is the guarantee that lets exec-graph/api.ts's importTask()
 * be called twice for the same legacy (source.kind, source.ref) pair and
 * only ever produce ONE active task. As of the M3D cutover this check runs
 * INSIDE the locked transaction (withExecGraphMutation), so two concurrent
 * appendEvent() calls for the same idempotencyKey can no longer both observe
 * "not yet created" and both write.
 */

import {
  appendFileSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { resolveMigratingStateDir } from '../atlas/state-root.js';
import {
  type Goal,
  type Task,
  type LedgerEvent,
  type NewLedgerEvent,
  ledgerEventSchema,
  graphSnapshotFileSchema,
} from './contracts.js';

export interface GraphSnapshot {
  goals: Record<string, Goal>;
  tasks: Record<string, Task>;
}

export const EMPTY_SNAPSHOT: GraphSnapshot = { goals: {}, tasks: {} };

const DUNDER_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
function isSafeKey(key: string): boolean {
  return !DUNDER_KEYS.has(key);
}

/**
 * Resolve state/exec-graph/. Candidates in order:
 *   1. ATLAS_EXEC_GRAPH_DIR (explicit override — tests point this at a temp dir)
 *   2. <ATLAS_STATE_ROOT>/exec-graph once shared-root routing is explicit
 *   3. <cwd>/state/exec-graph, IF <cwd> looks like the repo root (has package.json)
 *   4. walk up from this module's dir looking for package.json, then <that dir>/state/exec-graph
 *   5. last resort: <cwd>/state/exec-graph anyway
 * The target directory itself need not exist yet (first run creates it) —
 * unlike policy.ts's resolvePolicyPath(), which looks for an existing file,
 * this looks for the repo-root LANDMARK (package.json) so it works before
 * state/exec-graph/ has ever been created.
 */
function resolveLegacyExecGraphDir(): string {
  const cwdCandidate = resolve(process.cwd(), 'state', 'exec-graph');
  if (existsSync(resolve(process.cwd(), 'package.json'))) return cwdCandidate;

  let dir = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 6; i++) {
    if (existsSync(resolve(dir, 'package.json'))) {
      return resolve(dir, 'state', 'exec-graph');
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return cwdCandidate;
}

export function resolveExecGraphDir(): string {
  return resolveMigratingStateDir('exec-graph', resolveLegacyExecGraphDir);
}

export function ledgerPath(): string {
  return resolve(resolveExecGraphDir(), 'ledger.jsonl');
}

export function snapshotPath(): string {
  return resolve(resolveExecGraphDir(), 'graph.json');
}

// ── Fold ─────────────────────────────────────────────────────────────────

/** The one place a single event is folded into a snapshot. Pure, never throws. */
export function applyEventToSnapshot(snapshot: GraphSnapshot, event: LedgerEvent): GraphSnapshot {
  switch (event.kind) {
    case 'goal-created': {
      const g = event.payload.goal;
      if (!isSafeKey(g.id)) {
        console.error(`[exec-graph] refusing unsafe goal id '${g.id}' in event ${event.eventId}`);
        return snapshot;
      }
      return { ...snapshot, goals: { ...snapshot.goals, [g.id]: g } };
    }
    case 'task-created': {
      const t = event.payload.task;
      if (!isSafeKey(t.id)) {
        console.error(`[exec-graph] refusing unsafe task id '${t.id}' in event ${event.eventId}`);
        return snapshot;
      }
      return { ...snapshot, tasks: { ...snapshot.tasks, [t.id]: t } };
    }
    case 'transition': {
      const { taskId, transition } = event.payload;
      if (!isSafeKey(taskId)) {
        console.error(`[exec-graph] refusing unsafe task id '${taskId}' in event ${event.eventId}`);
        return snapshot;
      }
      const existing = snapshot.tasks[taskId];
      if (!existing) {
        console.error(`[exec-graph] transition event ${event.eventId} references unknown task ${taskId} — skipping`);
        return snapshot;
      }
      const nextTask: Task = {
        ...existing,
        status: transition.to,
        transitions: [...existing.transitions, transition],
      };
      return { ...snapshot, tasks: { ...snapshot.tasks, [taskId]: nextTask } };
    }
    case 'evidence-added': {
      const { taskId, evidence } = event.payload;
      if (!isSafeKey(taskId)) {
        console.error(`[exec-graph] refusing unsafe task id '${taskId}' in event ${event.eventId}`);
        return snapshot;
      }
      const existing = snapshot.tasks[taskId];
      if (!existing) {
        console.error(`[exec-graph] evidence-added event ${event.eventId} references unknown task ${taskId} — skipping`);
        return snapshot;
      }
      const nextTask: Task = { ...existing, evidence: [...existing.evidence, evidence] };
      return { ...snapshot, tasks: { ...snapshot.tasks, [taskId]: nextTask } };
    }
    case 'owner-reassigned': {
      // Owner-only mutation — deliberately does NOT touch status or push a
      // fake Transition (see contracts.ts's ownerReassignedPayloadSchema doc):
      // the audit trail for a reassignment lives in the ledger event itself,
      // not in task.transitions (which is reserved for real status moves).
      const { taskId, to } = event.payload;
      if (!isSafeKey(taskId)) {
        console.error(`[exec-graph] refusing unsafe task id '${taskId}' in event ${event.eventId}`);
        return snapshot;
      }
      const existing = snapshot.tasks[taskId];
      if (!existing) {
        console.error(`[exec-graph] owner-reassigned event ${event.eventId} references unknown task ${taskId} — skipping`);
        return snapshot;
      }
      const nextTask: Task = { ...existing, owner: to };
      return { ...snapshot, tasks: { ...snapshot.tasks, [taskId]: nextTask } };
    }
    default: {
      // Exhaustiveness guard — a new LedgerEvent kind added to contracts.ts
      // without a fold case here is a build-time error, not a silent no-op.
      const _exhaustive: never = event;
      return _exhaustive;
    }
  }
}

export function foldEvents(events: LedgerEvent[]): GraphSnapshot {
  return events.reduce(applyEventToSnapshot, { goals: {}, tasks: {} } as GraphSnapshot);
}

// ── Ledger reads (fail-safe legacy — used by `atlas graph verify`) ────────

/** Reads + parses ledger.jsonl. Malformed lines are skipped + console.error'd — never throws. */
export function readLedgerEvents(): LedgerEvent[] {
  const path = ledgerPath();
  if (!existsSync(path)) return [];

  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch (err) {
    console.error(`[exec-graph] failed to read ledger file ${path}: ${(err as Error)?.message ?? err}`);
    return [];
  }

  const events: LedgerEvent[] = [];
  const lines = raw.split(/\r?\n/);
  lines.forEach((line, idx) => {
    const trimmed = line.trim();
    if (!trimmed) return;

    let parsedJson: unknown;
    try {
      parsedJson = JSON.parse(trimmed);
    } catch (err) {
      console.error(`[exec-graph] skipping malformed ledger line ${idx + 1} in ${path}: invalid JSON — ${(err as Error)?.message ?? err}`);
      return;
    }

    const result = ledgerEventSchema.safeParse(parsedJson);
    if (!result.success) {
      console.error(`[exec-graph] skipping malformed ledger line ${idx + 1} in ${path}: ${result.error.issues.map((i) => i.message).join('; ')}`);
      return;
    }
    events.push(result.data);
  });

  return events;
}

/** Pure fold of the WHOLE ledger. This is the ground truth `atlas graph verify` compares against. */
export function rebuildSnapshot(): GraphSnapshot {
  return foldEvents(readLedgerEvents());
}

function snapshotToFile(s: GraphSnapshot) {
  return {
    goals: Object.values(s.goals),
    tasks: Object.values(s.tasks),
  };
}

function snapshotFromFile(raw: { goals: Goal[]; tasks: Task[] }): GraphSnapshot {
  const goals: Record<string, Goal> = {};
  const tasks: Record<string, Task> = {};
  for (const g of raw.goals) {
    if (isSafeKey(g.id)) goals[g.id] = g;
  }
  for (const t of raw.tasks) {
    if (isSafeKey(t.id)) tasks[t.id] = t;
  }
  return { goals, tasks };
}

/**
 * Strict on-disk snapshot read: null if the file is missing, unparseable, or
 * fails schema validation. Unlike readGraph(), this does NOT fall back to a
 * ledger rebuild — it's the "what is actually on disk right now" primitive
 * `atlas graph verify` needs in order to be a meaningful check.
 */
export function readSnapshotFile(): GraphSnapshot | null {
  const path = snapshotPath();
  if (!existsSync(path)) return null;
  try {
    const raw = JSON.parse(readFileSync(path, 'utf8'));
    const result = graphSnapshotFileSchema.safeParse(raw);
    if (!result.success) return null;
    return snapshotFromFile(result.data);
  } catch {
    return null;
  }
}

/** Snapshot if valid on disk, else a full rebuild from the ledger. Never throws. */
export function readGraph(): GraphSnapshot {
  const fromDisk = readSnapshotFile();
  if (fromDisk) return fromDisk;
  return rebuildSnapshot();
}

/** Order-independent structural equality — used by `atlas graph verify`. */
export function snapshotsEqual(a: GraphSnapshot, b: GraphSnapshot): boolean {
  const canon = (s: GraphSnapshot) =>
    JSON.stringify({
      goals: Object.values(s.goals).sort((x, y) => x.id.localeCompare(y.id)),
      tasks: Object.values(s.tasks).sort((x, y) => x.id.localeCompare(y.id)),
    });
  return canon(a) === canon(b);
}

// ── Ledger reads (strict — used by the mutation transaction) ─────────────

/**
 * Same parse as readLedgerEvents(), but THROWS ExecGraphLedgerCorruptError on
 * the first malformed line instead of skipping it. This is what
 * withExecGraphMutation() reads before folding in a new event — a mutation
 * must never be computed against a snapshot that silently dropped part of
 * the ledger.
 */
export function readLedgerEventsStrict(): LedgerEvent[] {
  const path = ledgerPath();
  if (!existsSync(path)) return [];

  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch (err) {
    throw new ExecGraphLedgerCorruptError(
      `exec-graph: failed to read ledger file ${path}: ${(err as Error)?.message ?? err}`,
    );
  }

  const events: LedgerEvent[] = [];
  const lines = raw.split(/\r?\n/);
  for (let idx = 0; idx < lines.length; idx++) {
    const trimmed = lines[idx].trim();
    if (!trimmed) continue;

    let parsedJson: unknown;
    try {
      parsedJson = JSON.parse(trimmed);
    } catch (err) {
      throw new ExecGraphLedgerCorruptError(
        `exec-graph: malformed ledger line ${idx + 1} in ${path}: invalid JSON — ${(err as Error)?.message ?? err}`,
      );
    }

    const result = ledgerEventSchema.safeParse(parsedJson);
    if (!result.success) {
      throw new ExecGraphLedgerCorruptError(
        `exec-graph: malformed ledger line ${idx + 1} in ${path}: ${result.error.issues.map((i) => i.message).join('; ')}`,
      );
    }
    events.push(result.data);
  }

  return events;
}

/** Strict full-ledger fold — throws ExecGraphLedgerCorruptError instead of skipping corruption. */
export function rebuildSnapshotStrict(): GraphSnapshot {
  return foldEvents(readLedgerEventsStrict());
}

// ── Cross-process exclusive lock ──────────────────────────────────────────

/** Thrown when the exclusive lock can't be acquired within its timeout. */
export class ExecGraphLockTimeoutError extends Error {
  readonly code = 'exec_graph_lock_timeout' as const;
  constructor(message: string) {
    super(message);
    this.name = 'ExecGraphLockTimeoutError';
  }
}

/** Thrown when a ledger append inside a locked transaction fails to persist. */
export class ExecGraphPersistError extends Error {
  readonly code = 'exec_graph_persist_failed' as const;
  constructor(message: string) {
    super(message);
    this.name = 'ExecGraphPersistError';
  }
}

/** Thrown by the strict readers when the ledger contains a malformed line. */
export class ExecGraphLedgerCorruptError extends Error {
  readonly code = 'exec_graph_ledger_corrupt' as const;
  constructor(message: string) {
    super(message);
    this.name = 'ExecGraphLedgerCorruptError';
  }
}

const LOCK_RETRY_MS = 25;
const LOCK_STALE_MS = 30_000;
/** How long a caller will wait to acquire the exclusive lock before ExecGraphLockTimeoutError. */
export const LOCK_ACQUIRE_TIMEOUT_MS = 5_000;

/** Synchronous sleep — Atomics.wait blocks the calling thread without a busy loop. */
function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * Acquire an exclusive lock via atomic `open(path, 'wx')` (fails with EEXIST
 * if the lock file already exists). A lock file older than LOCK_STALE_MS is
 * treated as abandoned (crashed holder) and reclaimed.
 */
function acquireExclusiveLock(lockPath: string, timeoutMs = LOCK_ACQUIRE_TIMEOUT_MS): number {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      return openSync(lockPath, 'wx');
    } catch (err) {
      const code = (err as NodeJS.ErrnoException)?.code;
      if (code !== 'EEXIST') throw err;

      try {
        const st = statSync(lockPath);
        if (Date.now() - st.mtimeMs > LOCK_STALE_MS) {
          try {
            unlinkSync(lockPath);
          } catch {
            // Raced with another reclaimer/the real holder releasing — fall through to retry.
          }
          continue;
        }
      } catch {
        // Lock file vanished between the EEXIST and the stat (holder released
        // it concurrently) — retry immediately, the next open() will likely win.
        continue;
      }

      if (Date.now() >= deadline) {
        throw new ExecGraphLockTimeoutError(
          `exec-graph: timed out after ${timeoutMs}ms waiting for the exclusive lock at ${lockPath}`,
        );
      }
      sleepSync(LOCK_RETRY_MS);
    }
  }
}

function releaseExclusiveLock(lockPath: string, fd: number): void {
  try {
    closeSync(fd);
  } catch {
    // Already closed.
  }
  try {
    unlinkSync(lockPath);
  } catch {
    // Already gone (e.g. reclaimed by a timed-out waiter after a crash) — fine.
  }
}

/**
 * Generic synchronous cross-process mutual exclusion via an exclusive-create
 * lock file in `dir`. Shared by exec-graph's ledger transaction
 * (withExecGraphMutation, below) and atlas/instance-lease.ts's lease
 * read-modify-write.
 */
export function withExclusiveFileLock<T>(dir: string, lockFileName: string, fn: () => T): T {
  mkdirSync(dir, { recursive: true });
  const lockPath = resolve(dir, lockFileName);
  const fd = acquireExclusiveLock(lockPath);
  try {
    return fn();
  } finally {
    releaseExclusiveLock(lockPath, fd);
  }
}

// ── Writes ───────────────────────────────────────────────────────────────

/**
 * The ONE place an exec-graph mutation happens. Acquires the exclusive
 * ledger lock, re-reads the ledger with the STRICT reader, calls `fn` with
 * that just-read snapshot (fn is pure: it validates/computes and returns the
 * NewLedgerEvent[] to persist plus an arbitrary caller value), appends each
 * event inside the lock (throwing ExecGraphPersistError on failure — never a
 * swallowed partial success), then writes graph.json as a best-effort cache
 * (console.error only — a stale cache is always recoverable from the
 * ledger). The lock is always released via `finally`.
 *
 * `fn` must NOT call appendEvent()/addEvidence()/any other function that
 * itself calls withExecGraphMutation() — the lock is not reentrant, so that
 * would deadlock. Build any extra events (e.g. evidence-added from a
 * --evidence move) directly as NewLedgerEvent objects instead.
 */
export function withExecGraphMutation<T>(
  fn: (snapshot: GraphSnapshot) => { events: NewLedgerEvent[]; value: T },
): { value: T; events: LedgerEvent[]; snapshot: GraphSnapshot } {
  const dir = resolveExecGraphDir();
  return withExclusiveFileLock(dir, 'ledger.lock', () => {
    const snapshot = rebuildSnapshotStrict();
    const { events: newEvents, value } = fn(snapshot);

    let nextSnapshot = snapshot;
    const persisted: LedgerEvent[] = [];
    for (const input of newEvents) {
      const event = ledgerEventSchema.parse({ eventId: randomUUID(), ...input });
      nextSnapshot = applyEventToSnapshot(nextSnapshot, event);
      try {
        appendFileSync(resolve(dir, 'ledger.jsonl'), `${JSON.stringify(event)}\n`, 'utf8');
      } catch (err) {
        throw new ExecGraphPersistError(
          `exec-graph: failed to append ledger event ${event.eventId} (${event.kind}) to ${dir} — event is NOT durably recorded: ${(err as Error)?.message ?? err}`,
        );
      }
      persisted.push(event);
    }

    try {
      writeFileSync(resolve(dir, 'graph.json'), `${JSON.stringify(snapshotToFile(nextSnapshot), null, 2)}\n`, 'utf8');
    } catch (err) {
      console.error(
        `[exec-graph] failed to write snapshot cache after a successful append — on-disk graph.json is stale; 'atlas graph verify' will catch this until the next successful write: ${(err as Error)?.message ?? err}`,
      );
    }

    return { value, events: persisted, snapshot: nextSnapshot };
  });
}

export interface AppendResult {
  /** True if this was a task-created event deduped against an existing idempotencyKey (no new event written). */
  deduped: boolean;
  /** The persisted event, or null when deduped. */
  event: LedgerEvent | null;
  /** Best-known snapshot after this call (current graph if deduped, else the updated one). */
  snapshot: GraphSnapshot;
  /** For task-created events: the resulting (new or pre-existing) task id. */
  taskId?: string;
}

/**
 * Append one event to the ledger and refresh graph.json. Enforces the
 * task-created idempotency/reconciliation guarantee (see module doc). Thin
 * wrapper over withExecGraphMutation() — the dedup checks run inside the
 * locked transaction so two concurrent callers can never both "win".
 */
export function appendEvent(input: NewLedgerEvent): AppendResult {
  const { events, snapshot, value } = withExecGraphMutation((snap) => {
    if (input.kind === 'goal-created') {
      const goalId = input.payload.goal.id;
      if (snap.goals[goalId]) {
        return { events: [], value: { deduped: true, taskId: undefined as string | undefined } };
      }
    }

    if (input.kind === 'task-created') {
      const key = input.payload.task.idempotencyKey;
      const existing = Object.values(snap.tasks).find((t) => t.idempotencyKey === key);
      if (existing) {
        return { events: [], value: { deduped: true, taskId: existing.id as string | undefined } };
      }
    }

    const taskId = input.kind === 'task-created' ? input.payload.task.id : undefined;
    return { events: [input], value: { deduped: false, taskId } };
  });

  if (value.deduped) {
    return { deduped: true, event: null, snapshot, taskId: value.taskId };
  }
  return { deduped: false, event: events[0] ?? null, snapshot, taskId: value.taskId };
}
