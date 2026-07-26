/**
 * Regression tests for claim-store CAS, GCS read retry, projection reconcile.
 */

import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { spawn } from 'node:child_process';
import {
  existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync,
} from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { LEARNING_SCHEMA_VERSION, type LearningRequest } from '../learning/contracts.js';
import { type LearningOperationClaim } from '../learning/claim-contract.js';
import { readGcsClaimObject } from '../learning/claim-store.js';
import { hashLearningRequest } from '../learning/claim-contract.js';
import { processLearningRequest } from '../learning/request-port.js';
import { isolateLearningTestEnv } from '../learning/test-isolation.js';
import { readLedgerEntries } from '../evidence/ledger.js';
import { readSpendReceipts } from '../atlas/spend-tracker.js';

const ROOT = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const REQUEST_PORT_MODULE = pathToFileURL(join(ROOT, 'src/learning/request-port.ts')).href;
const TSX_IMPORT = pathToFileURL(join(ROOT, 'node_modules', 'tsx', 'dist', 'loader.mjs')).href;
const CLAIM_STORE_MODULE = pathToFileURL(join(ROOT, 'src/learning/claim-store.ts')).href;
const CONTRACTS_MODULE = pathToFileURL(join(ROOT, 'src/learning/contracts.ts')).href;

const NOW = '2026-07-25T12:00:00.000Z';

function decideReq(idempotencyKey: string): LearningRequest {
  return {
    schemaVersion: LEARNING_SCHEMA_VERSION,
    requestId: 'req_regression_001',
    idempotencyKey,
    createdAt: NOW,
    issuedBy: 'volaura',
    kind: 'decide',
    payload: {
      learnerId: '123',
      concept: 'sigmoid',
      mastery: 0.35,
      lastAnswers: [false, true, false],
      responseTimeSec: 28,
      energy: 'medium',
    },
  };
}

function receiptFile(stateDir: string, idempotencyKey: string): string {
  return join(stateDir, 'receipts', `${idempotencyKey}.json`);
}

function countProjectionSinks(stateDir: string): { goals: number; evidence: number; spend: number } {
  const graphLedger = join(stateDir, 'exec-graph', 'ledger.jsonl');
  const goals = existsSync(graphLedger)
    ? readFileSync(graphLedger, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line) as { kind?: string })
      .filter((event) => event.kind === 'goal-created').length
    : 0;
  const evidence = readLedgerEntries(join(stateDir, 'evidence')).length;
  const spend = readSpendReceipts().filter((r) => r.caller === 'learning-nba').length;
  return { goals, evidence, spend };
}

function wipeLocalProjections(stateDir: string): void {
  for (const sub of ['exec-graph', 'evidence', 'spend'] as const) {
    const dir = join(stateDir, sub);
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(dir, { recursive: true });
  }
}

function writeTempScript(body: string): string {
  const path = join(tmpdir(), `atlas-claim-reg-${randomUUID()}.mts`);
  writeFileSync(path, body, 'utf8');
  return path;
}

function spawnClaimWorker(
  scriptPath: string,
  env: Record<string, string>,
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--import', TSX_IMPORT, scriptPath], {
      cwd: ROOT,
      env: { ...process.env, ...env, NODE_NO_WARNINGS: '1' },
      windowsHide: true,
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += String(chunk); });
    child.stderr.on('data', (chunk) => { stderr += String(chunk); });
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

describe('learning claim regression', () => {
  let stateDir: string;
  const scripts: string[] = [];

  beforeEach(() => {
    stateDir = mkdtempSync(join(tmpdir(), 'atlas-claim-reg-'));
    isolateLearningTestEnv(stateDir);
    process.env.SUPABASE_URL = '';
    delete process.env.ATLAS_READONLY;
  });

  afterEach(() => {
    vi.restoreAllMocks();
    for (const script of scripts) {
      try { rmSync(script, { force: true }); } catch { /* ignore */ }
    }
    scripts.length = 0;
    rmSync(stateDir, { recursive: true, force: true });
  });

  it('file CAS: only one cross-process takeover winner at generation 1', async () => {
    const idempotencyKey = 'idem_cross_process_cas';
    const workerReq = decideReq(idempotencyKey);
    const claimPath = join(stateDir, 'claims', `${idempotencyKey}.json`);
    const seeded: LearningOperationClaim = {
      schemaVersion: LEARNING_SCHEMA_VERSION,
      idempotencyKey,
      kind: 'decide',
      state: 'processing',
      owner: 'stale-owner:seed',
      requestHash: hashLearningRequest(workerReq),
      leaseUntil: '2026-01-01T00:00:00.000Z',
      generation: '1',
      attempt: 1,
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    };
    writeFileSync(claimPath, JSON.stringify(seeded), 'utf8');

    const scriptPath = writeTempScript(`
import { FileLearningClaimStore } from ${JSON.stringify(CLAIM_STORE_MODULE)};
import { LEARNING_SCHEMA_VERSION } from ${JSON.stringify(CONTRACTS_MODULE)};

const root = process.env.CLAIM_ROOT!;
const owner = process.env.CLAIM_OWNER!;
const key = process.env.CLAIM_KEY!;
const req = {
  schemaVersion: LEARNING_SCHEMA_VERSION,
  requestId: 'req_' + owner,
  idempotencyKey: key,
  createdAt: '2026-01-01T00:00:00.000Z',
  issuedBy: 'volaura',
  kind: 'decide',
  payload: {
    learnerId: '123',
    concept: 'sigmoid',
    mastery: 0.35,
    lastAnswers: [false, true, false],
    responseTimeSec: 28,
    energy: 'medium',
  },
};
const store = new FileLearningClaimStore(root);
const result = await store.beginOperation(req, owner, '2026-01-01T00:00:10.000Z');
console.log(JSON.stringify({ owner, outcome: result.outcome }));
`);
    scripts.push(scriptPath);

    const workers = Array.from({ length: 8 }, (_, i) =>
      spawnClaimWorker(scriptPath, {
        CLAIM_ROOT: stateDir,
        CLAIM_KEY: idempotencyKey,
        CLAIM_OWNER: `worker-${i}:${randomUUID()}`,
      }),
    );
    const results = await Promise.all(workers);
    for (const r of results) {
      expect(r.code).toBe(0);
      expect(r.stderr).toBe('');
    }

    const parsed = results.map((r) => JSON.parse(r.stdout.trim()) as { owner: string; outcome: string });
    const winners = parsed.filter((r) => r.outcome === 'proceed');
    expect(winners.length).toBe(1);

    const finalClaim = JSON.parse(readFileSync(claimPath, 'utf8')) as LearningOperationClaim;
    expect(finalClaim.generation).toBe('2');
    expect(finalClaim.owner).toBe(winners[0]!.owner);
  }, 60_000);

  it('GCS read retries when versioned download returns 404 for stale generation', async () => {
    let metaReads = 0;
    let versionedDownloads = 0;
    const sample = {
      schemaVersion: LEARNING_SCHEMA_VERSION,
      idempotencyKey: 'idem_gcs_404',
      kind: 'decide',
      state: 'processing',
      owner: 'rev:uuid',
      requestHash: 'abc',
      leaseUntil: '2099-01-01T00:00:00.000Z',
      generation: '2',
      attempt: 1,
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    };

    const file = {
      name: 'claims/idem_gcs_404.json',
      bucket: {
        file: vi.fn(() => ({
          download: vi.fn(async () => {
            versionedDownloads += 1;
            if (versionedDownloads === 1) {
              const err = new Error('No such object') as Error & { code?: number };
              err.code = 404;
              throw err;
            }
            return [Buffer.from(JSON.stringify(sample))];
          }),
        })),
      },
      getMetadata: vi.fn(async () => {
        metaReads += 1;
        return [{ generation: metaReads === 1 ? '1' : '2' }];
      }),
    };

    const pair = await readGcsClaimObject(file as unknown as import('@google-cloud/storage').File, 3);
    expect(pair?.generation).toBe('2');
    expect(versionedDownloads).toBeGreaterThanOrEqual(2);
    expect(metaReads).toBeGreaterThanOrEqual(2);
  });

  it('reconciles receipt and projections after durable completion when local receipt was deleted', async () => {
    const idempotencyKey = 'idem_projection_reconcile';
    const req = decideReq(idempotencyKey);
    const first = await processLearningRequest(req, { exchangeDir: stateDir });
    expect(first.status).toBe('completed');
    expect(existsSync(receiptFile(stateDir, idempotencyKey))).toBe(true);

    rmSync(join(stateDir, 'receipts'), { recursive: true, force: true });
    expect(existsSync(receiptFile(stateDir, idempotencyKey))).toBe(false);

    const second = await processLearningRequest(
      { ...req, requestId: 'req_after_delete' },
      { exchangeDir: stateDir },
    );
    expect(second.status).toBe('completed');
    expect(second.decisionId).toBe(first.decisionId);
    expect(existsSync(receiptFile(stateDir, idempotencyKey))).toBe(true);
  });

  it('concurrent completed replays project exactly one goal, evidence, and spend', async () => {
    const idempotencyKey = 'idem_projection_concurrent';
    const req = decideReq(idempotencyKey);
    const first = await processLearningRequest(req, { exchangeDir: stateDir });
    expect(first.status).toBe('completed');

    wipeLocalProjections(stateDir);
    expect(countProjectionSinks(stateDir)).toEqual({ goals: 0, evidence: 0, spend: 0 });

    const scriptPath = writeTempScript(`
import { processLearningRequest } from ${JSON.stringify(REQUEST_PORT_MODULE)};
const req = JSON.parse(process.env.REQ_JSON!);
const result = await processLearningRequest(req, {
  exchangeDir: process.env.ATLAS_LEARNING_EXCHANGE_DIR!,
});
console.log(JSON.stringify({ status: result.status }));
`);
    scripts.push(scriptPath);

    const workers = Array.from({ length: 16 }, (_, i) =>
      spawnClaimWorker(scriptPath, {
        ATLAS_LEARNING_EXCHANGE_DIR: stateDir,
        ATLAS_LEARNING_STATE_DIR: stateDir,
        ATLAS_EVIDENCE_DIR: join(stateDir, 'evidence'),
        ATLAS_EXEC_GRAPH_DIR: join(stateDir, 'exec-graph'),
        ATLAS_SPEND_RECEIPT_DIR: join(stateDir, 'spend'),
        REQ_JSON: JSON.stringify({ ...req, requestId: `req_replay_${i}` }),
      }),
    );
    const results = await Promise.all(workers);
    for (const r of results) {
      expect(r.code).toBe(0);
      expect(JSON.parse(r.stdout.trim()).status).toBe('completed');
    }

    expect(countProjectionSinks(stateDir)).toEqual({ goals: 1, evidence: 1, spend: 1 });
  }, 90_000);
});
