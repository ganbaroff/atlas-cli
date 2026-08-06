/**
 * atlas/spend/store.ts — durable, atomic, restart-safe persistence for the
 * spend ledger (P1-B wave 1).
 *
 * Reuse survey (see P1-B deliverable report for the full quoted evidence):
 * this deliberately does NOT register a new state-root store. It reuses the
 * EXISTING 'spend-receipts' family (src/atlas/state-root.ts's STATE_STORES,
 * legacy env ATLAS_SPEND_RECEIPT_DIR) via spend-tracker.ts's own
 * resolveSpendReceiptDir() — imported directly, not reimplemented — the
 * same way atlas/work-order/replay.ts reuses the 'queue-auth' family
 * distinguished only by filename. One accounting day's ledger lives at
 * `<spend-receipts-dir>/spend-ledger-<YYYY-MM-DD>.json`, alongside
 * spend-tracker.ts's own `spend-receipts.jsonl`.
 *
 * Atomicity mirrors atlas/cost-router-state.ts's writeRecordAtomically /
 * withGoalLock exactly: open(wx) + write + fsync + close + rename for the
 * data file, and an O_EXCL lockfile (with stale-lock takeover) held for the
 * duration of every read-modify-write. Reads always re-read from disk — no
 * process-wide cache — so state observed after a restart is identical to
 * state observed mid-run.
 *
 * FAIL-CLOSED RULE (explicit, see P1-B report):
 *  - A day-file that exists but fails JSON.parse or zod validation is
 *    CORRUPT: loadDayFile() throws SpendStateCorruptError. Callers (ledger.ts
 *    / preflight.ts) must never treat this as "zero spent today" — it means
 *    "unknown", and unknown must refuse paid calls.
 *  - A day-file that does not exist yet (ENOENT) inside an otherwise
 *    resolvable, writable state directory is the ORDINARY first-call-of-the-
 *    day case — this is not "missing state root", it is "day one", and it
 *    bootstraps a fresh zero-totals file. This is the one explicit named
 *    safe-bootstrap rule ("first-touch-bootstrap"): a bootstrap only ever
 *    starts a NEW file at zero; it never repairs or replaces an existing
 *    file that failed to parse.
 *  - A state ROOT that cannot be resolved or created at all (state-root.ts
 *    throws StateRootActivationError/StateRootConfigurationError, or mkdir
 *    fails) is a deeper infrastructure failure, not day one: it propagates
 *    as SpendStateRootUnavailableError and the caller must refuse paid
 *    calls rather than silently operating out of a fallback location.
 */

import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

import { resolveSpendReceiptDir } from '../spend-tracker.js';
import { StateRootActivationError, StateRootConfigurationError } from '../state-root.js';
import {
  SPEND_SCHEMA_VERSION,
  spendDayFileSchema,
  SpendStateCorruptError,
  SpendStateRootUnavailableError,
  type SpendDayFile,
} from './types.js';

const DEFAULT_LOCK_WAIT_MS = 10_000;
const STALE_LOCK_MS = 30_000;

function dayFileName(accountingDay: string): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(accountingDay)) {
    throw new SpendStateCorruptError(`invalid accountingDay for ledger file: ${JSON.stringify(accountingDay)}`);
  }
  return `spend-ledger-${accountingDay}.json`;
}

/** Resolve the directory the ledger lives in. Wraps state-root policy errors into the one spend-specific "root unavailable" type callers key their fail-closed behaviour on. */
export function resolveSpendLedgerDir(): string {
  try {
    return resolveSpendReceiptDir();
  } catch (error) {
    if (error instanceof StateRootActivationError || error instanceof StateRootConfigurationError) {
      throw new SpendStateRootUnavailableError(`spend state root unavailable: ${error.message}`, error);
    }
    throw new SpendStateRootUnavailableError(
      `spend state root unavailable: ${error instanceof Error ? error.message : String(error)}`,
      error,
    );
  }
}

export function resolveDayFilePath(accountingDay: string, rootDir?: string): string {
  const dir = rootDir ?? resolveSpendLedgerDir();
  return join(dir, dayFileName(accountingDay));
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function removeStaleLock(lockPath: string): void {
  if (!existsSync(lockPath)) return;
  try {
    if (Date.now() - statSync(lockPath).mtimeMs > STALE_LOCK_MS) {
      unlinkSync(lockPath);
    }
  } catch {
    /* best effort */
  }
}

/**
 * Hold an exclusive file lock for the duration of `fn`. Mirrors
 * cost-router-state.ts's withGoalLock: O_EXCL create, stale-lock takeover
 * after STALE_LOCK_MS, bounded wait before giving up. This is what makes
 * concurrent reserve() attempts against the same day file serialize instead
 * of racing (see money-invariants / concurrency tests).
 */
export async function withLedgerLock<T>(
  filePath: string,
  fn: () => T | Promise<T>,
  waitMs = DEFAULT_LOCK_WAIT_MS,
): Promise<T> {
  let dir: string;
  try {
    mkdirSync((rootDirOf(filePath)), { recursive: true });
    dir = rootDirOf(filePath);
  } catch (error) {
    throw new SpendStateRootUnavailableError(
      `cannot create spend ledger directory: ${error instanceof Error ? error.message : String(error)}`,
      error,
    );
  }
  void dir;

  const lockPath = `${filePath}.lock`;
  const deadline = Date.now() + waitMs;
  let descriptor: number | undefined;

  while (descriptor === undefined) {
    try {
      descriptor = openSync(lockPath, 'wx');
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== 'EEXIST' && code !== 'EPERM' && code !== 'EACCES') {
        throw new SpendStateRootUnavailableError(
          `cannot acquire spend ledger lock: ${error instanceof Error ? error.message : String(error)}`,
          error,
        );
      }
      removeStaleLock(lockPath);
      if (Date.now() >= deadline) {
        throw new SpendStateRootUnavailableError(`spend ledger lock timed out: ${lockPath}`);
      }
      await sleep(10);
    }
  }

  try {
    return await fn();
  } finally {
    try {
      closeSync(descriptor);
    } finally {
      try {
        if (existsSync(lockPath)) unlinkSync(lockPath);
      } catch {
        /* best effort */
      }
    }
  }
}

function rootDirOf(filePath: string): string {
  const idx = Math.max(filePath.lastIndexOf('/'), filePath.lastIndexOf('\\'));
  return idx >= 0 ? filePath.slice(0, idx) : '.';
}

/**
 * Read a day file from disk. ENOENT bootstraps a fresh zero-record file at
 * the given cap (the "first-touch-bootstrap" rule — see module header).
 * Any other read/parse/validation failure is SpendStateCorruptError — never
 * treated as empty.
 */
export function loadOrBootstrapDayFile(
  accountingDay: string,
  ianaTimezone: string,
  dailyCapMinor: number,
  rootDir?: string,
): SpendDayFile {
  const filePath = resolveDayFilePath(accountingDay, rootDir);
  if (!existsSync(filePath)) {
    return spendDayFileSchema.parse({
      schemaVersion: SPEND_SCHEMA_VERSION,
      accountingDay,
      ianaTimezone,
      dailyCapMinor,
      records: {},
    });
  }

  let raw: string;
  try {
    raw = readFileSync(filePath, 'utf8');
  } catch (error) {
    throw new SpendStateCorruptError(`spend ledger file unreadable: ${filePath}: ${error instanceof Error ? error.message : String(error)}`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new SpendStateCorruptError(`spend ledger file is not valid JSON: ${filePath}: ${error instanceof Error ? error.message : String(error)}`);
  }

  const result = spendDayFileSchema.safeParse(parsed);
  if (!result.success) {
    throw new SpendStateCorruptError(
      `spend ledger file failed schema validation: ${filePath}: ${result.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`,
    );
  }
  if (result.data.accountingDay !== accountingDay) {
    throw new SpendStateCorruptError(`spend ledger file accountingDay mismatch: ${filePath}`);
  }
  return result.data;
}

/** Load an existing day file for read-only inspection. Missing file returns an empty (not bootstrapped-to-disk) in-memory day file — used by getDailyTotal() so a pure read never writes. */
export function peekDayFile(accountingDay: string, ianaTimezone: string, rootDir?: string): SpendDayFile {
  const filePath = resolveDayFilePath(accountingDay, rootDir);
  if (!existsSync(filePath)) {
    return spendDayFileSchema.parse({
      schemaVersion: SPEND_SCHEMA_VERSION,
      accountingDay,
      ianaTimezone,
      dailyCapMinor: 1,
      records: {},
    });
  }
  return loadOrBootstrapDayFile(accountingDay, ianaTimezone, 1, rootDir);
}

/** Atomic write: tmp file (O_EXCL) + fsync + rename. Validates against the schema before touching disk, so a bug can never persist a record that would immediately be classified corrupt on next read. */
export function writeDayFileAtomically(dayFile: SpendDayFile, rootDir?: string): void {
  const validated = spendDayFileSchema.parse(dayFile);
  const filePath = resolveDayFilePath(validated.accountingDay, rootDir);
  const dir = rootDirOf(filePath);
  mkdirSync(dir, { recursive: true });
  const tmpPath = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  let descriptor: number | undefined;
  try {
    descriptor = openSync(tmpPath, 'wx');
    writeFileSync(descriptor, `${JSON.stringify(validated, null, 2)}\n`, 'utf8');
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = undefined;
    renameSync(tmpPath, filePath);
  } catch (error) {
    throw new SpendStateRootUnavailableError(
      `spend ledger file unwritable: ${filePath}: ${error instanceof Error ? error.message : String(error)}`,
      error,
    );
  } finally {
    if (descriptor !== undefined) {
      try {
        closeSync(descriptor);
      } catch {
        /* best effort */
      }
    }
    try {
      if (existsSync(tmpPath)) unlinkSync(tmpPath);
    } catch {
      /* best effort */
    }
  }
}
