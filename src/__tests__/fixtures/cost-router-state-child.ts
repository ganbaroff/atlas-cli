import {
  acquirePremiumOwner,
  GoalRouterStateError,
  loadGoalRouterRecord,
} from '../../atlas/cost-router-state.js';

const [action, rootDir, goalId, now] = process.argv.slice(2);

if (
  action !== 'inspect-and-conflict' ||
  !rootDir ||
  !goalId ||
  !now
) {
  throw new Error(
    'usage: inspect-and-conflict <absolute-root> <goal-id> <now>'
  );
}

const record = loadGoalRouterRecord(goalId, { rootDir });
let conflictCode: string | undefined;

try {
  await acquirePremiumOwner(
    goalId,
    {
      phaseId: 'phase-child',
      taskId: 'task-child',
      seat: 'opus',
      acquiredAt: now,
      expiresAt: new Date(Date.parse(now) + 10 * 60_000).toISOString(),
    },
    now,
    { rootDir }
  );
} catch (error) {
  if (error instanceof GoalRouterStateError) {
    conflictCode = error.code;
  } else {
    throw error;
  }
}

if (conflictCode !== 'premium_owner_active') {
  throw new Error(
    `expected premium_owner_active, received ${String(conflictCode)}`
  );
}

process.stdout.write(JSON.stringify({
  goalId: record.goalId,
  revision: record.revision,
  activeTaskId: record.activePremiumOwner?.taskId,
  usedLocalSlices: record.budget.usedLocalSlices,
  usedPremiumEscalations: record.budget.usedPremiumEscalations,
  transportRetries: record.retryLedger['task-001']?.transportRetries,
  conflictCode,
}));
