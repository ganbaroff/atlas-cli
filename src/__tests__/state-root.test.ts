import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

import { resolveStateRoot, resolveStateDir, STATE_STORES } from '../atlas/state-root.js';

const MANAGED_ENV_KEYS = [
  'ATLAS_STATE_ROOT',
  'ATLAS_EXEC_GRAPH_DIR',
  'ATLAS_EVIDENCE_DIR',
  'ATLAS_GOAL_BUDGET_DIR',
] as const;

describe('atlas/state-root', () => {
  let prior: Record<string, string | undefined>;
  let priorCwd: string;

  beforeEach(() => {
    prior = {};
    for (const key of MANAGED_ENV_KEYS) {
      prior[key] = process.env[key];
      delete process.env[key];
    }
    priorCwd = process.cwd();
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
  });

  describe('resolveStateRoot()', () => {
    it('respects ATLAS_STATE_ROOT when set and non-empty', () => {
      process.env.ATLAS_STATE_ROOT = '/tmp/custom-atlas-root';
      expect(resolveStateRoot()).toBe(resolve('/tmp/custom-atlas-root'));
    });

    it('trims whitespace on ATLAS_STATE_ROOT', () => {
      process.env.ATLAS_STATE_ROOT = '  /tmp/custom-atlas-root  ';
      expect(resolveStateRoot()).toBe(resolve('/tmp/custom-atlas-root'));
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
  });

  describe('resolveStateDir()', () => {
    it('lands under the state root when the store has no legacy env var', () => {
      process.env.ATLAS_STATE_ROOT = '/tmp/custom-atlas-root';
      expect(resolveStateDir('swarm-runs')).toBe(resolve('/tmp/custom-atlas-root', 'swarm-runs'));
      expect(resolveStateDir('operator-state')).toBe(
        resolve('/tmp/custom-atlas-root', 'operator-state')
      );
      expect(resolveStateDir('operator-runs')).toBe(
        resolve('/tmp/custom-atlas-root', 'operator-runs')
      );
    });

    it('lands under the default state root when nothing is set', () => {
      expect(resolveStateDir('swarm-runs')).toBe(join(homedir(), '.atlas', 'state', 'swarm-runs'));
    });

    it('the legacy per-store env var wins over ATLAS_STATE_ROOT', () => {
      process.env.ATLAS_STATE_ROOT = '/tmp/custom-atlas-root';
      process.env.ATLAS_EXEC_GRAPH_DIR = '/tmp/legacy-exec-graph';
      expect(resolveStateDir('exec-graph')).toBe(resolve('/tmp/legacy-exec-graph'));
    });

    it('the legacy per-store env var wins even when ATLAS_STATE_ROOT is unset', () => {
      process.env.ATLAS_EVIDENCE_DIR = '/tmp/legacy-evidence';
      expect(resolveStateDir('evidence')).toBe(resolve('/tmp/legacy-evidence'));
    });

    it('falls through to the root when the legacy env var is set but empty', () => {
      process.env.ATLAS_STATE_ROOT = '/tmp/custom-atlas-root';
      process.env.ATLAS_GOAL_BUDGET_DIR = '';
      expect(resolveStateDir('goal-budgets')).toBe(resolve('/tmp/custom-atlas-root', 'goal-budgets'));
    });

    it('honors an explicit legacyEnv override argument over the registry default', () => {
      process.env.ATLAS_STATE_ROOT = '/tmp/custom-atlas-root';
      process.env.SOME_OTHER_VAR = '/tmp/override-target';
      try {
        expect(resolveStateDir('swarm-runs', 'SOME_OTHER_VAR')).toBe(resolve('/tmp/override-target'));
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

  describe('STATE_STORES registry', () => {
    it('names all six checkout-relative stores from the P2 inventory', () => {
      expect(Object.keys(STATE_STORES).sort()).toEqual(
        [
          'exec-graph',
          'evidence',
          'goal-budgets',
          'swarm-runs',
          'operator-state',
          'operator-runs',
        ].sort()
      );
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
