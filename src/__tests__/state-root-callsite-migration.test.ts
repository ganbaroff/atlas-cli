import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { resolveExecGraphDir } from '../exec-graph/ledger.js';
import { resolveEvidenceDir } from '../evidence/ledger.js';
import * as budgets from '../goal-runner/budgets.js';
import {
  operatorStatePath as controlOperatorStatePath,
  writeOperatorState,
} from '../atlas/control-plane.js';
import { STATE_ROOT_ACTIVATION_FILE, STATE_STORES } from '../atlas/state-root.js';
import {
  dispatchOperatorTask,
  operatorRunsDir,
  operatorStatePath as dispatcherOperatorStatePath,
  writeOperatorTrace,
} from '../operator/dispatcher.js';
import { appendRunLedgerEntry } from '../operator/run-ledger.js';
import type { OperatorResult, OperatorTask } from '../operator/contracts.js';
import { bundleRoot } from '../swarm-exec/run-bundle.js';
import { draftsRoot } from '../swarm-exec/intake.js';
import { resolveTaskResultsDir } from '../atlas/task-spawner.js';
import { resolveProjectionLockPath } from '../learning/projections.js';
import {
  processLearningRequest,
  resolveLearningExchangeDir,
} from '../learning/request-port.js';
import { resolveLearningStateDir } from '../learning/state-dir.js';
import type { LearningRequest } from '../learning/contracts.js';
import * as spendTracker from '../atlas/spend-tracker.js';
import * as instanceLease from '../atlas/instance-lease.js';
import * as providerHealth from '../atlas/provider-health.js';
import * as breadcrumbs from '../atlas/write-back-hook.js';

const MANAGED_ENV_KEYS = [
  'ATLAS_STATE_ROOT',
  'ATLAS_STATE_ROOT_REQUIRED',
  'ATLAS_EXEC_GRAPH_DIR',
  'ATLAS_EVIDENCE_DIR',
  'ATLAS_GOAL_BUDGET_DIR',
  'ATLAS_LEARNING_EXCHANGE_DIR',
  'ATLAS_LEARNING_STATE_DIR',
  'ATLAS_SPEND_RECEIPT_DIR',
  'ATLAS_INSTANCE_LEASE_DIR',
  'ATLAS_PROVIDER_HEALTH_DIR',
  'ATLAS_BREADCRUMB_DIR',
  'ATLAS_READONLY',
  'SUPABASE_URL',
  'SUPABASE_SERVICE_ROLE_KEY',
] as const;
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

describe('M3D-A2 state-root call-site migration slices 1-7', () => {
  let root: string;
  let prior: Record<string, string | undefined>;
  let priorCwd: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'atlas-m3d-a2-root-'));
    priorCwd = process.cwd();
    prior = {};
    for (const key of MANAGED_ENV_KEYS) {
      prior[key] = process.env[key];
      delete process.env[key];
    }
  });

  afterEach(() => {
    for (const key of MANAGED_ENV_KEYS) {
      const value = prior[key];
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    process.chdir(priorCwd);
    rmSync(root, { recursive: true, force: true });
  });

  function activateRoot(): void {
    process.env.ATLAS_STATE_ROOT = root;
    process.env.ATLAS_STATE_ROOT_REQUIRED = '1';
    writeFileSync(
      join(root, STATE_ROOT_ACTIVATION_FILE),
      `${JSON.stringify({
        schemaVersion: 1,
        nodeRole: 'local',
        activatedAt: '2026-07-30T00:00:00.000Z',
        stores: Object.keys(STATE_STORES),
        sourceReceipts: [{ kind: 'm3c-exec-graph', sha256: 'a'.repeat(64) }],
      })}\n`,
      'utf8',
    );
  }

  function operatorResult(taskId: string): OperatorResult {
    return {
      task_id: taskId,
      status: 'blocked',
      executor: 'atlas',
      started_at: '2026-07-30T00:00:00.000Z',
      completed_at: '2026-07-30T00:00:01.000Z',
      summary: 'state-root migration fixture',
      evidence: [],
      errors: ['fixture intentionally blocked'],
    };
  }

  function promotionTask(sourceTaskId: string): OperatorTask {
    return {
      id: 'm3d-a2-activated-promotion',
      title: 'Activated operator promotion readback',
      created_at: '2026-07-30T00:00:02.000Z',
      route: 'manual',
      mode: 'read_only',
      cwd: REPO_ROOT,
      allowed_paths: [REPO_ROOT, resolve(root, 'operator-runs')],
      objective: 'Read one migrated operator result without falling back to the legacy checkout path.',
      inputs: { promotion_result_task_id: sourceTaskId },
      expected_evidence: ['file_read'],
      safety: {
        sandbox_required: false,
        network_allowed: false,
        write_allowed: false,
      },
    };
  }

  function learningOutcomeRequest(suffix: string): LearningRequest {
    return {
      schemaVersion: '1.0',
      kind: 'outcome',
      requestId: `req_m3d_a2_learning_${suffix}`,
      idempotencyKey: `idem_m3d_a2_learning_${suffix}`,
      createdAt: '2026-07-30T00:00:00.000Z',
      issuedBy: 'volaura',
      payload: {
        learnerId: 'm3d-a2',
        concept: 'state-root',
        decisionCorrelationId: 'idem_m3d_a2_learning',
        completed: true,
        correct: true,
        responseTimeSec: 5,
        selfReportedConfidence: 0.9,
      },
    };
  }

  it('does not reroute any store when the shared root is only staged', () => {
    process.env.ATLAS_STATE_ROOT = root;
    process.chdir(root);

    expect(resolveExecGraphDir()).toBe(resolve(REPO_ROOT, 'state', 'exec-graph'));
    expect(resolveEvidenceDir()).toBe(resolve(root, 'state', 'evidence'));
    expect(budgets.resolveGoalBudgetDir()).toBe(
      resolve(root, 'state', 'goal-budgets'),
    );
    expect(bundleRoot()).toBe(resolve(root, 'state', 'swarm-runs'));
    expect(draftsRoot()).toBe(resolve(root, 'state', 'intake-drafts'));
    expect(controlOperatorStatePath()).toBe(
      resolve(REPO_ROOT, 'operator', 'state', 'operator-state.json'),
    );
    expect(dispatcherOperatorStatePath()).toBe(
      resolve(REPO_ROOT, 'operator', 'state', 'operator-state.json'),
    );
    expect(operatorRunsDir()).toBe(resolve(REPO_ROOT, 'operator', 'runs'));
    expect(resolveTaskResultsDir()).toBe(
      resolve('C:/Projects/ATLAS/data/task-results'),
    );
  });

  it('preserves explicit swarm roots before required activation', () => {
    process.env.ATLAS_STATE_ROOT = root;
    const legacyBundleRoot = join(root, 'legacy-swarm-runs');
    const legacyDraftsRoot = join(root, 'legacy-intake-drafts');

    expect(bundleRoot({ rootDir: legacyBundleRoot })).toBe(resolve(legacyBundleRoot));
    expect(draftsRoot({ rootDir: legacyDraftsRoot })).toBe(resolve(legacyDraftsRoot));
  });

  it('ignores an explicit swarm-run root after required activation', () => {
    activateRoot();
    const legacyBundleRoot = join(root, 'legacy-swarm-runs');

    expect(bundleRoot({ rootDir: legacyBundleRoot })).toBe(resolve(root, 'swarm-runs'));
  });

  it('ignores an explicit intake-drafts root after required activation', () => {
    activateRoot();
    const legacyDraftsRoot = join(root, 'legacy-intake-drafts');

    expect(draftsRoot({ rootDir: legacyDraftsRoot })).toBe(resolve(root, 'intake-drafts'));
  });

  it('routes control-plane operator state through the activated shared root', () => {
    activateRoot();

    expect(controlOperatorStatePath()).toBe(
      resolve(root, 'operator-state', 'operator-state.json'),
    );
  });

  it('routes dispatcher operator state through the activated shared root', () => {
    activateRoot();

    expect(dispatcherOperatorStatePath()).toBe(
      resolve(root, 'operator-state', 'operator-state.json'),
    );
  });

  it('routes operator runs through the activated shared root', () => {
    activateRoot();

    expect(operatorRunsDir()).toBe(resolve(root, 'operator-runs'));
  });

  it('routes task results through the activated shared root', () => {
    activateRoot();

    expect(resolveTaskResultsDir()).toBe(resolve(root, 'task-results'));
  });

  it('keeps spend receipts on the legacy path when the shared root is staged', () => {
    process.env.ATLAS_STATE_ROOT = root;
    const legacySpend = resolve(root, 'legacy-spend-receipts');
    process.env.ATLAS_SPEND_RECEIPT_DIR = legacySpend;
    const resolver = (
      spendTracker as typeof spendTracker & {
        resolveSpendReceiptDir?: () => string;
      }
    ).resolveSpendReceiptDir;

    expect(resolver?.()).toBe(legacySpend);
  });

  it('routes the spend receipt store through the activated root', () => {
    activateRoot();
    const resolver = (
      spendTracker as typeof spendTracker & {
        resolveSpendReceiptDir?: () => string;
      }
    ).resolveSpendReceiptDir;

    expect(resolver?.()).toBe(resolve(root, 'spend-receipts'));
  });

  it('refuses an escaped spend override before creating its directory', () => {
    activateRoot();
    const escapedSpend = resolve(tmpdir(), `${basename(root)}-escaped-spend`);
    process.env.ATLAS_SPEND_RECEIPT_DIR = escapedSpend;
    const resolver = (
      spendTracker as typeof spendTracker & {
        resolveSpendReceiptDir?: () => string;
      }
    ).resolveSpendReceiptDir;

    try {
      expect(() => resolver?.()).toThrow(/store_outside_root/);
      expect(existsSync(escapedSpend)).toBe(false);
    } finally {
      rmSync(escapedSpend, { recursive: true, force: true });
    }
  });

  it('does not swallow an activated spend-store invariant denial', () => {
    activateRoot();
    process.env.SUPABASE_URL = '';
    process.env.SUPABASE_SERVICE_ROLE_KEY = '';
    const escapedSpend = resolve(
      tmpdir(),
      `${basename(root)}-escaped-record-spend`,
    );
    process.env.ATLAS_SPEND_RECEIPT_DIR = escapedSpend;
    spendTracker.resetDailySpend();

    try {
      expect(() => spendTracker.recordSpend({
        provider: 'atlas-local',
        model: 'state-root-fixture',
        tokensIn: 0,
        tokensOut: 0,
        caller: 'm3d-a2',
      })).toThrow(/store_outside_root/);
      expect(existsSync(escapedSpend)).toBe(false);
      expect(spendTracker.getDailySpend().calls).toBe(0);
    } finally {
      rmSync(escapedSpend, { recursive: true, force: true });
    }
  });

  it('writes spend receipts only inside the activated store', () => {
    activateRoot();
    process.env.SUPABASE_URL = '';
    process.env.SUPABASE_SERVICE_ROLE_KEY = '';
    spendTracker.resetDailySpend();

    expect(spendTracker.recordSpend({
      provider: 'atlas-local',
      model: 'state-root-fixture',
      tokensIn: 7,
      tokensOut: 3,
      caller: 'm3d-a2',
      correlationId: 'm3d-a2-spend-root-positive',
    })).toBe(0);

    const receiptFile = resolve(root, 'spend-receipts', 'spend-receipts.jsonl');
    expect(existsSync(receiptFile)).toBe(true);
    expect(spendTracker.readSpendReceipts()).toEqual([
      expect.objectContaining({
        correlationId: 'm3d-a2-spend-root-positive',
        tokensIn: 7,
        tokensOut: 3,
      }),
    ]);
  });

  it('keeps legacy home-directory stores in their explicit directories while root is staged', () => {
    process.env.ATLAS_STATE_ROOT = root;
    const legacyLease = resolve(root, 'legacy-instance-lease');
    const legacyHealth = resolve(root, 'legacy-provider-health');
    const legacyBreadcrumbs = resolve(root, 'legacy-breadcrumbs');
    process.env.ATLAS_INSTANCE_LEASE_DIR = legacyLease;
    process.env.ATLAS_PROVIDER_HEALTH_DIR = legacyHealth;
    process.env.ATLAS_BREADCRUMB_DIR = legacyBreadcrumbs;

    expect((instanceLease as typeof instanceLease & {
      resolveInstanceLeaseDir?: () => string;
    }).resolveInstanceLeaseDir?.()).toBe(legacyLease);
    expect((providerHealth as typeof providerHealth & {
      resolveProviderHealthDir?: () => string;
    }).resolveProviderHealthDir?.()).toBe(legacyHealth);
    expect((breadcrumbs as typeof breadcrumbs & {
      resolveBreadcrumbDir?: () => string;
    }).resolveBreadcrumbDir?.()).toBe(legacyBreadcrumbs);
  });

  it('keeps the shared legacy home default while root is only staged', () => {
    process.env.ATLAS_STATE_ROOT = root;
    const legacyHome = resolve(homedir(), '.atlas');

    expect(instanceLease.resolveInstanceLeaseDir()).toBe(legacyHome);
    expect(providerHealth.resolveProviderHealthDir()).toBe(legacyHome);
    expect(breadcrumbs.resolveBreadcrumbDir()).toBe(legacyHome);
  });

  it('routes legacy home-directory stores through their activated stores', () => {
    activateRoot();

    expect((instanceLease as typeof instanceLease & {
      resolveInstanceLeaseDir?: () => string;
    }).resolveInstanceLeaseDir?.()).toBe(resolve(root, 'instance-lease'));
    expect((providerHealth as typeof providerHealth & {
      resolveProviderHealthDir?: () => string;
    }).resolveProviderHealthDir?.()).toBe(resolve(root, 'provider-health'));
    expect((breadcrumbs as typeof breadcrumbs & {
      resolveBreadcrumbDir?: () => string;
    }).resolveBreadcrumbDir?.()).toBe(resolve(root, 'breadcrumbs'));
  });

  it('refuses escaped legacy home-directory stores before creating them', () => {
    activateRoot();
    const cases = [
      {
        env: 'ATLAS_INSTANCE_LEASE_DIR',
        path: resolve(tmpdir(), `${basename(root)}-escaped-lease`),
        resolveDir: () => (instanceLease as typeof instanceLease & {
          resolveInstanceLeaseDir?: () => string;
        }).resolveInstanceLeaseDir?.(),
      },
      {
        env: 'ATLAS_PROVIDER_HEALTH_DIR',
        path: resolve(tmpdir(), `${basename(root)}-escaped-health`),
        resolveDir: () => (providerHealth as typeof providerHealth & {
          resolveProviderHealthDir?: () => string;
        }).resolveProviderHealthDir?.(),
      },
      {
        env: 'ATLAS_BREADCRUMB_DIR',
        path: resolve(tmpdir(), `${basename(root)}-escaped-breadcrumbs`),
        resolveDir: () => (breadcrumbs as typeof breadcrumbs & {
          resolveBreadcrumbDir?: () => string;
        }).resolveBreadcrumbDir?.(),
      },
    ] as const;

    try {
      for (const entry of cases) {
        process.env[entry.env] = entry.path;
        expect(entry.resolveDir).toThrow(/store_outside_root/);
        expect(existsSync(entry.path)).toBe(false);
        delete process.env[entry.env];
      }
    } finally {
      for (const entry of cases) {
        delete process.env[entry.env];
        rmSync(entry.path, { recursive: true, force: true });
      }
    }
  });

  it('writes each legacy home-directory store only below the activated root', () => {
    activateRoot();
    breadcrumbs.resetBreadcrumbStateForTests();
    const leaseId = 'm3d-a2-slice-7';

    try {
      expect(instanceLease.acquireInstanceLease({ instanceId: leaseId }).mode).toBe('writer');
      providerHealth.markProviderHealthy('nvidia');
      breadcrumbs.writeSessionBreadcrumb('m3d-a2-slice-7');

      expect(existsSync(resolve(root, 'instance-lease', 'instance-lease.json'))).toBe(true);
      expect(existsSync(resolve(root, 'provider-health', 'provider-health.json'))).toBe(true);
      expect(existsSync(resolve(root, 'breadcrumbs', 'session-breadcrumb.jsonl'))).toBe(true);
    } finally {
      instanceLease.releaseInstanceLease(leaseId);
      breadcrumbs.resetBreadcrumbStateForTests();
    }
  });

  it('refuses all three home-directory writers before mutation when activation is invalid', () => {
    process.env.ATLAS_STATE_ROOT = root;
    process.env.ATLAS_STATE_ROOT_REQUIRED = '1';
    breadcrumbs.resetBreadcrumbStateForTests();

    expect(() => instanceLease.acquireInstanceLease({
      instanceId: 'm3d-a2-invalid-slice-7',
    })).toThrow(/activation_manifest_missing/);
    expect(() => providerHealth.markProviderHealthy('nvidia')).toThrow(
      /activation_manifest_missing/,
    );
    expect(() => breadcrumbs.writeSessionBreadcrumb('m3d-a2-invalid-slice-7')).toThrow(
      /activation_manifest_missing/,
    );

    expect(existsSync(resolve(root, 'instance-lease'))).toBe(false);
    expect(existsSync(resolve(root, 'provider-health'))).toBe(false);
    expect(existsSync(resolve(root, 'breadcrumbs'))).toBe(false);
    expect(breadcrumbs.hasSessionBreadcrumb()).toBe(false);
  });

  it('preserves each learning legacy resolver before required activation', () => {
    process.env.ATLAS_STATE_ROOT = root;
    const legacyState = resolve(root, 'legacy-learning-state');
    const legacyExchange = resolve(root, 'legacy-learning-exchange');
    const explicitState = resolve(root, 'explicit-learning-state');
    process.env.ATLAS_LEARNING_STATE_DIR = legacyState;
    process.env.ATLAS_LEARNING_EXCHANGE_DIR = legacyExchange;

    expect(resolveLearningStateDir()).toBe(legacyState);
    expect(resolveLearningExchangeDir()).toBe(legacyExchange);
    expect(resolveLearningStateDir(explicitState)).toBe(explicitState);
    expect(resolveProjectionLockPath('m3d-a2-learning')).toBe(
      resolve(legacyExchange, 'projection-locks', 'm3d-a2-learning'),
    );
  });

  it('rejects relative learning overrides under the stable-path contract', () => {
    process.env.ATLAS_LEARNING_STATE_DIR = 'relative-learning-state';
    expect(() => resolveLearningStateDir()).toThrow(/stable absolute path/);

    delete process.env.ATLAS_LEARNING_STATE_DIR;
    expect(() => resolveLearningExchangeDir('relative-learning-exchange')).toThrow(
      /stable absolute path/,
    );
  });

  it('routes every learning resolver through one activated store', () => {
    activateRoot();
    const legacyExchange = resolve(root, 'legacy-learning-exchange');
    const explicitState = resolve(root, 'explicit-learning-state');
    process.env.ATLAS_LEARNING_EXCHANGE_DIR = legacyExchange;

    expect(resolveLearningStateDir(explicitState)).toBe(resolve(root, 'learning'));
    expect(resolveLearningExchangeDir(legacyExchange)).toBe(resolve(root, 'learning'));
    expect(resolveProjectionLockPath('m3d-a2-learning')).toBe(
      resolve(root, 'learning', 'projection-locks', 'm3d-a2-learning'),
    );
    expect(process.env.ATLAS_EVIDENCE_DIR).toBe(resolve(root, 'evidence'));
    expect(process.env.ATLAS_EXEC_GRAPH_DIR).toBe(resolve(root, 'exec-graph'));
    expect(process.env.ATLAS_SPEND_RECEIPT_DIR).toBe(resolve(root, 'spend-receipts'));
    expect(existsSync(explicitState)).toBe(false);
    expect(existsSync(legacyExchange)).toBe(false);
  });

  it('refuses invalid learning activation before touching a legacy path', () => {
    process.env.ATLAS_STATE_ROOT = root;
    process.env.ATLAS_STATE_ROOT_REQUIRED = '1';
    const legacyPath = resolve(root, 'legacy-learning-before-manifest');

    expect(() => resolveLearningStateDir(legacyPath)).toThrow(
      /activation_manifest_missing/,
    );
    expect(() => resolveLearningExchangeDir(legacyPath)).toThrow(
      /activation_manifest_missing/,
    );
    expect(existsSync(legacyPath)).toBe(false);
  });

  it('writes a readonly learning receipt only under the activated store', async () => {
    activateRoot();
    process.env.ATLAS_READONLY = '1';
    const legacyExchange = resolve(root, 'legacy-learning-write');

    const receipt = await processLearningRequest({
      schemaVersion: '1.0',
      kind: 'decide',
      requestId: 'req_m3d_a2_learning',
      idempotencyKey: 'idem_m3d_a2_learning',
      createdAt: '2026-07-30T00:00:00.000Z',
      issuedBy: 'volaura',
      payload: {
        learnerId: 'm3d-a2',
        concept: 'state-root',
        mastery: 0.5,
        lastAnswers: [true],
        responseTimeSec: 5,
        energy: 'medium',
      },
    }, { exchangeDir: legacyExchange });

    expect(receipt.status).toBe('readonly');
    expect(process.env.ATLAS_EVIDENCE_DIR).toBe(resolve(root, 'evidence'));
    expect(process.env.ATLAS_EXEC_GRAPH_DIR).toBe(resolve(root, 'exec-graph'));
    expect(process.env.ATLAS_SPEND_RECEIPT_DIR).toBe(resolve(root, 'spend-receipts'));
    expect(existsSync(resolve(
      root,
      'learning',
      'receipts',
      'idem_m3d_a2_learning.json',
    ))).toBe(true);
    expect(existsSync(legacyExchange)).toBe(false);
  });

  it('refuses an escaped spend alias before a completed learning projection', async () => {
    activateRoot();
    process.env.SUPABASE_URL = '';
    process.env.SUPABASE_SERVICE_ROLE_KEY = '';
    const escapedSpend = resolve(
      tmpdir(),
      `${basename(root)}-escaped-learning-spend`,
    );
    process.env.ATLAS_SPEND_RECEIPT_DIR = escapedSpend;

    try {
      await expect(processLearningRequest(
        learningOutcomeRequest('escaped_spend'),
        { exchangeDir: resolve(root, 'legacy-learning-write') },
      )).rejects.toThrow(/store_outside_root/);
      expect(existsSync(resolve(root, 'learning', 'claims'))).toBe(false);
      expect(existsSync(escapedSpend)).toBe(false);
      expect(process.env.ATLAS_EVIDENCE_DIR).toBeUndefined();
      expect(process.env.ATLAS_EXEC_GRAPH_DIR).toBeUndefined();
    } finally {
      rmSync(escapedSpend, { recursive: true, force: true });
    }
  });

  it('writes a completed learning spend receipt under the activated store', async () => {
    activateRoot();
    process.env.SUPABASE_URL = '';
    process.env.SUPABASE_SERVICE_ROLE_KEY = '';
    const legacyExchange = resolve(root, 'legacy-learning-completed');

    const receipt = await processLearningRequest(
      learningOutcomeRequest('completed'),
      { exchangeDir: legacyExchange },
    );

    expect(receipt.status).toBe('completed');
    expect(process.env.ATLAS_SPEND_RECEIPT_DIR).toBe(
      resolve(root, 'spend-receipts'),
    );
    expect(existsSync(resolve(
      root,
      'spend-receipts',
      'spend-receipts.jsonl',
    ))).toBe(true);
    expect(existsSync(legacyExchange)).toBe(false);
  });

  it('writes operator state and default traces only under the activated root', () => {
    activateRoot();
    const expectedStatePath = resolve(root, 'operator-state', 'operator-state.json');
    const expectedTracePath = resolve(root, 'operator-runs', 'm3d-a2-slice3.result.json');

    writeOperatorState({ control: { mode: 'paused', next_lane: 'fixture' } });
    const written = writeOperatorTrace(operatorResult('m3d-a2-slice3'), {
      persistState: false,
    });

    expect(controlOperatorStatePath()).toBe(expectedStatePath);
    expect(existsSync(expectedStatePath)).toBe(true);
    expect(written.trace_path).toBe(expectedTracePath);
    expect(existsSync(expectedTracePath)).toBe(true);
  });

  it('refuses an explicit trace path outside the activated operator-runs store', () => {
    activateRoot();
    const escapedTracePath = resolve(root, 'escaped-operator-trace.json');

    expect(() => writeOperatorTrace(operatorResult('m3d-a2-trace-escape'), {
      tracePath: escapedTracePath,
      persistState: false,
    })).toThrow(/store_outside_root/);
    expect(existsSync(escapedTracePath)).toBe(false);
    expect(existsSync(resolve(root, 'operator-runs'))).toBe(false);
  });

  it('accepts an explicit trace path inside the activated operator-runs store', () => {
    activateRoot();
    const containedTracePath = resolve(root, 'operator-runs', 'contained-trace.json');

    const written = writeOperatorTrace(operatorResult('m3d-a2-contained-trace'), {
      tracePath: containedTracePath,
      persistState: false,
    });

    expect(written.trace_path).toBe(containedTracePath);
    expect(existsSync(containedTracePath)).toBe(true);
  });

  it('manual promotion reads its source result from the activated operator-runs store', () => {
    activateRoot();
    const sourceTaskId = 'm3d-a2-promotion-source';
    writeOperatorTrace(operatorResult(sourceTaskId), { persistState: false });

    const promoted = dispatchOperatorTask(promotionTask(sourceTaskId), {
      persistState: false,
    });

    expect(promoted.task_id).toBe('m3d-a2-activated-promotion');
    expect(promoted.evidence.some((item) => item.source.includes(sourceTaskId))).toBe(true);
  });

  it('refuses an explicit ledger path outside the activated operator-runs store', () => {
    activateRoot();
    const escapedLedgerPath = resolve(root, 'escaped-run-ledger.jsonl');

    expect(() => appendRunLedgerEntry({
      run_id: 'm3d-a2-slice3.20260730t000001000z.000001',
      task_id: 'm3d-a2-slice3',
      executor: 'atlas',
      started_at: '2026-07-30T00:00:00.000Z',
      completed_at: '2026-07-30T00:00:01.000Z',
      status: 'blocked',
      verdict: 'blocked',
      expected_evidence_met: false,
      proof_tokens: [],
      result_path: resolve(root, 'operator-runs', 'm3d-a2-slice3.result.json'),
    }, escapedLedgerPath)).toThrow(/store_outside_root/);
    expect(existsSync(escapedLedgerPath)).toBe(false);
    expect(existsSync(resolve(root, 'operator-runs'))).toBe(false);
  });

  it('routes exec-graph through the activated shared root', () => {
    activateRoot();
    expect(resolveExecGraphDir()).toBe(resolve(root, 'exec-graph'));
  });

  it('routes evidence through the activated shared root', () => {
    activateRoot();
    const expected = resolve(root, 'evidence');

    expect(resolveEvidenceDir()).toBe(expected);
    expect(existsSync(expected)).toBe(true);
  });

  it('routes goal budgets through the activated shared root', () => {
    activateRoot();
    const resolveGoalBudgetDir = (
      budgets as typeof budgets & { resolveGoalBudgetDir?: () => string }
    ).resolveGoalBudgetDir;

    expect(resolveGoalBudgetDir?.()).toBe(resolve(root, 'goal-budgets'));
  });

  it('keeps all three call sites under an activated root after CWD changes', () => {
    activateRoot();
    const alternateCwd = join(root, 'unrelated-cwd');
    mkdirSync(alternateCwd);
    process.chdir(alternateCwd);

    expect(resolveExecGraphDir()).toBe(resolve(root, 'exec-graph'));
    expect(resolveEvidenceDir()).toBe(resolve(root, 'evidence'));
    expect(budgets.resolveGoalBudgetDir()).toBe(resolve(root, 'goal-budgets'));
  });
});
