/**
 * M3C retained-copy preservation.
 *
 * Every path is explicit. This module creates one complete artifact beneath a
 * caller-owned preservation parent and never activates it as live state.
 * Source stability is observed across S0/S1/S2; the preserved candidate is P0.
 */

import { randomUUID } from 'node:crypto';
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
  ShadowRehearsalError,
} from './shadow-rehearsal.js';

const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);
const absolutePathSchema = z.string().min(1).refine(isAbsolute, 'path must be absolute');
const ARTIFACT_NAME_RE = /^atlas-exec-graph-m3c-\d{8}T\d{6}Z-[a-f0-9]{8}$/;
const MANIFEST_BASENAME = 'preservation-manifest.json';
const PRESERVED_DIRECTORY_BASENAME = 'exec-graph';

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

export type PreservedStateRehearsalErrorCode =
  | 'path_invalid'
  | 'artifact_exists'
  | 'source_mutated'
  | 'preservation_mismatch'
  | 'manifest_invalid'
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
