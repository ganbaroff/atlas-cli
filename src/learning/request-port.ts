/**
 * Sprint 1 — VOLAURA ↔ Atlas file-exchange port for learning decisions.
 * Pattern mirrors src/opsboard/goal-request-port.ts (M9).
 */

import { randomUUID } from 'node:crypto';
import {
  existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync, renameSync,
} from 'node:fs';
import { join } from 'node:path';
import { assertWritable, isAtlasReadonly } from '../atlas/readonly-guard.js';
import { recordSpend } from '../atlas/spend-tracker.js';
import { createGoal } from '../exec-graph/api.js';
import { appendClaim } from '../evidence/ledger.js';
import { generateCandidates } from './candidate-generator.js';
import { decideNextAction, finalizeDecision } from './nba-engine.js';
import {
  LEARNING_SCHEMA_VERSION,
  LearningRequestParseError,
  formatLearningRequestError,
  parseLearningRequest,
  resolveRequestCorrelationId,
  type LearningDecideInput,
  type LearningDecision,
  type LearningOutcomeInput,
  type LearningReceipt,
  type LearningRequest,
} from './contracts.js';

export function resolveLearningExchangeDir(): string {
  const dir = process.env.ATLAS_LEARNING_EXCHANGE_DIR;
  if (!dir) throw new Error('ATLAS_LEARNING_EXCHANGE_DIR not set');
  mkdirSync(join(dir, 'requests'), { recursive: true });
  mkdirSync(join(dir, 'receipts'), { recursive: true });
  return dir;
}

function receiptPath(dir: string, idempotencyKey: string): string {
  return join(dir, 'receipts', `${sanitizeFileKey(idempotencyKey)}.json`);
}

function failedReceiptPath(dir: string, requestId: string): string {
  mkdirSync(join(dir, 'receipts', 'failed'), { recursive: true });
  return join(dir, 'receipts', 'failed', `${sanitizeFileKey(requestId)}.json`);
}

function sanitizeFileKey(key: string): string {
  return key.replace(/[^a-zA-Z0-9._-]/g, '_');
}

function writeReceiptAtomic(dir: string, receipt: LearningReceipt, path?: string): void {
  mkdirSync(join(dir, 'receipts'), { recursive: true });
  const dest = path ?? receiptPath(dir, receipt.idempotencyKey);
  const tmp = `${dest}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(receipt, null, 2), 'utf8');
  renameSync(tmp, dest);
}

function readCompletedReceipt(dir: string, idempotencyKey: string): LearningReceipt | null {
  const path = receiptPath(dir, idempotencyKey);
  if (!existsSync(path)) return null;
  const receipt = JSON.parse(readFileSync(path, 'utf8')) as LearningReceipt;
  if (receipt.status === 'completed') return receipt;
  return null;
}

function makeClaimId(): string {
  return `clm_${randomUUID().replace(/-/g, '').slice(0, 16)}`;
}

function makeDecisionId(): string {
  return `dec_${randomUUID().replace(/-/g, '').slice(0, 16)}`;
}

function buildReceiptBase(req: LearningRequest, now: string): Pick<
  LearningReceipt,
  'schemaVersion' | 'requestId' | 'idempotencyKey' | 'createdAt' | 'correlationId' | 'kind'
> {
  return {
    schemaVersion: LEARNING_SCHEMA_VERSION,
    requestId: req.requestId,
    idempotencyKey: req.idempotencyKey,
    createdAt: req.createdAt,
    correlationId: resolveRequestCorrelationId(req),
    kind: req.kind,
  };
}

export function readLearningRequest(path: string): LearningRequest {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, 'utf8'));
  } catch (err) {
    throw new LearningRequestParseError(
      'learning request file is not valid JSON',
      formatLearningRequestError(err),
    );
  }
  return parseLearningRequest(raw);
}

export function listPendingLearningRequests(dir = resolveLearningExchangeDir()): string[] {
  const reqDir = join(dir, 'requests');
  if (!existsSync(reqDir)) return [];
  return readdirSync(reqDir)
    .filter((f) => f.endsWith('.json'))
    .map((f) => join(reqDir, f));
}

const seen = new Set<string>();

function auditDecision(
  idempotencyKey: string,
  decisionId: string,
  input: LearningDecideInput,
  decision: LearningDecision,
  goalId: string,
): string {
  const claimId = makeClaimId();
  appendClaim({
    claimId,
    claim: JSON.stringify({
      kind: 'learning-nba-decision',
      idempotencyKey,
      decisionId,
      learnerId: input.learnerId,
      concept: input.concept,
      masterySnapshot: input.mastery,
      decision,
      goalId,
    }),
    type: 'narrative',
    path: `learning://${idempotencyKey}`,
    confidence: 0,
    source: 'learning-nba',
    sourceRef: decisionId,
    ts: new Date().toISOString(),
  });
  return claimId;
}

function auditOutcome(
  idempotencyKey: string,
  input: LearningOutcomeInput,
): string {
  const claimId = makeClaimId();
  appendClaim({
    claimId,
    claim: JSON.stringify({
      kind: 'learning-outcome',
      idempotencyKey,
      decisionCorrelationId: input.decisionCorrelationId,
      learnerId: input.learnerId,
      concept: input.concept,
      completed: input.completed,
      correct: input.correct,
      responseTimeSec: input.responseTimeSec,
      selfReportedConfidence: input.selfReportedConfidence,
    }),
    type: 'narrative',
    path: `learning://outcome/${idempotencyKey}`,
    confidence: 0,
    source: 'learning-nba',
    sourceRef: input.decisionCorrelationId,
    ts: new Date().toISOString(),
  });
  return claimId;
}

async function processDecide(
  req: Extract<LearningRequest, { kind: 'decide' }>,
  dir: string,
  now: () => string,
): Promise<LearningReceipt> {
  assertWritable('learning.processDecide');
  const input = req.payload;
  const candidates = await generateCandidates(input);
  const scored = decideNextAction(input, candidates);
  const decisionId = makeDecisionId();
  const decision = finalizeDecision(scored, decisionId);

  const goal = createGoal({
    title: `NBA: ${input.concept} → ${decision.action}`,
    source: { kind: 'volaura-work-queue', ref: req.idempotencyKey },
    actor: 'learning-nba',
  });

  const claimId = auditDecision(req.idempotencyKey, decisionId, input, decision, goal.id);

  const spendCorrelationId = randomUUID();
  recordSpend({
    provider: 'atlas-local',
    model: 'nba-engine-v1',
    tokensIn: 0,
    tokensOut: 0,
    caller: 'learning-nba',
    correlationId: spendCorrelationId,
  });

  const receipt: LearningReceipt = {
    ...buildReceiptBase(req, now()),
    status: 'completed',
    updatedAt: now(),
    decisionId,
    goalId: goal.id,
    decision,
    spendCorrelationId,
    evidenceClaimId: claimId,
  };
  seen.add(req.idempotencyKey);
  writeReceiptAtomic(dir, receipt);
  return receipt;
}

async function processOutcome(
  req: Extract<LearningRequest, { kind: 'outcome' }>,
  dir: string,
  now: () => string,
): Promise<LearningReceipt> {
  assertWritable('learning.processOutcome');
  const input = req.payload;
  const claimId = auditOutcome(req.idempotencyKey, input);

  const spendCorrelationId = randomUUID();
  recordSpend({
    provider: 'atlas-local',
    model: 'nba-outcome-v1',
    tokensIn: 0,
    tokensOut: 0,
    caller: 'learning-nba',
    correlationId: spendCorrelationId,
  });

  const receipt: LearningReceipt = {
    ...buildReceiptBase(req, now()),
    status: 'completed',
    updatedAt: now(),
    spendCorrelationId,
    evidenceClaimId: claimId,
  };
  seen.add(req.idempotencyKey);
  writeReceiptAtomic(dir, receipt);
  return receipt;
}

/** Process one learning request → write receipt. Idempotent on idempotencyKey. */
export async function processLearningRequest(
  req: LearningRequest,
  opts?: { exchangeDir?: string; now?: () => Date },
): Promise<LearningReceipt> {
  const dir = opts?.exchangeDir ?? resolveLearningExchangeDir();
  const now = () => (opts?.now ? opts.now() : new Date()).toISOString();

  if (isAtlasReadonly()) {
    const receipt: LearningReceipt = {
      ...buildReceiptBase(req, now()),
      status: 'readonly',
      updatedAt: now(),
      error: 'ATLAS_READONLY=1',
    };
    writeReceiptAtomic(dir, receipt);
    return receipt;
  }

  const existing = readCompletedReceipt(dir, req.idempotencyKey);
  if (existing) {
    return { ...existing, status: 'completed', requestId: req.requestId };
  }

  if (seen.has(req.idempotencyKey)) {
    const receipt: LearningReceipt = {
      ...buildReceiptBase(req, now()),
      status: 'duplicate',
      updatedAt: now(),
      error: 'idempotencyKey already processed in this process',
    };
    return receipt;
  }

  try {
    if (req.kind === 'decide') return await processDecide(req, dir, now);
    return await processOutcome(req, dir, now);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const receipt: LearningReceipt = {
      ...buildReceiptBase(req, now()),
      status: 'failed',
      updatedAt: now(),
      error: msg.slice(0, 500),
    };
    // Failed receipts go to receipts/failed/{requestId} — do not block idempotencyKey retry.
    writeReceiptAtomic(dir, {
      ...receipt,
      idempotencyKey: `failed-${req.requestId}`,
    }, failedReceiptPath(dir, req.requestId));
    return receipt;
  }
}

/** Test helper. */
export function resetLearningRequestSeenForTests(): void {
  seen.clear();
}

export { LearningRequestParseError };
