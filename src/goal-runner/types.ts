/**
 * goal-runner/types.ts — shared types for the goal-runner module.
 *
 * Effect vocabulary, budget configuration, and report structures.
 * The goal-runner orchestrates exec-graph tasks through registered Hands,
 * bounded by per-goal budgets and red-line guards.
 */

/** Typed effect kinds — closed vocabulary from Round 16 binding amendment. */
export type EffectKind =
  // Red-line effects (irreversible / CEO-only)
  | 'submit' | 'credentials' | 'upload' | 'payment' | 'consent-oauth'
  | 'live-db-apply' | 'deploy' | 'merge-to-main' | 'deletion' | 'money'
  | 'external-send' | 'mutating-http' | 'account-change' | 'auth-change'
  | 'legal-acceptance' | 'dns-mutation' | 'env-secret-mutation'
  | 'prod-data-write' | 'remote-vcs-mutation' | 'destructive-overwrite'
  | 'install-uninstall' | 'paid-api'
  // Safe effects (autonomously executable)
  | 'browser-navigate' | 'browser-read' | 'browser-fill'
  | 'browser-click' | 'browser-select'
  | 'read-file' | 'grep' | 'git-readonly'
  | 'analyze' | 'swarm-run'
  // Unknown — deny by default
  | 'unknown';

export type EffectClass = 'safe' | 'red-line';

export interface TypedEffect {
  kind: EffectKind;
  class: EffectClass;
}

export interface TaskPlan {
  taskTitle: string;
  handId: string;
  effects: TypedEffect[];
  actions: string[];
  acceptanceCriteria: string;
  proofSpec: string;
}

export interface GoalRunnerConfig {
  maxAttemptsPerTask: number;
  maxTotalAttempts: number;
  maxTotalTasks: number;
  maxDecompositionRounds: number;
  maxGraphDepth: number;
  maxWallTimeMs: number;
}

export const DEFAULT_GOAL_RUNNER_CONFIG: GoalRunnerConfig = {
  maxAttemptsPerTask: 3,
  maxTotalAttempts: 10,
  maxTotalTasks: 10,
  maxDecompositionRounds: 2,
  maxGraphDepth: 3,
  maxWallTimeMs: 300_000,
};

export interface GoalBudget {
  goalId: string;
  startedAt: string;
  taskAttempts: Record<string, number>;
  totalAttempts: number;
  totalTasksCreated: number;
  decompositionRounds: number;
  attemptFingerprints: string[];
  config: GoalRunnerConfig;
}

export interface GoalReport {
  goalId: string;
  objective: string;
  status: 'completed' | 'partial' | 'failed' | 'escalated' | 'budget-exceeded';
  tasksTotal: number;
  tasksVerified: number;
  tasksFailed: number;
  tasksEscalated: number;
  wallTimeMs: number;
  details: TaskReport[];
}

export interface TaskReport {
  taskId: string;
  title: string;
  handId: string;
  finalStatus: string;
  attempts: number;
  verifierReason?: string;
}
