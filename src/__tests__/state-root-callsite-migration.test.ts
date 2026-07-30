import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { resolveExecGraphDir } from '../exec-graph/ledger.js';
import { resolveEvidenceDir } from '../evidence/ledger.js';
import * as budgets from '../goal-runner/budgets.js';
import { STATE_ROOT_ACTIVATION_FILE, STATE_STORES } from '../atlas/state-root.js';
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

describe('M3D-A2 state-root call-site migration slices 1-2', () => {
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
