/**
 * M3D Task 5 — retain current authoritative stores into one outside-repo
 * artifact, then rehearse only against that retained copy.
 *
 * Never activates live state. Never points resolvers at the artifact.
 * Checkout-relative stores are read from an explicit primary checkout root,
 * not from process.cwd() of a linked worktree.
 */

import { createHash, randomUUID } from 'node:crypto';
import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import {
  basename,
  dirname,
  isAbsolute,
  join,
  resolve,
  sep,
} from 'node:path';
import { z } from 'zod';

import {
  AUTHORITATIVE_FULL_ROOT_STORES,
  coldReplayFullRoot,
  compareFullRoots,
  copyStateRootAtomic,
  FullRootRehearsalError,
  inspectFullRoot,
  verifyFullRootRehearsal,
  type FullRootRehearsalReceipt,
  type VerifiedFullRootRehearsal,
} from './full-root-rehearsal.js';
import type { StateStore } from './state-root.js';

const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);
const absolutePathSchema = z
  .string()
  .min(1)
  .refine(isAbsolute, 'path must be absolute');
const ARTIFACT_NAME_RE = /^atlas-full-root-m3d-\d{8}T\d{6}Z-[a-f0-9]{8}$/;
const RETAINED_ROOT_BASENAME = 'retained-root';
const PREFLIGHT_BASENAME = 'preflight.json';
const ASSEMBLE_MANIFEST_BASENAME = 'assemble-manifest.json';

/** Five unrelated dirty paths that must never be staged by agents. */
export const PROTECTED_DIRTY_PATHS = [
  'docs/atlas-cto/FABLE-PROTOCOL.md',
  'state/exec-graph/graph.json',
  'state/exec-graph/ledger.jsonl',
  'docs/atlas-cto/VOLAURA-LEARNING-ENGINE-HANDOFF-2026-07-25.md',
  'state/evidence/',
] as const;

export type LiveStoreStatus = 'present' | 'empty' | 'missing';

export type LiveStoreSourceKind =
  | 'directory'
  | 'file-into-directory'
  | 'empty-policy';

export interface LiveStoreSourcePlan {
  readonly store: StateStore;
  readonly kind: LiveStoreSourceKind;
  /** Absolute live path (directory or file). Null when no live binding exists. */
  readonly livePath: string | null;
  readonly status: LiveStoreStatus;
}

export interface FullRootRetainPreflight {
  readonly schemaVersion: 1;
  readonly kind: 'atlas.m3d-full-root-retain-preflight';
  readonly recordedAt: string;
  readonly primaryCheckoutRoot: string;
  readonly preservationParentDirectory: string;
  readonly artifactName: string;
  readonly artifactDirectory: string;
  readonly artifactAbsent: true;
  readonly stateRootRequiredUnset: true;
  readonly protectedPaths: ReadonlyArray<{
    readonly path: string;
    readonly status: 'clean' | 'dirty' | 'missing';
  }>;
  readonly stores: readonly LiveStoreSourcePlan[];
  readonly accepted: true;
}

export interface AssembleManifest {
  readonly schemaVersion: 1;
  readonly kind: 'atlas.m3d-full-root-assemble';
  readonly assembledAt: string;
  readonly primaryCheckoutRoot: string;
  readonly retainedRoot: string;
  readonly stores: ReadonlyArray<{
    readonly store: StateStore;
    readonly livePath: string | null;
    readonly status: LiveStoreStatus;
    readonly policy: 'copied' | 'empty-policy';
    readonly treeSha256: string;
  }>;
  readonly retainedTreeSha256: string;
}

export const fullRootRetainPreflightSchema = z
  .object({
    schemaVersion: z.literal(1),
    kind: z.literal('atlas.m3d-full-root-retain-preflight'),
    recordedAt: z.string().datetime(),
    primaryCheckoutRoot: absolutePathSchema,
    preservationParentDirectory: absolutePathSchema,
    artifactName: z.string().regex(ARTIFACT_NAME_RE),
    artifactDirectory: absolutePathSchema,
    artifactAbsent: z.literal(true),
    stateRootRequiredUnset: z.literal(true),
    protectedPaths: z
      .array(
        z
          .object({
            path: z.string().min(1),
            status: z.enum(['clean', 'dirty', 'missing']),
          })
          .strict(),
      )
      .length(5),
    stores: z
      .array(
        z
          .object({
            store: z.string().min(1),
            kind: z.enum(['directory', 'file-into-directory', 'empty-policy']),
            livePath: z.string().nullable(),
            status: z.enum(['present', 'empty', 'missing']),
          })
          .strict(),
      )
      .min(1),
    accepted: z.literal(true),
  })
  .strict();

function sha256(value: Buffer | string): string {
  return createHash('sha256').update(value).digest('hex');
}

function requireAbsolute(path: string, label: string): string {
  if (typeof path !== 'string' || !path.trim() || !isAbsolute(path)) {
    throw new FullRootRehearsalError(
      'path_invalid',
      `${label} must be an absolute path`,
    );
  }
  return resolve(path);
}

function pathEntryExists(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch {
    return false;
  }
}

function isNonEmptyDirectory(path: string): boolean {
  if (!pathEntryExists(path)) return false;
  const stat = lstatSync(path);
  if (!stat.isDirectory() || stat.isSymbolicLink()) return false;
  const stack = [path];
  while (stack.length > 0) {
    const dir = stack.pop()!;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const abs = join(dir, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isFile()) return true;
      if (entry.isDirectory()) stack.push(abs);
    }
  }
  return false;
}

function classifyDirectory(path: string | null): LiveStoreStatus {
  if (!path || !pathEntryExists(path)) return 'missing';
  const stat = lstatSync(path);
  if (!stat.isDirectory()) return 'missing';
  return isNonEmptyDirectory(path) ? 'present' : 'empty';
}

function classifyFile(path: string | null): LiveStoreStatus {
  if (!path || !pathEntryExists(path)) return 'missing';
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.size <= 0) return 'empty';
  return 'present';
}

function homeAtlas(...parts: string[]): string {
  return join(homedir(), '.atlas', ...parts);
}

/**
 * Resolve the live legacy path plan for every authoritative store against an
 * explicit primary checkout root (not process.cwd()).
 */
export function planLiveAuthoritativeStores(
  primaryCheckoutRoot: string,
): LiveStoreSourcePlan[] {
  const checkout = requireAbsolute(primaryCheckoutRoot, 'primaryCheckoutRoot');
  const plans: LiveStoreSourcePlan[] = [];

  const directoryStores: Array<[StateStore, string]> = [
    ['exec-graph', join(checkout, 'state', 'exec-graph')],
    ['evidence', join(checkout, 'state', 'evidence')],
    ['goal-budgets', join(checkout, 'state', 'goal-budgets')],
    ['swarm-runs', join(checkout, 'state', 'swarm-runs')],
    ['intake-drafts', join(checkout, 'state', 'intake-drafts')],
    ['operator-runs', join(checkout, 'operator', 'runs')],
    ['operator-state', join(checkout, 'operator', 'state')],
    ['task-results', resolve('C:/Projects/ATLAS/data/task-results')],
    ['learning', join(checkout, 'state', 'learning')],
    ['cost-router', homeAtlas('state', 'cost-router')],
    ['effect-journal', homeAtlas('state', 'effect-journal')],
  ];

  for (const [store, livePath] of directoryStores) {
    const status = classifyDirectory(livePath);
    plans.push({
      store,
      kind: status === 'present' ? 'directory' : 'empty-policy',
      livePath,
      status,
    });
  }

  const fileStores: Array<[StateStore, string, string]> = [
    // store, live file path, destination basename inside retained store dir
    ['spend-receipts', homeAtlas('spend-receipts.jsonl'), 'spend-receipts.jsonl'],
    ['instance-lease', homeAtlas('instance-lease.json'), 'instance-lease.json'],
    ['queue-auth', homeAtlas('nonce-ledger.json'), 'nonce-ledger.json'],
    ['notify-queue', homeAtlas('notify-queue.json'), 'notify-queue.json'],
  ];
  for (const [store, livePath] of fileStores) {
    const status = classifyFile(livePath);
    plans.push({
      store,
      kind: status === 'present' ? 'file-into-directory' : 'empty-policy',
      livePath,
      status,
    });
  }

  // External / unbound stores — honest empty-policy when absent.
  plans.push({
    store: 'opsboard-exchange',
    kind: 'empty-policy',
    livePath: process.env.ATLAS_OPSBOARD_EXCHANGE_DIR?.trim()
      ? resolve(process.env.ATLAS_OPSBOARD_EXCHANGE_DIR)
      : null,
    status: process.env.ATLAS_OPSBOARD_EXCHANGE_DIR?.trim()
      ? classifyDirectory(resolve(process.env.ATLAS_OPSBOARD_EXCHANGE_DIR))
      : 'missing',
  });
  plans.push({
    store: 'pause-control',
    kind: 'empty-policy',
    livePath: homeAtlas('PAUSE'),
    status: classifyFile(homeAtlas('PAUSE')) === 'present' ? 'present' : 'missing',
  });

  // If pause file is present, copy it as a file-into-directory instead.
  const pause = plans.find((p) => p.store === 'pause-control');
  if (pause && pause.status === 'present') {
    const idx = plans.indexOf(pause);
    plans[idx] = {
      store: 'pause-control',
      kind: 'file-into-directory',
      livePath: homeAtlas('PAUSE'),
      status: 'present',
    };
  }

  // If opsboard env points at a present directory, copy it.
  const ops = plans.find((p) => p.store === 'opsboard-exchange');
  if (ops && ops.status === 'present' && ops.livePath) {
    const idx = plans.indexOf(ops);
    plans[idx] = {
      store: 'opsboard-exchange',
      kind: 'directory',
      livePath: ops.livePath,
      status: 'present',
    };
  }

  const byStore = new Map(plans.map((p) => [p.store, p]));
  return AUTHORITATIVE_FULL_ROOT_STORES.map((store) => {
    const plan = byStore.get(store);
    if (!plan) {
      throw new FullRootRehearsalError(
        'store_missing',
        `no live source plan for authoritative store ${store}`,
      );
    }
    return plan;
  });
}

function protectedPathStatus(
  checkoutRoot: string,
  relPath: string,
  dirtySet: ReadonlySet<string>,
): 'clean' | 'dirty' | 'missing' {
  const abs = join(checkoutRoot, relPath.replace(/\/$/, ''));
  const normalized = relPath.replace(/\\/g, '/');
  if (
    [...dirtySet].some(
      (d) =>
        d.replace(/\\/g, '/') === normalized ||
        d.replace(/\\/g, '/').startsWith(normalized) ||
        normalized.startsWith(d.replace(/\\/g, '/')),
    )
  ) {
    return 'dirty';
  }
  if (normalized.endsWith('/')) {
    return pathEntryExists(abs) ? 'clean' : 'missing';
  }
  return pathEntryExists(abs) ? 'clean' : 'missing';
}

export interface PreflightFullRootRetainOptions {
  readonly primaryCheckoutRoot: string;
  readonly preservationParentDirectory: string;
  readonly artifactName: string;
  /** Relative dirty paths from `git status --porcelain` of the primary checkout. */
  readonly porcelainPaths?: readonly string[];
}

export function preflightFullRootRetain(
  options: PreflightFullRootRetainOptions,
): FullRootRetainPreflight {
  const primaryCheckoutRoot = requireAbsolute(
    options.primaryCheckoutRoot,
    'primaryCheckoutRoot',
  );
  const preservationParentDirectory = requireAbsolute(
    options.preservationParentDirectory,
    'preservationParentDirectory',
  );
  if (!ARTIFACT_NAME_RE.test(options.artifactName)) {
    throw new FullRootRehearsalError(
      'path_invalid',
      `artifactName must match ${ARTIFACT_NAME_RE}`,
    );
  }
  const artifactDirectory = join(
    preservationParentDirectory,
    options.artifactName,
  );
  if (pathEntryExists(artifactDirectory)) {
    throw new FullRootRehearsalError(
      'artifact_exists',
      `artifact already exists: ${artifactDirectory}`,
    );
  }

  const required = (process.env.ATLAS_STATE_ROOT_REQUIRED ?? '').trim().toLowerCase();
  if (required === '1' || required === 'true' || required === 'yes') {
    throw new FullRootRehearsalError(
      'path_invalid',
      'ATLAS_STATE_ROOT_REQUIRED is set; refuse retain rehearsal while activation is gated',
    );
  }

  const dirtySet = new Set(
    (options.porcelainPaths ?? []).map((p) => p.replace(/\\/g, '/')),
  );
  const protectedPaths = PROTECTED_DIRTY_PATHS.map((path) => ({
    path,
    status: protectedPathStatus(primaryCheckoutRoot, path, dirtySet),
  }));

  const stores = planLiveAuthoritativeStores(primaryCheckoutRoot);
  const preflight: FullRootRetainPreflight = {
    schemaVersion: 1,
    kind: 'atlas.m3d-full-root-retain-preflight',
    recordedAt: new Date().toISOString(),
    primaryCheckoutRoot,
    preservationParentDirectory,
    artifactName: options.artifactName,
    artifactDirectory,
    artifactAbsent: true,
    stateRootRequiredUnset: true,
    protectedPaths,
    stores,
    accepted: true,
  };
  return fullRootRetainPreflightSchema.parse(preflight) as FullRootRetainPreflight;
}

function copyDirectoryRecursive(source: string, destination: string): void {
  mkdirSync(destination, { recursive: true });
  for (const entry of readdirSync(source, { withFileTypes: true })) {
    const from = join(source, entry.name);
    const to = join(destination, entry.name);
    const stat = lstatSync(from);
    if (stat.isSymbolicLink()) {
      throw new FullRootRehearsalError(
        'copy_failed',
        `refusing to copy symlink: ${from}`,
      );
    }
    if (stat.isDirectory()) copyDirectoryRecursive(from, to);
    else if (stat.isFile()) copyFileSync(from, to);
  }
}

function writeEmptyPolicyMarker(
  storeDir: string,
  store: StateStore,
  plan: LiveStoreSourcePlan,
): void {
  mkdirSync(storeDir, { recursive: true });
  writeFileSync(
    join(storeDir, `${store}.empty-policy.json`),
    `${JSON.stringify(
      {
        schemaVersion: 1,
        kind: 'atlas.m3d-empty-store-policy',
        store,
        liveStatus: plan.status,
        livePath: plan.livePath,
        recordedAt: new Date().toISOString(),
      },
      null,
      2,
    )}\n`,
    'utf8',
  );
}

function hashStoreTree(storeDir: string): string {
  const files: string[] = [];
  const walk = (dir: string, prefix: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      const abs = join(dir, entry.name);
      if (entry.isDirectory()) walk(abs, rel);
      else if (entry.isFile()) files.push(rel.replaceAll('\\', '/'));
    }
  };
  walk(storeDir, '');
  files.sort();
  const hash = createHash('sha256');
  for (const rel of files) {
    hash.update(rel);
    hash.update('\0');
    hash.update(readFileSync(join(storeDir, rel)));
    hash.update('\0');
  }
  return hash.digest('hex');
}

/**
 * Assemble a disposable full root from live legacy paths + empty-policy
 * markers into `destinationRoot`. Destination must not already exist.
 */
export function assembleLiveFullRoot(
  primaryCheckoutRoot: string,
  destinationRoot: string,
  plans?: readonly LiveStoreSourcePlan[],
): AssembleManifest {
  const checkout = requireAbsolute(primaryCheckoutRoot, 'primaryCheckoutRoot');
  const destination = requireAbsolute(destinationRoot, 'destinationRoot');
  if (pathEntryExists(destination)) {
    throw new FullRootRehearsalError(
      'artifact_exists',
      `assemble destination already exists: ${destination}`,
    );
  }
  // Refuse to write into the live checkout or the live ~/.atlas tree.
  const liveHomeAtlas = resolve(homedir(), '.atlas');
  if (
    destination === checkout ||
    destination.startsWith(`${checkout}${sep}`) ||
    destination === liveHomeAtlas ||
    destination.startsWith(`${liveHomeAtlas}${sep}`)
  ) {
    throw new FullRootRehearsalError(
      'path_invalid',
      'assemble destination must not be under the primary checkout or ~/.atlas',
    );
  }

  const sourcePlans = plans ?? planLiveAuthoritativeStores(checkout);
  mkdirSync(destination, { recursive: true });

  const storeRows: Array<AssembleManifest['stores'][number]> = [];
  for (const plan of sourcePlans) {
    const storeDir = join(destination, plan.store);
    if (plan.kind === 'directory' && plan.status === 'present' && plan.livePath) {
      copyDirectoryRecursive(plan.livePath, storeDir);
      storeRows.push({
        store: plan.store,
        livePath: plan.livePath,
        status: plan.status,
        policy: 'copied',
        treeSha256: hashStoreTree(storeDir),
      });
      continue;
    }
    if (
      plan.kind === 'file-into-directory' &&
      plan.status === 'present' &&
      plan.livePath
    ) {
      mkdirSync(storeDir, { recursive: true });
      copyFileSync(plan.livePath, join(storeDir, basename(plan.livePath)));
      storeRows.push({
        store: plan.store,
        livePath: plan.livePath,
        status: plan.status,
        policy: 'copied',
        treeSha256: hashStoreTree(storeDir),
      });
      continue;
    }
    writeEmptyPolicyMarker(storeDir, plan.store, plan);
    storeRows.push({
      store: plan.store,
      livePath: plan.livePath,
      status: plan.status,
      policy: 'empty-policy',
      treeSha256: hashStoreTree(storeDir),
    });
  }

  const inspection = inspectFullRoot(destination);
  return {
    schemaVersion: 1,
    kind: 'atlas.m3d-full-root-assemble',
    assembledAt: new Date().toISOString(),
    primaryCheckoutRoot: checkout,
    retainedRoot: destination,
    stores: storeRows,
    retainedTreeSha256: inspection.treeSha256,
  };
}

export interface RetainAndRehearseFullRootOptions {
  readonly primaryCheckoutRoot: string;
  readonly preservationParentDirectory: string;
  readonly artifactName: string;
  readonly porcelainPaths?: readonly string[];
  readonly childTimeoutMs?: number;
  /** Absolute disposable staging parent; defaults under preservation parent. */
  readonly stagingParentDirectory?: string;
  /**
   * Which live sources must stay byte-stable across the run.
   * - `all` (default): every present copied live path (production Task 5)
   * - `checkout`: only paths under primaryCheckoutRoot (unit-test isolation)
   */
  readonly liveInvariance?: 'all' | 'checkout';
}

export interface RetainAndRehearseFullRootResult {
  readonly preflight: FullRootRetainPreflight;
  readonly assemble: AssembleManifest;
  readonly receipt: FullRootRehearsalReceipt;
  readonly verified: VerifiedFullRootRehearsal;
  readonly liveSourcesUnchanged: true;
}

function snapshotLiveSources(
  plans: readonly LiveStoreSourcePlan[],
  scope: 'all' | 'checkout',
  checkoutRoot: string,
): Map<string, string> {
  const checkout = resolve(checkoutRoot);
  const out = new Map<string, string>();
  for (const plan of plans) {
    if (!plan.livePath || plan.status !== 'present') continue;
    const live = resolve(plan.livePath);
    if (
      scope === 'checkout' &&
      live !== checkout &&
      !live.startsWith(`${checkout}${sep}`)
    ) {
      continue;
    }
    if (plan.kind === 'directory') {
      const files: string[] = [];
      const walk = (dir: string, prefix: string): void => {
        for (const entry of readdirSync(dir, { withFileTypes: true })) {
          const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
          const abs = join(dir, entry.name);
          if (entry.isDirectory()) walk(abs, rel);
          else if (entry.isFile()) files.push(rel.replaceAll('\\', '/'));
        }
      };
      walk(plan.livePath, '');
      files.sort();
      const hash = createHash('sha256');
      for (const rel of files) {
        hash.update(rel);
        hash.update('\0');
        hash.update(readFileSync(join(plan.livePath, rel)));
        hash.update('\0');
      }
      out.set(plan.store, hash.digest('hex'));
    } else if (plan.kind === 'file-into-directory') {
      out.set(plan.store, sha256(readFileSync(plan.livePath)));
    }
  }
  return out;
}

/**
 * One-shot Task 5: preflight → assemble → retain → rehearse → verify →
 * prove live sources unchanged. Staging is removed; retained artifact kept.
 */
export function retainAndRehearseFullRoot(
  options: RetainAndRehearseFullRootOptions,
): RetainAndRehearseFullRootResult {
  const preflight = preflightFullRootRetain(options);
  const invariance = options.liveInvariance ?? 'all';
  const beforeLive = snapshotLiveSources(
    preflight.stores,
    invariance,
    preflight.primaryCheckoutRoot,
  );

  const stagingParent = requireAbsolute(
    options.stagingParentDirectory ??
      join(preflight.preservationParentDirectory, '.m3d-full-root-staging'),
    'stagingParentDirectory',
  );
  mkdirSync(stagingParent, { recursive: true });
  const stagingRoot = join(stagingParent, `staging-${randomUUID()}`);

  let assemble: AssembleManifest | undefined;
  try {
    assemble = assembleLiveFullRoot(
      preflight.primaryCheckoutRoot,
      stagingRoot,
      preflight.stores,
    );

    // Retain under the artifact as retained-root, then rehearse that copy.
    mkdirSync(preflight.artifactDirectory, { recursive: false });
    const retainedRoot = copyStateRootAtomic(
      stagingRoot,
      preflight.artifactDirectory,
      RETAINED_ROOT_BASENAME,
    );
    writeFileSync(
      join(preflight.artifactDirectory, PREFLIGHT_BASENAME),
      `${JSON.stringify(preflight, null, 2)}\n`,
      'utf8',
    );
    writeFileSync(
      join(preflight.artifactDirectory, ASSEMBLE_MANIFEST_BASENAME),
      `${JSON.stringify({ ...assemble, retainedRoot }, null, 2)}\n`,
      'utf8',
    );

    // Rehearse against retained-root. Receipt must land inside the same
    // artifact directory — use a dedicated helper path via fixture API by
    // pointing artifact parent at the artifact itself with a fixed receipt
    // name through a thin internal call: copy candidate beside artifact.
    const receipt = rehearseAgainstRetainedRoot({
      retainedRoot,
      artifactDirectory: preflight.artifactDirectory,
      childTimeoutMs: options.childTimeoutMs,
    });

    const verified = verifyFullRootRehearsal(preflight.artifactDirectory);
    const afterLive = snapshotLiveSources(
      preflight.stores,
      invariance,
      preflight.primaryCheckoutRoot,
    );
    for (const [store, beforeHash] of beforeLive) {
      if (afterLive.get(store) !== beforeHash) {
        throw new FullRootRehearsalError(
          'source_mutated',
          `live source for ${store} changed during retain/rehearsal`,
        );
      }
    }

    return {
      preflight,
      assemble: { ...assemble, retainedRoot },
      receipt,
      verified,
      liveSourcesUnchanged: true,
    };
  } finally {
    try {
      if (pathEntryExists(stagingRoot)) {
        rmSync(stagingRoot, { recursive: true, force: true });
      }
    } catch {
      /* best effort */
    }
  }
}

/**
 * Rehearse an already-retained root that lives inside `artifactDirectory`.
 * Writes `rehearsal-receipt.json` into that artifact after rollback.
 */
export function rehearseAgainstRetainedRoot(options: {
  readonly retainedRoot: string;
  readonly artifactDirectory: string;
  readonly childTimeoutMs?: number;
}): FullRootRehearsalReceipt {
  const retainedRoot = requireAbsolute(options.retainedRoot, 'retainedRoot');
  const artifactDirectory = requireAbsolute(
    options.artifactDirectory,
    'artifactDirectory',
  );
  const receiptPath = join(artifactDirectory, 'rehearsal-receipt.json');
  if (pathEntryExists(receiptPath)) {
    throw new FullRootRehearsalError(
      'receipt_exists',
      `rehearsal receipt already exists: ${receiptPath}`,
    );
  }
  if (!retainedRoot.startsWith(`${artifactDirectory}${sep}`)) {
    throw new FullRootRehearsalError(
      'path_invalid',
      'retainedRoot must be inside artifactDirectory',
    );
  }

  // Reuse fixture rehearsal by creating a temporary sibling artifact name
  // under the artifact's parent is wrong (new dir). Instead inline the same
  // steps with receipt path fixed inside the existing artifact.
  const artifactParent = dirname(artifactDirectory);
  const sourceBefore = inspectFullRoot(retainedRoot);
  const candidateName = `.m3d-full-root-work-${randomUUID()}`;
  const candidateRoot = join(artifactParent, candidateName);
  const candidateStatBefore = pathEntryExists(candidateRoot);

  try {
    if (candidateStatBefore) {
      throw new FullRootRehearsalError(
        'copy_failed',
        `candidate path already exists: ${candidateRoot}`,
      );
    }
    copyStateRootAtomic(retainedRoot, artifactParent, candidateName);
    const child = coldReplayFullRoot(candidateRoot, {
      timeoutMs: options.childTimeoutMs,
    });
    const comparison = compareFullRoots(retainedRoot, candidateRoot);
    if (!comparison.accepted || child.treeSha256 !== sourceBefore.treeSha256) {
      throw new FullRootRehearsalError(
        'compare_failed',
        'retained/candidate/child full-root inspection did not agree',
      );
    }
    const sourceAfter = inspectFullRoot(retainedRoot);
    if (sourceAfter.treeSha256 !== sourceBefore.treeSha256) {
      throw new FullRootRehearsalError(
        'source_mutated',
        'retained root changed during rehearsal',
      );
    }
    rmSync(candidateRoot, { recursive: true, force: false });
    if (pathEntryExists(candidateRoot)) {
      throw new FullRootRehearsalError(
        'rollback_failed',
        'candidate root still present after rollback',
      );
    }

    const receipt: FullRootRehearsalReceipt = {
      schemaVersion: 1,
      kind: 'atlas.m3d-full-root-rehearsal',
      completedAt: new Date().toISOString(),
      sourceRoot: retainedRoot,
      artifactDirectory,
      candidateRoot,
      candidateAbsent: true,
      sourceUnchanged: true,
      coldReplayAccepted: true,
      rollbackVerified: true,
      networkDenied: true,
      storeCount: sourceBefore.stores.length,
      sourceTreeSha256: sourceBefore.treeSha256,
      candidateTreeSha256: child.treeSha256,
      stores: [...sourceBefore.stores],
    };
    const temporaryPath = `${receiptPath}.${process.pid}.${randomUUID()}.tmp`;
    writeFileSync(
      temporaryPath,
      `${JSON.stringify(receipt, null, 2)}\n`,
      'utf8',
    );
    renameSync(temporaryPath, receiptPath);
    return receipt;
  } catch (error) {
    try {
      if (pathEntryExists(candidateRoot)) {
        rmSync(candidateRoot, { recursive: true, force: true });
      }
    } catch {
      /* best effort */
    }
    throw error;
  }
}
