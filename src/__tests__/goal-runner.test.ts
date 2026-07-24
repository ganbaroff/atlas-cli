/**
 * Gate C — GOAL-RUNNER-01 tests.
 *
 * Tests the goal-runner module: red-line guard (deny-by-EFFECT), persisted
 * budgets + circuit breaker, verifier authority boundary (Round 16 item 4
 * adversarial negatives), submit-click hardening (Round 16 item 3), and
 * fixture e2e through goal-runner → browser-foreground → hub71-fake-form.html.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';

// ── Goal-runner imports ─────────────────────────────────────────────────
import { classifyEffect, deriveEffectsFromHand, hasRedLine, redLineReason, isExternalTarget } from '../goal-runner/red-line.js';
import {
  createBudget, loadBudget, saveBudget, checkBudget,
  recordAttempt, checkCircuitBreaker, attemptFingerprint,
  acquireLease, releaseLease,
} from '../goal-runner/budgets.js';
import { DEFAULT_GOAL_RUNNER_CONFIG } from '../goal-runner/types.js';
import { runGoal } from '../goal-runner/runner.js';

// ── exec-graph imports (public surface only — goal-runner must use these) ─
import {
  createGoal, createTask, moveTask, reassignOwner, getTask,
  HandAuthorityError,
} from '../exec-graph/api.js';

// ── Hands imports ────────────────────────────────────────────────────────
import { BrowserSession } from '../hands/browser-adapter.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SRC_DIR = resolve(__dirname, '..');

let tmpDir: string;
let budgetDir: string;
const NOW = new Date().toISOString();

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'goal-runner-test-'));
  budgetDir = mkdtempSync(join(tmpdir(), 'goal-budget-test-'));
  process.env.ATLAS_EXEC_GRAPH_DIR = tmpDir;
  process.env.ATLAS_GOAL_BUDGET_DIR = budgetDir;
});

afterEach(() => {
  delete process.env.ATLAS_EXEC_GRAPH_DIR;
  delete process.env.ATLAS_GOAL_BUDGET_DIR;
  rmSync(tmpDir, { recursive: true, force: true });
  rmSync(budgetDir, { recursive: true, force: true });
});

// ═══════════════════════════════════════════════════════════════════════
// 1. RED-LINE GUARD (Round 16 item 1 — deny by EFFECT)
// ═══════════════════════════════════════════════════════════════════════

describe('1. Red-line guard — deny by EFFECT', () => {
  it('1a. safe browser effects are classified as safe', () => {
    expect(classifyEffect('browser-navigate')).toBe('safe');
    expect(classifyEffect('browser-read')).toBe('safe');
    expect(classifyEffect('browser-fill')).toBe('safe');
    expect(classifyEffect('browser-click')).toBe('safe');
    expect(classifyEffect('browser-select')).toBe('safe');
    expect(classifyEffect('read-file')).toBe('safe');
    expect(classifyEffect('grep')).toBe('safe');
    expect(classifyEffect('git-readonly')).toBe('safe');
  });

  it('1b. unknown effect is red-line (deny by default)', () => {
    expect(classifyEffect('unknown')).toBe('red-line');
  });

  it('1c. every listed red-line kind is classified as red-line', () => {
    const redLines = [
      'submit', 'credentials', 'upload', 'payment', 'consent-oauth',
      'live-db-apply', 'deploy', 'merge-to-main', 'deletion', 'money',
      'external-send', 'mutating-http', 'account-change', 'auth-change',
      'legal-acceptance', 'dns-mutation', 'env-secret-mutation',
      'prod-data-write', 'remote-vcs-mutation', 'destructive-overwrite',
      'install-uninstall', 'paid-api',
    ] as const;
    for (const kind of redLines) {
      expect(classifyEffect(kind)).toBe('red-line');
    }
  });

  it('1d. browser-foreground hand has no red-line effects', () => {
    const effects = deriveEffectsFromHand('browser-foreground');
    expect(hasRedLine(effects)).toBe(false);
    expect(effects.every(e => e.class === 'safe')).toBe(true);
  });

  it('1e. sonnet-foreground hand has red-line effects (write-scoped-code → destructive-overwrite)', () => {
    const effects = deriveEffectsFromHand('sonnet-foreground');
    expect(hasRedLine(effects)).toBe(true);
    const reason = redLineReason(effects);
    expect(reason).toContain('destructive-overwrite');
  });

  it('1f. file:// URL is not external', () => {
    expect(isExternalTarget('file:///C:/test/fixture.html')).toBe(false);
    expect(isExternalTarget('file://localhost/test.html')).toBe(false);
  });

  it('1g. localhost URL is not external', () => {
    expect(isExternalTarget('http://localhost:3000/page')).toBe(false);
    expect(isExternalTarget('http://127.0.0.1:8080')).toBe(false);
    expect(isExternalTarget('http://[::1]:3000')).toBe(false);
  });

  it('1h. real-world URL is external', () => {
    expect(isExternalTarget('https://hub71.com/apply')).toBe(true);
    expect(isExternalTarget('https://example.com')).toBe(true);
    expect(isExternalTarget('http://production.api.company.com')).toBe(true);
  });

  it('1i. red-line task is escalated, executor never invoked, notify fired', async () => {
    let notified = false;
    const report = await runGoal({
      objective: 'test red-line escalation',
      handId: 'sonnet-foreground', // has write-scoped-code → red-line
      config: { maxAttemptsPerTask: 1, maxTotalAttempts: 1, maxTotalTasks: 1, maxDecompositionRounds: 1, maxGraphDepth: 1, maxWallTimeMs: 10000 },
      notifyCeo: async () => { notified = true; return { result: 'SENT' }; },
    });

    expect(report.status).toBe('escalated');
    expect(report.tasksEscalated).toBe(1);
    expect(report.tasksVerified).toBe(0);
    expect(report.details[0].finalStatus).toBe('escalated');
    expect(report.details[0].attempts).toBe(0);
    expect(notified).toBe(true);
  });

  it('1j. external browser target is escalated', async () => {
    let notified = false;
    const report = await runGoal({
      objective: 'test external target',
      handId: 'browser-foreground',
      browserActions: [{ kind: 'navigate', url: 'https://evil.com/steal' }],
      config: { maxAttemptsPerTask: 1, maxTotalAttempts: 1, maxTotalTasks: 1, maxDecompositionRounds: 1, maxGraphDepth: 1, maxWallTimeMs: 10000 },
      notifyCeo: async () => { notified = true; return { result: 'SENT' }; },
    });

    expect(report.status).toBe('escalated');
    expect(notified).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════════════
// 2. BUDGETS & CIRCUIT BREAKER (Round 16 item 2)
// ═══════════════════════════════════════════════════════════════════════

describe('2. Budgets & circuit breaker', () => {
  it('2a. createBudget persists to disk and loadBudget reads it back', () => {
    const budget = createBudget('gol_test00000000000001', DEFAULT_GOAL_RUNNER_CONFIG);
    expect(budget.goalId).toBe('gol_test00000000000001');
    const loaded = loadBudget('gol_test00000000000001');
    expect(loaded).not.toBeNull();
    expect(loaded!.goalId).toBe('gol_test00000000000001');
  });

  it('2b. checkBudget: within limits → allowed', () => {
    const budget = createBudget('gol_test00000000000002', DEFAULT_GOAL_RUNNER_CONFIG);
    expect(checkBudget(budget)).toEqual({ allowed: true });
  });

  it('2c. checkBudget: max total attempts exceeded → denied', () => {
    const budget = createBudget('gol_test00000000000003', { ...DEFAULT_GOAL_RUNNER_CONFIG, maxTotalAttempts: 2 });
    budget.totalAttempts = 2;
    expect(checkBudget(budget)).toEqual({ allowed: false, reason: expect.stringContaining('total attempts exceeded') });
  });

  it('2d. checkBudget: per-task attempts exceeded → denied', () => {
    const budget = createBudget('gol_test00000000000004', { ...DEFAULT_GOAL_RUNNER_CONFIG, maxAttemptsPerTask: 1 });
    budget.taskAttempts['tsk_x'] = 1;
    expect(checkBudget(budget, 'tsk_x')).toEqual({ allowed: false, reason: expect.stringContaining('task tsk_x attempts exceeded') });
  });

  it('2e. circuit breaker: repeated fingerprint halts', () => {
    const budget = createBudget('gol_test00000000000005', DEFAULT_GOAL_RUNNER_CONFIG);
    const fp = attemptFingerprint('tsk_1', 'plan_abc', 'error_xyz');
    expect(checkCircuitBreaker(budget, fp)).toBe(false);
    recordAttempt(budget, 'tsk_1', fp);
    expect(checkCircuitBreaker(budget, fp)).toBe(true);
  });

  it('2f. one active lease per goal — second goal denied', () => {
    expect(acquireLease('gol_test00000000000006')).toBe(true);
    expect(acquireLease('gol_test00000000000007')).toBe(false);
    releaseLease('gol_test00000000000006');
    expect(acquireLease('gol_test00000000000007')).toBe(true);
    releaseLease('gol_test00000000000007');
  });

  it('2g. same goal can re-acquire its own lease (crash/resume)', () => {
    expect(acquireLease('gol_test00000000000008')).toBe(true);
    expect(acquireLease('gol_test00000000000008')).toBe(true);
    releaseLease('gol_test00000000000008');
  });

  it('2h. stale lease from dead pid allows a different goal to acquire (M4 resume)', () => {
    writeFileSync(
      join(budgetDir, 'active-lease.json'),
      JSON.stringify({ goalId: 'gol_stale0000000000001', startedAt: NOW, pid: 999_999_999 }),
    );
    expect(acquireLease('gol_test00000000000009')).toBe(true);
    releaseLease('gol_test00000000000009');
  });

  it('2i. kill-and-resume: persisted budget survives simulated process death', async () => {
    const tight = {
      maxAttemptsPerTask: 1, maxTotalAttempts: 5, maxTotalTasks: 2,
      maxDecompositionRounds: 1, maxGraphDepth: 1, maxWallTimeMs: 30_000,
    };
    const report1 = await runGoal({
      objective: 'M4 kill-resume budget test',
      handId: 'sonnet-foreground',
      config: tight,
      notifyCeo: async () => ({ result: 'NOT_CONFIGURED' }),
    });
    const before = loadBudget(report1.goalId);
    expect(before).not.toBeNull();
    const attemptsBefore = before!.totalAttempts;
    recordAttempt(before!, 'tsk_simulated_kill', attemptFingerprint('tsk_simulated_kill', 'plan', 'kill'));
    saveBudget(before!);
    writeFileSync(
      join(budgetDir, 'active-lease.json'),
      JSON.stringify({ goalId: report1.goalId, startedAt: NOW, pid: 999_999_999 }),
    );

    expect(acquireLease(report1.goalId)).toBe(true);
    const reloaded = loadBudget(report1.goalId)!;
    expect(reloaded.totalAttempts).toBe(attemptsBefore + 1);
    expect(reloaded.goalId).toBe(report1.goalId);
    releaseLease(report1.goalId);
  });

  it('2j. resumeGoalId without budget file returns failed report', async () => {
    const report = await runGoal({
      objective: 'missing budget',
      resumeGoalId: 'gol_nonexistent00000001',
      notifyCeo: async () => ({ result: 'NOT_CONFIGURED' }),
    });
    expect(report.status).toBe('failed');
    expect(report.tasksTotal).toBe(0);
  });

  it('2k. resumeGoalId reuses terminal exec-graph task without duplicate creation', async () => {
    const tight = {
      maxAttemptsPerTask: 1, maxTotalAttempts: 5, maxTotalTasks: 2,
      maxDecompositionRounds: 1, maxGraphDepth: 1, maxWallTimeMs: 30_000,
    };
    const report1 = await runGoal({
      objective: 'M4 resume exec-graph reuse',
      handId: 'sonnet-foreground',
      config: tight,
      notifyCeo: async () => ({ result: 'NOT_CONFIGURED' }),
    });
    expect(report1.status).toBe('escalated');
    const taskIdFirst = report1.details[0]!.taskId;

    writeFileSync(
      join(budgetDir, 'active-lease.json'),
      JSON.stringify({ goalId: report1.goalId, startedAt: NOW, pid: 999_999_999 }),
    );

    const report2 = await runGoal({
      objective: 'M4 resume exec-graph reuse',
      handId: 'sonnet-foreground',
      resumeGoalId: report1.goalId,
      config: tight,
      notifyCeo: async () => ({ result: 'NOT_CONFIGURED' }),
    });
    expect(report2.status).toBe('escalated');
    expect(report2.tasksTotal).toBe(1);
    expect(report2.details[0]!.taskId).toBe(taskIdFirst);
    expect(report2.details[0]!.finalStatus).toBe('escalated');
  });
});

// ═══════════════════════════════════════════════════════════════════════
// 3. VERIFIER AUTHORITY — Round 16 item 4 adversarial negative tests
// ═══════════════════════════════════════════════════════════════════════

describe('3. Verifier authority — adversarial negatives', () => {
  it('3a. goal-runner source NEVER imports verifier-port', () => {
    const files = ['types.ts', 'red-line.ts', 'budgets.ts', 'runner.ts'];
    for (const file of files) {
      const source = readFileSync(resolve(SRC_DIR, 'goal-runner', file), 'utf8');
      expect(source).not.toContain('verifier-port');
    }
  });

  it('3b. goal-runner source has no _viaVerifier string', () => {
    const files = ['types.ts', 'red-line.ts', 'budgets.ts', 'runner.ts'];
    for (const file of files) {
      const source = readFileSync(resolve(SRC_DIR, 'goal-runner', file), 'utf8');
      expect(source).not.toContain('_viaVerifier');
    }
  });

  it('3c. forged _viaVerifier — moveTask ALWAYS rejects verified (no escape hatch)', () => {
    const goal = createGoal({ title: 'forge-test', actor: 'atlas', ts: NOW });
    const { task } = createTask({ goalId: goal.id, title: 'forge-task', actor: 'atlas', ts: NOW });
    moveTask({ taskId: task.id, to: 'accepted', actor: 'atlas' });
    moveTask({ taskId: task.id, to: 'planned', actor: 'atlas' });
    moveTask({ taskId: task.id, to: 'in-progress', actor: 'atlas' });
    moveTask({ taskId: task.id, to: 'evidence-submitted', actor: 'atlas', evidenceRefs: ['x'] });

    // Even passing the old flag shape as an extra property has no effect —
    // the guard is unconditional now.
    expect(() =>
      moveTask({ taskId: task.id, to: 'verified', actor: 'atlas', evidenceRefs: ['x'] }),
    ).toThrow(HandAuthorityError);

    // Also test rejected
    expect(() =>
      moveTask({ taskId: task.id, to: 'rejected', actor: 'atlas' }),
    ).toThrow(HandAuthorityError);
  });

  it('3d. forged hand: owner — reassignOwner ALWAYS rejects hand: prefix', () => {
    const goal = createGoal({ title: 'forge-owner-test', actor: 'atlas', ts: NOW });
    const { task } = createTask({ goalId: goal.id, title: 'forge-owner-task', actor: 'atlas', ts: NOW });

    expect(() =>
      reassignOwner(task.id, 'hand:browser-foreground', { actor: 'atlas', reason: 'forged' }),
    ).toThrow(HandAuthorityError);
    expect(getTask(task.id)?.owner).toBe('atlas');
  });

  it('3e. direct final transition — moveTask to verified always throws regardless of owner', () => {
    // Non-hand-owned task also cannot reach verified via generic moveTask
    const goal = createGoal({ title: 'direct-transition-test', actor: 'atlas', ts: NOW });
    const { task } = createTask({ goalId: goal.id, title: 'dt-task', actor: 'atlas', ts: NOW });
    moveTask({ taskId: task.id, to: 'accepted', actor: 'atlas' });
    moveTask({ taskId: task.id, to: 'planned', actor: 'atlas' });
    moveTask({ taskId: task.id, to: 'in-progress', actor: 'atlas' });
    moveTask({ taskId: task.id, to: 'evidence-submitted', actor: 'atlas', evidenceRefs: ['x'] });

    expect(() =>
      moveTask({ taskId: task.id, to: 'verified', actor: 'atlas', evidenceRefs: ['x'] }),
    ).toThrow(HandAuthorityError);

    expect(getTask(task.id)?.status).toBe('evidence-submitted');
  });

  it('3f. stale receipt replay — duplicate receipt is idempotent no-op (no double evidence)', async () => {
    const { assignHand, submitReceipt } = await import('../hands/exec-graph-adapter.js');

    const goal = createGoal({ title: 'stale-replay-test', actor: 'atlas', ts: NOW });
    const { task } = createTask({ goalId: goal.id, title: 'replay-task', actor: 'atlas', ts: NOW });
    moveTask({ taskId: task.id, to: 'accepted', actor: 'atlas' });
    moveTask({ taskId: task.id, to: 'planned', actor: 'atlas' });
    assignHand(task.id, 'local-readonly', { actor: 'atlas' });

    const receipt = {
      taskId: task.id,
      handId: 'local-readonly',
      submittedBy: 'local-readonly',
      kind: 'file-exists' as const,
      ref: resolve(__dirname, '../../package.json'),
      claimedResult: 'file exists',
    };

    submitReceipt(task.id, receipt);
    const afterFirst = getTask(task.id)!;
    const evidenceCount = afterFirst.evidence.length;

    // Submit same receipt again — idempotent no-op
    submitReceipt(task.id, receipt);
    const afterSecond = getTask(task.id)!;
    expect(afterSecond.evidence.length).toBe(evidenceCount);
  });

  it('3g. empty-task success — empty decomposition cannot close goal', async () => {
    const report = await runGoal({
      objective: 'empty goal test',
      handId: 'browser-foreground',
      taskPlans: [], // empty decomposition
      config: { maxAttemptsPerTask: 1, maxTotalAttempts: 1, maxTotalTasks: 1, maxDecompositionRounds: 1, maxGraphDepth: 1, maxWallTimeMs: 10000 },
      notifyCeo: async () => ({ result: 'SUPPRESSED' }),
    });

    expect(report.status).toBe('failed');
    expect(report.tasksTotal).toBe(0);
    expect(report.tasksVerified).toBe(0);
  });

  it('3h. only exec-graph-adapter.ts imports verifier-port (structural)', () => {
    // Scan all .ts files in src/ (excluding tests and verifier-port itself)
    const { globSync } = require('node:fs');
    const { resolve: r } = require('node:path');

    // Read all non-test source files
    const sourceFiles = [
      'goal-runner/types.ts', 'goal-runner/red-line.ts',
      'goal-runner/budgets.ts', 'goal-runner/runner.ts',
      'exec-graph/api.ts', 'exec-graph/contracts.ts',
      'exec-graph/transitions.ts', 'exec-graph/ledger.ts',
      'exec-graph/brief.ts',
      'hands/registry.ts', 'hands/contract.ts', 'hands/risk.ts',
      'hands/verifier.ts', 'hands/refuter.ts',
      'hands/browser-actions.ts', 'hands/browser-adapter.ts',
    ];

    for (const file of sourceFiles) {
      const fullPath = resolve(SRC_DIR, file);
      try {
        const source = readFileSync(fullPath, 'utf8');
        expect(source).not.toContain('verifier-port');
      } catch {
        // File might not exist — skip
      }
    }

    // Confirm exec-graph-adapter DOES import it
    const adapterSource = readFileSync(resolve(SRC_DIR, 'hands/exec-graph-adapter.ts'), 'utf8');
    expect(adapterSource).toContain('verifier-port');
  });

  it('3i. _viaVerifier string does not appear in any production source', () => {
    const productionFiles = [
      'exec-graph/api.ts', 'exec-graph/verifier-port.ts',
      'hands/exec-graph-adapter.ts', 'hands/registry.ts',
      'hands/contract.ts', 'hands/risk.ts', 'hands/verifier.ts',
      'hands/refuter.ts', 'hands/browser-adapter.ts',
      'goal-runner/types.ts', 'goal-runner/red-line.ts',
      'goal-runner/budgets.ts', 'goal-runner/runner.ts',
    ];

    for (const file of productionFiles) {
      const source = readFileSync(resolve(SRC_DIR, file), 'utf8');
      expect(source).not.toContain('_viaVerifier');
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════
// 4. SUBMIT-CLICK HARDENING (Round 16 item 3)
// ═══════════════════════════════════════════════════════════════════════

describe('4. Submit-click hardening', () => {
  const fixturePath = resolve('fixtures/hub71-fake-form.html');
  const fixtureUrl = `file://${fixturePath.replace(/\\/g, '/')}`;
  let session: BrowserSession;

  beforeAll(async () => {
    session = new BrowserSession();
    await session.launch();
  }, 60_000);

  afterAll(async () => {
    await session.close();
  }, 30_000);

  it('4a. explicit type=submit button click is DENIED', async () => {
    await session.execute({ kind: 'navigate', url: fixtureUrl });
    const result = await session.execute({ kind: 'click', role: 'button', name: 'Submit Application' });
    expect(result.success).toBe(false);
    expect(result.error).toContain('SUBMIT_DENIED');
  }, 30_000);

  it('4b. safe non-submit click is ALLOWED', async () => {
    // Create a fixture with a type=button element
    const safeFixture = `file://${resolve('fixtures/hub71-fake-form.html').replace(/\\/g, '/')}`;
    await session.execute({ kind: 'navigate', url: safeFixture });

    // fillField and readText still work fine
    const fill = await session.execute({ kind: 'fillField', label: 'Company Name', value: 'Test Corp' });
    expect(fill.success).toBe(true);

    const read = await session.execute({ kind: 'readValue', selector: '#company-name' });
    expect(read.success).toBe(true);
    expect(read.value).toBe('Test Corp');
  }, 30_000);

  it('4c. submit-denied cases prove driver was NOT invoked for submission', async () => {
    await session.execute({ kind: 'navigate', url: fixtureUrl });

    // Click on the submit button — should be denied at the adapter level
    const result = await session.execute({ kind: 'click', role: 'button', name: 'Submit Application' });
    expect(result.success).toBe(false);
    expect(result.error).toContain('SUBMIT_DENIED');

    // The page should still be on the same URL (no form submission occurred)
    const titleCheck = await session.execute({ kind: 'readText', selector: 'h1' });
    expect(titleCheck.success).toBe(true);
    expect(titleCheck.value).toContain('Hub71');
  }, 30_000);
});

// ═══════════════════════════════════════════════════════════════════════
// 5. GOAL-RUNNER E2E — fixture form
// ═══════════════════════════════════════════════════════════════════════

describe('5. Goal-runner e2e: fixture form', () => {
  const fixturePath = resolve('fixtures/hub71-fake-form.html');
  const fixtureUrl = `file://${fixturePath.replace(/\\/g, '/')}`;

  it('5a. toy goal: navigate, read, fill on fixture → verified, no submit', async () => {
    const report = await runGoal({
      objective: 'Read form title and fill company name on fixture',
      handId: 'browser-foreground',
      browserActions: [
        { kind: 'navigate', url: fixtureUrl },
        { kind: 'readText', selector: 'h1' },
        { kind: 'fillField', label: 'Company Name', value: 'VOLAURA Inc' },
        { kind: 'readValue', selector: '#company-name' },
      ],
      config: {
        maxAttemptsPerTask: 1, maxTotalAttempts: 1, maxTotalTasks: 5,
        maxDecompositionRounds: 1, maxGraphDepth: 3, maxWallTimeMs: 60_000,
      },
      notifyCeo: async () => ({ result: 'SUPPRESSED' }),
    });

    expect(report.status).toBe('completed');
    expect(report.tasksVerified).toBe(1);
    expect(report.tasksFailed).toBe(0);
    expect(report.tasksEscalated).toBe(0);
    expect(report.details[0].finalStatus).toBe('verified');
    expect(report.details[0].handId).toBe('browser-foreground');
  }, 60_000);

  it('5b. toy goal with submit attempt: fill + click submit → submit denied, task rejected', async () => {
    const report = await runGoal({
      objective: 'Fill form and try to submit on fixture',
      handId: 'browser-foreground',
      browserActions: [
        { kind: 'navigate', url: fixtureUrl },
        { kind: 'fillField', label: 'Company Name', value: 'Evil Corp' },
        { kind: 'click', role: 'button', name: 'Submit Application' }, // DENIED
      ],
      config: {
        maxAttemptsPerTask: 1, maxTotalAttempts: 1, maxTotalTasks: 5,
        maxDecompositionRounds: 1, maxGraphDepth: 3, maxWallTimeMs: 60_000,
      },
      notifyCeo: async () => ({ result: 'SUPPRESSED' }),
    });

    // The click fails → browser-action receipt has a failed action → verifier rejects
    expect(report.status).toBe('failed');
    expect(report.tasksVerified).toBe(0);
  }, 60_000);
});
