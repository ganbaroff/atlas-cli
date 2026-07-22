/**
 * goal-runner/budgets.ts — persisted budget tracking + circuit breaker.
 *
 * Per Round 16 binding amendment item 2: budgets persist across restart,
 * replanning cannot reset any budget, no-progress circuit breaker halts
 * before repeated equivalent attempts, one active lease per goal.
 */

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { GoalBudget, GoalRunnerConfig } from './types.js';

function budgetDir(): string {
  const dir = process.env.ATLAS_GOAL_BUDGET_DIR ?? resolve('state/goal-budgets');
  mkdirSync(dir, { recursive: true });
  return dir;
}

function budgetPath(goalId: string): string {
  return join(budgetDir(), `${goalId}.json`);
}

let tmpCounter = 0;
function writeAtomic(filePath: string, data: string): void {
  tmpCounter++;
  const tmp = `${filePath}.${process.pid}-${tmpCounter}.tmp`;
  writeFileSync(tmp, data, 'utf8');
  renameSync(tmp, filePath);
}

export function createBudget(goalId: string, config: GoalRunnerConfig): GoalBudget {
  const budget: GoalBudget = {
    goalId,
    startedAt: new Date().toISOString(),
    taskAttempts: {},
    totalAttempts: 0,
    totalTasksCreated: 0,
    decompositionRounds: 0,
    attemptFingerprints: [],
    config,
  };
  writeAtomic(budgetPath(goalId), JSON.stringify(budget, null, 2));
  return budget;
}

export function loadBudget(goalId: string): GoalBudget | null {
  const path = budgetPath(goalId);
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch { return null; }
}

export function saveBudget(budget: GoalBudget): void {
  writeAtomic(budgetPath(budget.goalId), JSON.stringify(budget, null, 2));
}

export type BudgetCheckResult = { allowed: true } | { allowed: false; reason: string };

export function checkBudget(budget: GoalBudget, taskId?: string): BudgetCheckResult {
  const c = budget.config;

  const elapsed = Date.now() - new Date(budget.startedAt).getTime();
  if (elapsed > c.maxWallTimeMs) {
    return { allowed: false, reason: `wall time exceeded: ${elapsed}ms > ${c.maxWallTimeMs}ms` };
  }
  if (budget.totalAttempts >= c.maxTotalAttempts) {
    return { allowed: false, reason: `total attempts exceeded: ${budget.totalAttempts} >= ${c.maxTotalAttempts}` };
  }
  if (budget.totalTasksCreated > c.maxTotalTasks) {
    return { allowed: false, reason: `total tasks exceeded: ${budget.totalTasksCreated} > ${c.maxTotalTasks}` };
  }
  if (budget.decompositionRounds > c.maxDecompositionRounds) {
    return { allowed: false, reason: `decomposition rounds exceeded: ${budget.decompositionRounds} > ${c.maxDecompositionRounds}` };
  }
  if (taskId && (budget.taskAttempts[taskId] ?? 0) >= c.maxAttemptsPerTask) {
    return { allowed: false, reason: `task ${taskId} attempts exceeded: ${budget.taskAttempts[taskId]} >= ${c.maxAttemptsPerTask}` };
  }
  return { allowed: true };
}

export function recordAttempt(budget: GoalBudget, taskId: string, fingerprint: string): void {
  budget.totalAttempts++;
  budget.taskAttempts[taskId] = (budget.taskAttempts[taskId] ?? 0) + 1;
  budget.attemptFingerprints.push(fingerprint);
  saveBudget(budget);
}

/** True if the same fingerprint already appeared — no progress being made. */
export function checkCircuitBreaker(budget: GoalBudget, fingerprint: string): boolean {
  return budget.attemptFingerprints.includes(fingerprint);
}

/** Deterministic fingerprint for (task version, action plan, verdict/error). */
export function attemptFingerprint(taskId: string, actionPlanHash: string, verdictOrError: string): string {
  return createHash('sha256').update(`${taskId}:${actionPlanHash}:${verdictOrError}`).digest('hex').slice(0, 16);
}

// ── Lease management — one active goal at a time ────────────────────────

const LEASE_FILE = 'active-lease.json';

interface GoalLease {
  goalId: string;
  startedAt: string;
  pid: number;
}

export function acquireLease(goalId: string): boolean {
  const leasePath = join(budgetDir(), LEASE_FILE);
  if (existsSync(leasePath)) {
    try {
      const existing: GoalLease = JSON.parse(readFileSync(leasePath, 'utf8'));
      if (existing.goalId && existing.goalId !== goalId) return false;
    } catch { /* corrupt lease = acquirable */ }
  }
  writeAtomic(leasePath, JSON.stringify({ goalId, startedAt: new Date().toISOString(), pid: process.pid }));
  return true;
}

export function releaseLease(goalId: string): void {
  const leasePath = join(budgetDir(), LEASE_FILE);
  if (!existsSync(leasePath)) return;
  try {
    const existing: GoalLease = JSON.parse(readFileSync(leasePath, 'utf8'));
    if (existing.goalId === goalId) {
      writeFileSync(leasePath, '{}', 'utf8');
    }
  } catch { /* ignore */ }
}
