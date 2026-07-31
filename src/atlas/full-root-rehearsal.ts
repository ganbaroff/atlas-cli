/**
 * M3D Task 4 — full-root migration rehearsal against an isolated fixture root.
 *
 * Scope: every authoritative store under one explicit root. Never activates
 * live state, never reads ATLAS_STATE_ROOT / per-store env for proof paths,
 * never accepts cast work/receipt/candidate destinations.
 *
 * Flow: inspect source → staging tree copy + durable rename → network-denied
 * cold child inspect → parent compare → source invariance → rollback candidate
 * → receipt only after observed cleanup.
 */

import { spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
  type Stats,
} from 'node:fs';
import { dirname, basename, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { z } from 'zod';

import { STATE_STORES, type StateStore } from './state-root.js';
import {
  EXTERNAL_STATE_WRITERS,
  STATE_WRITER_INVENTORY,
} from './state-writer-inventory.js';
import {
  compareExecGraphDirectories,
  inspectExecGraphDirectory,
  type ExecGraphInspection,
} from './shadow-state.js';
import { foldEvents } from '../exec-graph/ledger.js';
import { ledgerEventSchema, type LedgerEvent } from '../exec-graph/contracts.js';

const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);
const absolutePathSchema = z
  .string()
  .min(1)
  .refine(isAbsolute, 'path must be absolute');
const ARTIFACT_NAME_RE = /^atlas-full-root-m3d-\d{8}T\d{6}Z-[a-f0-9]{8}$/;
const RECEIPT_BASENAME = 'rehearsal-receipt.json';
const DEFAULT_CHILD_TIMEOUT_MS = 20_000;
const MAX_CHILD_TIMEOUT_MS = 45_000;

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const tsxCliPath = join(repoRoot, 'node_modules', 'tsx', 'dist', 'cli.mjs');
const childScriptPath = join(
  dirname(fileURLToPath(import.meta.url)),
  'full-root-rehearsal-child.ts',
);
const forbidNetworkPath = join(
  repoRoot,
  'src',
  '__tests__',
  'fixtures',
  'forbid-network.mjs',
);

function collectAuthoritativeStores(): readonly StateStore[] {
  const stores = new Set<StateStore>();
  for (const surfaces of Object.values(STATE_WRITER_INVENTORY)) {
    for (const surface of surfaces) {
      if (surface.classification !== 'authoritative') continue;
      for (const store of surface.stores ?? []) stores.add(store);
    }
  }
  for (const [store, writer] of Object.entries(EXTERNAL_STATE_WRITERS) as Array<
    [StateStore, NonNullable<(typeof EXTERNAL_STATE_WRITERS)[StateStore]>]
  >) {
    if (writer.classification === 'authoritative') stores.add(store);
  }
  return Object.freeze([...stores].sort() as StateStore[]);
}

/** Authoritative stores a full-root fixture must seed and prove. */
export const AUTHORITATIVE_FULL_ROOT_STORES = collectAuthoritativeStores();

export type FullRootRehearsalErrorCode =
  | 'path_invalid'
  | 'store_missing'
  | 'store_empty'
  | 'store_unknown'
  | 'store_unreadable'
  | 'copy_failed'
  | 'copy_interrupted'
  | 'compare_failed'
  | 'source_mutated'
  | 'replay_failed'
  | 'replay_timeout'
  | 'receipt_exists'
  | 'receipt_invalid'
  | 'receipt_tampered'
  | 'rollback_failed'
  | 'cleanup_unsafe'
  | 'timeout_invalid'
  | 'artifact_exists';

export class FullRootRehearsalError extends Error {
  constructor(
    readonly code: FullRootRehearsalErrorCode,
    message: string,
  ) {
    super(`${code}: ${message}`);
    this.name = 'FullRootRehearsalError';
  }
}

const storeInspectionSchema = z
  .object({
    store: z.string().min(1),
    directory: absolutePathSchema,
    treeSha256: sha256Schema,
    fileCount: z.number().int().positive(),
    execGraph: z
      .object({
        ledgerSha256: sha256Schema,
        snapshotSha256: sha256Schema,
        semanticSha256: sha256Schema,
        eventCount: z.number().int().nonnegative(),
        goalCount: z.number().int().nonnegative(),
        taskCount: z.number().int().nonnegative(),
      })
      .strict()
      .optional(),
  })
  .strict();

export type StoreInspection = z.infer<typeof storeInspectionSchema>;

export interface FullRootInspection {
  readonly root: string;
  readonly treeSha256: string;
  readonly stores: readonly StoreInspection[];
  readonly accepted: true;
}

export interface FullRootComparison {
  readonly treeBytesEqual: boolean;
  readonly execGraphAccepted: boolean;
  readonly storeSetEqual: boolean;
  readonly accepted: boolean;
}

export const fullRootRehearsalReceiptSchema = z
  .object({
    schemaVersion: z.literal(1),
    kind: z.literal('atlas.m3d-full-root-rehearsal'),
    completedAt: z.string().datetime(),
    sourceRoot: absolutePathSchema,
    artifactDirectory: absolutePathSchema,
    candidateRoot: absolutePathSchema,
    candidateAbsent: z.literal(true),
    sourceUnchanged: z.literal(true),
    coldReplayAccepted: z.literal(true),
    rollbackVerified: z.literal(true),
    networkDenied: z.literal(true),
    storeCount: z.number().int().positive(),
    sourceTreeSha256: sha256Schema,
    candidateTreeSha256: sha256Schema,
    stores: z.array(storeInspectionSchema).min(1),
  })
  .strict();

export type FullRootRehearsalReceipt = z.infer<
  typeof fullRootRehearsalReceiptSchema
>;

export interface VerifiedFullRootRehearsal {
  readonly verified: true;
  readonly receipt: FullRootRehearsalReceipt;
  readonly receiptSha256: string;
}

export interface RehearseFullRootFixtureOptions {
  readonly sourceRoot: string;
  readonly artifactParentDirectory: string;
  readonly artifactName: string;
  readonly childTimeoutMs?: number;
}

interface DirectoryIdentity {
  readonly dev: number | bigint;
  readonly ino: number | bigint;
  readonly birthtimeMs: number;
}

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

function requireChildTimeout(value: number | undefined): number {
  const timeout = value ?? DEFAULT_CHILD_TIMEOUT_MS;
  if (!Number.isSafeInteger(timeout) || timeout < 1 || timeout > MAX_CHILD_TIMEOUT_MS) {
    throw new FullRootRehearsalError(
      'timeout_invalid',
      `child timeout must be a safe integer from 1 through ${MAX_CHILD_TIMEOUT_MS}ms`,
    );
  }
  return timeout;
}

function pathEntryExists(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch {
    return false;
  }
}

function directoryIdentity(stat: Stats): DirectoryIdentity {
  return {
    dev: stat.dev,
    ino: stat.ino,
    birthtimeMs: stat.birthtimeMs,
  };
}

function identitiesMatch(left: DirectoryIdentity, right: DirectoryIdentity): boolean {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.birthtimeMs === right.birthtimeMs
  );
}

function listRelativeFiles(root: string): string[] {
  const out: string[] = [];
  function walk(dir: string, prefix: string): void {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch (error) {
      throw new FullRootRehearsalError(
        'store_unreadable',
        `cannot read ${dir}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    for (const entry of entries) {
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      const abs = join(dir, entry.name);
      let stat: Stats;
      try {
        stat = lstatSync(abs);
      } catch (error) {
        throw new FullRootRehearsalError(
          'store_unreadable',
          `cannot lstat ${abs}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      if (stat.isSymbolicLink()) {
        throw new FullRootRehearsalError(
          'store_unreadable',
          `symlink refused in full-root fixture: ${abs}`,
        );
      }
      if (stat.isDirectory()) walk(abs, rel);
      else if (stat.isFile()) out.push(rel.replaceAll('\\', '/'));
    }
  }
  walk(root, '');
  return out.sort();
}

function hashDirectoryTree(root: string): { treeSha256: string; fileCount: number } {
  const files = listRelativeFiles(root);
  if (files.length === 0) {
    throw new FullRootRehearsalError(
      'store_empty',
      `store directory is empty: ${root}`,
    );
  }
  const hash = createHash('sha256');
  for (const rel of files) {
    const abs = join(root, rel);
    hash.update(rel);
    hash.update('\0');
    hash.update(readFileSync(abs));
    hash.update('\0');
  }
  return { treeSha256: hash.digest('hex'), fileCount: files.length };
}

function inspectStore(store: StateStore, directory: string): StoreInspection {
  if (!pathEntryExists(directory)) {
    throw new FullRootRehearsalError(
      'store_missing',
      `authoritative store missing: ${store}`,
    );
  }
  const { treeSha256, fileCount } = hashDirectoryTree(directory);
  const base: StoreInspection = {
    store,
    directory: resolve(directory),
    treeSha256,
    fileCount,
  };
  if (store === 'exec-graph') {
    const inspection: ExecGraphInspection = inspectExecGraphDirectory(directory);
    return {
      ...base,
      execGraph: {
        ledgerSha256: inspection.ledgerSha256,
        snapshotSha256: inspection.snapshotSha256,
        semanticSha256: inspection.semanticSha256,
        eventCount: inspection.eventCount,
        goalCount: inspection.goalCount,
        taskCount: inspection.taskCount,
      },
    };
  }
  return base;
}

/** Inspect every authoritative store under an explicit root. Fail closed. */
export function inspectFullRoot(rootDir: string): FullRootInspection {
  const root = requireAbsolute(rootDir, 'sourceRoot');
  if (!pathEntryExists(root) || !statSync(root).isDirectory()) {
    throw new FullRootRehearsalError('path_invalid', `root is not a directory: ${root}`);
  }

  const known = new Set(Object.keys(STATE_STORES));
  let entries;
  try {
    entries = readdirSync(root, { withFileTypes: true });
  } catch (error) {
    throw new FullRootRehearsalError(
      'store_unreadable',
      `cannot read root ${root}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (!known.has(entry.name)) {
      throw new FullRootRehearsalError(
        'store_unknown',
        `unknown store directory at root: ${entry.name}`,
      );
    }
  }

  const stores = AUTHORITATIVE_FULL_ROOT_STORES.map((store) =>
    inspectStore(store, join(root, store)),
  );
  const rootHash = createHash('sha256');
  for (const store of stores) {
    rootHash.update(store.store);
    rootHash.update('\0');
    rootHash.update(store.treeSha256);
    rootHash.update('\0');
  }
  return {
    root,
    treeSha256: rootHash.digest('hex'),
    stores,
    accepted: true,
  };
}

export function compareFullRoots(
  sourceRoot: string,
  candidateRoot: string,
): FullRootComparison {
  const source = inspectFullRoot(sourceRoot);
  const candidate = inspectFullRoot(candidateRoot);
  const storeSetEqual =
    source.stores.length === candidate.stores.length &&
    source.stores.every((s, i) => s.store === candidate.stores[i]!.store);
  const treeBytesEqual = source.treeSha256 === candidate.treeSha256;
  const sourceExec = source.stores.find((s) => s.store === 'exec-graph');
  const candidateExec = candidate.stores.find((s) => s.store === 'exec-graph');
  let execGraphAccepted = false;
  if (sourceExec && candidateExec) {
    const comparison = compareExecGraphDirectories(
      sourceExec.directory,
      candidateExec.directory,
    );
    execGraphAccepted = comparison.accepted;
  }
  return {
    treeBytesEqual,
    execGraphAccepted,
    storeSetEqual,
    accepted: treeBytesEqual && execGraphAccepted && storeSetEqual,
  };
}

function writeStoreMarker(storeDir: string, store: string, payload: unknown): void {
  mkdirSync(storeDir, { recursive: true });
  writeFileSync(
    join(storeDir, `${store}.fixture.json`),
    `${JSON.stringify(payload, null, 2)}\n`,
    'utf8',
  );
}

function seedExecGraphFixture(root: string): void {
  const NOW = '2026-08-01T00:00:00.000Z';
  const events: LedgerEvent[] = [
    ledgerEventSchema.parse({
      eventId: 'evt-full-root-goal',
      kind: 'goal-created',
      ts: NOW,
      actor: 'atlas',
      payload: {
        goal: {
          id: 'gol_full_root',
          title: 'full-root fixture goal',
          source: { kind: 'exec-graph', ref: 'full-root-goal' },
          status: 'open',
          createdAt: NOW,
        },
      },
    }),
    ledgerEventSchema.parse({
      eventId: 'evt-full-root-task',
      kind: 'task-created',
      ts: NOW,
      actor: 'atlas',
      payload: {
        task: {
          id: 'tsk_full_root',
          goalId: 'gol_full_root',
          title: 'full-root fixture task',
          source: { kind: 'exec-graph', ref: 'full-root-task' },
          owner: 'atlas',
          status: 'proposed',
          riskClass: 'low',
          idempotencyKey: 'exec-graph:full-root-task',
          evidence: [],
          createdAt: NOW,
          transitions: [{ from: null, to: 'proposed', ts: NOW, actor: 'atlas' }],
        },
      },
    }),
  ];
  const snapshot = foldEvents(events);
  const directory = join(root, 'exec-graph');
  mkdirSync(directory, { recursive: true });
  writeFileSync(
    join(directory, 'ledger.jsonl'),
    `${events.map((event) => JSON.stringify(event)).join('\n')}\n`,
    'utf8',
  );
  writeFileSync(
    join(directory, 'graph.json'),
    `${JSON.stringify({
      goals: Object.values(snapshot.goals),
      tasks: Object.values(snapshot.tasks),
    })}\n`,
    'utf8',
  );
}

/**
 * Seed a disposable fixture root with every authoritative store.
 * Uses an inline exec-graph fixture for the M3A slice; other stores get
 * deterministic non-empty marker files (isolation only — not live shapes).
 */
export function seedFixtureFullRoot(rootDir: string): void {
  const root = requireAbsolute(rootDir, 'fixtureRoot');
  mkdirSync(root, { recursive: true });
  for (const store of AUTHORITATIVE_FULL_ROOT_STORES) {
    const storeDir = join(root, store);
    if (store === 'exec-graph') {
      seedExecGraphFixture(root);
      continue;
    }
    if (store === 'effect-journal') {
      mkdirSync(join(storeDir, 'ops'), { recursive: true });
      writeFileSync(
        join(storeDir, 'ops', 'fixture-op.json'),
        `${JSON.stringify({
          schemaVersion: 1,
          operationId: 'queue:fixture-cmd',
          status: 'succeeded',
          identity: { kind: 'queue-command', commandId: 'fixture-cmd' },
          preparedAt: '2026-08-01T00:00:00.000Z',
          startedAt: '2026-08-01T00:00:00.000Z',
          terminalAt: '2026-08-01T00:00:01.000Z',
          receipt: { output: 'fixture' },
          revision: 2,
        })}\n`,
        'utf8',
      );
      continue;
    }
    writeStoreMarker(storeDir, store, {
      store,
      fixture: true,
      seededAt: '2026-08-01T00:00:00.000Z',
    });
  }
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

/** Staging sibling + renameSync into final destination. */
export function copyStateRootAtomic(
  sourceRoot: string,
  destinationParentDirectory: string,
  destinationName: string,
): string {
  const source = requireAbsolute(sourceRoot, 'sourceRoot');
  const parent = requireAbsolute(destinationParentDirectory, 'destinationParent');
  if (!/^[A-Za-z0-9._-]+$/.test(destinationName) || destinationName.includes('..')) {
    throw new FullRootRehearsalError(
      'path_invalid',
      `invalid destination name: ${destinationName}`,
    );
  }
  const finalDestination = join(parent, destinationName);
  const stagingDestination = join(
    parent,
    `.staging-${destinationName}-${randomUUID()}`,
  );

  if (pathEntryExists(finalDestination)) {
    throw new FullRootRehearsalError(
      'copy_failed',
      `refusing to overwrite existing candidate: ${finalDestination}`,
    );
  }

  try {
    mkdirSync(stagingDestination, { recursive: false });
    copyDirectoryRecursive(source, stagingDestination);
    renameSync(stagingDestination, finalDestination);
  } catch (error) {
    try {
      rmSync(stagingDestination, { recursive: true, force: true });
    } catch {
      /* best effort */
    }
    if (error instanceof FullRootRehearsalError) throw error;
    throw new FullRootRehearsalError(
      'copy_interrupted',
      `full-root copy did not complete: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }

  if (pathEntryExists(stagingDestination) || !pathEntryExists(finalDestination)) {
    throw new FullRootRehearsalError(
      'copy_interrupted',
      'copy did not land atomically at the destination',
    );
  }
  return finalDestination;
}

function removeGeneratedDirectory(
  parent: string,
  target: string,
  prefix: string,
  expectedIdentity: DirectoryIdentity,
): void {
  if (!pathEntryExists(target)) return;
  const lexicalParent = resolve(parent);
  const lexicalTarget = resolve(target);
  if (
    dirname(lexicalTarget) !== lexicalParent ||
    !basename(lexicalTarget).startsWith(prefix)
  ) {
    throw new FullRootRehearsalError(
      'cleanup_unsafe',
      `refusing unsafe cleanup target: ${target}`,
    );
  }
  const stat = lstatSync(lexicalTarget);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new FullRootRehearsalError(
      'cleanup_unsafe',
      `cleanup target is not a normal directory: ${target}`,
    );
  }
  if (!identitiesMatch(directoryIdentity(stat), expectedIdentity)) {
    throw new FullRootRehearsalError(
      'cleanup_unsafe',
      `cleanup target identity mismatch: ${target}`,
    );
  }
  const realParent = realpathSync.native(lexicalParent);
  const realTarget = realpathSync.native(lexicalTarget);
  const rel = relative(realParent, realTarget);
  if (rel === '' || rel.startsWith(`..${sep}`) || rel === '..' || isAbsolute(rel)) {
    throw new FullRootRehearsalError(
      'cleanup_unsafe',
      `cleanup target escapes parent: ${target}`,
    );
  }
  rmSync(lexicalTarget, { recursive: true, force: false });
}

export interface ColdFullRootReplayResult {
  readonly root: string;
  readonly treeSha256: string;
  readonly stores: StoreInspection[];
  readonly networkDenied: true;
}

export function coldReplayFullRoot(
  candidateRoot: string,
  options: { timeoutMs?: number } = {},
): ColdFullRootReplayResult {
  const root = requireAbsolute(candidateRoot, 'candidateRoot');
  const timeoutMs = requireChildTimeout(options.timeoutMs);
  const forbidNetworkUrl = pathToFileURL(forbidNetworkPath).href;
  const nodeOptions = [process.env.NODE_OPTIONS, `--import=${forbidNetworkUrl}`]
    .filter(Boolean)
    .join(' ');

  const result = spawnSync(
    process.execPath,
    [tsxCliPath, childScriptPath, root],
    {
      encoding: 'utf8',
      timeout: timeoutMs,
      windowsHide: true,
      cwd: repoRoot,
      env: {
        ...process.env,
        NODE_OPTIONS: nodeOptions,
        // Explicit proof paths only — strip live state routing from the child.
        ATLAS_STATE_ROOT: '',
        ATLAS_STATE_ROOT_REQUIRED: '',
        ATLAS_EFFECT_JOURNAL_DIR: '',
        ATLAS_EXEC_GRAPH_DIR: '',
      },
    },
  );

  if (result.error) {
    const code = (result.error as NodeJS.ErrnoException).code;
    if (code === 'ETIMEDOUT') {
      throw new FullRootRehearsalError(
        'replay_timeout',
        `cold full-root child timed out after ${timeoutMs}ms`,
      );
    }
    throw new FullRootRehearsalError(
      'replay_failed',
      `cold full-root child spawn failed: ${result.error.message}`,
    );
  }
  if (result.status !== 0) {
    throw new FullRootRehearsalError(
      'replay_failed',
      `cold full-root child exited ${result.status}: ${(result.stderr || '').slice(0, 500)}`,
    );
  }
  const stdout = (result.stdout || '').trim();
  if (!stdout) {
    throw new FullRootRehearsalError('replay_failed', 'cold full-root child printed nothing');
  }
  let parsed: ColdFullRootReplayResult;
  try {
    parsed = JSON.parse(stdout) as ColdFullRootReplayResult;
  } catch {
    throw new FullRootRehearsalError(
      'replay_failed',
      'cold full-root child printed unparseable output',
    );
  }
  if (
    !parsed ||
    parsed.root !== root ||
    parsed.networkDenied !== true ||
    typeof parsed.treeSha256 !== 'string'
  ) {
    throw new FullRootRehearsalError(
      'replay_failed',
      'cold full-root child returned an invalid inspection payload',
    );
  }
  return parsed;
}

function writeReceiptAtomically(
  receiptPath: string,
  receipt: FullRootRehearsalReceipt,
): void {
  const validated = fullRootRehearsalReceiptSchema.parse(receipt);
  const temporaryPath = `${receiptPath}.${process.pid}.${randomUUID()}.tmp`;
  writeFileSync(temporaryPath, `${JSON.stringify(validated, null, 2)}\n`, 'utf8');
  renameSync(temporaryPath, receiptPath);
}

/**
 * Rehearse a complete authoritative-root migration against a fixture source.
 * Cast fields beyond the declared options are ignored.
 */
export function rehearseFullRootFixture(
  options: RehearseFullRootFixtureOptions,
): FullRootRehearsalReceipt {
  const sourceRoot = requireAbsolute(options.sourceRoot, 'sourceRoot');
  const artifactParent = requireAbsolute(
    options.artifactParentDirectory,
    'artifactParentDirectory',
  );
  if (!ARTIFACT_NAME_RE.test(options.artifactName)) {
    throw new FullRootRehearsalError(
      'path_invalid',
      `artifactName must match ${ARTIFACT_NAME_RE}`,
    );
  }
  const artifactDirectory = join(artifactParent, options.artifactName);
  const receiptPath = join(artifactDirectory, RECEIPT_BASENAME);
  if (pathEntryExists(receiptPath)) {
    throw new FullRootRehearsalError(
      'receipt_exists',
      `rehearsal receipt already exists: ${receiptPath}`,
    );
  }
  if (pathEntryExists(artifactDirectory)) {
    throw new FullRootRehearsalError(
      'artifact_exists',
      `artifact directory already exists: ${artifactDirectory}`,
    );
  }

  const sourceBefore = inspectFullRoot(sourceRoot);
  const candidateName = `.m3d-full-root-work-${randomUUID()}`;
  const candidateRoot = join(artifactParent, candidateName);

  let candidateIdentity: DirectoryIdentity | undefined;
  try {
    copyStateRootAtomic(sourceRoot, artifactParent, candidateName);
    candidateIdentity = directoryIdentity(lstatSync(candidateRoot));

    const child = coldReplayFullRoot(candidateRoot, {
      timeoutMs: options.childTimeoutMs,
    });
    const comparison = compareFullRoots(sourceRoot, candidateRoot);
    if (!comparison.accepted || child.treeSha256 !== sourceBefore.treeSha256) {
      throw new FullRootRehearsalError(
        'compare_failed',
        'source/candidate/child full-root inspection did not agree',
      );
    }

    const sourceAfter = inspectFullRoot(sourceRoot);
    if (sourceAfter.treeSha256 !== sourceBefore.treeSha256) {
      throw new FullRootRehearsalError(
        'source_mutated',
        'source root changed during full-root rehearsal',
      );
    }

    removeGeneratedDirectory(
      artifactParent,
      candidateRoot,
      '.m3d-full-root-work-',
      candidateIdentity,
    );
    if (pathEntryExists(candidateRoot)) {
      throw new FullRootRehearsalError(
        'rollback_failed',
        'candidate root still present after rollback',
      );
    }

    mkdirSync(artifactDirectory, { recursive: false });
    const receipt: FullRootRehearsalReceipt = {
      schemaVersion: 1,
      kind: 'atlas.m3d-full-root-rehearsal',
      completedAt: new Date().toISOString(),
      sourceRoot,
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
    writeReceiptAtomically(receiptPath, receipt);
    return receipt;
  } catch (error) {
    if (candidateIdentity && pathEntryExists(candidateRoot)) {
      try {
        removeGeneratedDirectory(
          artifactParent,
          candidateRoot,
          '.m3d-full-root-work-',
          candidateIdentity,
        );
      } catch {
        /* best-effort cleanup; original error wins */
      }
    }
    throw error;
  }
}

export function verifyFullRootRehearsal(
  artifactDirectory: string,
): VerifiedFullRootRehearsal {
  const artifact = requireAbsolute(artifactDirectory, 'artifactDirectory');
  const receiptPath = join(artifact, RECEIPT_BASENAME);
  let raw: string;
  try {
    raw = readFileSync(receiptPath, 'utf8');
  } catch {
    throw new FullRootRehearsalError(
      'receipt_invalid',
      `missing rehearsal receipt: ${receiptPath}`,
    );
  }
  let receipt: FullRootRehearsalReceipt;
  try {
    receipt = fullRootRehearsalReceiptSchema.parse(JSON.parse(raw));
  } catch {
    throw new FullRootRehearsalError(
      'receipt_invalid',
      'rehearsal receipt failed schema validation',
    );
  }
  if (receipt.artifactDirectory !== artifact) {
    throw new FullRootRehearsalError(
      'receipt_tampered',
      'receipt artifactDirectory does not match verify target',
    );
  }
  if (pathEntryExists(receipt.candidateRoot)) {
    throw new FullRootRehearsalError(
      'rollback_failed',
      'candidate root still exists during independent verify',
    );
  }
  const liveSource = inspectFullRoot(receipt.sourceRoot);
  if (liveSource.treeSha256 !== receipt.sourceTreeSha256) {
    throw new FullRootRehearsalError(
      'receipt_tampered',
      'source tree no longer matches receipt sourceTreeSha256',
    );
  }
  // Re-hash the on-disk receipt bytes against a re-serialized canonical form
  // only after schema parse — unknown-field injection already fails parse.
  return {
    verified: true,
    receipt,
    receiptSha256: sha256(raw),
  };
}
