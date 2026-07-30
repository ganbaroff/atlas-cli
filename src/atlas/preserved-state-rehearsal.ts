/**
 * M3C retained-copy preservation.
 *
 * Every path is explicit. This module creates one complete artifact beneath a
 * caller-owned preservation parent and never activates it as live state.
 * Source stability is observed across S0/S1/S2; the preserved candidate is P0.
 */

import { createHash, randomUUID } from 'node:crypto';
import {
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  type Stats,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { z } from 'zod';

import {
  compareExecGraphDirectories,
  inspectExecGraphDirectory,
  ShadowStateError,
  type ExecGraphInspection,
  type ShadowStateComparison,
} from './shadow-state.js';
import {
  copyExecGraphDirectoryAtomic,
  rehearsalReceiptSchema,
  runShadowRehearsal,
  ShadowRehearsalError,
  type RehearsalReceipt,
} from './shadow-rehearsal.js';

const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);
const absolutePathSchema = z.string().min(1).refine(isAbsolute, 'path must be absolute');
const ARTIFACT_NAME_RE = /^atlas-exec-graph-m3c-\d{8}T\d{6}Z-[a-f0-9]{8}$/;
const MANIFEST_BASENAME = 'preservation-manifest.json';
const PRESERVED_DIRECTORY_BASENAME = 'exec-graph';
const M3B_RECEIPT_BASENAME = 'shadow-rehearsal-receipt.json';
const M3C_RECEIPT_BASENAME = 'rehearsal-receipt.json';
const DEFAULT_CHILD_TIMEOUT_MS = 15_000;
const MAX_CHILD_TIMEOUT_MS = 30_000;

const preservedInspectionSchema = z
  .object({
    directory: absolutePathSchema,
    ledgerSha256: sha256Schema,
    snapshotSha256: sha256Schema,
    semanticSha256: sha256Schema,
    eventCount: z.number().int().nonnegative(),
    goalCount: z.number().int().nonnegative(),
    taskCount: z.number().int().nonnegative(),
  })
  .strict();

const preservedComparisonSchema = z
  .object({
    ledgerBytesEqual: z.literal(true),
    semanticStateEqual: z.literal(true),
    countsEqual: z.literal(true),
    accepted: z.literal(true),
  })
  .strict();

export const preservedExecGraphManifestSchema = z
  .object({
    schemaVersion: z.literal(1),
    kind: z.literal('atlas.exec-graph-preservation'),
    createdAt: z.string().datetime(),
    sourceDirectory: absolutePathSchema,
    artifactDirectory: absolutePathSchema,
    preservedDirectory: absolutePathSchema,
    sourceBefore: preservedInspectionSchema,
    sourceAfterCopy: preservedInspectionSchema,
    sourceDuringComparison: preservedInspectionSchema,
    preserved: preservedInspectionSchema,
    comparison: preservedComparisonSchema,
    sourceStable: z.literal(true),
    preservationAccepted: z.literal(true),
  })
  .strict();

export type PreservedExecGraphManifest = z.infer<
  typeof preservedExecGraphManifestSchema
>;

export const preservedStateRehearsalReceiptSchema = z
  .object({
    schemaVersion: z.literal(1),
    kind: z.literal('atlas.m3c-preserved-state-rehearsal'),
    completedAt: z.string().datetime(),
    artifactDirectory: absolutePathSchema,
    preservedDirectory: absolutePathSchema,
    workDirectory: absolutePathSchema,
    workDirectoryAbsent: z.literal(true),
    manifestSha256: sha256Schema,
    preservedLedgerSha256: sha256Schema,
    preservedSnapshotSha256: sha256Schema,
    preservedSemanticSha256: sha256Schema,
    eventCount: z.number().int().nonnegative(),
    goalCount: z.number().int().nonnegative(),
    taskCount: z.number().int().nonnegative(),
    preservationAccepted: z.literal(true),
    coldReplayAccepted: z.literal(true),
    rollbackVerified: z.literal(true),
    preservedStateUnchanged: z.literal(true),
    m3bReceipt: rehearsalReceiptSchema,
  })
  .strict();

export type PreservedStateRehearsalReceipt = z.infer<
  typeof preservedStateRehearsalReceiptSchema
>;

export interface VerifiedPreservedStateRehearsal {
  readonly verified: true;
  readonly manifestSha256: string;
  readonly manifest: PreservedExecGraphManifest;
  readonly receipt: PreservedStateRehearsalReceipt;
}

export type PreservedStateRehearsalErrorCode =
  | 'path_invalid'
  | 'artifact_exists'
  | 'source_mutated'
  | 'preservation_mismatch'
  | 'manifest_invalid'
  | 'manifest_tampered'
  | 'preserved_state_tampered'
  | 'receipt_invalid'
  | 'receipt_exists'
  | 'rehearsal_failed'
  | 'timeout_invalid'
  | 'cleanup_unsafe'
  | 'cleanup_failed'
  | 'preservation_failed';

export class PreservedStateRehearsalError extends Error {
  constructor(
    readonly code: PreservedStateRehearsalErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'PreservedStateRehearsalError';
  }
}

export interface PreserveExecGraphSnapshotOptions {
  readonly sourceDirectory: string;
  readonly preservationParentDirectory: string;
  readonly artifactName: string;
}

interface ValidatedPreservationPaths {
  readonly sourceDirectory: string;
  readonly preservationParentDirectory: string;
  readonly artifactDirectory: string;
  readonly preservedDirectory: string;
  readonly artifactName: string;
}

interface LoadedPreservationManifest {
  readonly raw: string;
  readonly sha256: string;
  readonly manifest: PreservedExecGraphManifest;
  readonly artifactDirectory: string;
  readonly preservedDirectory: string;
  readonly receiptPath: string;
}

export interface RehearsePreservedExecGraphOptions {
  readonly artifactDirectory: string;
  readonly childTimeoutMs?: number;
}

function sha256(value: Buffer | string): string {
  return createHash('sha256').update(value).digest('hex');
}

function requireChildTimeout(value: number | undefined): number {
  const timeout = value ?? DEFAULT_CHILD_TIMEOUT_MS;
  if (!Number.isSafeInteger(timeout) || timeout < 1 || timeout > MAX_CHILD_TIMEOUT_MS) {
    throw new PreservedStateRehearsalError(
      'timeout_invalid',
      `child timeout must be a safe integer from 1 through ${MAX_CHILD_TIMEOUT_MS}ms`,
    );
  }
  return timeout;
}

interface DirectoryIdentity {
  readonly dev: number | bigint;
  readonly ino: number | bigint;
  readonly birthtimeMs: number;
}

function isWithin(parent: string, candidate: string): boolean {
  const rel = relative(resolve(parent), resolve(candidate));
  return rel !== '' && !rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel);
}

function pathsEqual(left: string, right: string): boolean {
  return relative(resolve(left), resolve(right)) === '';
}

function pathEntryExists(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch {
    return false;
  }
}

function isNormalDirectory(directory: string): boolean {
  try {
    const stat = lstatSync(directory);
    return stat.isDirectory() && !stat.isSymbolicLink();
  } catch {
    return false;
  }
}

function validatePreservationPaths(
  options: PreserveExecGraphSnapshotOptions,
): ValidatedPreservationPaths {
  if (
    typeof options !== 'object' ||
    options === null ||
    typeof options.sourceDirectory !== 'string' ||
    typeof options.preservationParentDirectory !== 'string' ||
    typeof options.artifactName !== 'string' ||
    !isAbsolute(options.sourceDirectory) ||
    !isAbsolute(options.preservationParentDirectory) ||
    !ARTIFACT_NAME_RE.test(options.artifactName)
  ) {
    throw new PreservedStateRehearsalError(
      'path_invalid',
      'source and preservation parent must be absolute and artifact name must match the M3C basename contract',
    );
  }

  const sourceDirectory = resolve(options.sourceDirectory);
  const preservationParentDirectory = resolve(options.preservationParentDirectory);
  if (!isNormalDirectory(preservationParentDirectory)) {
    throw new PreservedStateRehearsalError(
      'path_invalid',
      `preservation parent is missing or is not a normal directory: ${preservationParentDirectory}`,
    );
  }
  if (
    pathsEqual(sourceDirectory, preservationParentDirectory) ||
    isWithin(sourceDirectory, preservationParentDirectory) ||
    isWithin(preservationParentDirectory, sourceDirectory)
  ) {
    throw new PreservedStateRehearsalError(
      'path_invalid',
      'source and preservation parent must not overlap in either direction',
    );
  }

  const artifactDirectory = join(preservationParentDirectory, options.artifactName);
  if (!isWithin(preservationParentDirectory, artifactDirectory)) {
    throw new PreservedStateRehearsalError(
      'path_invalid',
      'artifact path must be a direct child of the preservation parent',
    );
  }
  if (pathEntryExists(artifactDirectory)) {
    throw new PreservedStateRehearsalError(
      'artifact_exists',
      `refusing to overwrite an existing preserved artifact: ${artifactDirectory}`,
    );
  }

  return {
    sourceDirectory,
    preservationParentDirectory,
    artifactDirectory,
    preservedDirectory: join(artifactDirectory, PRESERVED_DIRECTORY_BASENAME),
    artifactName: options.artifactName,
  };
}

function assertResolvedSeparation(source: string, preservationParent: string): void {
  let realSource: string;
  let realParent: string;
  try {
    realSource = realpathSync.native(source);
    realParent = realpathSync.native(preservationParent);
  } catch (error) {
    throw new PreservedStateRehearsalError(
      'path_invalid',
      `failed to resolve source and preservation parent: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
  if (
    pathsEqual(realSource, realParent) ||
    isWithin(realSource, realParent) ||
    isWithin(realParent, realSource)
  ) {
    throw new PreservedStateRehearsalError(
      'path_invalid',
      'resolved source and preservation parent must not overlap in either direction',
    );
  }
}

function inspectionsMatch(
  left: ExecGraphInspection,
  right: ExecGraphInspection,
): boolean {
  return (
    left.ledgerSha256 === right.ledgerSha256 &&
    left.snapshotSha256 === right.snapshotSha256 &&
    left.semanticSha256 === right.semanticSha256 &&
    left.eventCount === right.eventCount &&
    left.goalCount === right.goalCount &&
    left.taskCount === right.taskCount
  );
}

function assertStable(...observations: ExecGraphInspection[]): void {
  const first = observations[0];
  if (!first || observations.slice(1).some((item) => !inspectionsMatch(first, item))) {
    throw new PreservedStateRehearsalError(
      'source_mutated',
      'source changed during the preservation observation window',
    );
  }
}

function assertAccepted(comparison: ShadowStateComparison): void {
  if (!comparison.accepted) {
    throw new PreservedStateRehearsalError(
      'preservation_mismatch',
      `preserved copy comparison failed: ${comparison.blocker}`,
    );
  }
}

function bindInspection(
  inspection: ExecGraphInspection,
  finalDirectory: string,
): z.infer<typeof preservedInspectionSchema> {
  return preservedInspectionSchema.parse({
    ...inspection,
    directory: resolve(finalDirectory),
  });
}

function readPersistedManifest(path: string): {
  readonly raw: string;
  readonly manifest: PreservedExecGraphManifest;
} {
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch (error) {
    throw new PreservedStateRehearsalError(
      'manifest_invalid',
      `preservation manifest is missing or unreadable: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new PreservedStateRehearsalError(
      'manifest_invalid',
      `preservation manifest is not valid JSON: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
  const result = preservedExecGraphManifestSchema.safeParse(parsed);
  if (!result.success) {
    throw new PreservedStateRehearsalError(
      'manifest_invalid',
      `preservation manifest failed strict validation: ${path}`,
    );
  }
  return { raw, manifest: result.data };
}

function resolveArtifactDirectoryInput(artifactDirectoryInput: string): string {
  if (typeof artifactDirectoryInput !== 'string' || !isAbsolute(artifactDirectoryInput)) {
    throw new PreservedStateRehearsalError(
      'path_invalid',
      'artifact directory must be an explicit absolute path',
    );
  }
  const artifactDirectory = resolve(artifactDirectoryInput);
  if (!isNormalDirectory(artifactDirectory)) {
    throw new PreservedStateRehearsalError(
      'manifest_invalid',
      `preserved artifact is missing or is not a normal directory: ${artifactDirectory}`,
    );
  }
  return artifactDirectory;
}

function loadBoundManifest(artifactDirectoryInput: string): LoadedPreservationManifest {
  const artifactDirectory = resolveArtifactDirectoryInput(artifactDirectoryInput);
  const preservedDirectory = join(artifactDirectory, PRESERVED_DIRECTORY_BASENAME);
  const manifestPath = join(artifactDirectory, MANIFEST_BASENAME);
  const read = readPersistedManifest(manifestPath);
  const manifest = read.manifest;
  if (
    manifest.artifactDirectory !== artifactDirectory ||
    manifest.preservedDirectory !== preservedDirectory ||
    manifest.sourceBefore.directory !== manifest.sourceDirectory ||
    manifest.sourceAfterCopy.directory !== manifest.sourceDirectory ||
    manifest.sourceDuringComparison.directory !== manifest.sourceDirectory ||
    manifest.preserved.directory !== preservedDirectory ||
    !inspectionsMatch(manifest.sourceBefore, manifest.sourceAfterCopy) ||
    !inspectionsMatch(manifest.sourceBefore, manifest.sourceDuringComparison) ||
    !inspectionsMatch(manifest.sourceBefore, manifest.preserved)
  ) {
    throw new PreservedStateRehearsalError(
      'manifest_invalid',
      `preservation manifest is internally inconsistent: ${manifestPath}`,
    );
  }
  return {
    raw: read.raw,
    sha256: sha256(read.raw),
    manifest,
    artifactDirectory,
    preservedDirectory,
    receiptPath: join(artifactDirectory, M3C_RECEIPT_BASENAME),
  };
}

function inspectBoundPreservedState(
  loaded: LoadedPreservationManifest,
): ExecGraphInspection {
  let inspection: ExecGraphInspection;
  try {
    inspection = inspectExecGraphDirectory(loaded.preservedDirectory);
  } catch (error) {
    throw new PreservedStateRehearsalError(
      'preserved_state_tampered',
      `preserved exec graph failed strict inspection: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
  if (!inspectionsMatch(inspection, loaded.manifest.preserved)) {
    throw new PreservedStateRehearsalError(
      'preserved_state_tampered',
      'preserved exec graph no longer matches its preservation manifest',
    );
  }
  return inspection;
}

function cleanupUnsafe(target: string): PreservedStateRehearsalError {
  return new PreservedStateRehearsalError(
    'cleanup_unsafe',
    `refusing recursive cleanup outside the generated direct-child boundary: ${target}`,
  );
}

function directoryIdentity(stat: Stats): DirectoryIdentity {
  return { dev: stat.dev, ino: stat.ino, birthtimeMs: stat.birthtimeMs };
}

function identitiesMatch(
  left: DirectoryIdentity,
  right: DirectoryIdentity,
): boolean {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.birthtimeMs === right.birthtimeMs
  );
}

function captureOwnedDirectoryIdentity(target: string): DirectoryIdentity {
  let stat: Stats;
  try {
    stat = lstatSync(target);
  } catch {
    throw cleanupUnsafe(target);
  }
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw cleanupUnsafe(target);
  return directoryIdentity(stat);
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
    throw cleanupUnsafe(target);
  }

  let stat: Stats;
  try {
    stat = lstatSync(lexicalTarget);
  } catch (error) {
    throw new PreservedStateRehearsalError(
      'cleanup_failed',
      `failed to inspect incomplete preservation artifact: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw cleanupUnsafe(target);
  if (!identitiesMatch(directoryIdentity(stat), expectedIdentity)) {
    throw cleanupUnsafe(target);
  }

  let realParent: string;
  let realTarget: string;
  try {
    realParent = realpathSync.native(lexicalParent);
    realTarget = realpathSync.native(lexicalTarget);
  } catch (error) {
    throw new PreservedStateRehearsalError(
      'cleanup_failed',
      `failed to resolve incomplete preservation artifact: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
  if (dirname(realTarget) !== realParent) throw cleanupUnsafe(target);

  const finalStat = captureOwnedDirectoryIdentity(lexicalTarget);
  if (!identitiesMatch(finalStat, expectedIdentity)) throw cleanupUnsafe(target);

  try {
    rmSync(lexicalTarget, { recursive: true, force: true });
  } catch (error) {
    throw new PreservedStateRehearsalError(
      'cleanup_failed',
      `failed to remove incomplete preservation artifact: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
  if (pathEntryExists(lexicalTarget)) {
    throw new PreservedStateRehearsalError(
      'cleanup_failed',
      `incomplete preservation artifact still exists after cleanup: ${target}`,
    );
  }
}

export function preserveExecGraphSnapshot(
  options: PreserveExecGraphSnapshotOptions,
): PreservedExecGraphManifest {
  const paths = validatePreservationPaths(options);
  const stagingDirectory = join(
    paths.preservationParentDirectory,
    `.m3c-staging-${paths.artifactName}-${randomUUID()}`,
  );
  const stagingPreservedDirectory = join(
    stagingDirectory,
    PRESERVED_DIRECTORY_BASENAME,
  );
  const sourceBefore = inspectExecGraphDirectory(paths.sourceDirectory);
  assertResolvedSeparation(
    paths.sourceDirectory,
    paths.preservationParentDirectory,
  );
  let stagingCreated = false;
  let ownedIdentity: DirectoryIdentity | undefined;
  let promoted = false;

  try {
    mkdirSync(stagingDirectory, { recursive: false });
    stagingCreated = true;
    ownedIdentity = captureOwnedDirectoryIdentity(stagingDirectory);
    copyExecGraphDirectoryAtomic(
      paths.sourceDirectory,
      stagingDirectory,
      PRESERVED_DIRECTORY_BASENAME,
    );
    const sourceAfterCopy = inspectExecGraphDirectory(paths.sourceDirectory);
    const comparison = compareExecGraphDirectories(
      paths.sourceDirectory,
      stagingPreservedDirectory,
    );
    assertStable(sourceBefore, sourceAfterCopy, comparison.source);
    assertAccepted(comparison);

    const manifest = preservedExecGraphManifestSchema.parse({
      schemaVersion: 1,
      kind: 'atlas.exec-graph-preservation',
      createdAt: new Date().toISOString(),
      sourceDirectory: paths.sourceDirectory,
      artifactDirectory: paths.artifactDirectory,
      preservedDirectory: paths.preservedDirectory,
      sourceBefore: bindInspection(sourceBefore, paths.sourceDirectory),
      sourceAfterCopy: bindInspection(sourceAfterCopy, paths.sourceDirectory),
      sourceDuringComparison: bindInspection(comparison.source, paths.sourceDirectory),
      preserved: bindInspection(comparison.candidate, paths.preservedDirectory),
      comparison: {
        ledgerBytesEqual: comparison.ledgerBytesEqual,
        semanticStateEqual: comparison.semanticStateEqual,
        countsEqual: comparison.countsEqual,
        accepted: comparison.accepted,
      },
      sourceStable: true,
      preservationAccepted: true,
    });
    const serializedManifest = `${JSON.stringify(manifest, null, 2)}\n`;
    writeFileSync(
      join(stagingDirectory, MANIFEST_BASENAME),
      serializedManifest,
      { encoding: 'utf8', flush: true },
    );

    if (pathEntryExists(paths.artifactDirectory)) {
      throw new PreservedStateRehearsalError(
        'artifact_exists',
        `preserved artifact appeared before promotion: ${paths.artifactDirectory}`,
      );
    }
    // First live M3C drill is Windows-only. Node exposes no portable
    // RENAME_NOREPLACE for directories; on Windows renameSync refuses an
    // existing destination. The second check and post-error classification
    // cover ordinary races there. POSIX empty-directory replacement is not a
    // supported live-drill guarantee without a future native no-replace port.
    try {
      renameSync(stagingDirectory, paths.artifactDirectory);
    } catch (error) {
      if (pathEntryExists(paths.artifactDirectory)) {
        throw new PreservedStateRehearsalError(
          'artifact_exists',
          `preserved artifact appeared during promotion: ${paths.artifactDirectory}`,
        );
      }
      throw error;
    }
    promoted = true;
    if (
      !identitiesMatch(
        captureOwnedDirectoryIdentity(paths.artifactDirectory),
        ownedIdentity,
      )
    ) {
      throw cleanupUnsafe(paths.artifactDirectory);
    }

    const persistedRead = readPersistedManifest(
      join(paths.artifactDirectory, MANIFEST_BASENAME),
    );
    if (persistedRead.raw !== serializedManifest) {
      throw new PreservedStateRehearsalError(
        'manifest_invalid',
        'promoted preservation manifest bytes differ from the flushed staging manifest',
      );
    }
    const persisted = persistedRead.manifest;
    if (
      persisted.sourceDirectory !== paths.sourceDirectory ||
      persisted.artifactDirectory !== paths.artifactDirectory ||
      persisted.preservedDirectory !== paths.preservedDirectory
    ) {
      throw new PreservedStateRehearsalError(
        'manifest_invalid',
        'preservation manifest paths do not match the promoted artifact',
      );
    }
    let finalInspection: ExecGraphInspection;
    try {
      finalInspection = inspectExecGraphDirectory(paths.preservedDirectory);
    } catch (error) {
      throw new PreservedStateRehearsalError(
        'preservation_mismatch',
        `promoted preserved state failed strict inspection: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
    if (!inspectionsMatch(finalInspection, persisted.preserved)) {
      throw new PreservedStateRehearsalError(
        'preservation_mismatch',
        'promoted preserved state differs from its bound manifest inspection',
      );
    }
    return persisted;
  } catch (error) {
    if (promoted) {
      if (!ownedIdentity) throw cleanupUnsafe(paths.artifactDirectory);
      removeGeneratedDirectory(
        paths.preservationParentDirectory,
        paths.artifactDirectory,
        paths.artifactName,
        ownedIdentity,
      );
    } else if (stagingCreated) {
      if (!ownedIdentity) throw cleanupUnsafe(stagingDirectory);
      removeGeneratedDirectory(
        paths.preservationParentDirectory,
        stagingDirectory,
        `.m3c-staging-${paths.artifactName}-`,
        ownedIdentity,
      );
    }
    if (
      error instanceof PreservedStateRehearsalError ||
      error instanceof ShadowStateError ||
      error instanceof ShadowRehearsalError
    ) {
      throw error;
    }
    throw new PreservedStateRehearsalError(
      'preservation_failed',
      `preserved snapshot failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

function readM3bReceipt(path: string): RehearsalReceipt {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    throw new PreservedStateRehearsalError(
      'receipt_invalid',
      `M3B receipt is missing or unreadable JSON: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
  const result = rehearsalReceiptSchema.safeParse(parsed);
  if (!result.success) {
    throw new PreservedStateRehearsalError(
      'receipt_invalid',
      `M3B receipt failed strict validation: ${path}`,
    );
  }
  return result.data;
}

function assertM3bReceiptBindings(
  receipt: RehearsalReceipt,
  loaded: LoadedPreservationManifest,
  workDirectory: string,
): void {
  const expectedReceiptPath = join(workDirectory, M3B_RECEIPT_BASENAME);
  if (
    receipt.receiptPath !== expectedReceiptPath ||
    receipt.sourceDirectory !== loaded.preservedDirectory ||
    receipt.sourceLedgerSha256 !== loaded.manifest.preserved.ledgerSha256 ||
    receipt.sourceSnapshotSha256 !== loaded.manifest.preserved.snapshotSha256 ||
    receipt.sourceSemanticSha256 !== loaded.manifest.preserved.semanticSha256 ||
    receipt.childReplayEventCount !== loaded.manifest.preserved.eventCount ||
    receipt.childReplayGoalCount !== loaded.manifest.preserved.goalCount ||
    receipt.childReplayTaskCount !== loaded.manifest.preserved.taskCount ||
    dirname(receipt.shadowRoot) !== workDirectory ||
    !basename(receipt.shadowRoot).startsWith('shadow-') ||
    pathEntryExists(receipt.shadowRoot)
  ) {
    throw new PreservedStateRehearsalError(
      'receipt_invalid',
      'M3B receipt is not bound to the exact preserved state and generated work directory',
    );
  }
}

function readM3cReceipt(path: string): {
  readonly raw: string;
  readonly receipt: PreservedStateRehearsalReceipt;
} {
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch (error) {
    throw new PreservedStateRehearsalError(
      'receipt_invalid',
      `M3C receipt is missing or unreadable: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new PreservedStateRehearsalError(
      'receipt_invalid',
      `M3C receipt is not valid JSON: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
  const result = preservedStateRehearsalReceiptSchema.safeParse(parsed);
  if (!result.success) {
    throw new PreservedStateRehearsalError(
      'receipt_invalid',
      `M3C receipt failed strict validation: ${path}`,
    );
  }
  return { raw, receipt: result.data };
}

function persistM3cReceipt(
  loaded: LoadedPreservationManifest,
  prospectiveReceipt: PreservedStateRehearsalReceipt,
): {
  readonly raw: string;
  readonly receipt: PreservedStateRehearsalReceipt;
} {
  if (pathEntryExists(loaded.receiptPath)) {
    throw new PreservedStateRehearsalError(
      'receipt_exists',
      `refusing to overwrite an existing M3C receipt: ${loaded.receiptPath}`,
    );
  }
  const temporaryPath = join(
    loaded.artifactDirectory,
    `.m3c-receipt-${randomUUID()}.tmp`,
  );
  const receipt = preservedStateRehearsalReceiptSchema.parse(prospectiveReceipt);
  const serialized = `${JSON.stringify(receipt, null, 2)}\n`;
  let promoted = false;
  try {
    writeFileSync(temporaryPath, serialized, { encoding: 'utf8', flush: true });
    if (pathEntryExists(loaded.receiptPath)) {
      throw new PreservedStateRehearsalError(
        'receipt_exists',
        `M3C receipt appeared before promotion: ${loaded.receiptPath}`,
      );
    }
    renameSync(temporaryPath, loaded.receiptPath);
    promoted = true;
    const persisted = readM3cReceipt(loaded.receiptPath);
    if (persisted.raw !== serialized) {
      throw new PreservedStateRehearsalError(
        'receipt_invalid',
        'persisted M3C receipt bytes differ from the flushed temporary receipt',
      );
    }
    return { raw: serialized, receipt: persisted.receipt };
  } catch (error) {
    try {
      rmSync(temporaryPath, { force: true });
    } catch {
      // Exact generated non-directory temporary file is the sole cleanup target.
    }
    if (promoted) {
      removeOwnedReceiptFile(
        loaded.artifactDirectory,
        loaded.receiptPath,
        serialized,
      );
    }
    if (error instanceof PreservedStateRehearsalError) throw error;
    throw new PreservedStateRehearsalError(
      'receipt_invalid',
      `failed to persist M3C receipt: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

function removeOwnedReceiptFile(
  artifactDirectory: string,
  receiptPath: string,
  expectedRaw: string,
): void {
  if (!pathEntryExists(receiptPath)) return;
  const lexicalArtifact = resolve(artifactDirectory);
  const lexicalReceipt = resolve(receiptPath);
  if (
    dirname(lexicalReceipt) !== lexicalArtifact ||
    basename(lexicalReceipt) !== M3C_RECEIPT_BASENAME
  ) {
    throw cleanupUnsafe(receiptPath);
  }
  let stat: Stats;
  let currentRaw: string;
  try {
    stat = lstatSync(lexicalReceipt);
    currentRaw = readFileSync(lexicalReceipt, 'utf8');
  } catch (error) {
    throw new PreservedStateRehearsalError(
      'cleanup_failed',
      `failed to inspect owned M3C receipt before cleanup: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
  if (!stat.isFile() || stat.isSymbolicLink() || currentRaw !== expectedRaw) {
    throw cleanupUnsafe(receiptPath);
  }
  const expectedIdentity = directoryIdentity(stat);
  let finalStat: Stats;
  try {
    finalStat = lstatSync(lexicalReceipt);
  } catch {
    throw cleanupUnsafe(receiptPath);
  }
  if (
    !finalStat.isFile() ||
    finalStat.isSymbolicLink() ||
    !identitiesMatch(directoryIdentity(finalStat), expectedIdentity) ||
    readFileSync(lexicalReceipt, 'utf8') !== expectedRaw
  ) {
    throw cleanupUnsafe(receiptPath);
  }
  try {
    rmSync(lexicalReceipt, { force: true });
  } catch (error) {
    throw new PreservedStateRehearsalError(
      'cleanup_failed',
      `failed to remove invalid M3C receipt: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
  if (pathEntryExists(lexicalReceipt)) {
    throw new PreservedStateRehearsalError(
      'cleanup_failed',
      `invalid M3C receipt still exists after cleanup: ${lexicalReceipt}`,
    );
  }
}

function assertReceiptBindings(
  loaded: LoadedPreservationManifest,
  receipt: PreservedStateRehearsalReceipt,
  currentPreserved: ExecGraphInspection,
): void {
  const workDirectory = resolve(receipt.workDirectory);
  if (receipt.manifestSha256 !== loaded.sha256) {
    throw new PreservedStateRehearsalError(
      'manifest_tampered',
      'current preservation manifest bytes do not match the receipt-bound SHA-256',
    );
  }
  if (
    receipt.artifactDirectory !== loaded.artifactDirectory ||
    receipt.preservedDirectory !== loaded.preservedDirectory ||
    receipt.workDirectory !== workDirectory ||
    receipt.preservedLedgerSha256 !== loaded.manifest.preserved.ledgerSha256 ||
    receipt.preservedSnapshotSha256 !== loaded.manifest.preserved.snapshotSha256 ||
    receipt.preservedSemanticSha256 !== loaded.manifest.preserved.semanticSha256 ||
    receipt.eventCount !== loaded.manifest.preserved.eventCount ||
    receipt.goalCount !== loaded.manifest.preserved.goalCount ||
    receipt.taskCount !== loaded.manifest.preserved.taskCount ||
    !inspectionsMatch(currentPreserved, loaded.manifest.preserved) ||
    dirname(workDirectory) !== dirname(loaded.artifactDirectory) ||
    !basename(workDirectory).startsWith('.m3c-work-') ||
    dirname(receipt.m3bReceipt.shadowRoot) !== workDirectory ||
    !basename(receipt.m3bReceipt.shadowRoot).startsWith('shadow-') ||
    receipt.m3bReceipt.receiptPath !== join(workDirectory, M3B_RECEIPT_BASENAME) ||
    pathEntryExists(workDirectory) ||
    pathEntryExists(receipt.m3bReceipt.shadowRoot) ||
    pathEntryExists(receipt.m3bReceipt.receiptPath)
  ) {
    throw new PreservedStateRehearsalError(
      'receipt_invalid',
      'M3C receipt does not bind the exact manifest, preserved state, and absent work paths',
    );
  }
  assertM3bReceiptBindings(receipt.m3bReceipt, loaded, workDirectory);
}

export function verifyPreservedStateRehearsal(
  artifactDirectory: string,
): VerifiedPreservedStateRehearsal {
  const resolvedArtifact = resolveArtifactDirectoryInput(artifactDirectory);
  const receiptRead = readM3cReceipt(join(resolvedArtifact, M3C_RECEIPT_BASENAME));
  let currentManifestRaw: string;
  try {
    currentManifestRaw = readFileSync(join(resolvedArtifact, MANIFEST_BASENAME), 'utf8');
  } catch (error) {
    throw new PreservedStateRehearsalError(
      'manifest_tampered',
      `receipt-bound manifest is missing or unreadable: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
  if (sha256(currentManifestRaw) !== receiptRead.receipt.manifestSha256) {
    throw new PreservedStateRehearsalError(
      'manifest_tampered',
      'current preservation manifest bytes do not match the receipt-bound SHA-256',
    );
  }
  const loaded = loadBoundManifest(resolvedArtifact);
  const currentPreserved = inspectBoundPreservedState(loaded);
  assertReceiptBindings(loaded, receiptRead.receipt, currentPreserved);
  return {
    verified: true,
    manifestSha256: loaded.sha256,
    manifest: loaded.manifest,
    receipt: receiptRead.receipt,
  };
}

export function rehearsePreservedExecGraph(
  options: RehearsePreservedExecGraphOptions,
): PreservedStateRehearsalReceipt {
  if (
    typeof options !== 'object' ||
    options === null ||
    typeof options.artifactDirectory !== 'string'
  ) {
    throw new PreservedStateRehearsalError(
      'path_invalid',
      'rehearsal options must contain one explicit absolute artifact directory',
    );
  }
  const timeout = requireChildTimeout(options.childTimeoutMs);
  const loaded = loadBoundManifest(options.artifactDirectory);
  if (pathEntryExists(loaded.receiptPath)) {
    throw new PreservedStateRehearsalError(
      'receipt_exists',
      `refusing to overwrite an existing M3C receipt: ${loaded.receiptPath}`,
    );
  }
  const preservedBefore = inspectBoundPreservedState(loaded);
  const workParent = dirname(loaded.artifactDirectory);
  const workDirectory = join(workParent, `.m3c-work-${randomUUID()}`);
  let workCreated = false;
  let workIdentity: DirectoryIdentity | undefined;
  let workCleanupAttempted = false;
  let persistedM3cReceiptRaw: string | undefined;

  try {
    mkdirSync(workDirectory, { recursive: false });
    workCreated = true;
    workIdentity = captureOwnedDirectoryIdentity(workDirectory);

    let m3bReceipt: RehearsalReceipt;
    try {
      m3bReceipt = runShadowRehearsal(loaded.preservedDirectory, {
        workDirectory,
        childTimeoutMs: timeout,
      });
    } catch (error) {
      const nestedCode =
        typeof error === 'object' && error !== null && 'code' in error
          ? String(error.code)
          : 'unknown';
      throw new PreservedStateRehearsalError(
        'rehearsal_failed',
        `M3B preserved-copy rehearsal failed closed (${nestedCode})`,
      );
    }

    const persistedM3bReceipt = readM3bReceipt(m3bReceipt.receiptPath);
    if (JSON.stringify(persistedM3bReceipt) !== JSON.stringify(m3bReceipt)) {
      throw new PreservedStateRehearsalError(
        'receipt_invalid',
        'returned M3B receipt differs from its persisted bytes',
      );
    }
    assertM3bReceiptBindings(persistedM3bReceipt, loaded, workDirectory);
    const preservedAfter = inspectBoundPreservedState(loaded);
    if (!inspectionsMatch(preservedBefore, preservedAfter)) {
      throw new PreservedStateRehearsalError(
        'preserved_state_tampered',
        'preserved exec graph changed during the M3C rehearsal',
      );
    }

    const prospectiveReceipt = preservedStateRehearsalReceiptSchema.parse({
      schemaVersion: 1,
      kind: 'atlas.m3c-preserved-state-rehearsal',
      completedAt: new Date().toISOString(),
      artifactDirectory: loaded.artifactDirectory,
      preservedDirectory: loaded.preservedDirectory,
      workDirectory,
      workDirectoryAbsent: true,
      manifestSha256: loaded.sha256,
      preservedLedgerSha256: preservedAfter.ledgerSha256,
      preservedSnapshotSha256: preservedAfter.snapshotSha256,
      preservedSemanticSha256: preservedAfter.semanticSha256,
      eventCount: preservedAfter.eventCount,
      goalCount: preservedAfter.goalCount,
      taskCount: preservedAfter.taskCount,
      preservationAccepted: true,
      coldReplayAccepted: true,
      rollbackVerified: true,
      preservedStateUnchanged: true,
      m3bReceipt: persistedM3bReceipt,
    });

    workCleanupAttempted = true;
    removeGeneratedDirectory(workParent, workDirectory, '.m3c-work-', workIdentity);
    workCreated = false;
    const persisted = persistM3cReceipt(loaded, prospectiveReceipt);
    const persistedReceipt = persisted.receipt;
    persistedM3cReceiptRaw = persisted.raw;
    const verified = verifyPreservedStateRehearsal(loaded.artifactDirectory);
    if (JSON.stringify(verified.receipt) !== JSON.stringify(persistedReceipt)) {
      throw new PreservedStateRehearsalError(
        'receipt_invalid',
        'independent verifier returned a different M3C receipt',
      );
    }
    return verified.receipt;
  } catch (error) {
    if (persistedM3cReceiptRaw !== undefined) {
      removeOwnedReceiptFile(
        loaded.artifactDirectory,
        loaded.receiptPath,
        persistedM3cReceiptRaw,
      );
    }
    if (workCreated && !workCleanupAttempted) {
      if (!workIdentity) throw cleanupUnsafe(workDirectory);
      removeGeneratedDirectory(workParent, workDirectory, '.m3c-work-', workIdentity);
    }
    if (error instanceof PreservedStateRehearsalError) throw error;
    throw new PreservedStateRehearsalError(
      'rehearsal_failed',
      `preserved-copy rehearsal failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}
