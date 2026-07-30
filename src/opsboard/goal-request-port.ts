/**
 * M9 — ANUS-side OPSBOARD goal-request port (file exchange).
 * Writes receipts only; never imports OPSBOARD product code.
 */

import {
  existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync, renameSync,
} from 'node:fs';
import { join } from 'node:path';
import { assertWritable, isAtlasReadonly } from '../atlas/readonly-guard.js';
import {
  constrainMigratingStatePath,
  resolveMigratingStateDir,
} from '../atlas/state-root.js';

export type GoalRequestAction = 'run' | 'cancel';
export type GoalReceiptStatus =
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'rejected'
  | 'readonly'
  | 'duplicate'
  | 'timeout';

export interface GoalRequest {
  correlationId: string;
  action: GoalRequestAction;
  objective: string;
  issuedAt: string;
  issuedBy: string;
  handId?: string;
  timeoutMs?: number;
}

export interface GoalReceipt {
  correlationId: string;
  status: GoalReceiptStatus;
  updatedAt: string;
  goalId?: string;
  error?: string;
  report?: unknown;
}

function exchangePath(dir: string, ...segments: string[]): string {
  return constrainMigratingStatePath(
    'opsboard-exchange',
    join(dir, ...segments),
  );
}

export function resolveExchangeDir(explicitDir?: string): string {
  const dir = resolveMigratingStateDir(
    'opsboard-exchange',
    () => {
      const legacy = explicitDir ?? process.env.ATLAS_OPSBOARD_EXCHANGE_DIR;
      if (!legacy) throw new Error('ATLAS_OPSBOARD_EXCHANGE_DIR not set');
      return legacy;
    },
    explicitDir === undefined ? 'ATLAS_OPSBOARD_EXCHANGE_DIR' : null,
  );
  const childDirs = ['requests', 'receipts', 'processed'].map(
    (name) => exchangePath(dir, name),
  );
  for (const childDir of childDirs) {
    mkdirSync(childDir, { recursive: true });
  }
  return dir;
}

interface ReceiptPaths {
  readonly directory: string;
  readonly final: string;
  readonly temporary: string;
}

/**
 * Validate the correlation id BEFORE any path is resolved or any directory is
 * created. A traversal-shaped id must not be able to bring the exchange tree
 * into existence as a side effect of being rejected.
 */
function assertValidCorrelationId(correlationId: string): void {
  if (
    !correlationId ||
    correlationId === '.' ||
    correlationId === '..' ||
    /[\\/\0]/.test(correlationId)
  ) {
    throw new Error('invalid correlationId: must be one file-name segment');
  }
}

function resolveReceiptPaths(dir: string, correlationId: string): ReceiptPaths {
  assertValidCorrelationId(correlationId);
  return {
    directory: exchangePath(dir, 'receipts'),
    final: exchangePath(dir, 'receipts', `${correlationId}.json`),
    temporary: exchangePath(
      dir,
      'receipts',
      `${correlationId}.json.${process.pid}.tmp`,
    ),
  };
}

function writeReceiptAtomic(paths: ReceiptPaths, receipt: GoalReceipt): void {
  mkdirSync(paths.directory, { recursive: true });
  writeFileSync(paths.temporary, JSON.stringify(receipt, null, 2), 'utf8');
  renameSync(paths.temporary, paths.final);
}

export function readGoalRequest(path: string): GoalRequest {
  const safePath = constrainMigratingStatePath('opsboard-exchange', path);
  const raw = JSON.parse(readFileSync(safePath, 'utf8')) as GoalRequest;
  if (!raw.correlationId || !raw.action || !raw.objective) {
    throw new Error('invalid GoalRequest shape');
  }
  return raw;
}

export function listPendingRequests(explicitDir?: string): string[] {
  const dir = resolveExchangeDir(explicitDir);
  const reqDir = exchangePath(dir, 'requests');
  return readdirSync(reqDir)
    .filter((f) => f.endsWith('.json'))
    .map((f) => exchangePath(dir, 'requests', f));
}

export type GoalRunnerFn = (input: {
  objective: string;
  handId: string;
  timeoutMs: number;
  correlationId: string;
}) => Promise<{ status: string; goalId?: string; report?: unknown }>;

const seen = new Set<string>();

/** Process one request → write receipt. Deterministic failure matrix. */
export async function processGoalRequest(
  req: GoalRequest,
  opts?: { run?: GoalRunnerFn; exchangeDir?: string; now?: () => Date },
): Promise<GoalReceipt> {
  // Refuse a malformed correlation id before `resolveExchangeDir` can create
  // the exchange tree, so a rejected request leaves zero filesystem residue.
  assertValidCorrelationId(req.correlationId);
  const dir = resolveExchangeDir(opts?.exchangeDir);
  const receiptPaths = resolveReceiptPaths(dir, req.correlationId);
  const now = () => (opts?.now ? opts.now() : new Date()).toISOString();

  if (isAtlasReadonly()) {
    const receipt: GoalReceipt = {
      correlationId: req.correlationId,
      status: 'readonly',
      updatedAt: now(),
      error: 'ATLAS_READONLY=1',
    };
    writeReceiptAtomic(receiptPaths, receipt);
    return receipt;
  }

  if (
    seen.has(req.correlationId) ||
    existsSync(receiptPaths.final)
  ) {
    const receipt: GoalReceipt = {
      correlationId: req.correlationId,
      status: 'duplicate',
      updatedAt: now(),
      error: 'correlationId already processed',
    };
    writeReceiptAtomic(receiptPaths, receipt);
    return receipt;
  }

  if (req.action === 'cancel') {
    const receipt: GoalReceipt = {
      correlationId: req.correlationId,
      status: 'cancelled',
      updatedAt: now(),
    };
    writeReceiptAtomic(receiptPaths, receipt);
    seen.add(req.correlationId);
    return receipt;
  }

  assertWritable('opsboard.processGoalRequest');
  const timeoutMs = req.timeoutMs ?? 60_000;
  const run = opts?.run;
  if (!run) {
    const receipt: GoalReceipt = {
      correlationId: req.correlationId,
      status: 'failed',
      updatedAt: now(),
      error: 'no goal runner injected',
    };
    writeReceiptAtomic(receiptPaths, receipt);
    return receipt;
  }

  try {
    const result = await Promise.race([
      run({
        objective: req.objective,
        handId: req.handId ?? 'browser-foreground',
        timeoutMs,
        correlationId: req.correlationId,
      }),
      new Promise<never>((_, reject) => {
        setTimeout(() => reject(new Error('timeout')), timeoutMs);
      }),
    ]);
    const status: GoalReceiptStatus =
      result.status === 'completed' ? 'completed'
        : result.status === 'rejected' ? 'rejected'
          : 'failed';
    const receipt: GoalReceipt = {
      correlationId: req.correlationId,
      status,
      updatedAt: now(),
      goalId: result.goalId,
      report: result.report ?? result,
    };
    writeReceiptAtomic(receiptPaths, receipt);
    seen.add(req.correlationId);
    return receipt;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const receipt: GoalReceipt = {
      correlationId: req.correlationId,
      status: msg.includes('timeout') ? 'timeout' : 'failed',
      updatedAt: now(),
      error: msg.slice(0, 500),
    };
    writeReceiptAtomic(receiptPaths, receipt);
    seen.add(req.correlationId);
    return receipt;
  }
}

/** Test helper. */
export function resetGoalRequestSeenForTests(): void {
  seen.clear();
}
