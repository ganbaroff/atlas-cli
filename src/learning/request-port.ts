/**
 * Sprint 1 — VOLAURA ↔ Atlas file-exchange port for learning decisions.
 * Sprint 3 — GCS claim state machine for crash-safe idempotency.
 */

import {
  existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync, renameSync,
} from 'node:fs';
import { join } from 'node:path';
import { assertWritable, isAtlasReadonly } from '../atlas/readonly-guard.js';
import {
  LEARNING_SCHEMA_VERSION,
  LearningRequestParseError,
  formatLearningRequestError,
  parseLearningRequest,
  resolveRequestCorrelationId,
  type LearningProofBundle,
  type LearningReceipt,
  type LearningRequest,
} from './contracts.js';
import {
  buildProofBundle,
  newOperationOwner,
} from './claim-contract.js';
import { createLearningClaimStore } from './claim-store.js';
import { generateCandidates } from './candidate-generator.js';
import { decideNextAction, finalizeDecision } from './nba-engine.js';
import {
  deterministicDecisionId,
  deterministicEvidenceClaimId,
  deterministicGoalId,
  deterministicSpendCorrelationId,
  applyLearningProjections,
} from './projections.js';

export function resolveLearningExchangeDir(): string {
  const dir = process.env.ATLAS_LEARNING_EXCHANGE_DIR;
  if (!dir) throw new Error('ATLAS_LEARNING_EXCHANGE_DIR not set');
  mkdirSync(join(dir, 'requests'), { recursive: true });
  mkdirSync(join(dir, 'claims'), { recursive: true });
  return dir;
}

function receiptPath(dir: string, idempotencyKey: string): string {
  return join(dir, 'receipts', `${sanitizeFileKey(idempotencyKey)}.json`);
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

interface OperationArtifacts {
  receipt: LearningReceipt;
  evidencePayload: Record<string, unknown>;
  artifactHashes: Record<string, string>;
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

/** Pure computation — no local side effects (durable claim CAS fences writes). */
async function computeDecideArtifacts(
  req: Extract<LearningRequest, { kind: 'decide' }>,
  now: () => string,
): Promise<OperationArtifacts> {
  assertWritable('learning.processDecide');
  const input = req.payload;
  const candidates = await generateCandidates(input);
  const scored = decideNextAction(input, candidates);
  const decisionId = deterministicDecisionId(req.idempotencyKey);
  const decision = finalizeDecision(scored, decisionId);
  const goalId = deterministicGoalId(req.idempotencyKey);
  const evidenceClaimId = deterministicEvidenceClaimId(req.idempotencyKey, 'decide');
  const spendCorrelationId = deterministicSpendCorrelationId(req.idempotencyKey, 'decide');

  const evidencePayload = {
    kind: 'learning-nba-decision',
    idempotencyKey: req.idempotencyKey,
    decisionId,
    learnerId: input.learnerId,
    concept: input.concept,
    masterySnapshot: input.mastery,
    decision,
    goalId,
  };

  const receipt: LearningReceipt = {
    ...buildReceiptBase(req, now()),
    status: 'completed',
    updatedAt: now(),
    decisionId,
    goalId,
    decision,
    spendCorrelationId,
    evidenceClaimId,
  };

  return {
    receipt,
    evidencePayload,
    artifactHashes: { goalId, spendCorrelationId, evidenceClaimId },
  };
}

async function computeOutcomeArtifacts(
  req: Extract<LearningRequest, { kind: 'outcome' }>,
  now: () => string,
): Promise<OperationArtifacts> {
  assertWritable('learning.processOutcome');
  const input = req.payload;
  const evidenceClaimId = deterministicEvidenceClaimId(req.idempotencyKey, 'outcome');
  const spendCorrelationId = deterministicSpendCorrelationId(req.idempotencyKey, 'outcome');

  const evidencePayload = {
    kind: 'learning-outcome',
    idempotencyKey: req.idempotencyKey,
    decisionCorrelationId: input.decisionCorrelationId,
    learnerId: input.learnerId,
    concept: input.concept,
    completed: input.completed,
    correct: input.correct,
    responseTimeSec: input.responseTimeSec,
    selfReportedConfidence: input.selfReportedConfidence,
  };

  const receipt: LearningReceipt = {
    ...buildReceiptBase(req, now()),
    status: 'completed',
    updatedAt: now(),
    spendCorrelationId,
    evidenceClaimId,
  };

  return {
    receipt,
    evidencePayload,
    artifactHashes: { spendCorrelationId, evidenceClaimId },
  };
}

function completedReceiptFromProof(
  proof: LearningProofBundle,
  requestId: string,
): LearningReceipt {
  return { ...proof.receipt, proof, requestId, status: 'completed' };
}

function deliverCompletedFromProof(
  req: LearningRequest,
  proof: LearningProofBundle,
  dir: string,
  writeReceipt: (d: string, r: LearningReceipt) => void,
): Promise<LearningReceipt> {
  const receipt = completedReceiptFromProof(proof, req.requestId);
  return applyLearningProjections(req, proof)
    .catch((projErr) => {
      console.error('[learning] projection reconcile failed (non-fatal):', projErr);
    })
    .then(() => {
      try {
        if (!existsSync(receiptPath(dir, req.idempotencyKey))) {
          writeReceipt(dir, receipt);
        }
      } catch (projErr) {
        console.error('[learning] receipt reconcile failed (non-fatal):', projErr);
      }
      return receipt;
    });
}

/** Process one learning request with durable claim CAS. Idempotent on idempotencyKey + payload hash. */
export async function processLearningRequest(
  req: LearningRequest,
  opts?: {
    exchangeDir?: string;
    now?: () => Date;
    owner?: string;
    receiptWriter?: (dir: string, receipt: LearningReceipt) => void;
  },
): Promise<LearningReceipt> {
  const dir = opts?.exchangeDir ?? resolveLearningExchangeDir();
  const now = () => (opts?.now ? opts.now() : new Date()).toISOString();
  const store = createLearningClaimStore(dir);
  const owner = opts?.owner ?? newOperationOwner();
  const writeReceipt = opts?.receiptWriter ?? ((d: string, r: LearningReceipt) => writeReceiptAtomic(d, r));

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

  const begin = await store.beginOperation(req, owner, now());

  if (begin.outcome === 'completed') {
    return deliverCompletedFromProof(req, begin.proof, dir, writeReceipt);
  }

  if (begin.outcome === 'conflict') {
    return {
      ...buildReceiptBase(req, now()),
      status: 'rejected',
      updatedAt: now(),
      error: begin.message,
    };
  }

  if (begin.outcome === 'in_flight') {
    return {
      ...buildReceiptBase(req, now()),
      status: 'duplicate',
      updatedAt: now(),
      error: 'operation in flight',
    };
  }

  if (begin.outcome === 'stale_owner') {
    return {
      ...buildReceiptBase(req, now()),
      status: 'duplicate',
      updatedAt: now(),
      error: 'stale owner',
    };
  }

  const { claim, generation } = begin;
  let durableProof: LearningProofBundle | null = null;

  try {
    const artifacts = req.kind === 'decide'
      ? await computeDecideArtifacts(req, now)
      : await computeOutcomeArtifacts(req, now);

    const proof: LearningProofBundle = buildProofBundle(
      req,
      artifacts.receipt,
      artifacts.evidencePayload,
      artifacts.artifactHashes,
      claim.createdAt,
    );

    const complete = await store.completeOperation(
      req.idempotencyKey,
      owner,
      generation,
      proof,
      now(),
    );

    if (complete === 'stale_owner') {
      const durable = await store.readProof(req.idempotencyKey);
      if (durable) return deliverCompletedFromProof(req, durable, dir, writeReceipt);
      return {
        ...buildReceiptBase(req, now()),
        status: 'duplicate',
        updatedAt: now(),
        error: 'stale owner lost race',
      };
    }

    if (complete !== 'ok') {
      const durable = await store.readProof(req.idempotencyKey);
      if (durable) return deliverCompletedFromProof(req, durable, dir, writeReceipt);
      throw new Error('claim CAS lost after operation');
    }

    durableProof = proof;

    try {
      await applyLearningProjections(req, proof);
    } catch (projErr) {
      console.error('[learning] projection failed (non-fatal):', projErr);
    }

    try {
      writeReceipt(dir, { ...artifacts.receipt, proof });
    } catch (projErr) {
      console.error('[learning] receipt projection failed (non-fatal):', projErr);
    }

    return { ...artifacts.receipt, proof };
  } catch (err) {
    if (durableProof) {
      return deliverCompletedFromProof(req, durableProof, dir, writeReceipt);
    }
    const msg = err instanceof Error ? err.message : String(err);
    await store.failOperation(req.idempotencyKey, owner, generation, msg, req.requestId, now());
    return {
      ...buildReceiptBase(req, now()),
      status: 'failed',
      updatedAt: now(),
      error: msg.slice(0, 500),
    };
  }
}

/** Test helper — no-op (claim store is durable). */
export function resetLearningRequestSeenForTests(): void {
  /* retained for test compatibility */
}

export { LearningRequestParseError };
