/**
 * Chief-of-Staff facts — a PURE read-model/projection over exec-graph +
 * control-plane + spend. Writes nothing; not an authority. Injectable
 * providers for tests.
 */

import type { Task, TaskStatus } from '../../exec-graph/contracts.js';
import { statusSummary as liveStatusSummary, listTasks as liveListTasks } from '../../exec-graph/api.js';
import { getControlState } from '../control-plane.js';
import { getDailySpend } from '../spend-tracker.js';

export interface WaitingItem {
  taskId: string;
  title: string;
  status: TaskStatus;
  owner: string;
  ageHours: number;
}

export interface ShippedItem {
  taskId: string;
  title: string;
  status: 'verified' | 'closed';
}

export interface CosFacts {
  /** escalated/blocked/evidence-submitted — waiting on decision/verification. */
  waiting: WaitingItem[];
  /** verified + closed. */
  shipped: ShippedItem[];
  counts: Record<TaskStatus, number>;
  controlMode: 'active' | 'paused' | 'stopped';
  spend: { costUsd: number; calls: number; tokens: number };
  generatedAt: string;
}

export interface CosFactProviders {
  statusSummary: () => { counts: Record<TaskStatus, number>; waiting: Task[] };
  listTasks: (filter?: { status?: TaskStatus }) => Task[];
  controlMode: () => 'active' | 'paused' | 'stopped';
  spend: () => { costUsd: number; calls: number; tokensIn: number; tokensOut: number };
  /** ISO timestamp of "now". */
  now: () => string;
}

const DEFAULT_PROVIDERS: CosFactProviders = {
  statusSummary: liveStatusSummary,
  listTasks: liveListTasks,
  controlMode: () => getControlState().mode,
  spend: getDailySpend,
  now: () => new Date().toISOString(),
};

const MS_PER_HOUR = 3_600_000;

/**
 * Hours since the task's last transition (falls back to createdAt when
 * transitions is empty). Rounded to 1 decimal; clamped to 0 on a
 * NaN/negative parse (clock skew or malformed timestamps never produce a
 * negative or garbage age). Exported so ./gather.ts's stuck-task candidate
 * reader uses the identical age computation instead of a second copy.
 */
export function ageHoursSince(task: Task, nowIso: string): number {
  const lastTs = task.transitions.length > 0
    ? task.transitions[task.transitions.length - 1].ts
    : task.createdAt;
  const diffMs = Date.parse(nowIso) - Date.parse(lastTs);
  const hours = diffMs / MS_PER_HOUR;
  if (!Number.isFinite(hours) || hours < 0) return 0;
  return Math.round(hours * 10) / 10;
}

function toWaitingItem(task: Task, nowIso: string): WaitingItem {
  return {
    taskId: task.id,
    title: task.title,
    status: task.status,
    owner: task.owner,
    ageHours: ageHoursSince(task, nowIso),
  };
}

function toShippedItem(task: Task, status: 'verified' | 'closed'): ShippedItem {
  return { taskId: task.id, title: task.title, status };
}

/**
 * Gather the current Chief-of-Staff facts snapshot. Pure projection: reads
 * from the injected (or live default) providers and returns a plain data
 * object — never mutates its inputs, never writes anything back to
 * exec-graph/control-plane/spend state.
 */
export function gatherCosFacts(providers?: Partial<CosFactProviders>): CosFacts {
  const p: CosFactProviders = { ...DEFAULT_PROVIDERS, ...providers };
  const nowIso = p.now();
  const summary = p.statusSummary();

  const waiting = summary.waiting.map((t) => toWaitingItem(t, nowIso));
  const shipped = [
    ...p.listTasks({ status: 'verified' }).map((t) => toShippedItem(t, 'verified')),
    ...p.listTasks({ status: 'closed' }).map((t) => toShippedItem(t, 'closed')),
  ];
  const spend = p.spend();

  return {
    waiting,
    shipped,
    counts: summary.counts,
    controlMode: p.controlMode(),
    spend: { costUsd: spend.costUsd, calls: spend.calls, tokens: spend.tokensIn + spend.tokensOut },
    generatedAt: nowIso,
  };
}
