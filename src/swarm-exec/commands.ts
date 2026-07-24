/**
 * swarm-exec/commands.ts — thin, testable command functions behind the
 * operator CLI surface (`atlas swarm-exec intake|commit|run`, wired in
 * src/cli.ts). Each function here does exactly one step of the chain
 * documented in intake.ts / executor.ts's module docs:
 *
 *   1. intakeCommand — compileIntake() + writeDraft(): freeform text -> a
 *      persisted IntakeDraft. Never touches exec-graph.
 *   2. commitCommand — commitDraft(): a persisted draft -> a real exec-graph
 *      task (creating a goal first if the caller didn't supply one).
 *   3. runCommand — ensures the task is delegated to hand:swarm-local (via
 *      the SAME status walk src/__tests__/hands.test.ts's planTask() and
 *      src/__tests__/swarm-executor.test.ts's planAndDelegate() use:
 *      proposed -> accepted -> planned, then assignHand() takes planned ->
 *      delegated — no transition is invented here), then delegates to
 *      runSwarmForTask() for the actual run + deterministic verification.
 *
 * None of these functions print anything — they return plain data; src/cli.ts
 * is the only place output is formatted/printed, same convention as every
 * other exec-graph/hands CLI action (see the goal/task/graph/hand command
 * groups in cli.ts).
 *
 * Tests: ../__tests__/swarm-commands.test.ts.
 */

import { createGoal, getTask, moveTask } from '../exec-graph/api.js';
import { assignHand } from '../hands/exec-graph-adapter.js';
import { runSwarmForTask, type RunSwarmForTaskOptions, type RunSwarmForTaskResult } from './executor.js';
import { commitDraft, compileIntake, readDraft, writeDraft, type IntakeDraft, type IntakeOpts } from './intake.js';

const SWARM_HAND_ID = 'swarm-local';
const SWARM_HAND_OWNER = `hand:${SWARM_HAND_ID}`;

// ── intake ───────────────────────────────────────────────────────────────

export interface IntakeCommandResult {
  draftId: string;
  draftPath: string;
  draft: IntakeDraft;
}

/**
 * Compile freeform intent into a structured draft and persist it. Does NOT
 * create an exec-graph task — that's commitCommand()'s job, a separate,
 * explicit step (see intake.ts's module doc for why the two are never
 * collapsed into one).
 */
export function intakeCommand(intent: string, opts?: IntakeOpts): IntakeCommandResult {
  const draft = compileIntake(intent, opts);
  const draftPath = writeDraft(draft, opts);
  return { draftId: draft.draftId, draftPath, draft };
}

// ── commit ───────────────────────────────────────────────────────────────

export interface CommitCommandArgs {
  goalId?: string;
  actor?: string;
}

export interface CommitCommandResult {
  taskId: string;
  created: boolean;
  goalId: string;
}

/**
 * Commit a previously-written draft into a real exec-graph task. If
 * args.goalId is omitted, a new goal is created first (title = `intake:
 * <objective, truncated to 60 chars>`) and its id is used. Throws a clear
 * Error if the draft cannot be found (mirrors commitDraft()'s own message,
 * but raised here too so callers get the same failure whether or not a goal
 * had to be created first).
 */
export function commitCommand(
  draftId: string,
  args: CommitCommandArgs = {},
  opts?: IntakeOpts,
): CommitCommandResult {
  const draft = readDraft(draftId, opts);
  if (!draft) {
    throw new Error(
      `swarm commit: draft ${draftId} not found (run 'atlas swarm-exec intake <intent...>' first)`,
    );
  }

  const actor = args.actor ?? 'atlas';
  const goalId = args.goalId ?? createGoal({
    title: `intake: ${draft.objective.slice(0, 60)}`,
    actor,
  }).id;

  const { taskId, created } = commitDraft(draftId, { goalId, actor }, opts);
  return { taskId, created, goalId };
}

// ── run ──────────────────────────────────────────────────────────────────

export type RunCommandOpts = { actor?: string }
  & Pick<RunSwarmForTaskOptions, 'runSwarm' | 'controlAllows' | 'evaluate' | 'now' | 'runId' | 'policy' | 'bundleRootDir'>;

/**
 * Ensure `taskId` is delegated to hand:swarm-local, then run the swarm and
 * verify it through the Hand Contract (runSwarmForTask()).
 *
 * Assignment cases:
 *   - already owned by hand:swarm-local and status delegated/in-progress ->
 *     nothing to do, proceed straight to runSwarmForTask().
 *   - owned by 'atlas' -> walk the task's CURRENT status to 'planned' using
 *     only the legal transitions exec-graph/transitions.ts defines (proposed
 *     -> accepted -> planned; a task already at 'accepted' only needs the
 *     second hop; a task already at 'planned' needs no hop at all — this is
 *     the exact walk hands.test.ts's planTask() / swarm-executor.test.ts's
 *     planAndDelegate() perform), then assignHand(taskId, 'swarm-local', ...).
 *   - anything else (owned by a different hand, or an 'atlas'-owned task in
 *     a status this walk doesn't cover) -> throw a clear Error; this command
 *     never invents a transition to force its way to 'planned'.
 */
export async function runCommand(taskId: string, opts: RunCommandOpts = {}): Promise<RunSwarmForTaskResult> {
  const { actor = 'atlas', ...passthrough } = opts;

  const task = getTask(taskId);
  if (!task) {
    throw new Error(`swarm run: unknown task ${taskId}`);
  }

  const alreadyAssigned = task.owner === SWARM_HAND_OWNER
    && (task.status === 'delegated' || task.status === 'in-progress');

  if (!alreadyAssigned) {
    if (task.owner !== 'atlas') {
      throw new Error(
        `swarm run: task ${taskId} is owned by '${task.owner}' in status '${task.status}' — expected either `
        + `owner '${SWARM_HAND_OWNER}' in 'delegated'/'in-progress', or owner 'atlas' so this command can assign it`,
      );
    }

    if (task.status === 'proposed') {
      moveTask({ taskId, to: 'accepted', actor });
      moveTask({ taskId, to: 'planned', actor });
    } else if (task.status === 'accepted') {
      moveTask({ taskId, to: 'planned', actor });
    } else if (task.status !== 'planned') {
      throw new Error(
        `swarm run: task ${taskId} is owned by 'atlas' in status '${task.status}', which this command does not `
        + "know a legal walk to 'planned' from (only 'proposed', 'accepted', and 'planned' are supported) — "
        + 'move it manually first',
      );
    }

    assignHand(taskId, SWARM_HAND_ID, { actor, unattended: false });
  }

  return runSwarmForTask(taskId, { actor, ...passthrough });
}
