/**
 * goal-runner/runner.ts — bounded autonomous goal execution loop.
 *
 * Orchestrates: objective intake → decomposition → exec-graph tasks →
 * hand assignment → execution → receipt submission → verification.
 *
 * AUTHORITY: the goal-runner may call the verifier facade
 * (verifyAndTransition) and read its result, but cannot import the
 * privileged capability port, ledger/transitions internals, or write
 * state/exec-graph directly. It cannot choose verifier actor identity
 * or derive the final verdict from its own narrative. Final report is
 * rebuilt from exec-graph + verifier receipts.
 *
 * IMPORTS: only from exec-graph/api.js (public surface), hands/ adapters,
 * and goal-runner/ siblings. NEVER from the privileged capability port.
 */

import { createHash } from 'node:crypto';
import { createGoal, createTask, moveTask } from '../exec-graph/api.js';
import {
  assignHand,
  submitReceipt,
  verifyAndTransition,
  abortHandTask,
} from '../hands/exec-graph-adapter.js';
import { getHand } from '../hands/registry.js';
import { deriveEffectsFromHand, hasRedLine, redLineReason, isExternalTarget } from './red-line.js';
import {
  createBudget,
  saveBudget,
  checkBudget,
  recordAttempt,
  checkCircuitBreaker,
  attemptFingerprint,
  acquireLease,
  releaseLease,
} from './budgets.js';
import { notifyCeoResult, type NotifyOutcome } from '../atlas/notify.js';
import { effectivelyPaused } from '../atlas/control-plane.js';
import { DEFAULT_GOAL_RUNNER_CONFIG, type GoalRunnerConfig, type GoalReport, type TaskReport, type TaskPlan } from './types.js';
import type { BrowserAction } from '../hands/browser-actions.js';
import { BrowserSession } from '../hands/browser-adapter.js';

export interface GoalRunnerInput {
  objective: string;
  config?: Partial<GoalRunnerConfig>;
  handId?: string;
  taskPlans?: TaskPlan[];
  browserActions?: BrowserAction[];
  /** Injectable for testing — avoids real Telegram sends. */
  notifyCeo?: (kind: 'important', msg: string) => Promise<NotifyOutcome>;
}

function planHash(plan: TaskPlan): string {
  return createHash('sha256').update(JSON.stringify(plan)).digest('hex').slice(0, 16);
}

/**
 * Deterministic V0 decomposition: objective → one task for the designated hand.
 * Future versions may use LLM decomposition with bounded replanning.
 */
function decomposeObjective(objective: string, handId: string): TaskPlan[] {
  return [{
    taskTitle: objective,
    handId,
    effects: deriveEffectsFromHand(handId),
    actions: getHand(handId).allowedActions,
    acceptanceCriteria: `Task "${objective}" completed and verified by deterministic verifier`,
    proofSpec: 'browser-action receipt with all actions succeeded',
  }];
}

export async function runGoal(input: GoalRunnerInput): Promise<GoalReport> {
  const config: GoalRunnerConfig = { ...DEFAULT_GOAL_RUNNER_CONFIG, ...input.config };
  const notify = input.notifyCeo ?? ((kind: 'important', msg: string) => notifyCeoResult(kind, msg));

  const goal = createGoal({
    title: input.objective,
    source: { kind: 'exec-graph', ref: 'goal-runner' },
    actor: 'goal-runner',
  });

  if (!acquireLease(goal.id)) {
    return {
      goalId: goal.id,
      objective: input.objective,
      status: 'failed',
      tasksTotal: 0, tasksVerified: 0, tasksFailed: 0, tasksEscalated: 0,
      wallTimeMs: 0,
      details: [],
    };
  }

  const budget = createBudget(goal.id, config);
  const startTime = Date.now();
  const taskReports: TaskReport[] = [];

  try {
    const handId = input.handId ?? 'browser-foreground';
    const plans = input.taskPlans ?? decomposeObjective(input.objective, handId);
    budget.decompositionRounds = 1;
    budget.totalTasksCreated = plans.length;
    saveBudget(budget);

    // Acceptance/proof spec frozen before first execution (Round 16 item 2).
    const frozenAcceptance = plans.map(p => ({ title: p.taskTitle, criteria: p.acceptanceCriteria }));

    for (const plan of plans) {
      // ── Effective control re-check (M7: pause arriving mid-goal prevents next action) ──
      if (effectivelyPaused()) {
        const { task } = createTask({
          goalId: goal.id, title: plan.taskTitle,
          riskClass: 'low',
          source: { kind: 'exec-graph', ref: 'goal-runner' },
          actor: 'goal-runner',
        });
        moveTask({ taskId: task.id, to: 'accepted', actor: 'goal-runner' });
        moveTask({ taskId: task.id, to: 'escalated', actor: 'goal-runner',
          note: 'control paused — task blocked before execution' });
        taskReports.push({
          taskId: task.id, title: plan.taskTitle, handId: plan.handId,
          finalStatus: 'blocked', attempts: 0,
          verifierReason: 'control paused — task blocked before execution',
        });
        continue;
      }

      // ── Red-line check ────────────────────────────────────────
      if (hasRedLine(plan.effects)) {
        const { task } = createTask({
          goalId: goal.id,
          title: plan.taskTitle,
          riskClass: 'irreversible',
          source: { kind: 'exec-graph', ref: 'goal-runner' },
          actor: 'goal-runner',
        });
        moveTask({ taskId: task.id, to: 'accepted', actor: 'goal-runner' });
        moveTask({
          taskId: task.id, to: 'escalated', actor: 'goal-runner',
          note: redLineReason(plan.effects),
        });

        const reason = redLineReason(plan.effects);
        await notify('important',
          `Red-line halt: goal "${input.objective}" — ${reason}. Task ${task.id} escalated.`);

        taskReports.push({
          taskId: task.id, title: plan.taskTitle, handId: plan.handId,
          finalStatus: 'escalated', attempts: 0, verifierReason: reason,
        });
        continue;
      }

      // ── External target check for browser actions ─────────────
      if (input.browserActions) {
        const externalNav = input.browserActions.find(
          a => a.kind === 'navigate' && isExternalTarget((a as { url?: string }).url),
        );
        if (externalNav) {
          const { task } = createTask({
            goalId: goal.id, title: plan.taskTitle,
            riskClass: 'irreversible',
            source: { kind: 'exec-graph', ref: 'goal-runner' },
            actor: 'goal-runner',
          });
          moveTask({ taskId: task.id, to: 'accepted', actor: 'goal-runner' });
          moveTask({ taskId: task.id, to: 'escalated', actor: 'goal-runner',
            note: 'external browser target denied' });

          await notify('important',
            `Red-line halt: goal "${input.objective}" — external browser target detected.`);

          taskReports.push({
            taskId: task.id, title: plan.taskTitle, handId: plan.handId,
            finalStatus: 'escalated', attempts: 0,
          });
          continue;
        }
      }

      // ── Create exec-graph task ────────────────────────────────
      const { task } = createTask({
        goalId: goal.id, title: plan.taskTitle,
        riskClass: 'low',
        source: { kind: 'exec-graph', ref: 'goal-runner' },
        actor: 'goal-runner',
      });
      moveTask({ taskId: task.id, to: 'accepted', actor: 'goal-runner' });
      moveTask({ taskId: task.id, to: 'planned', actor: 'goal-runner' });

      // ── Budget check ──────────────────────────────────────────
      const budgetCheck = checkBudget(budget, task.id);
      if (!budgetCheck.allowed) {
        moveTask({ taskId: task.id, to: 'escalated', actor: 'goal-runner',
          note: budgetCheck.reason });
        taskReports.push({
          taskId: task.id, title: plan.taskTitle, handId: plan.handId,
          finalStatus: 'budget-exceeded', attempts: 0,
          verifierReason: budgetCheck.reason,
        });
        continue;
      }

      // ── Circuit breaker ───────────────────────────────────────
      const fp = attemptFingerprint(task.id, planHash(plan), 'initial');
      if (checkCircuitBreaker(budget, fp)) {
        moveTask({ taskId: task.id, to: 'escalated', actor: 'goal-runner',
          note: 'no-progress circuit breaker: repeated fingerprint' });
        taskReports.push({
          taskId: task.id, title: plan.taskTitle, handId: plan.handId,
          finalStatus: 'blocked', attempts: 0,
          verifierReason: 'no-progress circuit breaker',
        });
        continue;
      }
      recordAttempt(budget, task.id, fp);

      // ── Assign hand + execute ─────────────────────────────────
      try {
        assignHand(task.id, plan.handId, { actor: 'goal-runner' });

        if (plan.handId === 'browser-foreground' && input.browserActions) {
          const session = new BrowserSession();
          try {
            await session.launch();
            const results = await session.executeSequence(input.browserActions);

            submitReceipt(task.id, {
              taskId: task.id,
              handId: plan.handId,
              submittedBy: plan.handId,
              kind: 'browser-action',
              claimedResult: `goal-runner: executed ${results.length} browser actions`,
              actions: input.browserActions,
              actionResults: results,
            });

            const verdict = verifyAndTransition(task.id, { actor: 'goal-runner' });
            taskReports.push({
              taskId: task.id, title: plan.taskTitle, handId: plan.handId,
              finalStatus: verdict.finalStatus,
              attempts: 1,
              verifierReason: verdict.verdict.reason,
            });
          } finally {
            await session.close();
          }
        } else {
          abortHandTask(task.id, {
            actor: 'goal-runner',
            reason: `hand execution not yet implemented for ${plan.handId}`,
          });
          taskReports.push({
            taskId: task.id, title: plan.taskTitle, handId: plan.handId,
            finalStatus: 'blocked', attempts: 1,
            verifierReason: 'hand execution not yet implemented',
          });
        }
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        taskReports.push({
          taskId: task.id, title: plan.taskTitle, handId: plan.handId,
          finalStatus: 'failed', attempts: 1,
          verifierReason: errMsg,
        });
      }
    }

    // ── Goal-level verdict (derived projection, not self-assessed) ───
    const wallTimeMs = Date.now() - startTime;
    const tasksVerified = taskReports.filter(r => r.finalStatus === 'verified').length;
    const tasksFailed = taskReports.filter(r =>
      ['rejected', 'failed', 'blocked', 'budget-exceeded'].includes(r.finalStatus)).length;
    const tasksEscalated = taskReports.filter(r => r.finalStatus === 'escalated').length;

    let status: GoalReport['status'];
    if (tasksEscalated > 0) status = 'escalated';
    else if (taskReports.length === 0) status = 'failed';
    else if (tasksVerified === taskReports.length) status = 'completed';
    else if (tasksVerified > 0) status = 'partial';
    else status = 'failed';

    return {
      goalId: goal.id, objective: input.objective, status,
      tasksTotal: taskReports.length, tasksVerified, tasksFailed, tasksEscalated,
      wallTimeMs, details: taskReports,
    };
  } finally {
    releaseLease(goal.id);
  }
}
