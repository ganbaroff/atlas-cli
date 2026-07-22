import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  appendFileSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';

import {
  type Task,
  type TaskStatus,
  taskSchema,
  TASK_STATUSES,
} from '../exec-graph/contracts.js';
import {
  applyTransition,
  LEGAL_TRANSITIONS,
  IllegalTransitionError,
  UnauthorizedTransitionError,
  InvalidTransitionError,
} from '../exec-graph/transitions.js';
import {
  resolveExecGraphDir,
  ledgerPath,
  readLedgerEvents,
  rebuildSnapshot,
  readSnapshotFile,
  snapshotsEqual,
} from '../exec-graph/ledger.js';
import {
  createGoal,
  createTask,
  importTask,
  moveTask,
  addEvidence,
  reassignOwner,
  ExecGraphOwnerReassignError,
  getTask,
  listTasks,
  statusSummary,
} from '../exec-graph/api.js';

const NOW = '2026-07-17T00:00:00.000Z';

function makeTask(status: TaskStatus, overrides: Partial<Task> = {}): Task {
  const needsRefs = status === 'verified' || status === 'evidence-submitted';
  const base = {
    id: 'tsk_test0000000000000001',
    goalId: 'gol_test0000000000000001',
    title: 'test task',
    source: { kind: 'exec-graph' as const, ref: 'test' },
    owner: 'atlas',
    status,
    riskClass: 'low' as const,
    idempotencyKey: 'exec-graph:test',
    // Always seed one evidence entry — harmless when not required, and
    // required for any test that lands the task (or a transition target) on
    // 'verified'/'closed'. Tests that specifically probe the evidenceRefs-
    // missing failure mode go through applyTransition() directly, which
    // fails at the transition-schema step before task.evidence is ever
    // consulted, so this default doesn't mask those.
    evidence: [{ ref: 'seed-ref', kind: 'other' as const }],
    createdAt: NOW,
    transitions: [{
      from: null,
      to: status,
      ts: NOW,
      actor: 'atlas',
      evidenceRefs: needsRefs ? ['seed-ref'] : undefined,
    }],
  };
  return taskSchema.parse({ ...base, ...overrides });
}

// ─── transitions.ts — pure state machine ───────────────────────────────────

describe('applyTransition — every legal transition in LEGAL_TRANSITIONS is accepted', () => {
  for (const [from, tos] of Object.entries(LEGAL_TRANSITIONS) as [TaskStatus, readonly TaskStatus[]][]) {
    for (const to of tos) {
      it(`${from} -> ${to}`, () => {
        const task = makeTask(from);
        const actor = from === 'escalated' ? 'ceo' : 'atlas';
        const evidenceRefs = to === 'verified' || to === 'evidence-submitted' ? ['proof-1'] : undefined;
        const next = applyTransition(task, to, { actor, ts: NOW, evidenceRefs });
        expect(next.status).toBe(to);
        expect(next.transitions.at(-1)).toMatchObject({ from, to, actor });
      });
    }
  }
});

describe('applyTransition — representative illegal transitions rejected', () => {
  it('proposed -> verified is illegal', () => {
    const task = makeTask('proposed');
    expect(() => applyTransition(task, 'verified', { actor: 'atlas', ts: NOW, evidenceRefs: ['x'] }))
      .toThrow(IllegalTransitionError);
  });

  it('closed -> anything is illegal (terminal, no exits — including escalated)', () => {
    const task = makeTask('closed');
    for (const to of TASK_STATUSES) {
      if (to === 'closed') continue;
      expect(() => applyTransition(task, to, { actor: 'ceo', ts: NOW, evidenceRefs: ['x'] }))
        .toThrow(IllegalTransitionError);
    }
  });

  it('verified -> in-progress is illegal', () => {
    const task = makeTask('verified');
    expect(() => applyTransition(task, 'in-progress', { actor: 'atlas', ts: NOW }))
      .toThrow(IllegalTransitionError);
  });
});

describe('applyTransition — evidenceRefs invariants', () => {
  it('transition to verified without evidenceRefs is rejected', () => {
    const task = makeTask('evidence-submitted');
    expect(() => applyTransition(task, 'verified', { actor: 'atlas', ts: NOW }))
      .toThrow(InvalidTransitionError);
  });

  it('transition to evidence-submitted without evidenceRefs is rejected', () => {
    const task = makeTask('in-progress');
    expect(() => applyTransition(task, 'evidence-submitted', { actor: 'atlas', ts: NOW }))
      .toThrow(InvalidTransitionError);
  });
});

describe('applyTransition — escalated exit is actor-gated (only ceo / external-cto)', () => {
  it('escalated exit allowed for actor "ceo"', () => {
    const task = makeTask('escalated');
    const next = applyTransition(task, 'in-progress', { actor: 'ceo', ts: NOW });
    expect(next.status).toBe('in-progress');
  });

  it('escalated exit allowed for actor "external-cto"', () => {
    const task = makeTask('escalated');
    const next = applyTransition(task, 'blocked', { actor: 'external-cto', ts: NOW });
    expect(next.status).toBe('blocked');
  });

  it('escalated exit rejected for actor "atlas"', () => {
    const task = makeTask('escalated');
    expect(() => applyTransition(task, 'in-progress', { actor: 'atlas', ts: NOW }))
      .toThrow(UnauthorizedTransitionError);
  });
});

describe('applyTransition — actor required', () => {
  it('empty-string actor is rejected', () => {
    const task = makeTask('proposed');
    expect(() => applyTransition(task, 'accepted', { actor: '', ts: NOW }))
      .toThrow(InvalidTransitionError);
  });

  it('whitespace-only actor is rejected', () => {
    const task = makeTask('proposed');
    expect(() => applyTransition(task, 'accepted', { actor: '   ', ts: NOW }))
      .toThrow(InvalidTransitionError);
  });
});

// ─── ledger.ts + api.ts — persisted behavior (temp ATLAS_EXEC_GRAPH_DIR) ──

describe('exec-graph ledger + api (isolated temp dir per test)', () => {
  let dir: string;
  let prior: string | undefined;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'atlas-exec-graph-'));
    prior = process.env.ATLAS_EXEC_GRAPH_DIR;
    process.env.ATLAS_EXEC_GRAPH_DIR = dir;
  });

  afterEach(() => {
    if (prior === undefined) delete process.env.ATLAS_EXEC_GRAPH_DIR;
    else process.env.ATLAS_EXEC_GRAPH_DIR = prior;
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  });

  it('resolveExecGraphDir() honors ATLAS_EXEC_GRAPH_DIR', () => {
    expect(resolveExecGraphDir()).toBe(resolve(dir));
  });

  it(
    'EB-0 DoD #5 — RECONCILIATION: importTask with the same source kind+ref twice returns the SAME task id, '
    + 'the ledger has exactly ONE task-created event for it, and listTasks shows exactly one task',
    () => {
      const goal = createGoal({ title: 'legacy import goal', actor: 'atlas', ts: NOW });

      const first = importTask({
        goalId: goal.id,
        title: 'legacy task',
        sourceKind: 'volaura-work-queue',
        sourceRef: 'wq-123',
        actor: 'atlas',
        ts: NOW,
      });
      const second = importTask({
        goalId: goal.id,
        title: 'legacy task (duplicate import attempt)',
        sourceKind: 'volaura-work-queue',
        sourceRef: 'wq-123',
        actor: 'atlas',
        ts: NOW,
      });

      expect(first.created).toBe(true);
      expect(second.created).toBe(false);
      expect(second.task.id).toBe(first.task.id);

      const events = readLedgerEvents();
      const taskCreatedForKey = events.filter(
        (e) => e.kind === 'task-created' && e.payload.task.idempotencyKey === 'volaura-work-queue:wq-123',
      );
      expect(taskCreatedForKey).toHaveLength(1);

      const tasks = listTasks({ goalId: goal.id });
      expect(tasks).toHaveLength(1);
      expect(tasks[0].id).toBe(first.task.id);
    },
  );

  it('createTask (non-import) is also idempotency-keyed and dedupes on a matching explicit idempotencyKey', () => {
    const goal = createGoal({ title: 'g', actor: 'atlas', ts: NOW });
    const first = createTask({ goalId: goal.id, title: 't1', idempotencyKey: 'exec-graph:same-key', actor: 'atlas', ts: NOW });
    const second = createTask({ goalId: goal.id, title: 't1-dup', idempotencyKey: 'exec-graph:same-key', actor: 'atlas', ts: NOW });
    expect(second.created).toBe(false);
    expect(second.task.id).toBe(first.task.id);
  });

  it('rebuildSnapshot() equals the on-disk snapshot after a multi-event sequence (create, move x N, evidence)', () => {
    const goal = createGoal({ title: 'chain goal', actor: 'atlas', ts: NOW });
    const { task } = createTask({ goalId: goal.id, title: 'chain task', actor: 'atlas', ts: NOW });

    moveTask({ taskId: task.id, to: 'accepted', actor: 'atlas', ts: NOW });
    moveTask({ taskId: task.id, to: 'planned', actor: 'atlas', ts: NOW });
    moveTask({ taskId: task.id, to: 'in-progress', actor: 'atlas', ts: NOW });
    addEvidence({ taskId: task.id, evidence: { ref: 'commit-abc123', kind: 'commit' }, actor: 'atlas', ts: NOW });
    moveTask({ taskId: task.id, to: 'evidence-submitted', actor: 'atlas', ts: NOW, evidenceRefs: ['commit-abc123'] });
    moveTask({ taskId: task.id, to: 'verified', actor: 'atlas', ts: NOW, evidenceRefs: ['commit-abc123'], _viaVerifier: true });
    moveTask({ taskId: task.id, to: 'closed', actor: 'ceo', ts: NOW });

    const onDisk = readSnapshotFile();
    const rebuilt = rebuildSnapshot();
    expect(onDisk).not.toBeNull();
    expect(snapshotsEqual(onDisk as NonNullable<typeof onDisk>, rebuilt)).toBe(true);
    expect(rebuilt.tasks[task.id].status).toBe('closed');
    expect(rebuilt.tasks[task.id].evidence.length).toBeGreaterThanOrEqual(1);
  });

  it('malformed JSONL line is skipped (console.error called) and surrounding valid lines still parse', () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const goal = createGoal({ title: 'g', actor: 'atlas', ts: NOW });
      appendFileSync(ledgerPath(), 'this is not valid json at all\n', 'utf8');
      const { task } = createTask({ goalId: goal.id, title: 'after-malformed', actor: 'atlas', ts: NOW });

      const events = readLedgerEvents();
      expect(errSpy).toHaveBeenCalled();
      expect(events).toHaveLength(2); // goal-created + task-created; malformed line excluded
      expect(events.some((e) => e.kind === 'goal-created' && e.payload.goal.id === goal.id)).toBe(true);
      expect(events.some((e) => e.kind === 'task-created' && e.payload.task.id === task.id)).toBe(true);
    } finally {
      errSpy.mockRestore();
    }
  });

  it('a dunder-prefixed id in an otherwise-well-formed payload is rejected safely — schema regex blocks it, no throw, no prototype pollution', () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const evilLine = JSON.stringify({
        eventId: 'evil-1',
        kind: 'task-created',
        ts: NOW,
        actor: 'atlas',
        payload: {
          task: {
            id: '__proto__',
            goalId: 'gol_test0000000000000001',
            title: 'evil',
            source: { kind: 'exec-graph', ref: 'test' },
            owner: 'atlas',
            status: 'proposed',
            riskClass: 'low',
            idempotencyKey: 'exec-graph:evil',
            evidence: [],
            createdAt: NOW,
            transitions: [{ from: null, to: 'proposed', ts: NOW, actor: 'atlas' }],
          },
        },
      });
      mkdirSync(resolveExecGraphDir(), { recursive: true });
      appendFileSync(ledgerPath(), `${evilLine}\n`, 'utf8');

      expect(() => readLedgerEvents()).not.toThrow();
      const events = readLedgerEvents();
      expect(events).toHaveLength(0); // '__proto__' fails taskIdSchema's 'tsk_' prefix regex -> whole event skipped
      expect(errSpy).toHaveBeenCalled();

      expect(() => rebuildSnapshot()).not.toThrow();
      const snap = rebuildSnapshot();
      expect(snap.tasks.__proto__ && Object.prototype.hasOwnProperty.call(snap.tasks, '__proto__')).toBeFalsy();
      // The shared Object prototype itself must not have been polluted.
      expect(({} as Record<string, unknown>).id).toBeUndefined();
      expect(({} as Record<string, unknown>).title).toBeUndefined();
    } finally {
      errSpy.mockRestore();
    }
  });

  it('snapshot write failure (ATLAS_EXEC_GRAPH_DIR points under a FILE, not a dir) logs via console.error and does not throw', () => {
    const blockerFile = join(dir, 'blocker-file');
    writeFileSync(blockerFile, 'x');
    const impossibleDir = join(blockerFile, 'exec-graph'); // blockerFile is a file, not a directory
    process.env.ATLAS_EXEC_GRAPH_DIR = impossibleDir;

    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      expect(() => createGoal({ title: 'g', actor: 'atlas', ts: NOW })).not.toThrow();
      expect(errSpy).toHaveBeenCalled();
    } finally {
      errSpy.mockRestore();
    }
  });

  it('moveTask promotes --evidence refs into task.evidence, satisfying the verified/closed evidence invariant end-to-end', () => {
    const goal = createGoal({ title: 'g', actor: 'atlas', ts: NOW });
    const { task } = createTask({ goalId: goal.id, title: 't', actor: 'atlas', ts: NOW });
    moveTask({ taskId: task.id, to: 'accepted', actor: 'atlas', ts: NOW });
    moveTask({ taskId: task.id, to: 'planned', actor: 'atlas', ts: NOW });
    moveTask({ taskId: task.id, to: 'in-progress', actor: 'atlas', ts: NOW });
    const submitted = moveTask({
      taskId: task.id,
      to: 'evidence-submitted',
      actor: 'atlas',
      ts: NOW,
      evidenceRefs: ['test-output:vitest-run-1'],
    });
    expect(submitted.evidence.some((e) => e.ref === 'test-output:vitest-run-1')).toBe(true);
    const verified = moveTask({
      taskId: task.id,
      to: 'verified',
      actor: 'atlas',
      ts: NOW,
      evidenceRefs: ['test-output:vitest-run-1'],
      _viaVerifier: true,
    });
    expect(verified.status).toBe('verified');
    expect(verified.evidence.length).toBeGreaterThanOrEqual(1);
  });

  it('moveTask on an unknown task id throws', () => {
    expect(() => moveTask({ taskId: 'tsk_doesnotexist00000000', to: 'accepted', actor: 'atlas', ts: NOW })).toThrow();
  });

  it('getTask / listTasks / statusSummary reflect current state', () => {
    const goal = createGoal({ title: 'g', actor: 'atlas', ts: NOW });
    const a = createTask({ goalId: goal.id, title: 'a', actor: 'atlas', ts: NOW, idempotencyKey: 'exec-graph:a' }).task;
    const b = createTask({ goalId: goal.id, title: 'b', actor: 'atlas', ts: NOW, idempotencyKey: 'exec-graph:b' }).task;
    moveTask({ taskId: b.id, to: 'accepted', actor: 'atlas', ts: NOW });
    moveTask({ taskId: b.id, to: 'escalated', actor: 'atlas', ts: NOW });

    expect(getTask(a.id)?.status).toBe('proposed');
    expect(getTask('tsk_doesnotexist00000000')).toBeUndefined();
    expect(listTasks({ status: 'proposed' })).toHaveLength(1);
    expect(listTasks({ status: 'escalated' })).toHaveLength(1);

    const summary = statusSummary();
    expect(summary.counts.proposed).toBe(1);
    expect(summary.counts.escalated).toBe(1);
    expect(summary.waiting.map((t) => t.id)).toContain(b.id);
    expect(summary.waiting.map((t) => t.id)).not.toContain(a.id);
  });

  // ─── reassignOwner — owner-reassignment primitive (Deliverable 1) ────────

  it('reassignOwner changes owner, NOT status (no fabricated transition)', () => {
    const goal = createGoal({ title: 'g', actor: 'atlas', ts: NOW });
    const { task } = createTask({ goalId: goal.id, title: 't', owner: 'atlas', actor: 'atlas', ts: NOW });
    expect(task.status).toBe('proposed');

    const reassigned = reassignOwner(task.id, 'volaura-product-chat', {
      actor: 'ceo',
      reason: 'OUT-OF-SCOPE FOR ATLAS — VOLAURA product decision',
      ts: NOW,
    });

    expect(reassigned.owner).toBe('volaura-product-chat');
    expect(reassigned.status).toBe('proposed'); // unchanged
    expect(reassigned.transitions).toHaveLength(task.transitions.length); // no fake transition appended

    const persisted = getTask(task.id);
    expect(persisted?.owner).toBe('volaura-product-chat');
    expect(persisted?.status).toBe('proposed');
  });

  it('ledger rebuild == on-disk snapshot after a reassign', () => {
    const goal = createGoal({ title: 'g', actor: 'atlas', ts: NOW });
    const { task } = createTask({ goalId: goal.id, title: 't', actor: 'atlas', ts: NOW });
    moveTask({ taskId: task.id, to: 'accepted', actor: 'atlas', ts: NOW });
    moveTask({ taskId: task.id, to: 'planned', actor: 'atlas', ts: NOW });
    moveTask({ taskId: task.id, to: 'delegated', actor: 'atlas', ts: NOW });
    moveTask({ taskId: task.id, to: 'escalated', actor: 'atlas', ts: NOW });

    // _viaVerifier:true — this test exercises the ledger/rebuild mechanics for an
    // arbitrary owner value (which happens to be hand:-prefixed); it is not simulating
    // the Hand Contract V0 adapter's real assignHand() flow, so it legitimately needs the
    // internal capability flag to get past api.ts's HandAuthorityError guard (see
    // hands.test.ts's dedicated Hole 1 regression tests for the guard itself).
    reassignOwner(task.id, 'hand:volaura', { actor: 'ceo', reason: 'delegated to hand', ts: NOW, _viaVerifier: true });

    const onDisk = readSnapshotFile();
    const rebuilt = rebuildSnapshot();
    expect(onDisk).not.toBeNull();
    expect(snapshotsEqual(onDisk as NonNullable<typeof onDisk>, rebuilt)).toBe(true);
    expect(rebuilt.tasks[task.id].owner).toBe('hand:volaura');
    expect(rebuilt.tasks[task.id].status).toBe('escalated'); // reassignment never touches status
  });

  it('reassignOwner rejects empty newOwner/actor/reason (typed error)', () => {
    const goal = createGoal({ title: 'g', actor: 'atlas', ts: NOW });
    const { task } = createTask({ goalId: goal.id, title: 't', actor: 'atlas', ts: NOW });

    expect(() => reassignOwner(task.id, '', { actor: 'ceo', reason: 'r', ts: NOW }))
      .toThrow(ExecGraphOwnerReassignError);
    expect(() => reassignOwner(task.id, '   ', { actor: 'ceo', reason: 'r', ts: NOW }))
      .toThrow(ExecGraphOwnerReassignError);
    expect(() => reassignOwner(task.id, 'new-owner', { actor: '', reason: 'r', ts: NOW }))
      .toThrow(ExecGraphOwnerReassignError);
    expect(() => reassignOwner(task.id, 'new-owner', { actor: 'ceo', reason: '', ts: NOW }))
      .toThrow(ExecGraphOwnerReassignError);
    expect(() => reassignOwner(task.id, 'new-owner', { actor: 'ceo', reason: '   ', ts: NOW }))
      .toThrow(ExecGraphOwnerReassignError);

    // None of the rejected calls should have mutated the task.
    expect(getTask(task.id)?.owner).toBe('atlas');
  });

  it('reassignOwner on an unknown task id throws a typed error (API boundary — never silently no-ops)', () => {
    expect(() => reassignOwner('tsk_doesnotexist00000000', 'new-owner', { actor: 'ceo', reason: 'r', ts: NOW }))
      .toThrow(ExecGraphOwnerReassignError);
  });

  it(
    'ledger FOLD layer: an owner-reassigned event referencing an unknown task id is skipped safely '
    + '(console.error, no throw, no phantom task) — mirrors the existing transition/evidence-added skip behavior',
    () => {
      const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      try {
        const goal = createGoal({ title: 'g', actor: 'atlas', ts: NOW });
        const orphanEvent = {
          eventId: 'orphan-owner-reassign-1',
          kind: 'owner-reassigned',
          ts: NOW,
          actor: 'ceo',
          payload: {
            taskId: 'tsk_doesnotexist00000000',
            from: 'atlas',
            to: 'volaura-product-chat',
            actor: 'ceo',
            reason: 'test orphan event',
            ts: NOW,
          },
        };
        mkdirSync(resolveExecGraphDir(), { recursive: true });
        appendFileSync(ledgerPath(), `${JSON.stringify(orphanEvent)}\n`, 'utf8');

        expect(() => rebuildSnapshot()).not.toThrow();
        const snap = rebuildSnapshot();
        expect(errSpy).toHaveBeenCalled();
        expect(Object.keys(snap.tasks)).toHaveLength(0);
        expect(snap.goals[goal.id]).toBeDefined();
      } finally {
        errSpy.mockRestore();
      }
    },
  );
});

// ─── operator/dispatcher.ts loadOperatorState() regression ────────────────

describe('operator/dispatcher.ts loadOperatorState() regression — missing operator/state/', () => {
  it('missing state file/dir returns a safe default and does not throw (previously threw ENOENT)', async () => {
    const statePath = resolve(process.cwd(), 'operator/state/operator-state.json');
    // Guarantee the precondition regardless of execution order relative to
    // other test files: every OTHER test that dispatches a task in this
    // suite explicitly passes persistState:false to avoid writing here (see
    // operator-dispatcher.test.ts), so in a normal run this file never
    // exists — this rmSync just makes that a hard precondition rather than
    // an assumption.
    rmSync(statePath, { force: true });

    const { loadOperatorState } = await import('../operator/dispatcher.js');
    let result: unknown;
    expect(() => {
      result = loadOperatorState();
    }).not.toThrow();
    expect(result).toEqual({ control: { mode: 'active' } });
  });
});
