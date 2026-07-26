/**
 * Idempotent local projections from durable learning proof bundles.
 * Side effects run only after claim CAS completes — safe under lease takeover.
 */

import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { createGoal } from '../exec-graph/api.js';
import { readGraph } from '../exec-graph/ledger.js';
import { appendClaim, readLedgerEntries } from '../evidence/ledger.js';
import { readSpendReceipts, recordSpend } from '../atlas/spend-tracker.js';
import type { LearningDecideInput, LearningDecision, LearningOutcomeInput, LearningProofBundle, LearningRequest } from './contracts.js';
import {
  deterministicEvidenceClaimId,
  deterministicGoalId,
  deterministicSpendCorrelationId,
} from './artifact-ids.js';
import { withFileLock } from './claim-file-lock.js';

function sanitizeFileKey(key: string): string {
  return key.replace(/[^a-zA-Z0-9._-]/g, '_');
}

export function resolveProjectionLockPath(idempotencyKey: string): string {
  const root = process.env.ATLAS_LEARNING_EXCHANGE_DIR
    ?? process.env.ATLAS_LEARNING_STATE_DIR
    ?? join(process.cwd(), 'state', 'learning');
  mkdirSync(join(root, 'projection-locks'), { recursive: true });
  return join(root, 'projection-locks', sanitizeFileKey(idempotencyKey));
}

function ledgerHasClaimId(claimId: string): boolean {
  return readLedgerEntries().some((e) => e.claim.claimId === claimId);
}

function spendHasCorrelation(correlationId: string): boolean {
  return readSpendReceipts().some((r) => r.correlationId === correlationId);
}

function projectDecideSideEffectsUnsafe(
  idempotencyKey: string,
  input: LearningDecideInput,
  decision: LearningDecision,
  decisionId: string,
  goalId: string,
  evidenceClaimId: string,
  spendCorrelationId: string,
): void {
  const graph = readGraph();
  if (!graph.goals[goalId]) {
    createGoal({
      id: goalId,
      title: `NBA: ${input.concept} → ${decision.action}`,
      source: { kind: 'volaura-work-queue', ref: idempotencyKey },
      actor: 'learning-nba',
    });
  }

  if (!ledgerHasClaimId(evidenceClaimId)) {
    const payload = {
      kind: 'learning-nba-decision',
      idempotencyKey,
      decisionId,
      learnerId: input.learnerId,
      concept: input.concept,
      masterySnapshot: input.mastery,
      decision,
      goalId,
    };
    appendClaim({
      claimId: evidenceClaimId,
      claim: JSON.stringify(payload),
      type: 'narrative',
      path: `learning://${idempotencyKey}`,
      confidence: 0,
      source: 'learning-nba',
      sourceRef: decisionId,
      ts: new Date().toISOString(),
    });
  }

  if (!spendHasCorrelation(spendCorrelationId)) {
    recordSpend({
      provider: 'atlas-local',
      model: 'nba-engine-v1',
      tokensIn: 0,
      tokensOut: 0,
      caller: 'learning-nba',
      correlationId: spendCorrelationId,
    });
  }
}

function projectOutcomeSideEffectsUnsafe(
  idempotencyKey: string,
  input: LearningOutcomeInput,
  evidenceClaimId: string,
  spendCorrelationId: string,
): void {
  if (!ledgerHasClaimId(evidenceClaimId)) {
    const payload = {
      kind: 'learning-outcome',
      idempotencyKey,
      decisionCorrelationId: input.decisionCorrelationId,
      learnerId: input.learnerId,
      concept: input.concept,
      completed: input.completed,
      correct: input.correct,
      responseTimeSec: input.responseTimeSec,
      selfReportedConfidence: input.selfReportedConfidence,
    };
    appendClaim({
      claimId: evidenceClaimId,
      claim: JSON.stringify(payload),
      type: 'narrative',
      path: `learning://outcome/${idempotencyKey}`,
      confidence: 0,
      source: 'learning-nba',
      sourceRef: input.decisionCorrelationId,
      ts: new Date().toISOString(),
    });
  }

  if (!spendHasCorrelation(spendCorrelationId)) {
    recordSpend({
      provider: 'atlas-local',
      model: 'nba-outcome-v1',
      tokensIn: 0,
      tokensOut: 0,
      caller: 'learning-nba',
      correlationId: spendCorrelationId,
    });
  }
}

function projectFromProofUnsafe(req: LearningRequest, proof: LearningProofBundle): void {
  const { artifactHashes, receipt } = proof;
  if (req.kind === 'decide' && receipt.decision) {
    projectDecideSideEffectsUnsafe(
      req.idempotencyKey,
      req.payload,
      receipt.decision,
      receipt.decisionId!,
      artifactHashes.goalId ?? deterministicGoalId(req.idempotencyKey),
      artifactHashes.evidenceClaimId ?? deterministicEvidenceClaimId(req.idempotencyKey, 'decide'),
      artifactHashes.spendCorrelationId ?? deterministicSpendCorrelationId(req.idempotencyKey, 'decide'),
    );
    return;
  }
  if (req.kind === 'outcome') {
    projectOutcomeSideEffectsUnsafe(
      req.idempotencyKey,
      req.payload,
      artifactHashes.evidenceClaimId ?? deterministicEvidenceClaimId(req.idempotencyKey, 'outcome'),
      artifactHashes.spendCorrelationId ?? deterministicSpendCorrelationId(req.idempotencyKey, 'outcome'),
    );
  }
}

/** Winner + replay entry — one cross-process lock per idempotencyKey. */
export async function applyLearningProjections(
  req: LearningRequest,
  proof: LearningProofBundle,
): Promise<void> {
  await withFileLock(resolveProjectionLockPath(req.idempotencyKey), () => {
    projectFromProofUnsafe(req, proof);
  });
}

/** @deprecated use applyLearningProjections */
export async function reconcileProjectionsFromProof(
  req: LearningRequest,
  proof: LearningProofBundle,
): Promise<void> {
  await applyLearningProjections(req, proof);
}

export {
  deterministicDecisionId,
  deterministicGoalId,
  deterministicEvidenceClaimId,
  deterministicSpendCorrelationId,
} from './artifact-ids.js';
