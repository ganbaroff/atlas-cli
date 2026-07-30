/**
 * M3B — isolated synthetic copy / cold replay / rollback rehearsal.
 *
 * This module extends `shadow-state.ts` (M3A). It never reads a live
 * resolver, never mutates `ATLAS_STATE_ROOT` / `ATLAS_EXEC_GRAPH_DIR`, and
 * never activates a shadow root as live state. Every rehearsal operates on
 * caller-supplied directories only (a synthetic source + a caller-owned
 * temporary work directory) and is a full loop: atomic copy -> source
 * unchanged assertion -> cold replay in a fresh child process -> strict
 * parity -> rollback -> verified rollback -> receipt.
 *
 * Silence is failure. A receipt is only ever produced after rollback has
 * been verified by observation, and that ordering is structural: the
 * rollback verifier returns a token recognised by object identity (a
 * module-private class + WeakSet), never by a copyable field. Every
 * fail-closed exit removes any partial shadow root and returns/throws
 * before a receipt is constructed.
 */

import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';

import {
  compareExecGraphDirectories,
  inspectExecGraphDirectory,
  type ExecGraphInspection,
  type ShadowStateComparison,
} from './shadow-state.js';
import {
  resolveShadowRehearsalDependencies,
  type ShadowRehearsalDependencies,
} from './shadow-rehearsal-test-seam.js';

const moduleDirectory = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(moduleDirectory, '..', '..');
const defaultChildScriptPath = resolve(moduleDirectory, 'shadow-rehearsal-child.ts');
const tsxCliPath = resolve(repoRoot, 'node_modules', 'tsx', 'dist', 'cli.mjs');
const DEFAULT_CHILD_TIMEOUT_MS = 15_000;
const MAX_CHILD_TIMEOUT_MS = 30_000;
const RECEIPT_BASENAME = 'shadow-rehearsal-receipt.json';

function currentDependencies(): ShadowRehearsalDependencies {
  return resolveShadowRehearsalDependencies({
    fileWriter: defaultFileWriter,
    childScriptPath: defaultChildScriptPath,
    executeRollback,
  });
}

export type ShadowRehearsalErrorCode =
  | 'copy_failed'
  | 'copy_interrupted'
  | 'source_mutated'
  | 'replay_spawn_failed'
  | 'replay_timeout'
  | 'replay_nonzero_exit'
  | 'replay_empty_output'
  | 'replay_unparseable_output'
  | 'parity_mismatch'
  | 'rollback_not_executed'
  | 'rollback_verification_failed'
  | 'rollback_token_invalid'
  | 'timeout_invalid'
  | 'receipt_exists'
  | 'receipt_write_failed'
  | 'receipt_invalid';

export class ShadowRehearsalError extends Error {
  constructor(
    readonly code: ShadowRehearsalErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'ShadowRehearsalError';
  }
}

export interface ChildReplayResult {
  readonly directory: string;
  readonly ledgerSha256: string;
  readonly snapshotSha256: string;
  readonly semanticSha256: string;
  readonly eventCount: number;
  readonly goalCount: number;
  readonly taskCount: number;
}

const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);

export const rehearsalReceiptSchema = z
  .object({
    receiptPath: z.string().min(1),
    sourceDirectory: z.string().min(1),
    shadowRoot: z.string().min(1),
    sourceLedgerSha256: sha256Schema,
    sourceSnapshotSha256: sha256Schema,
    sourceSemanticSha256: sha256Schema,
    childReplayEventCount: z.number().int().nonnegative(),
    childReplayGoalCount: z.number().int().nonnegative(),
    childReplayTaskCount: z.number().int().nonnegative(),
    parityAccepted: z.literal(true),
    rollbackVerified: z.literal(true),
    rehearsalCompletedAt: z.string().datetime(),
  })
  .strict();

export type RehearsalReceipt = z.infer<typeof rehearsalReceiptSchema>;

function requireChildTimeout(value: number | undefined): number {
  const timeout = value ?? DEFAULT_CHILD_TIMEOUT_MS;
  if (!Number.isSafeInteger(timeout) || timeout < 1 || timeout > MAX_CHILD_TIMEOUT_MS) {
    throw new ShadowRehearsalError(
      'timeout_invalid',
      `child timeout must be a safe integer from 1 through ${MAX_CHILD_TIMEOUT_MS}ms`,
    );
  }
  return timeout;
}

function receiptPathFor(workDirectory: string): string {
  return join(resolve(workDirectory), RECEIPT_BASENAME);
}

function refuseExistingReceipt(receiptPath: string): void {
  if (existsSync(receiptPath)) {
    throw new ShadowRehearsalError(
      'receipt_exists',
      `refusing to overwrite an existing rehearsal receipt: ${receiptPath}`,
    );
  }
}

// --- Rollback token -------------------------------------------------------
//
// This module's history contains four independently-refuted "the receipt
// only happens after rollback" guards: a copyable property brand, a
// comment, an environment variable, and an untested boundary claim. None of
// those survive a forged or copied value. Object identity does: the class
// is never exported, so nothing outside this module can construct one, and
// the WeakSet membership check means even a structurally-identical copy
// (`{...token}`, `Object.assign({}, token)`) is rejected because it is a
// different object that was never minted by `verifyRollback`.

class RollbackVerifiedToken {
  constructor(
    readonly shadowRoot: string,
    readonly source: ExecGraphInspection,
    readonly childReplay: ChildReplayResult,
    readonly parity: ShadowStateComparison,
    readonly verifiedAt: string,
  ) {}
}

const recognizedRollbackTokens = new WeakSet<RollbackVerifiedToken>();

type RollbackToken = RollbackVerifiedToken;

function isRecognizedRollbackToken(candidate: unknown): candidate is RollbackVerifiedToken {
  return candidate instanceof RollbackVerifiedToken && recognizedRollbackTokens.has(candidate);
}

// --- Atomic copy ------------------------------------------------------------

function defaultFileWriter(destinationPath: string, contents: Buffer): void {
  writeFileSync(destinationPath, contents, { flush: true });
}

/**
 * Assemble a byte-for-byte copy of an exec-graph directory into a sibling
 * staging path, then `renameSync` it into the final destination on the same
 * volume. A failure at any point removes the staging path and leaves no
 * partial directory at the destination.
 */
export function copyExecGraphDirectoryAtomic(
  sourceDirectory: string,
  destinationParentDirectory: string,
  destinationName: string,
): string {
  const resolvedSource = resolve(sourceDirectory);
  const resolvedParent = resolve(destinationParentDirectory);
  const finalDestination = join(resolvedParent, destinationName);
  const stagingDestination = join(resolvedParent, `.staging-${destinationName}-${randomUUID()}`);

  if (existsSync(finalDestination)) {
    throw new ShadowRehearsalError(
      'copy_failed',
      `refusing to overwrite an existing shadow root: ${finalDestination}`,
    );
  }

  const ledgerRaw = readSourceFile(join(resolvedSource, 'ledger.jsonl'));
  const snapshotRaw = readSourceFile(join(resolvedSource, 'graph.json'));
  const fileWriter = currentDependencies().fileWriter;

  try {
    mkdirSync(stagingDestination, { recursive: false });
    fileWriter(join(stagingDestination, 'ledger.jsonl'), ledgerRaw);
    fileWriter(join(stagingDestination, 'graph.json'), snapshotRaw);
    // node:fs renameSync is atomic on the same volume (POSIX rename(2) /
    // Win32 MoveFileEx). The staging path and final destination are
    // siblings under the same caller-supplied parent by construction.
    renameSync(stagingDestination, finalDestination);
  } catch (error) {
    try {
      rmSync(stagingDestination, { recursive: true, force: true });
    } catch {
      // Best-effort cleanup only; the destination check below is the real guarantee.
    }
    if (error instanceof ShadowRehearsalError) throw error;
    throw new ShadowRehearsalError(
      'copy_interrupted',
      `synthetic copy did not complete: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  if (existsSync(stagingDestination) || !existsSync(finalDestination)) {
    throw new ShadowRehearsalError(
      'copy_interrupted',
      'copy did not land atomically at the destination',
    );
  }

  return finalDestination;
}

function readSourceFile(path: string): Buffer {
  try {
    return readFileSync(path);
  } catch (error) {
    throw new ShadowRehearsalError(
      'copy_failed',
      `synthetic source file is missing or unreadable: ${path} (${
        error instanceof Error ? error.message : String(error)
      })`,
    );
  }
}

// --- Cold replay --------------------------------------------------------

export interface ColdReplayOptions {
  readonly timeoutMs?: number;
}

export function coldReplayExecGraphDirectory(
  shadowRoot: string,
  options: ColdReplayOptions = {},
): ChildReplayResult {
  const scriptPath = currentDependencies().childScriptPath;
  const timeoutMs = requireChildTimeout(options.timeoutMs);

  const result = spawnSync(process.execPath, [tsxCliPath, scriptPath, shadowRoot], {
    encoding: 'utf8',
    timeout: timeoutMs,
    windowsHide: true,
    cwd: repoRoot,
  });

  if (result.error) {
    const code = (result.error as NodeJS.ErrnoException).code;
    if (code === 'ETIMEDOUT') {
      throw new ShadowRehearsalError(
        'replay_timeout',
        `cold replay child process timed out after ${timeoutMs}ms`,
      );
    }
    throw new ShadowRehearsalError(
      'replay_spawn_failed',
      `cold replay child process failed to start: ${result.error.message}`,
    );
  }

  if (result.signal) {
    throw new ShadowRehearsalError(
      'replay_timeout',
      `cold replay child process was killed by signal ${result.signal} (likely timeout)`,
    );
  }

  if (result.status !== 0) {
    throw new ShadowRehearsalError(
      'replay_nonzero_exit',
      `cold replay child exited with status ${String(result.status)}: ${(result.stderr ?? '').slice(0, 500)}`,
    );
  }

  const stdout = (result.stdout ?? '').trim();
  if (!stdout) {
    throw new ShadowRehearsalError('replay_empty_output', 'cold replay child produced no stdout');
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    throw new ShadowRehearsalError(
      'replay_unparseable_output',
      `cold replay child stdout was not valid JSON: ${stdout.slice(0, 200)}`,
    );
  }

  if (!isChildReplayResult(parsed)) {
    throw new ShadowRehearsalError(
      'replay_unparseable_output',
      'cold replay child stdout did not match the expected inspection shape',
    );
  }

  return parsed;
}

function isChildReplayResult(value: unknown): value is ChildReplayResult {
  if (typeof value !== 'object' || value === null) return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record.directory === 'string' &&
    typeof record.ledgerSha256 === 'string' &&
    typeof record.snapshotSha256 === 'string' &&
    typeof record.semanticSha256 === 'string' &&
    typeof record.eventCount === 'number' &&
    typeof record.goalCount === 'number' &&
    typeof record.taskCount === 'number'
  );
}

// --- Strict parity --------------------------------------------------------

export function assertStrictParity(
  sourceDirectory: string,
  shadowRoot: string,
  childReplay: ChildReplayResult,
): ShadowStateComparison {
  const parity = compareExecGraphDirectories(sourceDirectory, shadowRoot);

  const childMatchesParent =
    childReplay.ledgerSha256 === parity.candidate.ledgerSha256 &&
    childReplay.snapshotSha256 === parity.candidate.snapshotSha256 &&
    childReplay.semanticSha256 === parity.candidate.semanticSha256 &&
    childReplay.eventCount === parity.candidate.eventCount &&
    childReplay.goalCount === parity.candidate.goalCount &&
    childReplay.taskCount === parity.candidate.taskCount;

  if (!parity.accepted || !childMatchesParent) {
    const detail = !parity.accepted ? parity.blocker : 'child replay output disagrees with parent-side inspection';
    throw new ShadowRehearsalError('parity_mismatch', `synthetic candidate failed strict parity: ${detail}`);
  }

  return parity;
}

// --- Rollback ---------------------------------------------------------------

function executeRollback(shadowRoot: string): void {
  rmSync(shadowRoot, { recursive: true, force: true });
}

/**
 * Verify, by observation, that the shadow root is gone AND that the
 * synthetic source is still intact (same three hashes as before the copy).
 * Only on success does this mint a token; the mint is the only place
 * `recognizedRollbackTokens` is written to.
 */
function verifyRollback(
  shadowRoot: string,
  sourceBeforeCopy: ExecGraphInspection,
  childReplay: ChildReplayResult,
  parity: ShadowStateComparison,
): RollbackToken {
  const resolvedShadowRoot = resolve(shadowRoot);
  if (existsSync(resolvedShadowRoot)) {
    throw new ShadowRehearsalError(
      'rollback_not_executed',
      `shadow root still exists after rollback: ${resolvedShadowRoot}`,
    );
  }

  const childMatchesParity =
    childReplay.ledgerSha256 === parity.candidate.ledgerSha256 &&
    childReplay.snapshotSha256 === parity.candidate.snapshotSha256 &&
    childReplay.semanticSha256 === parity.candidate.semanticSha256 &&
    childReplay.eventCount === parity.candidate.eventCount &&
    childReplay.goalCount === parity.candidate.goalCount &&
    childReplay.taskCount === parity.candidate.taskCount;
  if (
    !parity.accepted ||
    resolve(parity.source.directory) !== resolve(sourceBeforeCopy.directory) ||
    resolve(parity.candidate.directory) !== resolvedShadowRoot ||
    resolve(childReplay.directory) !== resolvedShadowRoot ||
    !childMatchesParity
  ) {
    throw new ShadowRehearsalError(
      'rollback_verification_failed',
      'rollback proof does not belong to this source, shadow root, and accepted replay',
    );
  }

  const sourceAfterRollback = inspectExecGraphDirectory(sourceBeforeCopy.directory);
  if (
    sourceAfterRollback.ledgerSha256 !== sourceBeforeCopy.ledgerSha256 ||
    sourceAfterRollback.snapshotSha256 !== sourceBeforeCopy.snapshotSha256 ||
    sourceAfterRollback.semanticSha256 !== sourceBeforeCopy.semanticSha256
  ) {
    throw new ShadowRehearsalError(
      'rollback_verification_failed',
      `synthetic source no longer matches its pre-copy hashes: ${sourceBeforeCopy.directory}`,
    );
  }

  const token = new RollbackVerifiedToken(
    resolvedShadowRoot,
    sourceAfterRollback,
    childReplay,
    parity,
    new Date().toISOString(),
  );
  recognizedRollbackTokens.add(token);
  return token;
}

// --- Receipt ----------------------------------------------------------------

function writeRehearsalReceipt(
  token: RollbackToken,
  workDirectory: string,
): RehearsalReceipt {
  if (!isRecognizedRollbackToken(token)) {
    throw new ShadowRehearsalError(
      'rollback_token_invalid',
      'refusing to write a rehearsal receipt: rollback token is not a recognized instance minted by verifyRollback',
    );
  }
  if (!token.parity.accepted) {
    throw new ShadowRehearsalError(
      'parity_mismatch',
      'refusing to write a rehearsal receipt: parity comparison was not accepted',
    );
  }

  const receiptPath = receiptPathFor(workDirectory);
  const temporaryPath = join(
    resolve(workDirectory),
    `.shadow-rehearsal-receipt-${randomUUID()}.tmp`,
  );
  const receipt = rehearsalReceiptSchema.parse({
    receiptPath,
    sourceDirectory: token.source.directory,
    shadowRoot: token.shadowRoot,
    sourceLedgerSha256: token.source.ledgerSha256,
    sourceSnapshotSha256: token.source.snapshotSha256,
    sourceSemanticSha256: token.source.semanticSha256,
    childReplayEventCount: token.childReplay.eventCount,
    childReplayGoalCount: token.childReplay.goalCount,
    childReplayTaskCount: token.childReplay.taskCount,
    parityAccepted: true,
    rollbackVerified: true,
    rehearsalCompletedAt: token.verifiedAt,
  });

  refuseExistingReceipt(receiptPath);
  try {
    writeFileSync(temporaryPath, `${JSON.stringify(receipt, null, 2)}\n`, {
      encoding: 'utf8',
      flush: true,
    });
    refuseExistingReceipt(receiptPath);
    renameSync(temporaryPath, receiptPath);
  } catch (error) {
    try {
      rmSync(temporaryPath, { force: true });
    } catch {
      // The exact generated temporary file is the only cleanup target here.
    }
    if (error instanceof ShadowRehearsalError) throw error;
    throw new ShadowRehearsalError(
      'receipt_write_failed',
      `failed to persist rehearsal receipt: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(receiptPath, 'utf8'));
  } catch (error) {
    throw new ShadowRehearsalError(
      'receipt_invalid',
      `persisted rehearsal receipt is unreadable JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const validated = rehearsalReceiptSchema.safeParse(parsed);
  if (!validated.success || validated.data.receiptPath !== receiptPath) {
    throw new ShadowRehearsalError(
      'receipt_invalid',
      `persisted rehearsal receipt failed strict validation: ${receiptPath}`,
    );
  }
  return validated.data;
}

// --- Orchestrator -----------------------------------------------------------

export interface ShadowRehearsalOptions {
  /** Parent directory the shadow root is assembled/staged/renamed into. Caller-owned. */
  readonly workDirectory: string;
  readonly childTimeoutMs?: number;
}

/**
 * Run the full M3B rehearsal against a synthetic source directory. Fails
 * closed on every step: any thrown error removes the shadow root (if it was
 * created) before propagating, and a receipt is only ever returned after a
 * verified rollback.
 */
export function runShadowRehearsal(
  sourceDirectory: string,
  options: ShadowRehearsalOptions,
): RehearsalReceipt {
  const resolvedSource = resolve(sourceDirectory);
  const resolvedWorkDirectory = resolve(options.workDirectory);
  const childTimeoutMs = requireChildTimeout(options.childTimeoutMs);
  const receiptPath = receiptPathFor(resolvedWorkDirectory);
  refuseExistingReceipt(receiptPath);
  const shadowRootName = `shadow-${randomUUID()}`;

  // Fail-closed on missing/empty/invalid source using the existing M3A
  // error codes (directory_missing, ledger_empty, etc.) — bubbled, not
  // wrapped, since nothing has been created yet.
  const sourceBeforeCopy = inspectExecGraphDirectory(resolvedSource);

  const shadowRoot = copyExecGraphDirectoryAtomic(
    resolvedSource,
    resolvedWorkDirectory,
    shadowRootName,
  );

  try {
    const sourceAfterCopy = inspectExecGraphDirectory(resolvedSource);
    if (
      sourceAfterCopy.ledgerSha256 !== sourceBeforeCopy.ledgerSha256 ||
      sourceAfterCopy.snapshotSha256 !== sourceBeforeCopy.snapshotSha256 ||
      sourceAfterCopy.semanticSha256 !== sourceBeforeCopy.semanticSha256
    ) {
      throw new ShadowRehearsalError(
        'source_mutated',
        `synthetic source changed during the copy; refusing to proceed: ${resolvedSource}`,
      );
    }

    const childReplay = coldReplayExecGraphDirectory(shadowRoot, {
      timeoutMs: childTimeoutMs,
    });

    const parity = assertStrictParity(resolvedSource, shadowRoot, childReplay);

    currentDependencies().executeRollback(shadowRoot);
    const token = verifyRollback(shadowRoot, sourceAfterCopy, childReplay, parity);

    return writeRehearsalReceipt(token, resolvedWorkDirectory);
  } catch (error) {
    try {
      rmSync(shadowRoot, { recursive: true, force: true });
    } catch {
      // Best-effort cleanup; the caller's own destination check is authoritative.
    }
    throw error;
  }
}
