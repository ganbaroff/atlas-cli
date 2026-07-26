/**
 * Cross-process exclusive file lock (Windows + POSIX).
 */

import {
  closeSync, existsSync, mkdirSync, openSync, statSync, unlinkSync,
} from 'node:fs';
import { dirname } from 'node:path';

const DEFAULT_LOCK_WAIT_MS = 10_000;
const STALE_LOCK_MS = 30_000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function removeStaleLock(lockPath: string): void {
  if (!existsSync(lockPath)) return;
  try {
    const age = Date.now() - statSync(lockPath).mtimeMs;
    if (age > STALE_LOCK_MS) unlinkSync(lockPath);
  } catch {
    /* best effort */
  }
}

/** Run fn while holding an exclusive lock on `<targetPath>.lock`. */
export async function withFileLock<T>(
  targetPath: string,
  fn: () => T | Promise<T>,
  waitMs = DEFAULT_LOCK_WAIT_MS,
): Promise<T> {
  mkdirSync(dirname(targetPath), { recursive: true });
  const lockPath = `${targetPath}.lock`;
  const deadlineMs = Date.now() + waitMs;
  let fd: number | null = null;

  while (fd === null && Date.now() < deadlineMs) {
    try {
      fd = openSync(lockPath, 'wx');
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'EEXIST' || code === 'EPERM' || code === 'EACCES') {
        removeStaleLock(lockPath);
        await sleep(15);
        continue;
      }
      throw err;
    }
  }
  if (fd === null) throw new Error(`file lock timeout: ${lockPath}`);

  try {
    return await fn();
  } finally {
    try {
      closeSync(fd);
    } finally {
      try {
        if (existsSync(lockPath)) unlinkSync(lockPath);
      } catch {
        /* best effort */
      }
    }
  }
}

/** @deprecated use withFileLock */
export const withClaimFileLock = withFileLock;
