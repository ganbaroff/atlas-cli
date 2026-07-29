import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { resolveStateRoot, resolveStateDir, STATE_STORES } from '../atlas/state-root.js';

const MANAGED_ENV_KEYS = [
  'ATLAS_STATE_ROOT',
  'ATLAS_EXEC_GRAPH_DIR',
  'ATLAS_EVIDENCE_DIR',
  'ATLAS_GOAL_BUDGET_DIR',
] as const;

const ABSOLUTE_STATE_ROOT = join(tmpdir(), 'atlas-state-root-test');
const ABSOLUTE_LEGACY_ROOT = join(tmpdir(), 'atlas-legacy-root-test');

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

  describe('STATE_STORES registry', () => {
    it('includes known stores omitted from the first migration inventory', () => {
      expect(Object.keys(STATE_STORES)).toEqual(
        expect.arrayContaining(['intake-drafts', 'task-results'])
      );
    });

    it('names the nine stores in the current migration registry', () => {
      expect(Object.keys(STATE_STORES).sort()).toEqual(
        [
          'exec-graph',
          'evidence',
          'goal-budgets',
          'cost-router',
          'swarm-runs',
          'operator-state',
          'operator-runs',
          'intake-drafts',
          'task-results',
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
