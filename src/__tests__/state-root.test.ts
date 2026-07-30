import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';

import {
  assertStateRootActivated,
  constrainMigratingStatePath,
  resolveMigratingStateDir,
  resolveMigratingStateFile,
  resolveStateRoot,
  resolveStateDir,
  STATE_ROOT_ACTIVATION_FILE,
  STATE_STORES,
} from '../atlas/state-root.js';

const MANAGED_ENV_KEYS = [
  'ATLAS_STATE_ROOT',
  'ATLAS_STATE_ROOT_REQUIRED',
  'ATLAS_EXEC_GRAPH_DIR',
  'ATLAS_EVIDENCE_DIR',
  'ATLAS_GOAL_BUDGET_DIR',
  'ATLAS_LEARNING_STATE_DIR',
  'ATLAS_INSTANCE_LEASE_DIR',
  'ATLAS_STATE_DIR',
  'ATLAS_PROVIDER_HEALTH_DIR',
  'ATLAS_SPEND_RECEIPT_DIR',
  'ATLAS_BREADCRUMB_DIR',
  'ATLAS_OPSBOARD_EXCHANGE_DIR',
  'ATLAS_NOTIFY_QUEUE_PATH',
] as const;

const ABSOLUTE_STATE_ROOT = join(tmpdir(), 'atlas-state-root-test');
const ABSOLUTE_LEGACY_ROOT = join(tmpdir(), 'atlas-legacy-root-test');

describe('atlas/state-root', () => {
  let prior: Record<string, string | undefined>;
  let priorCwd: string;
  let activationRoot: string;

  beforeEach(() => {
    prior = {};
    for (const key of MANAGED_ENV_KEYS) {
      prior[key] = process.env[key];
      delete process.env[key];
    }
    priorCwd = process.cwd();
    activationRoot = mkdtempSync(join(tmpdir(), 'atlas-state-root-activation-'));
  });

  afterEach(() => {
    for (const key of MANAGED_ENV_KEYS) {
      const value = prior[key];
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    try {
      process.chdir(priorCwd);
    } catch {
      /* ignore — cwd may already be valid */
    }
    rmSync(activationRoot, { recursive: true, force: true });
  });

  function writeActivationManifest(overrides: Record<string, unknown> = {}): void {
    mkdirSync(activationRoot, { recursive: true });
    writeFileSync(
      join(activationRoot, STATE_ROOT_ACTIVATION_FILE),
      `${JSON.stringify({
        schemaVersion: 1,
        nodeRole: 'local',
        activatedAt: '2026-07-30T00:00:00.000Z',
        stores: Object.keys(STATE_STORES),
        sourceReceipts: [
          { kind: 'm3c-exec-graph', sha256: 'a'.repeat(64) },
        ],
        ...overrides,
      }, null, 2)}\n`,
      'utf8',
    );
  }

  describe('resolveStateRoot()', () => {
    it('respects ATLAS_STATE_ROOT when set and non-empty', () => {
      process.env.ATLAS_STATE_ROOT = ABSOLUTE_STATE_ROOT;
      expect(resolveStateRoot()).toBe(resolve(ABSOLUTE_STATE_ROOT));
    });

    it('trims whitespace on ATLAS_STATE_ROOT', () => {
      process.env.ATLAS_STATE_ROOT = `  ${ABSOLUTE_STATE_ROOT}  `;
      expect(resolveStateRoot()).toBe(resolve(ABSOLUTE_STATE_ROOT));
    });

    it('rejects a relative ATLAS_STATE_ROOT', () => {
      process.env.ATLAS_STATE_ROOT = 'relative-state';
      expect(() => resolveStateRoot()).toThrow(
        'ATLAS_STATE_ROOT must be a stable absolute path'
      );
    });

    it('falls back to ~/.atlas/state when ATLAS_STATE_ROOT is unset', () => {
      expect(resolveStateRoot()).toBe(join(homedir(), '.atlas', 'state'));
    });

    it('falls back to ~/.atlas/state when ATLAS_STATE_ROOT is set but empty', () => {
      process.env.ATLAS_STATE_ROOT = '';
      expect(resolveStateRoot()).toBe(join(homedir(), '.atlas', 'state'));
    });

    it('falls back to ~/.atlas/state when ATLAS_STATE_ROOT is whitespace-only', () => {
      process.env.ATLAS_STATE_ROOT = '   ';
      expect(resolveStateRoot()).toBe(join(homedir(), '.atlas', 'state'));
    });

    it('returns an absolute path', () => {
      expect(resolve(resolveStateRoot())).toBe(resolveStateRoot());
    });

    it('does not depend on process.cwd()', () => {
      const before = resolveStateRoot();
      process.chdir(homedir());
      const after = resolveStateRoot();
      expect(after).toBe(before);
    });

    it('keeps an absolute override stable across cwd changes', () => {
      process.env.ATLAS_STATE_ROOT = ABSOLUTE_STATE_ROOT;
      const before = resolveStateRoot();
      process.chdir(tmpdir());
      expect(resolveStateRoot()).toBe(before);
    });

    it('requires an explicit root when production activation is enabled', () => {
      process.env.ATLAS_STATE_ROOT_REQUIRED = '1';
      expect(() => resolveStateRoot()).toThrow('explicit_root_required');
    });

    it('refuses an unknown activation-mode value instead of silently disabling it', () => {
      process.env.ATLAS_STATE_ROOT = ABSOLUTE_STATE_ROOT;
      process.env.ATLAS_STATE_ROOT_REQUIRED = 'yes';
      expect(() => resolveStateRoot()).toThrow(
        'ATLAS_STATE_ROOT_REQUIRED must be one of: 1, true, 0, false',
      );
    });
  });

  describe('activated root contract', () => {
    beforeEach(() => {
      process.env.ATLAS_STATE_ROOT = activationRoot;
      process.env.ATLAS_STATE_ROOT_REQUIRED = '1';
    });

    it('refuses a missing activation manifest before resolving a store', () => {
      expect(() => resolveStateDir('exec-graph')).toThrow('activation_manifest_missing');
    });

    it('accepts a strict manifest that activates the complete registry', () => {
      writeActivationManifest();
      expect(assertStateRootActivated().nodeRole).toBe('local');
      expect(resolveStateDir('exec-graph')).toBe(join(activationRoot, 'exec-graph'));
    });

    it('refuses a store omitted from the activation manifest', () => {
      writeActivationManifest({
        stores: Object.keys(STATE_STORES).filter((store) => store !== 'exec-graph'),
      });
      expect(() => assertStateRootActivated()).toThrow('store_not_activated');
    });

    it('refuses an invalid activation receipt hash', () => {
      writeActivationManifest({
        sourceReceipts: [{ kind: 'm3c-exec-graph', sha256: 'not-a-sha256' }],
      });
      expect(() => assertStateRootActivated()).toThrow('activation_manifest_invalid');
    });

    it('refuses a legacy override that escapes the activated root', () => {
      writeActivationManifest();
      process.env.ATLAS_EXEC_GRAPH_DIR = ABSOLUTE_LEGACY_ROOT;
      expect(() => resolveStateDir('exec-graph')).toThrow('store_outside_root');
    });

    it('allows a legacy override contained by the activated root', () => {
      writeActivationManifest();
      const contained = join(activationRoot, 'legacy-exec-graph');
      process.env.ATLAS_EXEC_GRAPH_DIR = contained;
      expect(resolveStateDir('exec-graph')).toBe(contained);
    });

    it('refuses a lexically-contained legacy path whose junction resolves outside the root', () => {
      writeActivationManifest();
      const outsideRoot = mkdtempSync(join(tmpdir(), 'atlas-state-root-outside-'));
      try {
        const linkedParent = join(activationRoot, 'linked-outside');
        symlinkSync(outsideRoot, linkedParent, process.platform === 'win32' ? 'junction' : 'dir');
        process.env.ATLAS_EXEC_GRAPH_DIR = join(linkedParent, 'exec-graph');
        expect(() => resolveStateDir('exec-graph')).toThrow('store_outside_root');
      } finally {
        rmSync(outsideRoot, { recursive: true, force: true });
      }
    });

    it('refuses a registered default store whose junction resolves outside the root', () => {
      writeActivationManifest();
      const outsideRoot = mkdtempSync(join(tmpdir(), 'atlas-state-root-store-outside-'));
      try {
        const linkedStore = join(activationRoot, 'operator-runs');
        symlinkSync(outsideRoot, linkedStore, process.platform === 'win32' ? 'junction' : 'dir');
        expect(() => resolveStateDir('operator-runs')).toThrow('store_outside_root');
      } finally {
        rmSync(outsideRoot, { recursive: true, force: true });
      }
    });

    it('refuses a relative file override after activation', () => {
      writeActivationManifest();
      expect(() =>
        constrainMigratingStatePath('operator-runs', 'relative-result.json'),
      ).toThrow('store_outside_root');
    });
  });

  describe('resolveStateDir()', () => {
    it('lands under the state root when the store has no legacy env var', () => {
      process.env.ATLAS_STATE_ROOT = ABSOLUTE_STATE_ROOT;
      expect(resolveStateDir('swarm-runs')).toBe(resolve(ABSOLUTE_STATE_ROOT, 'swarm-runs'));
      expect(resolveStateDir('operator-state')).toBe(
        resolve(ABSOLUTE_STATE_ROOT, 'operator-state')
      );
      expect(resolveStateDir('operator-runs')).toBe(
        resolve(ABSOLUTE_STATE_ROOT, 'operator-runs')
      );
    });

    it('lands under the default state root when nothing is set', () => {
      expect(resolveStateDir('swarm-runs')).toBe(join(homedir(), '.atlas', 'state', 'swarm-runs'));
    });

    it('lands cost-router state under the shared state root', () => {
      process.env.ATLAS_STATE_ROOT = ABSOLUTE_STATE_ROOT;
      expect(resolveStateDir('cost-router')).toBe(
        resolve(ABSOLUTE_STATE_ROOT, 'cost-router')
      );
    });

    it('the legacy per-store env var wins over ATLAS_STATE_ROOT', () => {
      process.env.ATLAS_STATE_ROOT = ABSOLUTE_STATE_ROOT;
      process.env.ATLAS_EXEC_GRAPH_DIR = ABSOLUTE_LEGACY_ROOT;
      expect(resolveStateDir('exec-graph')).toBe(resolve(ABSOLUTE_LEGACY_ROOT));
    });

    it('a valid legacy override wins over a malformed staged root before activation', () => {
      process.env.ATLAS_STATE_ROOT = 'relative-staged-root';
      process.env.ATLAS_EXEC_GRAPH_DIR = ABSOLUTE_LEGACY_ROOT;
      expect(resolveStateDir('exec-graph')).toBe(resolve(ABSOLUTE_LEGACY_ROOT));
    });

    it('the legacy per-store env var wins even when ATLAS_STATE_ROOT is unset', () => {
      process.env.ATLAS_EVIDENCE_DIR = ABSOLUTE_LEGACY_ROOT;
      expect(resolveStateDir('evidence')).toBe(resolve(ABSOLUTE_LEGACY_ROOT));
    });

    it('rejects a relative legacy store override', () => {
      process.env.ATLAS_EXEC_GRAPH_DIR = 'relative-exec-graph';
      expect(() => resolveStateDir('exec-graph')).toThrow(
        'ATLAS_EXEC_GRAPH_DIR must be a stable absolute path'
      );
    });

    it('falls through to the root when the legacy env var is set but empty', () => {
      process.env.ATLAS_STATE_ROOT = ABSOLUTE_STATE_ROOT;
      process.env.ATLAS_GOAL_BUDGET_DIR = '';
      expect(resolveStateDir('goal-budgets')).toBe(resolve(ABSOLUTE_STATE_ROOT, 'goal-budgets'));
    });

    it('honors an explicit legacyEnv override argument over the registry default', () => {
      process.env.ATLAS_STATE_ROOT = ABSOLUTE_STATE_ROOT;
      process.env.SOME_OTHER_VAR = ABSOLUTE_LEGACY_ROOT;
      try {
        expect(resolveStateDir('swarm-runs', 'SOME_OTHER_VAR')).toBe(
          resolve(ABSOLUTE_LEGACY_ROOT)
        );
      } finally {
        delete process.env.SOME_OTHER_VAR;
      }
    });

    it('returns an absolute path for every registered store', () => {
      for (const store of Object.keys(STATE_STORES) as Array<keyof typeof STATE_STORES>) {
        const dir = resolveStateDir(store);
        expect(resolve(dir)).toBe(dir);
      }
    });

    it('does not depend on process.cwd()', () => {
      const before = resolveStateDir('operator-runs');
      process.chdir(homedir());
      const after = resolveStateDir('operator-runs');
      expect(after).toBe(before);
    });
  });

  describe('resolveMigratingStateDir()', () => {
    it('preserves the exact legacy default before an explicit root is configured', () => {
      const legacyDefault = join(tmpdir(), 'atlas-legacy-default', 'exec-graph');
      const fallback = vi.fn(() => legacyDefault);

      expect(resolveMigratingStateDir('exec-graph', fallback)).toBe(
        resolve(legacyDefault),
      );
      expect(fallback).toHaveBeenCalledTimes(1);
    });

    it('does not switch to a staged explicit root before required activation', () => {
      process.env.ATLAS_STATE_ROOT = ABSOLUTE_STATE_ROOT;
      const legacyDefault = join(tmpdir(), 'atlas-staged-root-legacy-default');
      const fallback = vi.fn(() => legacyDefault);

      expect(resolveMigratingStateDir('exec-graph', fallback)).toBe(
        resolve(legacyDefault),
      );
      expect(fallback).toHaveBeenCalledTimes(1);
    });

    it('preserves a legacy per-store override before root activation', () => {
      process.env.ATLAS_STATE_ROOT = 'relative-staged-root';
      process.env.ATLAS_EVIDENCE_DIR = ABSOLUTE_LEGACY_ROOT;
      const fallback = vi.fn(() => join(tmpdir(), 'must-not-run'));

      expect(resolveMigratingStateDir('evidence', fallback)).toBe(
        resolve(ABSOLUTE_LEGACY_ROOT),
      );
      expect(fallback).not.toHaveBeenCalled();
    });

    it('rejects a relative legacy default instead of making it cwd-dependent', () => {
      expect(() =>
        resolveMigratingStateDir('goal-budgets', () => 'state/goal-budgets'),
      ).toThrow('legacy default for goal-budgets must be a stable absolute path');
    });

    it('uses the activated root only after the complete manifest is present', () => {
      process.env.ATLAS_STATE_ROOT = activationRoot;
      process.env.ATLAS_STATE_ROOT_REQUIRED = 'true';
      writeActivationManifest();
      const fallback = vi.fn(() => join(tmpdir(), 'must-not-run'));

      expect(resolveMigratingStateDir('goal-budgets', fallback)).toBe(
        join(activationRoot, 'goal-budgets'),
      );
      expect(fallback).not.toHaveBeenCalled();
    });

    it('preserves a relative file override before activation', () => {
      expect(constrainMigratingStatePath('operator-runs', 'relative-result.json'))
        .toBe('relative-result.json');
    });
  });

  describe('resolveMigratingStateFile()', () => {
    it('derives one fixed basename below the activated store', () => {
      process.env.ATLAS_STATE_ROOT = activationRoot;
      process.env.ATLAS_STATE_ROOT_REQUIRED = '1';
      process.env.ATLAS_NOTIFY_QUEUE_PATH = join(tmpdir(), 'escaped-notify.json');
      writeActivationManifest();
      const fallback = vi.fn(() => join(tmpdir(), 'legacy-notify.json'));

      expect(resolveMigratingStateFile(
        'notify-queue',
        'notify-queue.json',
        fallback,
        'ATLAS_NOTIFY_QUEUE_PATH',
      )).toBe(join(activationRoot, 'notify-queue', 'notify-queue.json'));
      expect(fallback).not.toHaveBeenCalled();
    });

    it('rejects a basename that could escape its activated store', () => {
      expect(() => resolveMigratingStateFile(
        'notify-queue',
        '../outside.json',
        () => join(tmpdir(), 'legacy-notify.json'),
      )).toThrow(/one fixed basename/);
      expect(() => resolveMigratingStateFile(
        'notify-queue',
        'nested\\outside.json',
        () => join(tmpdir(), 'legacy-notify.json'),
      )).toThrow(/one fixed basename/);
    });
  });

  describe('STATE_STORES registry', () => {
    it('includes known stores omitted from the first migration inventory', () => {
      expect(Object.keys(STATE_STORES)).toEqual(
        expect.arrayContaining(['intake-drafts', 'task-results'])
      );
    });

    it('covers every currently classified root-managed store', () => {
      expect(Object.keys(STATE_STORES)).toEqual(expect.arrayContaining([
        'exec-graph',
        'evidence',
        'goal-budgets',
        'cost-router',
        'swarm-runs',
        'operator-state',
        'operator-runs',
        'intake-drafts',
        'task-results',
        'learning',
        'instance-lease',
        'queue-auth',
        'provider-health',
        'spend-receipts',
        'notify-queue',
        'alert-state',
        'emotion-audit',
        'repo-watch',
        'breadcrumbs',
        'shell-audit',
        'opsboard-exchange',
        'pause-control',
        'runner-log',
      ]));
    });

    it('maps the three stores that already have a documented legacy env var', () => {
      expect(STATE_STORES['exec-graph']).toBe('ATLAS_EXEC_GRAPH_DIR');
      expect(STATE_STORES.evidence).toBe('ATLAS_EVIDENCE_DIR');
      expect(STATE_STORES['goal-budgets']).toBe('ATLAS_GOAL_BUDGET_DIR');
    });

    it('leaves the three newer stores without a legacy env var', () => {
      expect(STATE_STORES['swarm-runs']).toBeUndefined();
      expect(STATE_STORES['operator-state']).toBeUndefined();
      expect(STATE_STORES['operator-runs']).toBeUndefined();
    });
  });
});
