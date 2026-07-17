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
 * and appendEvent()'s incremental snapshot update calls the exact same
 * function on the single new event. That equality (incremental update ==
 * full rebuild) is what makes `atlas graph verify` meaningful.
 *
 * FAILURE BEHAVIOR (matches ../atlas/autonomy-loop.ts's writeAlertState /
 * readAlertState lesson):
 *   - Reads are fail-safe: a missing/corrupt graph.json falls back to a full
 *     ledger rebuild; a malformed JSONL line is skipped + console.error'd,
 *     the rest of the ledger still loads. Reads never throw.
 *   - Writes are loud-but-non-fatal: mkdir/append/write failures
 *     console.error (never silently swallowed) and never throw. A ledger
 *     append failure short-circuits before the snapshot write, so the two
 *     files are never allowed to drift further apart than an already-failed
 *     append necessarily causes.
 *
 * IDEMPOTENCY / RECONCILIATION: appendEvent() special-cases 'task-created' —
 * if a task with the same idempotencyKey already exists in the current
 * graph, NO new event is written; the existing task's id is returned
 * instead. This is the guarantee that lets exec-graph/api.ts's importTask()
 * be called twice for the same legacy (source.kind, source.ref) pair and
 * only ever produce ONE active task.
 */

import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
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
 *   2. <cwd>/state/exec-graph, IF <cwd> looks like the repo root (has package.json)
 *   3. walk up from this module's dir looking for package.json, then <that dir>/state/exec-graph
 *   4. last resort: <cwd>/state/exec-graph anyway
 * The target directory itself need not exist yet (first run creates it) —
 * unlike policy.ts's resolvePolicyPath(), which looks for an existing file,
 * this looks for the repo-root LANDMARK (package.json) so it works before
 * state/exec-graph/ has ever been created.
 */
export function resolveExecGraphDir(): string {
  const override = process.env.ATLAS_EXEC_GRAPH_DIR;
  if (override && override.trim()) return resolve(override.trim());

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

// ── Ledger reads ─────────────────────────────────────────────────────────

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

// ── Writes ───────────────────────────────────────────────────────────────

function persistEvent(dir: string, event: LedgerEvent, nextSnapshot: GraphSnapshot): void {
  try {
    mkdirSync(dir, { recursive: true });
    appendFileSync(resolve(dir, 'ledger.jsonl'), `${JSON.stringify(event)}\n`, 'utf8');
  } catch (err) {
    // Loud, not silent (same lesson as autonomy-loop's writeAlertState): a
    // failed append means this event is NOT durably recorded. Return before
    // touching the snapshot so graph.json never claims an event the ledger
    // doesn't have.
    console.error(
      `[exec-graph] failed to append ledger event ${event.eventId} (${event.kind}) to ${dir} — event is NOT durably recorded: ${(err as Error)?.message ?? err}`,
    );
    return;
  }

  try {
    writeFileSync(resolve(dir, 'graph.json'), `${JSON.stringify(snapshotToFile(nextSnapshot), null, 2)}\n`, 'utf8');
  } catch (err) {
    console.error(
      `[exec-graph] failed to write snapshot after event ${event.eventId} — on-disk graph.json is stale; 'atlas graph verify' will catch this until the next successful write: ${(err as Error)?.message ?? err}`,
    );
  }
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
 * task-created idempotency/reconciliation guarantee (see module doc).
 */
export function appendEvent(input: NewLedgerEvent): AppendResult {
  const dir = resolveExecGraphDir();
  const current = readGraph();

  if (input.kind === 'task-created') {
    const key = input.payload.task.idempotencyKey;
    const existing = Object.values(current.tasks).find((t) => t.idempotencyKey === key);
    if (existing) {
      return { deduped: true, event: null, snapshot: current, taskId: existing.id };
    }
  }

  const event = ledgerEventSchema.parse({ eventId: randomUUID(), ...input });
  const nextSnapshot = applyEventToSnapshot(current, event);
  persistEvent(dir, event, nextSnapshot);

  const taskId = input.kind === 'task-created' ? input.payload.task.id : undefined;
  return { deduped: false, event, snapshot: nextSnapshot, taskId };
}
