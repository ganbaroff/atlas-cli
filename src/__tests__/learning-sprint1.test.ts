/**
 * Sprint 1 — sigmoid lesson full-cycle + hardening tests.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  mkdtempSync, rmSync, readFileSync, existsSync, mkdirSync, writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { LEARNING_SCHEMA_VERSION } from '../learning/contracts.js';
import { generateCandidates } from '../learning/candidate-generator.js';
import { decideNextAction, rankCandidates } from '../learning/nba-engine.js';
import { applyReviewPolicy } from '../learning/review-policy.js';
import type { LearningRequest } from '../learning/contracts.js';
import {
  LearningRequestParseError,
  processLearningRequest,
  readLearningRequest,
  resetLearningRequestSeenForTests,
} from '../learning/request-port.js';
import { readLedgerEntries } from '../evidence/ledger.js';
import { readSpendReceipts } from '../atlas/spend-tracker.js';
import { readGraph } from '../exec-graph/ledger.js';

const NOW = '2026-07-25T12:00:00.000Z';

function decideReq(partial: Partial<LearningRequest> = {}): LearningRequest {
  return {
    schemaVersion: LEARNING_SCHEMA_VERSION,
    requestId: partial.requestId ?? 'req_sigmoid_001',
    idempotencyKey: partial.idempotencyKey ?? 'idem_sigmoid_123',
    createdAt: partial.createdAt ?? NOW,
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
    ...partial,
  };
}

describe('learning Sprint 1 — sigmoid NBA', () => {
  const sigmoidInput = {
    learnerId: '123',
    concept: 'sigmoid',
    mastery: 0.35,
    lastAnswers: [false, true, false],
    responseTimeSec: 28,
    energy: 'medium' as const,
  };

  it('transparent scorer picks VISUAL_EXPLANATION for sigmoid fixture', async () => {
    const candidates = await generateCandidates(sigmoidInput);
    const draft = decideNextAction(sigmoidInput, candidates);
    expect(draft.action).toBe('VISUAL_EXPLANATION');
    expect(draft.difficulty).toBe('BEGINNER');
    expect(draft.reason).toBe('Повторяющаяся ошибка в понимании вероятности');
    expect(draft.decisionScore).toBe(0.78);
    expect(draft.alternatives).toEqual(['GRILL_ME', 'FLASHCARDS']);
    expect(draft.requiresHumanReview).toBe(false);
  });

  it('ranking exposes explicit factor breakdown', async () => {
    const candidates = await generateCandidates(sigmoidInput);
    const ranked = rankCandidates(sigmoidInput, candidates);
    expect(ranked[0]!.action).toBe('VISUAL_EXPLANATION');
    expect(ranked[0]!.factors.repeatedErrors).toBe(0.22);
    expect(ranked[0]!.factors.mathVisualConcept).toBe(0.12);
  });

  it('review policy escalates low decisionScore', () => {
    const decision = applyReviewPolicy(
      {
        action: 'TEXT_EXPLANATION',
        difficulty: 'BEGINNER',
        reason: 'test',
        decisionScore: 0.4,
        alternatives: [],
        requiresHumanReview: false,
      },
      sigmoidInput,
    );
    expect(decision.requiresHumanReview).toBe(true);
  });

  it('LLM hint path does not change final score (deterministic scorer wins)', async () => {
    const withLlm = await generateCandidates(sigmoidInput, {
      llmSuggest: async () => ({ actions: ['GRILL_ME'], hint: 'try grill' }),
    });
    const draft = decideNextAction(sigmoidInput, withLlm);
    expect(draft.action).toBe('VISUAL_EXPLANATION');
  });
});

describe('learning Sprint 1 — hardening', () => {
  let exchangeDir: string;
  let evidenceDir: string;
  let execGraphDir: string;
  let spendReceiptDir: string;

  beforeEach(() => {
    exchangeDir = mkdtempSync(join(tmpdir(), 'atlas-learning-xchg-'));
    evidenceDir = mkdtempSync(join(tmpdir(), 'atlas-learning-ev-'));
    execGraphDir = mkdtempSync(join(tmpdir(), 'atlas-learning-graph-'));
    spendReceiptDir = mkdtempSync(join(tmpdir(), 'atlas-learning-spend-'));
    process.env.ATLAS_LEARNING_EXCHANGE_DIR = exchangeDir;
    process.env.ATLAS_EVIDENCE_DIR = evidenceDir;
    process.env.ATLAS_EXEC_GRAPH_DIR = execGraphDir;
    process.env.ATLAS_SPEND_RECEIPT_DIR = spendReceiptDir;
    process.env.SUPABASE_URL = '';
    process.env.SUPABASE_SERVICE_ROLE_KEY = '';
    delete process.env.ATLAS_READONLY;
    resetLearningRequestSeenForTests();
  });

  afterEach(() => {
    delete process.env.ATLAS_LEARNING_EXCHANGE_DIR;
    delete process.env.ATLAS_EVIDENCE_DIR;
    delete process.env.ATLAS_EXEC_GRAPH_DIR;
    delete process.env.ATLAS_SPEND_RECEIPT_DIR;
    delete process.env.ATLAS_READONLY;
    rmSync(exchangeDir, { recursive: true, force: true });
    rmSync(evidenceDir, { recursive: true, force: true });
    rmSync(execGraphDir, { recursive: true, force: true });
    rmSync(spendReceiptDir, { recursive: true, force: true });
  });

  it('repeat request with same idempotencyKey does not create a second decision', async () => {
    const first = await processLearningRequest(decideReq(), { exchangeDir });
    expect(first.status).toBe('completed');
    expect(first.decisionId).toMatch(/^dec_/);

    resetLearningRequestSeenForTests();
    const retry = await processLearningRequest(
      decideReq({ requestId: 'req_sigmoid_retry_002' }),
      { exchangeDir },
    );

    expect(retry.status).toBe('completed');
    expect(retry.decisionId).toBe(first.decisionId);
    expect(retry.goalId).toBe(first.goalId);
    expect(retry.decision?.action).toBe('VISUAL_EXPLANATION');

    const ledger = readLedgerEntries(evidenceDir);
    expect(ledger.length).toBe(1);
    expect(Object.keys(readGraph().goals).length).toBe(1);
  });

  it('invalid JSON returns a readable validation error', () => {
    mkdirSync(join(exchangeDir, 'requests'), { recursive: true });
    const badPath = join(exchangeDir, 'requests', 'bad.json');
    writeFileSync(badPath, '{ not-json');

    expect(() => readLearningRequest(badPath)).toThrow(LearningRequestParseError);
    try {
      readLearningRequest(badPath);
    } catch (err) {
      expect(err).toBeInstanceOf(LearningRequestParseError);
      const e = err as LearningRequestParseError;
      expect(e.message).toMatch(/not valid JSON/i);
      expect(e.details).toBeTruthy();
    }

    writeFileSync(badPath, JSON.stringify({ kind: 'decide', payload: {} }));
    try {
      readLearningRequest(badPath);
    } catch (err) {
      expect(err).toBeInstanceOf(LearningRequestParseError);
      const e = err as LearningRequestParseError;
      expect(e.message).toMatch(/validation failed/i);
      expect(e.details).toMatch(/schemaVersion|requestId|idempotencyKey|createdAt/);
    }
  });

  it('crash before receipt write → safe retry produces one decision', async () => {
    const { createGoal } = await import('../exec-graph/api.js');
    const goalSpy = vi.spyOn(await import('../exec-graph/api.js'), 'createGoal')
      .mockImplementationOnce(() => {
        throw new Error('simulated Atlas crash mid-decide');
      })
      .mockImplementation((...args) => createGoal(...args));

    const crashed = await processLearningRequest(
      decideReq({ requestId: 'req_crash_001' }),
      { exchangeDir },
    );
    expect(crashed.status).toBe('failed');
    expect(crashed.error).toMatch(/simulated Atlas crash/);

    goalSpy.mockRestore();
    resetLearningRequestSeenForTests();

    expect(existsSync(join(exchangeDir, 'receipts', 'idem_sigmoid_123.json'))).toBe(false);

    const recovered = await processLearningRequest(
      decideReq({ requestId: 'req_crash_002' }),
      { exchangeDir },
    );
    expect(recovered.status).toBe('completed');
    expect(recovered.decisionId).toMatch(/^dec_/);
    expect(readLedgerEntries(evidenceDir).length).toBe(1);
    expect(Object.keys(readGraph().goals).length).toBe(1);
  });
});

describe('learning Sprint 1 — full cycle port', () => {
  let exchangeDir: string;
  let evidenceDir: string;
  let execGraphDir: string;
  let spendReceiptDir: string;

  beforeEach(() => {
    exchangeDir = mkdtempSync(join(tmpdir(), 'atlas-learning-xchg-'));
    evidenceDir = mkdtempSync(join(tmpdir(), 'atlas-learning-ev-'));
    execGraphDir = mkdtempSync(join(tmpdir(), 'atlas-learning-graph-'));
    spendReceiptDir = mkdtempSync(join(tmpdir(), 'atlas-learning-spend-'));
    process.env.ATLAS_LEARNING_EXCHANGE_DIR = exchangeDir;
    process.env.ATLAS_EVIDENCE_DIR = evidenceDir;
    process.env.ATLAS_EXEC_GRAPH_DIR = execGraphDir;
    process.env.ATLAS_SPEND_RECEIPT_DIR = spendReceiptDir;
    process.env.SUPABASE_URL = '';
    process.env.SUPABASE_SERVICE_ROLE_KEY = '';
    delete process.env.ATLAS_READONLY;
    resetLearningRequestSeenForTests();
  });

  afterEach(() => {
    delete process.env.ATLAS_LEARNING_EXCHANGE_DIR;
    delete process.env.ATLAS_EVIDENCE_DIR;
    delete process.env.ATLAS_EXEC_GRAPH_DIR;
    delete process.env.ATLAS_SPEND_RECEIPT_DIR;
    delete process.env.ATLAS_READONLY;
    rmSync(exchangeDir, { recursive: true, force: true });
    rmSync(evidenceDir, { recursive: true, force: true });
    rmSync(execGraphDir, { recursive: true, force: true });
    rmSync(spendReceiptDir, { recursive: true, force: true });
  });

  it('decide → exec-graph goal + evidence + spend receipt + decision receipt', async () => {
    const receipt = await processLearningRequest(decideReq(), { exchangeDir });
    expect(receipt.status).toBe('completed');
    expect(receipt.decision?.action).toBe('VISUAL_EXPLANATION');
    expect(receipt.decision?.decisionScore).toBe(0.78);
    expect(receipt.decisionId).toMatch(/^dec_/);
    expect(receipt.goalId).toMatch(/^gol_/);
    expect(receipt.evidenceClaimId).toMatch(/^clm_/);
    expect(receipt.schemaVersion).toBe('1.0');

    const file = JSON.parse(
      readFileSync(join(exchangeDir, 'receipts', 'idem_sigmoid_123.json'), 'utf8'),
    );
    expect(file.decision.decisionScore).toBe(0.78);

    const ledger = readLedgerEntries(evidenceDir);
    expect(ledger.length).toBe(1);
    expect(JSON.parse(ledger[0]!.claim.claim).kind).toBe('learning-nba-decision');

    expect(Object.keys(readGraph().goals).length).toBe(1);

    const spend = readSpendReceipts().filter((r) => r.caller === 'learning-nba');
    expect(spend.some((r) => r.correlationId === receipt.spendCorrelationId)).toBe(true);
  });

  it('outcome round-trip after decide', async () => {
    await processLearningRequest(decideReq(), { exchangeDir });
    resetLearningRequestSeenForTests();

    const outcomeReceipt = await processLearningRequest({
      schemaVersion: LEARNING_SCHEMA_VERSION,
      requestId: 'req_outcome_001',
      idempotencyKey: 'idem_outcome_001',
      createdAt: NOW,
      issuedBy: 'volaura',
      kind: 'outcome',
      payload: {
        learnerId: '123',
        concept: 'sigmoid',
        decisionCorrelationId: 'idem_sigmoid_123',
        completed: true,
        correct: true,
        responseTimeSec: 15,
        selfReportedConfidence: 0.7,
      },
    }, { exchangeDir });
    expect(outcomeReceipt.status).toBe('completed');
    expect(outcomeReceipt.evidenceClaimId).toMatch(/^clm_/);

    const ledger = readLedgerEntries(evidenceDir);
    expect(ledger.length).toBe(2);
    expect(JSON.parse(ledger[1]!.claim.claim).kind).toBe('learning-outcome');
  });

  it('ATLAS_READONLY → readonly', async () => {
    process.env.ATLAS_READONLY = '1';
    const receipt = await processLearningRequest(decideReq(), { exchangeDir });
    expect(receipt.status).toBe('readonly');
  });

  it('file exchange: request JSON on disk → receipt JSON only artifact', async () => {
    mkdirSync(join(exchangeDir, 'requests'), { recursive: true });
    writeFileSync(
      join(exchangeDir, 'requests', 'req_file_001.json'),
      JSON.stringify(decideReq({ requestId: 'req_file_001' })),
    );
    const { listPendingLearningRequests } = await import('../learning/request-port.js');
    const paths = listPendingLearningRequests(exchangeDir);
    expect(paths.length).toBe(1);
    const req = readLearningRequest(paths[0]!);
    const receipt = await processLearningRequest(req, { exchangeDir });
    expect(receipt.status).toBe('completed');
    expect(existsSync(join(exchangeDir, 'receipts', 'idem_sigmoid_123.json'))).toBe(true);
    expect(existsSync(join(exchangeDir, 'graph.json'))).toBe(false);
  });
});
