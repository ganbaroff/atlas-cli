/**
 * atlas/state-root.ts — single ATLAS_STATE_ROOT resolver (P2.1 wave A).
 *
 * WHY THIS EXISTS: runtime path resolution is scattered, and verified stores
 * still include checkout-relative and legacy hardcoded defaults. That works
 * today because the checkout acts as runtime home, but a repository move can
 * make state vanish from the new checkout or split across two checkouts.
 *
 * This module adds ONE checkout-independent resolver plus a migration bridge.
 * A migrating call site keeps its exact legacy default until an operator
 * enables required activation. ATLAS_STATE_ROOT may be staged independently
 * without rerouting another store. That prevents code rollout from becoming a
 * hidden live-state cutover.
 *
 * Shared-resolver precedence for any given store:
 *   1. That store's legacy per-store env var (e.g. ATLAS_EXEC_GRAPH_DIR), if
 *      set and non-empty. Backward compatibility always wins — an operator
 *      who already pinned a store's location must never be silently moved.
 *   2. `<ATLAS_STATE_ROOT>/<store>`.
 * `resolveStateDir()` has no third fallback and no cwd branch: the root itself
 * defaults to `~/.atlas/state`, which is checkout-independent by construction.
 * `resolveMigratingStateDir()` adds only a pre-activation legacy-default
 * branch; that branch becomes unreachable once required activation is on.
 *
 * ACTIVATION: pre-cutover callers keep the backward-compatible default above.
 * Once `ATLAS_STATE_ROOT_REQUIRED=1|true`, the root must be explicit, a strict
 * activation manifest must cover the complete registry, and legacy overrides
 * may not escape the activated root. This turns a missing cutover binding into
 * a named refusal instead of silently opening a second state home.
 */

import { homedir } from 'node:os';
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, readFileSync, realpathSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, normalize, parse, relative, resolve } from 'node:path';
import { z } from 'zod';

export class StateRootConfigurationError extends Error {
  constructor(envName: string, message = `${envName} must be a stable absolute path`) {
    super(message);
    this.name = 'StateRootConfigurationError';
  }
}

export type StateRootActivationErrorCode =
  | 'explicit_root_required'
  | 'activation_manifest_missing'
  | 'activation_manifest_invalid'
  | 'store_not_activated'
  | 'store_outside_root'
  | 'node_role_unbound'
  | 'node_role_mismatch'
  | 'source_receipt_missing'
  | 'source_receipt_mismatch';

export class StateRootActivationError extends Error {
  constructor(
    readonly code: StateRootActivationErrorCode,
    message: string,
  ) {
    super(`${code}: ${message}`);
    this.name = 'StateRootActivationError';
  }
}

function normalizeStableAbsolute(value: string, label: string): string {
  const candidate = value.trim();
  const root = parse(candidate).root;
  const windowsRootIsStable =
    process.platform !== 'win32' ||
    /^[A-Za-z]:[\\/]$/.test(root) ||
    root.startsWith('\\\\');

  if (!candidate || !isAbsolute(candidate) || !windowsRootIsStable) {
    throw new StateRootConfigurationError(label);
  }

  return normalize(candidate);
}

function readAbsoluteOverride(envName: string): string | undefined {
  const value = process.env[envName]?.trim();
  if (!value) return undefined;
  return normalizeStableAbsolute(value, envName);
}

/**
 * Classified root-managed stores. File-shaped legacy overrides stay undefined
 * here and are handled by their call-site migration because resolveStateDir()
 * returns directories, never files.
 */
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
  learning: 'ATLAS_LEARNING_STATE_DIR',
  'instance-lease': 'ATLAS_INSTANCE_LEASE_DIR',
  'queue-auth': 'ATLAS_STATE_DIR',
  'provider-health': 'ATLAS_PROVIDER_HEALTH_DIR',
  'spend-receipts': 'ATLAS_SPEND_RECEIPT_DIR',
  'notify-queue': undefined,
  'alert-state': undefined,
  'emotion-audit': undefined,
  'repo-watch': undefined,
  breadcrumbs: 'ATLAS_BREADCRUMB_DIR',
  'shell-audit': undefined,
  'opsboard-exchange': 'ATLAS_OPSBOARD_EXCHANGE_DIR',
  'pause-control': undefined,
  'runner-log': undefined,
} as const satisfies Readonly<Record<string, string | undefined>>;

export type StateStore = keyof typeof STATE_STORES;

export const STATE_ROOT_ACTIVATION_FILE = 'state-root-activation.json';

const activationReceiptSchema = z.object({
  kind: z.string().trim().min(1).refine(
    (value) => value !== '.' && value !== '..' && !/[\\/]/.test(value),
    { message: 'receipt kind must be one safe path segment' },
  ),
  sha256: z.string().regex(/^[a-f0-9]{64}$/i),
}).strict();

const stateRootActivationManifestSchema = z.object({
  schemaVersion: z.literal(1),
  nodeRole: z.enum(['local', 'railway']),
  activatedAt: z.string().datetime(),
  stores: z.array(z.string().trim().min(1)).min(1),
  sourceReceipts: z.array(activationReceiptSchema).min(1),
}).strict();

export interface StateRootActivationManifest {
  schemaVersion: 1;
  nodeRole: 'local' | 'railway';
  activatedAt: string;
  stores: StateStore[];
  sourceReceipts: Array<{ kind: string; sha256: string }>;
}

/**
 * Per-role allowlist of source-receipt kinds a live activation manifest must
 * carry, verified against real artifact bytes below
 * `<root>/activation-receipts/<kind>`. The manifest's own claim is never
 * proof by itself — see assertStateRootActivated().
 */
const REQUIRED_RECEIPT_KINDS: Record<'local' | 'railway', readonly string[]> = {
  local: ['m3c-preserved-state-rehearsal'],
  railway: ['m3c-preserved-state-rehearsal'],
};

function readNodeRoleEnv(): 'local' | 'railway' | undefined {
  const value = process.env.ATLAS_NODE_ROLE?.trim();
  if (!value) return undefined;
  if (value === 'local' || value === 'railway') return value;
  throw new StateRootConfigurationError(
    'ATLAS_NODE_ROLE',
    'ATLAS_NODE_ROLE must be one of: local, railway',
  );
}

function stateRootRequired(): boolean {
  const value = process.env.ATLAS_STATE_ROOT_REQUIRED?.trim().toLowerCase();
  if (!value || value === '0' || value === 'false') return false;
  if (value === '1' || value === 'true') return true;
  throw new StateRootConfigurationError(
    'ATLAS_STATE_ROOT_REQUIRED',
    'ATLAS_STATE_ROOT_REQUIRED must be one of: 1, true, 0, false',
  );
}

/** True only for the explicit, fail-closed activation mode. */
export function isStateRootActivationRequired(): boolean {
  return stateRootRequired();
}

/**
 * Resolve the single root all Atlas runtime state lives under.
 * Returns `ATLAS_STATE_ROOT` when set and non-empty; otherwise
 * `~/.atlas/state`. Never cwd-relative or checkout-relative.
 */
export function resolveStateRoot(): string {
  const required = stateRootRequired();
  const override = readAbsoluteOverride('ATLAS_STATE_ROOT');
  if (override) return override;
  if (required) {
    throw new StateRootActivationError(
      'explicit_root_required',
      'ATLAS_STATE_ROOT_REQUIRED is enabled but ATLAS_STATE_ROOT is missing',
    );
  }
  return join(homedir(), '.atlas', 'state');
}

function canonicalizeExistingPrefix(path: string): string {
  const missingTail: string[] = [];
  let probe = path;
  while (!pathEntryExists(probe)) {
    const parent = dirname(probe);
    if (parent === probe) return normalize(path);
    missingTail.unshift(basename(probe));
    probe = parent;
  }
  return resolve(realpathSync(probe), ...missingTail);
}

function pathEntryExists(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ENOTDIR') return false;
    throw error;
  }
}

function isStrictChildPath(root: string, candidate: string): boolean {
  const canonicalRoot = canonicalizeExistingPrefix(root);
  const canonicalCandidate = canonicalizeExistingPrefix(candidate);
  const rel = relative(canonicalRoot, canonicalCandidate);
  const firstSegment = rel.split(/[\\/]/, 1)[0];
  return rel.length > 0 && firstSegment !== '..' && !isAbsolute(rel);
}

function assertPathContained(
  root: string,
  candidate: string,
  subject: string,
  parent: string,
): void {
  let contained = false;
  try {
    contained = isStrictChildPath(root, candidate);
  } catch (error) {
    throw new StateRootActivationError(
      'store_outside_root',
      `cannot prove ${subject} is contained by ${parent}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
  if (!contained) {
    throw new StateRootActivationError(
      'store_outside_root',
      `${subject} resolves outside ${parent}`,
    );
  }
}

export function stateRootActivationPath(root = resolveStateRoot()): string {
  return join(root, STATE_ROOT_ACTIVATION_FILE);
}

export function assertStateRootActivated(
  root = resolveStateRoot(),
): StateRootActivationManifest {
  const path = stateRootActivationPath(root);
  if (!existsSync(path)) {
    throw new StateRootActivationError(
      'activation_manifest_missing',
      `state root activation manifest is missing: ${path}`,
    );
  }

  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    throw new StateRootActivationError(
      'activation_manifest_invalid',
      `state root activation manifest is unreadable: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  const parsed = stateRootActivationManifestSchema.safeParse(raw);
  if (!parsed.success) {
    throw new StateRootActivationError(
      'activation_manifest_invalid',
      `state root activation manifest failed validation: ${parsed.error.issues.map((issue) => issue.message).join('; ')}`,
    );
  }

  const knownStores = new Set(Object.keys(STATE_STORES));
  const duplicateStores = parsed.data.stores.filter(
    (store, index, stores) => stores.indexOf(store) !== index,
  );
  const unknownStores = parsed.data.stores.filter((store) => !knownStores.has(store));
  if (duplicateStores.length > 0 || unknownStores.length > 0) {
    throw new StateRootActivationError(
      'activation_manifest_invalid',
      `activation manifest has duplicate or unknown stores: ${[
        ...new Set([...duplicateStores, ...unknownStores]),
      ].join(', ')}`,
    );
  }

  const missingStores = [...knownStores].filter((store) => !parsed.data.stores.includes(store));
  if (missingStores.length > 0) {
    throw new StateRootActivationError(
      'store_not_activated',
      `activation manifest omits registered stores: ${missingStores.join(', ')}`,
    );
  }

  // The manifest's own nodeRole/sourceReceipts fields are self-asserted and
  // are not provenance proof. Bind against an externally supplied node role
  // and verify every claimed receipt against real artifact bytes before any
  // store resolves.
  const nodeRole = readNodeRoleEnv();
  if (!nodeRole) {
    throw new StateRootActivationError(
      'node_role_unbound',
      'ATLAS_NODE_ROLE must be set to local or railway before activation is trusted',
    );
  }
  if (nodeRole !== parsed.data.nodeRole) {
    throw new StateRootActivationError(
      'node_role_mismatch',
      `ATLAS_NODE_ROLE '${nodeRole}' does not match activation manifest nodeRole '${parsed.data.nodeRole}'`,
    );
  }

  const requiredReceiptKinds = REQUIRED_RECEIPT_KINDS[parsed.data.nodeRole];
  const presentReceiptKinds = new Set(parsed.data.sourceReceipts.map((receipt) => receipt.kind));
  const missingRequiredKinds = requiredReceiptKinds.filter(
    (kind) => !presentReceiptKinds.has(kind),
  );
  if (missingRequiredKinds.length > 0) {
    throw new StateRootActivationError(
      'source_receipt_missing',
      `activation manifest omits required source receipt kind(s): ${missingRequiredKinds.join(', ')}`,
    );
  }

  const receiptsDir = join(root, 'activation-receipts');
  for (const receipt of parsed.data.sourceReceipts) {
    const artifactPath = join(receiptsDir, receipt.kind);
    if (!existsSync(artifactPath)) {
      throw new StateRootActivationError(
        'source_receipt_missing',
        `source receipt artifact is missing for kind '${receipt.kind}': ${artifactPath}`,
      );
    }
    const actualHash = createHash('sha256').update(readFileSync(artifactPath)).digest('hex');
    if (actualHash.toLowerCase() !== receipt.sha256.toLowerCase()) {
      throw new StateRootActivationError(
        'source_receipt_mismatch',
        `source receipt artifact hash mismatch for kind '${receipt.kind}': ${artifactPath}`,
      );
    }
  }

  return {
    ...parsed.data,
    stores: parsed.data.stores as StateStore[],
  };
}

/**
 * Resolve the directory for a specific state store.
 *
 * Precedence: (1) the legacy per-store env var named by `legacyEnv`, if set
 * and non-empty; (2) `resolveStateRoot()/<store>`. Does not create the
 * directory — callers that need it to exist create it themselves.
 */
export function resolveStateDir(store: StateStore, legacyEnv?: string): string {
  const required = stateRootRequired();
  const envName = legacyEnv ?? STATE_STORES[store];
  if (!required && envName) {
    const legacy = readAbsoluteOverride(envName);
    if (legacy) return legacy;
  }

  const root = resolveStateRoot();
  const activation = required ? assertStateRootActivated(root) : undefined;
  if (activation && !activation.stores.includes(store)) {
    throw new StateRootActivationError(
      'store_not_activated',
      `store '${store}' is absent from the activation manifest`,
    );
  }

  if (envName) {
    const legacy = readAbsoluteOverride(envName);
    if (legacy) {
      if (activation) {
        assertPathContained(
          root,
          legacy,
          envName,
          'activated ATLAS_STATE_ROOT',
        );
      }
      return legacy;
    }
  }

  const storeDir = join(root, store);
  if (activation) {
    assertPathContained(
      root,
      storeDir,
      `store '${store}'`,
      'activated ATLAS_STATE_ROOT',
    );
  }
  return storeDir;
}

/**
 * Bridge one legacy call site without moving its live default during code
 * rollout. Before required activation, retain the legacy env/default. A
 * staged ATLAS_STATE_ROOT alone is deliberately ignored. Once required
 * activation is enabled, use the store's canonical shared resolver and its
 * manifest/containment checks. An alternate `legacyEnv` argument is a
 * pre-activation compatibility alias only; `null` disables registry-env
 * lookup for a caller-supplied legacy default.
 */
export function resolveMigratingStateDir(
  store: StateStore,
  legacyDefault: () => string,
  legacyEnv?: string | null,
): string {
  const required = stateRootRequired();
  if (required) return resolveStateDir(store);

  const envName = legacyEnv === null
    ? undefined
    : legacyEnv ?? STATE_STORES[store];
  if (envName) {
    const legacy = readAbsoluteOverride(envName);
    if (legacy) return legacy;
  }

  return normalizeStableAbsolute(
    legacyDefault(),
    `legacy default for ${store}`,
  );
}

/**
 * Bridge a legacy file-shaped store. Before activation, preserve its absolute
 * file override/default. After required activation, derive one fixed basename
 * below the registered store directory and ignore the legacy file override.
 */
export function resolveMigratingStateFile(
  store: StateStore,
  fileName: string,
  legacyDefault: () => string,
  legacyEnv?: string | null,
): string {
  if (
    !fileName ||
    fileName.trim() !== fileName ||
    fileName === '.' ||
    fileName === '..' ||
    /[\\/]/.test(fileName)
  ) {
    throw new StateRootConfigurationError(
      `file name for ${store}`,
      `file name for '${store}' must be one fixed basename`,
    );
  }

  if (stateRootRequired()) {
    const storeDir = resolveStateDir(store);
    const filePath = join(storeDir, fileName);
    assertPathContained(
      storeDir,
      filePath,
      `file '${fileName}' for '${store}'`,
      `activated store '${store}'`,
    );
    return filePath;
  }

  return resolveMigratingStateDir(
    store,
    legacyDefault,
    legacyEnv,
  );
}

/**
 * Preserve a caller-supplied file path before cutover, but make it a strict
 * child of its registered store after required activation. This closes
 * file-level test/legacy escape hatches without changing pre-activation
 * behavior.
 */
export function constrainMigratingStatePath(
  store: StateStore,
  candidate: string,
): string {
  if (!stateRootRequired()) return candidate;

  let absoluteCandidate: string;
  try {
    absoluteCandidate = normalizeStableAbsolute(
      candidate,
      `path override for ${store}`,
    );
  } catch (error) {
    throw new StateRootActivationError(
      'store_outside_root',
      `path override for '${store}' must be absolute under its activated store: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }

  const storeDir = resolveStateDir(store);
  assertPathContained(
    storeDir,
    absoluteCandidate,
    `path override for '${store}'`,
    `activated store '${store}'`,
  );

  return absoluteCandidate;
}
