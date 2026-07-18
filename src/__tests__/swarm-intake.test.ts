import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';

import {
  compileIntake,
  writeDraft,
  readDraft,
  commitDraft,
  draftsRoot,
  type IntakeDraft,
} from '../swarm-exec/intake.js';
import { createGoal, getTask, listTasks } from '../exec-graph/api.js';

const NOW = '2026-07-18T00:00:00.000Z';

// Each test gets its own temp root for intake drafts, mirroring
// swarm-run-bundle.test.ts's makeTmpRoot pattern — the repo's real
// state/intake-drafts/ is never touched.
const tmpDirs: string[] = [];

function makeTmpRoot(): string {
  const dir = mkdtempSync(join(tmpdir(), 'anus-intake-'));
  tmpDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tmpDirs.length > 0) {
    const dir = tmpDirs.pop();
    if (!dir) continue;
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* ignore cleanup failures */
    }
  }
});

describe('intake.ts — compileIntake (pure, deterministic)', () => {
  it('produces all required fields; objective is the trimmed/normalized freeform', () => {
    const draft = compileIntake('  fix   the   flaky   test   suite  ');
    expect(draft.objective).toBe('fix the flaky test suite');
    expect(draft.draftId).toMatch(/^dft_[0-9a-f]{16}$/);
    expect(draft.scope).toEqual(['fix the flaky test suite']);
    expect(draft.exclusions.length).toBeGreaterThan(0);
    expect(draft.acceptanceCriteria.length).toBeGreaterThan(0);
    expect(draft.dependencies).toEqual([]);
    expect(draft.riskClass).toBe('low');
    expect(draft.proofSpec).toMatch(/SWARM-VERIFIED/);
    expect(draft.executor).toBe('swarm-local');
    expect(draft.timeoutMs).toBe(300000);
    expect(draft.retryPolicy).toBe('none');
    expect(draft.costClass).toBe('FOREGROUND-CEO-SUPERVISED');
    expect(draft.rollback).toMatch(/read-only/);
    expect(draft.createdFrom).toBe('  fix   the   flaky   test   suite  ');
  });

  it('throws a clear Error for empty/whitespace-only freeform', () => {
    expect(() => compileIntake('')).toThrow(/freeform/i);
    expect(() => compileIntake('   ')).toThrow(/freeform/i);
    expect(() => compileIntake('\n\t  ')).toThrow(/freeform/i);
  });

  it('same freeform -> same draftId (idempotent); different freeform -> different draftId', () => {
    const a1 = compileIntake('analyze the swarm executor for flakiness');
    const a2 = compileIntake('analyze the swarm executor for flakiness');
    expect(a1.draftId).toBe(a2.draftId);

    const b = compileIntake('analyze a completely different subsystem');
    expect(b.draftId).not.toBe(a1.draftId);
  });

  it('normalizing to the same objective (extra whitespace) still yields the same draftId', () => {
    const a = compileIntake('review the risk classifier');
    const b = compileIntake('  review   the    risk classifier ');
    expect(a.objective).toBe(b.objective);
    expect(a.draftId).toBe(b.draftId);
  });

  it('riskClass escalates for a deploy/secret-mentioning intent vs a plain analysis intent', () => {
    const escalated = compileIntake('deploy the new API key to production and rotate the secret');
    expect(escalated.riskClass).toBe('irreversible');

    const mutation = compileIntake('write and edit the config file to update db settings');
    expect(mutation.riskClass).toBe('medium');

    const plain = compileIntake('summarize the last 10 test failures and explain root causes');
    expect(plain.riskClass).toBe('low');
  });

  it('exclusions include the deploy/VOLAURA/credentials/prod-DB safe defaults', () => {
    const draft = compileIntake('investigate a flaky test');
    expect(draft.exclusions).toContain('no deploy');
    expect(draft.exclusions).toContain('no VOLAURA product code');
    expect(draft.exclusions).toContain('no credentials/keys');
    expect(draft.exclusions).toContain('no prod DB/migration');
  });

  it('opts.draftId overrides the derived id', () => {
    const draft = compileIntake('some intent', { draftId: 'dft_customoverride' });
    expect(draft.draftId).toBe('dft_customoverride');
  });
});

describe('intake.ts — writeDraft / readDraft (tmp rootDir)', () => {
  it('draftsRoot() resolves the given rootDir', () => {
    const rootDir = makeTmpRoot();
    expect(draftsRoot({ rootDir })).toBe(resolve(rootDir));
  });

  it('writeDraft then readDraft round-trips deep-equal', () => {
    const rootDir = makeTmpRoot();
    const draft = compileIntake('investigate the ledger fold performance');
    const filePath = writeDraft(draft, { rootDir });

    expect(filePath).toContain(draft.draftId);
    const readBack = readDraft(draft.draftId, { rootDir });
    expect(readBack).toEqual(draft);
  });

  it("readDraft('nope') -> null (missing file never throws)", () => {
    const rootDir = makeTmpRoot();
    expect(readDraft('nope', { rootDir })).toBeNull();
  });

  it('writeDraft is deterministic: writing the same draft twice yields byte-identical readback', () => {
    const rootDir = makeTmpRoot();
    const draft = compileIntake('check idempotent writes');
    writeDraft(draft, { rootDir });
    const first = readDraft(draft.draftId, { rootDir });
    writeDraft(draft, { rootDir });
    const second = readDraft(draft.draftId, { rootDir });
    expect(second).toEqual(first);
  });
});

describe('intake.ts — commitDraft (isolated temp exec-graph dir, ATLAS_EXEC_GRAPH_DIR)', () => {
  let execDir: string;
  let draftDir: string;
  let priorExecDir: string | undefined;

  beforeEach(() => {
    execDir = mkdtempSync(join(tmpdir(), 'atlas-intake-exec-'));
    draftDir = mkdtempSync(join(tmpdir(), 'atlas-intake-drafts-'));
    priorExecDir = process.env.ATLAS_EXEC_GRAPH_DIR;
    process.env.ATLAS_EXEC_GRAPH_DIR = execDir;
  });

  afterEach(() => {
    if (priorExecDir === undefined) delete process.env.ATLAS_EXEC_GRAPH_DIR;
    else process.env.ATLAS_EXEC_GRAPH_DIR = priorExecDir;
    try {
      rmSync(execDir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
    try {
      rmSync(draftDir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  });

  it('commitDraft creates an exec-graph task whose title === objective and riskClass === draft.riskClass; throws for an unknown draftId', () => {
    const goal = createGoal({ title: 'intake test goal', actor: 'atlas', ts: NOW });
    const draft: IntakeDraft = compileIntake('deploy a secret rotation script to production');
    writeDraft(draft, { rootDir: draftDir });

    expect(() => commitDraft('dft_doesnotexist', { goalId: goal.id }, { rootDir: draftDir })).toThrow();

    const { taskId, created } = commitDraft(draft.draftId, { goalId: goal.id, actor: 'atlas' }, { rootDir: draftDir });
    expect(created).toBe(true);
    const task = getTask(taskId);
    expect(task).toBeDefined();
    expect(task?.title).toBe(draft.objective);
    expect(task?.riskClass).toBe(draft.riskClass);
    expect(task?.riskClass).toBe('irreversible');
  });

  it('committing the SAME draft twice returns created:false the second time (dedup) and never creates a second task', () => {
    const goal = createGoal({ title: 'intake dedup goal', actor: 'atlas', ts: NOW });
    const draft = compileIntake('analyze the completion-policy test coverage gaps');
    writeDraft(draft, { rootDir: draftDir });

    const first = commitDraft(draft.draftId, { goalId: goal.id, actor: 'atlas' }, { rootDir: draftDir });
    expect(first.created).toBe(true);

    const second = commitDraft(draft.draftId, { goalId: goal.id, actor: 'atlas' }, { rootDir: draftDir });
    expect(second.created).toBe(false);
    expect(second.taskId).toBe(first.taskId);

    const tasksForGoal = listTasks({ goalId: goal.id });
    expect(tasksForGoal.length).toBe(1);
  });
});
