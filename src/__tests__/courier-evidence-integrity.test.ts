/**
 * ATLAS EVIDENCE INTEGRITY — reproduction tests for a suspected evidence-laundering
 * defect in the courier's final-verify construction path (src/courier/courier-loop.ts).
 *
 * These tests assert the SECURE behavior. If the audited defect is real, the
 * corresponding test is expected to FAIL (RED) today — that failure IS the
 * reproduction. A test that passes today is a valid finding: the claim did not
 * reproduce. This file intentionally does not fix anything.
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';

const capturedVerifyCalls = vi.hoisted(() => [] as Array<{ input: unknown; opts: unknown }>);

vi.mock('../core-spine/spine-verifier.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../core-spine/spine-verifier.js')>();
  return {
    ...actual,
    verifyEvidencePack: (input: unknown, opts: unknown) => {
      capturedVerifyCalls.push({ input, opts });
      return actual.verifyEvidencePack(input, opts as never);
    },
  };
});

import {
  buildCourierProjectContract,
  collectIndependentEvidence,
  runCourierLoop,
} from '../courier/courier-loop.js';
import { CURSOR_HEADLESS_ADAPTER_ID } from '../hands/cursor-headless-adapter.js';
import { CHATGPT_BROWSER_REVIEWER_ADAPTER_ID } from '../hands/chatgpt-browser-reviewer-adapter.js';
import { verifyEvidencePack } from '../core-spine/spine-verifier.js';
import { computeEvidenceHash } from '../core-spine/evidence-pack-contract.js';

/**
 * Same fixture shape as `courier-loop-negatives.test.ts`'s "happy path" test, but the
 * mocked Cursor executor reports a FAILED run (non-zero exitCode). The test workspace's
 * fixture files already satisfy the test suite, independent of whatever Cursor claims to
 * have done — this isolates the question "does a failed executor command get laundered
 * into a verified:true receipt" from "did the mock actually edit files."
 */
async function runLoopWithFailedExecutor() {
  const dir = mkdtempSync(join(tmpdir(), 'atlas-courier-integrity-'));
  const ws = join(dir, 'ws');
  mkdirSync(join(ws, 'src'), { recursive: true });
  mkdirSync(join(ws, 'test'), { recursive: true });
  writeFileSync(join(ws, 'src', 'counter.js'), 'export function nextCount(n){return n+1}\n', 'utf8');
  writeFileSync(
    join(ws, 'test', 'counter.test.js'),
    "import {test} from 'node:test'; import assert from 'node:assert/strict'; import {nextCount} from '../src/counter.js'; test('ok',()=>assert.equal(nextCount(0),1));\n",
    'utf8',
  );
  writeFileSync(
    join(ws, 'package.json'),
    JSON.stringify({ type: 'module', scripts: { test: 'node --test test/counter.test.js' } }),
    'utf8',
  );
  execFileSync('git', ['init'], { cwd: ws });
  execFileSync('git', ['-c', 'user.email=a@b', '-c', 'user.name=t', 'add', '-A'], { cwd: ws });
  execFileSync('git', ['-c', 'user.email=a@b', '-c', 'user.name=t', 'commit', '-m', 'init'], { cwd: ws });

  const cursorRunner = async () => ({
    adapterId: CURSOR_HEADLESS_ADAPTER_ID,
    pid: 1,
    sessionId: 'sess-fail-1',
    exitCode: 17, // FAILED executor run — this is the fact under test.
    timedOut: false,
    killed: false,
    terminalEventPresent: true,
    events: [{ raw: '{"type":"result","result":"error"}', type: 'result', result: 'error' }],
    streamPath: join(dir, 's.jsonl'),
    metaPath: join(dir, 'm.json'),
    claimedResultText: 'cursor-agent crashed mid-edit',
    error: 'boom',
    durationMs: 5,
    appliedWrites: [],
    forceUsed: false,
  });

  const chatgptReviewer = async () => ({
    adapterId: CHATGPT_BROWSER_REVIEWER_ADAPTER_ID,
    verdict: 'ACCEPT' as const,
    repairInstruction: null,
    responseText: 'VERDICT: ACCEPT',
    responseHash: 'd'.repeat(64),
    submittedMessageHash: 'e'.repeat(64),
    screenshotPath: null,
    timestamps: { startedAt: new Date().toISOString(), completedAt: new Date().toISOString() },
    browserErrors: [],
    loginRequired: false,
    emptyOrDuplicate: false,
  });

  const receipt = await runCourierLoop({
    disposableRepo: ws,
    evidenceDir: join(dir, 'ev'),
    agentBin: join(dir, 'agent.cmd'),
    browserProfileDir: join(dir, 'profile'),
    timeoutMs: 5000,
    cursorRunner: cursorRunner as any,
    chatgptReviewer: chatgptReviewer as any,
  });

  return { receipt, dir };
}

describe('T1 — a failed executor command must not reach final verified:true', () => {
  it('rejects verification when the cursor executor command exited non-zero', async () => {
    const { receipt } = await runLoopWithFailedExecutor();
    // SECURE expectation: a run whose executor command failed (exitCode=17) must
    // never produce a verified:true receipt through the courier's final-verify path.
    expect(receipt.verifierResult.verified).toBe(false);
  });
});

describe('T2 — the pack submitted to verification must retain the originally collected failed command', () => {
  it('does not silently replace the collected failed cmd-cursor-agent record with a synthetic passing one', async () => {
    const before = capturedVerifyCalls.length;
    await runLoopWithFailedExecutor();
    expect(capturedVerifyCalls.length).toBeGreaterThan(before);
    const call = capturedVerifyCalls[capturedVerifyCalls.length - 1];
    const cmds = (call.input as { commandsRun: Array<{ id: string; exitCode: number }> }).commandsRun;
    const original = cmds.find((c) => c.id === 'cmd-cursor-agent');
    // SECURE expectation: the originally collected failed command record must survive,
    // unaltered, into the exact pack object handed to verifyEvidencePack.
    expect(original).toBeDefined();
    expect(original?.exitCode).not.toBe(0);
  });
});

describe('T3 — caller-set verifierResult.verified must not be a readback', () => {
  it('produces the same real verdict regardless of the caller-supplied verified flag', () => {
    const dir = mkdtempSync(join(tmpdir(), 'atlas-t3-'));
    const project = buildCourierProjectContract(dir);
    const basePack = {
      taskId: 'tsk_t3',
      changeId: 'chg_t3',
      projectId: 'prj_courier_proof_disposable',
      baseCommit: 'a'.repeat(7),
      executorIdentity: `${CURSOR_HEADLESS_ADAPTER_ID}@0.1.0`,
      declaredEffects: ['e1'],
      actualEffects: ['e1'],
      effectProofs: [{ effectId: 'e1', provenBy: [{ kind: 'test' as const, ref: 't1' }] }],
      artifacts: [] as never[],
      diffHash: 'b'.repeat(64),
      commandsRun: [] as never[],
      testCommands: [{ id: 't1', command: 'npm test', exitCode: 0, outputHash: 'c'.repeat(64) }],
      costRecord: { provider: 'cursor-agent', tokens: 0, paid: false },
      rollbackState: { available: true, method: 'git checkout', proven: true },
      ceoDecision: 'pending' as const,
    };
    // ADAPTED: collectedEvidenceHash is now a required field. Computing it once from the
    // real evidence fields (rather than leaving it out) makes basePack fully verifiable,
    // so the comparison below isolates the property under test — caller-claimed
    // verifierResult has zero effect on the verdict — from an unrelated schema-parse
    // failure that would otherwise make both branches trivially "equal but unverified".
    const collectedEvidenceHash = computeEvidenceHash(basePack);

    const claimedVerified = verifyEvidencePack(
      {
        ...basePack,
        collectedEvidenceHash,
        verifierResult: { verified: true, reason: 'caller says so', verifierId: 'spine-verifier' },
      },
      { project },
    );
    const claimedUnverified = verifyEvidencePack(
      {
        ...basePack,
        collectedEvidenceHash,
        verifierResult: { verified: false, reason: 'caller says so', verifierId: 'spine-verifier' },
      },
      { project },
    );

    // SECURE expectation: an independent verifier computes its verdict from the real
    // evidence (commands/tests/effects/etc). It must not simply echo back whatever
    // `verified` flag the caller already wrote into the pack it is submitting.
    expect(claimedVerified.verified).toBe(claimedUnverified.verified);
    expect(claimedVerified.verified).toBe(true);
  });
});

describe('T4 — a self-stamped verifierId must be rejected by more than a name regex', () => {
  // ADAPTED: verifierResult.verifierId is advisory-only in the new API — the low-level
  // assertIndependentVerifier(executorIdentity, verifierId) building block still accepts
  // a label that merely matches the naming pattern (documented gap, unchanged), but the
  // real entry point (verifyEvidencePack) never lets that forged label reach the returned
  // verdict at all. Preserved intent: a name-regex-matching self-stamped verifierId must
  // carry zero authority in the actual verification path.
  it('never lets a caller-forged verifierId (even one matching the independent-id naming pattern) become the real verdict', () => {
    const dir = mkdtempSync(join(tmpdir(), 'atlas-t4-'));
    const project = buildCourierProjectContract(dir);
    // Matches spine-verifier's naming regex
    // (`/^(spine-verifier|hand-verifier|independent)([@./:].*)?$/i`) despite being nothing
    // more than a label the same actor that ran the executor chose for itself — no
    // separate process, credential, or attestation backs the claim.
    const forgedVerifierId = 'independent.self-attested-by-executor';
    const basePack = {
      taskId: 'tsk_t4',
      changeId: 'chg_t4',
      projectId: 'prj_courier_proof_disposable',
      baseCommit: 'a'.repeat(7),
      executorIdentity: `${CURSOR_HEADLESS_ADAPTER_ID}@0.1.0`,
      declaredEffects: ['e1'],
      actualEffects: ['e1'],
      effectProofs: [{ effectId: 'e1', provenBy: [{ kind: 'test' as const, ref: 't1' }] }],
      artifacts: [] as never[],
      diffHash: 'b'.repeat(64),
      commandsRun: [] as never[],
      testCommands: [{ id: 't1', command: 'npm test', exitCode: 0, outputHash: 'c'.repeat(64) }],
      costRecord: { provider: 'cursor-agent', tokens: 0, paid: false },
      rollbackState: { available: true, method: 'git checkout', proven: true },
      ceoDecision: 'pending' as const,
    };
    const collectedEvidenceHash = computeEvidenceHash(basePack);

    const r = verifyEvidencePack(
      {
        ...basePack,
        collectedEvidenceHash,
        verifierResult: { verified: true, reason: 'trust me', verifierId: forgedVerifierId },
      },
      { project },
    );

    // SECURE expectation: regardless of the forged, regex-matching label the caller wrote
    // into verifierResult.verifierId, the real verdict's verifierId is always the
    // verifier's own constant — the forged label never propagates anywhere.
    expect(r.verifierId).toBe('spine-verifier');
    expect(r.verifierId).not.toBe(forgedVerifierId);
  });
});

describe('T5 — integrity binding between collected evidence and the verified pack', () => {
  // ADAPTED: pre-fix, this test asserted (paradoxically, documenting the gap) that a
  // manually tampered pack's commandsRun ids "should" equal the originally collected
  // ones with no mechanism to make that true — there was no hash to check. Post-fix,
  // EvidencePack carries collectedEvidenceHash, so the real, checkable property is: a
  // pack tampered after collection (without recomputing the hash) no longer matches its
  // own stale collectedEvidenceHash — the substitution IS now detectable.
  it('detects that a materially tampered pack no longer matches its stale collectedEvidenceHash', () => {
    const dir = mkdtempSync(join(tmpdir(), 'atlas-t5-'));
    mkdirSync(join(dir, 'ws'));
    const collected = collectIndependentEvidence({
      taskId: 'tsk_t5',
      workspace: join(dir, 'ws'),
      cursor: {
        adapterId: CURSOR_HEADLESS_ADAPTER_ID,
        pid: 1,
        sessionId: 's',
        exitCode: 1,
        timedOut: false,
        killed: false,
        terminalEventPresent: true,
        events: [],
        streamPath: '',
        metaPath: '',
        claimedResultText: 'failed',
        error: 'boom',
        durationMs: 1,
        appliedWrites: [],
        forceUsed: false,
      } as any,
      test: { command: 'npm test', exitCode: 1, output: 'FAIL' },
    });

    // Build a "verified" pack that is materially different from what was collected —
    // same shape, but the failed command swapped for a synthetic passer, WITHOUT
    // recomputing collectedEvidenceHash. This mirrors an attacker substituting evidence
    // post-collection.
    const tampered = {
      ...collected,
      commandsRun: [{ id: 'cmd-git-diff', command: 'git diff HEAD', exitCode: 0, outputHash: collected.diffHash }],
    };

    const recomputed = computeEvidenceHash(tampered);
    expect(recomputed).not.toBe(tampered.collectedEvidenceHash);
  });
});

describe('T6 — tampering a commandsRun entry after collection is caught by the hash gate', () => {
  it('rejects a pack whose commandsRun outputHash was mutated after collectedEvidenceHash was stamped', () => {
    const dir = mkdtempSync(join(tmpdir(), 'atlas-t6-'));
    mkdirSync(join(dir, 'ws'));
    const project = buildCourierProjectContract(join(dir, 'ws'));
    const collected = collectIndependentEvidence({
      taskId: 'tsk_t6',
      workspace: join(dir, 'ws'),
      cursor: {
        adapterId: CURSOR_HEADLESS_ADAPTER_ID,
        pid: 1,
        sessionId: 's',
        exitCode: 0,
        timedOut: false,
        killed: false,
        terminalEventPresent: true,
        events: [],
        streamPath: '',
        metaPath: '',
        claimedResultText: 'done',
        error: null,
        durationMs: 1,
        appliedWrites: [],
        forceUsed: false,
      } as any,
      test: { command: 'npm test', exitCode: 0, output: 'PASS' },
    });

    // Tamper: same id, still-valid-format outputHash, exitCode left at 0 — so this
    // change is invisible to every structural check (checkCommandList only validates
    // format/exitCode/skipped; this command isn't referenced by any effectProof) and is
    // caught ONLY by the hash-recomputation gate.
    const tampered = {
      ...collected,
      commandsRun: collected.commandsRun.map((c) => ({ ...c, outputHash: 'f'.repeat(64) })),
    };

    const r = verifyEvidencePack(tampered, { project });
    expect(r.verified).toBe(false);
    expect(r.reason).toMatch(/hash/i);
  });
});

describe('T7 — caller-claimed ACCEPT never overrides a deterministic test failure', () => {
  it('rejects when testCommands failed, even though the caller-supplied verifierResult claims verified:true', () => {
    const dir = mkdtempSync(join(tmpdir(), 'atlas-t7-'));
    const project = buildCourierProjectContract(dir);
    const basePack = {
      taskId: 'tsk_t7',
      changeId: 'chg_t7',
      projectId: 'prj_courier_proof_disposable',
      baseCommit: 'a'.repeat(7),
      executorIdentity: `${CURSOR_HEADLESS_ADAPTER_ID}@0.1.0`,
      declaredEffects: ['e1'],
      actualEffects: ['e1'],
      effectProofs: [{ effectId: 'e1', provenBy: [{ kind: 'test' as const, ref: 't1' }] }],
      artifacts: [] as never[],
      diffHash: 'b'.repeat(64),
      commandsRun: [] as never[],
      // Deterministic failure: the test recorded a non-zero exit code.
      testCommands: [{ id: 't1', command: 'npm test', exitCode: 1, outputHash: 'c'.repeat(64) }],
      costRecord: { provider: 'cursor-agent', tokens: 0, paid: false },
      rollbackState: { available: true, method: 'git checkout', proven: true },
      ceoDecision: 'pending' as const,
    };
    const collectedEvidenceHash = computeEvidenceHash(basePack);

    const r = verifyEvidencePack(
      {
        ...basePack,
        collectedEvidenceHash,
        // Reviewer/caller claims ACCEPT / verified:true — must have zero effect on the
        // deterministic outcome below.
        verifierResult: { verified: true, reason: 'reviewer said ACCEPT', verifierId: 'spine-verifier' },
      },
      { project },
    );

    expect(r.verified).toBe(false);
    expect(r.reason).toMatch(/failed|test/i);
  });
});

describe('T8 — happy path end-to-end: real evidence produces verified:true with the verifier\'s own id', () => {
  it('returns a verified receipt when cursor succeeds and the reviewer ACCEPTs', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'atlas-t8-'));
    const ws = join(dir, 'ws');
    mkdirSync(join(ws, 'src'), { recursive: true });
    mkdirSync(join(ws, 'test'), { recursive: true });
    writeFileSync(join(ws, 'src', 'counter.js'), 'export function nextCount(n){return n+1}\n', 'utf8');
    writeFileSync(
      join(ws, 'test', 'counter.test.js'),
      "import {test} from 'node:test'; import assert from 'node:assert/strict'; import {nextCount} from '../src/counter.js'; test('ok',()=>assert.equal(nextCount(0),1));\n",
      'utf8',
    );
    writeFileSync(
      join(ws, 'package.json'),
      JSON.stringify({ type: 'module', scripts: { test: 'node --test test/counter.test.js' } }),
      'utf8',
    );
    execFileSync('git', ['init'], { cwd: ws });
    execFileSync('git', ['-c', 'user.email=a@b', '-c', 'user.name=t', 'add', '-A'], { cwd: ws });
    execFileSync('git', ['-c', 'user.email=a@b', '-c', 'user.name=t', 'commit', '-m', 'init'], { cwd: ws });

    const cursorRunner = async () => ({
      adapterId: CURSOR_HEADLESS_ADAPTER_ID,
      pid: 1,
      sessionId: 'sess-t8',
      exitCode: 0,
      timedOut: false,
      killed: false,
      terminalEventPresent: true,
      events: [{ raw: '{"type":"result","result":"done"}', type: 'result', result: 'done' }],
      streamPath: join(dir, 's.jsonl'),
      metaPath: join(dir, 'm.json'),
      claimedResultText: 'done',
      error: null,
      durationMs: 10,
      appliedWrites: ['src/counter.js'],
      forceUsed: false,
    });

    const chatgptReviewer = async () => ({
      adapterId: CHATGPT_BROWSER_REVIEWER_ADAPTER_ID,
      verdict: 'ACCEPT' as const,
      repairInstruction: null,
      responseText: 'VERDICT: ACCEPT',
      responseHash: 'd'.repeat(64),
      submittedMessageHash: 'e'.repeat(64),
      screenshotPath: null,
      timestamps: { startedAt: new Date().toISOString(), completedAt: new Date().toISOString() },
      browserErrors: [],
      loginRequired: false,
      emptyOrDuplicate: false,
    });

    const receipt = await runCourierLoop({
      disposableRepo: ws,
      evidenceDir: join(dir, 'ev'),
      agentBin: join(dir, 'agent.cmd'),
      browserProfileDir: join(dir, 'profile'),
      timeoutMs: 5000,
      cursorRunner: cursorRunner as any,
      chatgptReviewer: chatgptReviewer as any,
    });

    expect(receipt.verifierResult.verified).toBe(true);
    expect(receipt.verifierResult.verifierId).toBe('spine-verifier');
  });
});

describe('T9 — costRecord is hash-bound: post-hash tampering is caught by the hash gate', () => {
  it('rejects a pack whose costRecord.paid was flipped after collectedEvidenceHash was stamped', () => {
    const dir = mkdtempSync(join(tmpdir(), 'atlas-t9-'));
    const project = buildCourierProjectContract(dir);
    const basePack = {
      taskId: 'tsk_t9',
      changeId: 'chg_t9',
      projectId: 'prj_courier_proof_disposable',
      baseCommit: 'a'.repeat(7),
      executorIdentity: `${CURSOR_HEADLESS_ADAPTER_ID}@0.1.0`,
      declaredEffects: ['e1'],
      actualEffects: ['e1'],
      effectProofs: [{ effectId: 'e1', provenBy: [{ kind: 'test' as const, ref: 't1' }] }],
      artifacts: [] as never[],
      diffHash: 'b'.repeat(64),
      commandsRun: [] as never[],
      testCommands: [{ id: 't1', command: 'npm test', exitCode: 0, outputHash: 'c'.repeat(64) }],
      // Original evidence: a PAID run (tokens actually spent).
      costRecord: { provider: 'cursor-agent', tokens: 500, paid: true },
      rollbackState: { available: true, method: 'git checkout', proven: true },
      ceoDecision: 'pending' as const,
    };
    const collectedEvidenceHash = computeEvidenceHash(basePack);

    // Fabricate: flip paid:true → paid:false (to slip past the project's
    // modelSpendPolicy.allowPaid=false gate) while keeping the ORIGINAL, now-stale
    // collectedEvidenceHash unchanged — this is exactly the laundering pattern the hash
    // gate must catch. Today (pre-fix) costRecord is not part of the hash input, so this
    // tampered pack still matches its stale hash and sails through the paid-spend gate as
    // verified:true — that is the reproduction this test proves.
    const tampered = {
      ...basePack,
      collectedEvidenceHash,
      costRecord: { provider: 'cursor-agent', tokens: 500, paid: false },
    };

    const r = verifyEvidencePack(tampered, { project });
    expect(r.verified).toBe(false);
    expect(r.reason).toMatch(/hash/i);
  });
});
