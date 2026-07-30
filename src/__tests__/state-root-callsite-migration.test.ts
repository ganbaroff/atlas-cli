import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
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

const MANAGED_ENV_KEYS = [
  'ATLAS_STATE_ROOT',
  'ATLAS_STATE_ROOT_REQUIRED',
  'ATLAS_EXEC_GRAPH_DIR',
  'ATLAS_EVIDENCE_DIR',
  'ATLAS_GOAL_BUDGET_DIR',
] as const;
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

describe('M3D-A2 state-root call-site migration slices 1-3', () => {
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
