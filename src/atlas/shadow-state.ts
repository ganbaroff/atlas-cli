/**
 * Read-only state comparison primitives for M3 shadow consolidation.
 *
 * Every path is explicit. This module never reads a live resolver, changes an
 * environment variable, copies state, or writes a receipt. Normal exec-graph
 * reads are intentionally availability-oriented and skip malformed lines;
 * migration evidence must instead reject the first malformed line.
 */

import { createHash } from 'node:crypto';
import { lstatSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import {
  graphSnapshotFileSchema,
  ledgerEventSchema,
  type GraphSnapshotFile,
  type LedgerEvent,
} from '../exec-graph/contracts.js';
import {
  foldEvents,
  snapshotsEqual,
  type GraphSnapshot,
} from '../exec-graph/ledger.js';

export type ShadowStateErrorCode =
  | 'directory_missing'
  | 'ledger_not_regular'
  | 'snapshot_not_regular'
  | 'ledger_empty'
  | 'ledger_invalid'
  | 'snapshot_invalid'
  | 'snapshot_diverged';

export class ShadowStateError extends Error {
  constructor(
    readonly code: ShadowStateErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'ShadowStateError';
  }
}

export interface ExecGraphInspection {
  readonly directory: string;
  readonly ledgerSha256: string;
  readonly snapshotSha256: string;
  readonly semanticSha256: string;
  readonly eventCount: number;
  readonly goalCount: number;
  readonly taskCount: number;
}

export interface ShadowStateComparison {
  readonly source: ExecGraphInspection;
  readonly candidate: ExecGraphInspection;
  readonly ledgerBytesEqual: boolean;
  readonly snapshotBytesEqual: boolean;
  readonly semanticStateEqual: boolean;
  readonly countsEqual: boolean;
  readonly accepted: boolean;
  readonly blocker: string | 'not-applicable';
  readonly nextAction: string;
  readonly liveResolverChanged: false;
}

function sha256(value: Buffer | string): string {
  return createHash('sha256').update(value).digest('hex');
}

function requireDirectory(directory: string): void {
  try {
    if (lstatSync(directory).isDirectory()) return;
  } catch {
    // Converted to the stable domain error below.
  }
  throw new ShadowStateError(
    'directory_missing',
    `shadow state directory is missing or is not a real directory: ${directory}`,
  );
}

function requireRegularFile(
  path: string,
  code: 'ledger_not_regular' | 'snapshot_not_regular',
): Buffer {
  try {
    if (!lstatSync(path).isFile()) {
      throw new ShadowStateError(code, `shadow state input is not a regular file: ${path}`);
    }
    return readFileSync(path);
  } catch (error) {
    if (error instanceof ShadowStateError) throw error;
    throw new ShadowStateError(code, `shadow state input is missing or unreadable: ${path}`);
  }
}

function parseLedger(raw: Buffer, path: string): LedgerEvent[] {
  const events: LedgerEvent[] = [];
  const eventIds = new Set<string>();
  const goalIds = new Set<string>();
  const taskIds = new Set<string>();
  const lines = raw.toString('utf8').split(/\r?\n/);

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index].trim();
    if (!line) continue;

    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      throw new ShadowStateError(
        'ledger_invalid',
        `shadow ledger line ${index + 1} is not valid JSON: ${path}`,
      );
    }

    const result = ledgerEventSchema.safeParse(parsed);
    if (!result.success) {
      throw new ShadowStateError(
        'ledger_invalid',
        `shadow ledger line ${index + 1} failed schema validation: ${path}`,
      );
    }

    const event = result.data;
    if (eventIds.has(event.eventId)) {
      throw new ShadowStateError(
        'ledger_invalid',
        `shadow ledger line ${index + 1} repeats event id ${event.eventId}: ${path}`,
      );
    }
    eventIds.add(event.eventId);

    if (event.kind === 'goal-created') {
      if (goalIds.has(event.payload.goal.id)) {
        throw new ShadowStateError(
          'ledger_invalid',
          `shadow ledger line ${index + 1} recreates goal ${event.payload.goal.id}: ${path}`,
        );
      }
      goalIds.add(event.payload.goal.id);
    } else if (event.kind === 'task-created') {
      if (!goalIds.has(event.payload.task.goalId) || taskIds.has(event.payload.task.id)) {
        throw new ShadowStateError(
          'ledger_invalid',
          `shadow ledger line ${index + 1} creates an orphan or duplicate task: ${path}`,
        );
      }
      taskIds.add(event.payload.task.id);
    } else if (!taskIds.has(event.payload.taskId)) {
      throw new ShadowStateError(
        'ledger_invalid',
        `shadow ledger line ${index + 1} references unknown task ${event.payload.taskId}: ${path}`,
      );
    }

    events.push(event);
  }

  if (events.length === 0) {
    throw new ShadowStateError(
      'ledger_empty',
      `shadow ledger contains no authoritative events: ${path}`,
    );
  }

  return events;
}

function parseSnapshot(raw: Buffer, path: string): GraphSnapshotFile {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.toString('utf8'));
  } catch {
    throw new ShadowStateError('snapshot_invalid', `shadow snapshot is not valid JSON: ${path}`);
  }

  const result = graphSnapshotFileSchema.safeParse(parsed);
  if (!result.success) {
    throw new ShadowStateError(
      'snapshot_invalid',
      `shadow snapshot failed schema validation: ${path}`,
    );
  }
  if (
    new Set(result.data.goals.map((goal) => goal.id)).size !== result.data.goals.length ||
    new Set(result.data.tasks.map((task) => task.id)).size !== result.data.tasks.length
  ) {
    throw new ShadowStateError(
      'snapshot_invalid',
      `shadow snapshot contains duplicate goal or task ids: ${path}`,
    );
  }
  return result.data;
}

function snapshotFromFile(snapshot: GraphSnapshotFile): GraphSnapshot {
  return {
    goals: Object.fromEntries(snapshot.goals.map((goal) => [goal.id, goal])),
    tasks: Object.fromEntries(snapshot.tasks.map((task) => [task.id, task])),
  };
}

function canonicalSnapshot(snapshot: GraphSnapshot): string {
  return JSON.stringify({
    goals: Object.values(snapshot.goals).sort((left, right) => left.id.localeCompare(right.id)),
    tasks: Object.values(snapshot.tasks).sort((left, right) => left.id.localeCompare(right.id)),
  });
}

export function inspectExecGraphDirectory(directory: string): ExecGraphInspection {
  const resolvedDirectory = resolve(directory);
  requireDirectory(resolvedDirectory);

  const ledgerFile = join(resolvedDirectory, 'ledger.jsonl');
  const snapshotFile = join(resolvedDirectory, 'graph.json');
  const ledgerRaw = requireRegularFile(ledgerFile, 'ledger_not_regular');
  const snapshotRaw = requireRegularFile(snapshotFile, 'snapshot_not_regular');
  const events = parseLedger(ledgerRaw, ledgerFile);
  const onDiskSnapshot = snapshotFromFile(parseSnapshot(snapshotRaw, snapshotFile));
  const rebuiltSnapshot = foldEvents(events);

  if (!snapshotsEqual(onDiskSnapshot, rebuiltSnapshot)) {
    throw new ShadowStateError(
      'snapshot_diverged',
      `shadow snapshot does not equal a strict ledger fold: ${resolvedDirectory}`,
    );
  }

  return {
    directory: resolvedDirectory,
    ledgerSha256: sha256(ledgerRaw),
    snapshotSha256: sha256(snapshotRaw),
    semanticSha256: sha256(canonicalSnapshot(rebuiltSnapshot)),
    eventCount: events.length,
    goalCount: Object.keys(rebuiltSnapshot.goals).length,
    taskCount: Object.keys(rebuiltSnapshot.tasks).length,
  };
}

export function compareExecGraphDirectories(
  sourceDirectory: string,
  candidateDirectory: string,
): ShadowStateComparison {
  const source = inspectExecGraphDirectory(sourceDirectory);
  const candidate = inspectExecGraphDirectory(candidateDirectory);
  const ledgerBytesEqual = source.ledgerSha256 === candidate.ledgerSha256;
  const snapshotBytesEqual = source.snapshotSha256 === candidate.snapshotSha256;
  const semanticStateEqual = source.semanticSha256 === candidate.semanticSha256;
  const countsEqual =
    source.eventCount === candidate.eventCount &&
    source.goalCount === candidate.goalCount &&
    source.taskCount === candidate.taskCount;
  const accepted = ledgerBytesEqual && semanticStateEqual && countsEqual;
  const failedPredicates: string[] = [];

  if (!ledgerBytesEqual) failedPredicates.push('ledger bytes differ');
  if (!semanticStateEqual) failedPredicates.push('semantic state differs');
  if (!countsEqual) failedPredicates.push('event/goal/task counts differ');

  return {
    source,
    candidate,
    ledgerBytesEqual,
    snapshotBytesEqual,
    semanticStateEqual,
    countsEqual,
    accepted,
    blocker: accepted ? 'not-applicable' : failedPredicates.join('; '),
    nextAction: accepted
      ? 'proceed to an isolated synthetic copy/replay proof; do not switch the live resolver'
      : 'repair the isolated candidate and rerun comparison; do not activate it',
    liveResolverChanged: false,
  };
}
