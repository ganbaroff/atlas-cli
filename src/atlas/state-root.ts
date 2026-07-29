/**
 * atlas/state-root.ts — single ATLAS_STATE_ROOT resolver (P2.1 wave A).
 *
 * WHY THIS EXISTS: runtime path resolution is scattered, and verified stores
 * still include checkout-relative and legacy hardcoded defaults. That works
 * today because the checkout acts as runtime home, but a repository move can
 * make state vanish from the new checkout or split across two checkouts.
 *
 * This module adds ONE checkout-independent resolver. It intentionally does
 * NOT migrate any call site yet — existing resolvers keep their own
 * cwd/module-walk fallback untouched, so behavior is unchanged and nothing
 * can regress. Migration is a later wave; this wave only makes the target
 * resolution available and gives the store inventory a home in code.
 *
 * Precedence for any given store:
 *   1. That store's legacy per-store env var (e.g. ATLAS_EXEC_GRAPH_DIR), if
 *      set and non-empty. Backward compatibility always wins — an operator
 *      who already pinned a store's location must never be silently moved.
 *   2. `<ATLAS_STATE_ROOT>/<store>`.
 * There is no third fallback and no cwd branch: the root itself defaults to
 * `~/.atlas/state`, which is checkout-independent by construction.
 */

import { homedir } from 'node:os';
import { isAbsolute, join, normalize, parse } from 'node:path';

export class StateRootConfigurationError extends Error {
  constructor(envName: string) {
    super(`${envName} must be a stable absolute path`);
    this.name = 'StateRootConfigurationError';
  }
}

function readAbsoluteOverride(envName: string): string | undefined {
  const value = process.env[envName]?.trim();
  if (!value) return undefined;

  const root = parse(value).root;
  const windowsRootIsStable =
    process.platform !== 'win32' ||
    /^[A-Za-z]:[\\/]$/.test(root) ||
    root.startsWith('\\\\');

  if (!isAbsolute(value) || !windowsRootIsStable) {
    throw new StateRootConfigurationError(envName);
  }

  return normalize(value);
}

/** Managed state-store registry; not a claim of complete runtime-store inventory. */
export const STATE_STORES = {
  'exec-graph': 'ATLAS_EXEC_GRAPH_DIR',
  evidence: 'ATLAS_EVIDENCE_DIR',
  'goal-budgets': 'ATLAS_GOAL_BUDGET_DIR',
  'swarm-runs': undefined,
  'operator-state': undefined,
  'operator-runs': undefined,
  'intake-drafts': undefined,
  'task-results': undefined,
  'cost-router': undefined,
} as const satisfies Readonly<Record<string, string | undefined>>;

export type StateStore = keyof typeof STATE_STORES;

/**
 * Resolve the single root all Atlas runtime state lives under.
 * Returns `ATLAS_STATE_ROOT` when set and non-empty; otherwise
 * `~/.atlas/state`. Never cwd-relative or checkout-relative.
 */
export function resolveStateRoot(): string {
  const override = readAbsoluteOverride('ATLAS_STATE_ROOT');
  if (override) return override;
  return join(homedir(), '.atlas', 'state');
}

/**
 * Resolve the directory for a specific state store.
 *
 * Precedence: (1) the legacy per-store env var named by `legacyEnv`, if set
 * and non-empty; (2) `resolveStateRoot()/<store>`. Does not create the
 * directory — callers that need it to exist create it themselves.
 */
export function resolveStateDir(store: StateStore, legacyEnv?: string): string {
  const envName = legacyEnv ?? STATE_STORES[store];
  if (envName) {
    const legacy = readAbsoluteOverride(envName);
    if (legacy) return legacy;
  }
  return join(resolveStateRoot(), store);
}
