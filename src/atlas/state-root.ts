/**
 * atlas/state-root.ts — single ATLAS_STATE_ROOT resolver (P2.1 wave A).
 *
 * WHY THIS EXISTS: runtime state currently scatters across ~25 stores, six of
 * which (exec-graph, evidence, goal budgets, swarm-run bundles, operator
 * state, operator runs) resolve relative to the code checkout (cwd or a
 * module-walk to the nearest package.json — see exec-graph/ledger.ts's
 * resolveExecGraphDir() and evidence/ledger.ts's resolveEvidenceDir()). That
 * works today because the checkout IS the runtime home, but it breaks the
 * moment the repo moves out of OneDrive: state would either vanish (new cwd
 * has no matching tree) or split across two checkouts.
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
import { join, resolve } from 'node:path';

/** Registry of known state stores and (if any) their legacy per-store env var. */
export const STATE_STORES = {
  'exec-graph': 'ATLAS_EXEC_GRAPH_DIR',
  evidence: 'ATLAS_EVIDENCE_DIR',
  'goal-budgets': 'ATLAS_GOAL_BUDGET_DIR',
  'swarm-runs': undefined,
  'operator-state': undefined,
  'operator-runs': undefined,
} as const satisfies Readonly<Record<string, string | undefined>>;

export type StateStore = keyof typeof STATE_STORES;

/**
 * Resolve the single root all Atlas runtime state lives under.
 * Returns `ATLAS_STATE_ROOT` when set and non-empty; otherwise
 * `~/.atlas/state`. Never cwd-relative or checkout-relative.
 */
export function resolveStateRoot(): string {
  const override = process.env.ATLAS_STATE_ROOT;
  if (override && override.trim()) return resolve(override.trim());
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
    const legacy = process.env[envName];
    if (legacy && legacy.trim()) return resolve(legacy.trim());
  }
  return join(resolveStateRoot(), store);
}
