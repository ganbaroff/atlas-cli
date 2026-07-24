/**
 * M9 — ANUS-side OPSBOARD goal-request port (file exchange).
 * Writes receipts only; never imports OPSBOARD product code.
 */

import {
  existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync, renameSync,
} from 'node:fs';
import { join } from 'node:path';
import { assertWritable, isAtlasReadonly } from '../atlas/readonly-guard.js';

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

export function resolveExchangeDir(): string {
  const dir = process.env.ATLAS_OPSBOARD_EXCHANGE_DIR;
  if (!dir) throw new Error('ATLAS_OPSBOARD_EXCHANGE_DIR not set');
  mkdirSync(join(dir, 'requests'), { recursive: true });
  mkdirSync(join(dir, 'receipts'), { recursive: true });
  mkdirSync(join(dir, 'processed'), { recursive: true });
  return dir;
}

function writeReceiptAtomic(dir: string, receipt: GoalReceipt): void {
  mkdirSync(join(dir, 'receipts'), { recursive: true });
  const path = join(dir, 'receipts', `${receipt.correlationId}.json`);
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(receipt, null, 2), 'utf8');
  renameSync(tmp, path);
}

export function readGoalRequest(path: string): GoalRequest {
  const raw = JSON.parse(readFileSync(path, 'utf8')) as GoalRequest;
  if (!raw.correlationId || !raw.action || !raw.objective) {
    throw new Error('invalid GoalRequest shape');
  }
  return raw;
}

export function listPendingRequests(dir = resolveExchangeDir()): string[] {
  const reqDir = join(dir, 'requests');
  return readdirSync(reqDir)
    .filter((f) => f.endsWith('.json'))
    .map((f) => join(reqDir, f));
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
  const dir = opts?.exchangeDir ?? resolveExchangeDir();
  const now = () => (opts?.now ? opts.now() : new Date()).toISOString();

  if (isAtlasReadonly()) {
    const receipt: GoalReceipt = {
      correlationId: req.correlationId,
      status: 'readonly',
      updatedAt: now(),
      error: 'ATLAS_READONLY=1',
    };
    writeReceiptAtomic(dir, receipt);
    return receipt;
  }

  if (seen.has(req.correlationId) || existsSync(join(dir, 'receipts', `${req.correlationId}.json`))) {
    const receipt: GoalReceipt = {
      correlationId: req.correlationId,
      status: 'duplicate',
      updatedAt: now(),
      error: 'correlationId already processed',
    };
    writeReceiptAtomic(dir, receipt);
    return receipt;
  }

  if (req.action === 'cancel') {
    const receipt: GoalReceipt = {
      correlationId: req.correlationId,
      status: 'cancelled',
      updatedAt: now(),
    };
    seen.add(req.correlationId);
    writeReceiptAtomic(dir, receipt);
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
    writeReceiptAtomic(dir, receipt);
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
    seen.add(req.correlationId);
    writeReceiptAtomic(dir, receipt);
    return receipt;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const receipt: GoalReceipt = {
      correlationId: req.correlationId,
      status: msg.includes('timeout') ? 'timeout' : 'failed',
      updatedAt: now(),
      error: msg.slice(0, 500),
    };
    seen.add(req.correlationId);
    writeReceiptAtomic(dir, receipt);
    return receipt;
  }
}

/** Test helper. */
export function resetGoalRequestSeenForTests(): void {
  seen.clear();
}
