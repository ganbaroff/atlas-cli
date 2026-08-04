/**
 * RED-only pin tests for the Courier Loop reviewer/verifier decoupling contract.
 *
 * TARGET (not yet implemented) call order:
 *   executor -> collected evidence -> hash-bound EvidencePack -> DETERMINISTIC VERIFIER
 *   -> optional advisory reviewer -> receipt
 *
 * TODAY (courier-loop.ts, as read for this task) the order is reversed: the ChatGPT
 * reviewer is invoked INSIDE runOnce() (courier-loop.ts:431) *before* any deterministic
 * verification, and verifyEvidencePack() (courier-loop.ts:538) only runs at all when
 * lastReview?.verdict === 'ACCEPT' (courier-loop.ts:529) — so a reviewer crash/timeout
 * leaves verifierResult stuck at the default {verified:false, reason:'incomplete'}
 * (courier-loop.ts:520) even when the collected evidence is deterministically valid.
 * That is the live bug this file pins down (proven: Playwright viewport error ->
 * verifierResult {verified:false, reason:'incomplete'}).
 *
 * PROPOSED RECEIPT CONTRACT — fields the repair worker is expected to add to
 * CourierReceipt. NOT implemented yet; every test below accesses at least one of these
 * and therefore fails today. Field names per the mission brief, plus one addition
 * (evidencePack) needed to make R7 a real (non-vacuous) falsifier:
 *   - deterministicVerdict: { verified: boolean; reason: string; verifierId: string }
 *       The spine-verifier's own verdict, always computed BEFORE any reviewer call.
 *   - reviewerStatus: 'ADVISORY_UNAVAILABLE' | 'MALFORMED_REVIEW' | ... (repair worker's
 *       choice for the remaining enum members) — records what happened to the advisory
 *       reviewer without ever gating the verdict.
 *   - reviewerAdvice: string | null — human-readable advisory note, never authoritative.
 *   - finalStatus: 'VERIFIED_WITHOUT_ADVISORY_REVIEW' | 'VERIFIED_WITH_ADVISORY_REPAIR_APPLIED'
 *       | 'REJECT' | ... — the single authoritative outcome, derived ONLY from
 *       deterministicVerdict (+ bounded repair re-verification), never from reviewer verdict.
 *   - repairsApplied: number — count of bounded repair iterations actually re-executed
 *       (cap: 1, i.e. at most one extra executor pass beyond the first).
 *   - evidencePack: EvidencePack — the exact frozen pack the deterministic verifier ran
 *       against, exposed so R7 can prove a review round never mutates or rehashes
 *       collected evidence (courier-loop.ts already deepFreezes this pack at collection
 *       time via deepFreezeEvidencePack — R7 asserts that guarantee survives to the
 *       receipt, which requires the pack to actually be exposed there).
 *
 * Mocking idiom reused from courier-loop-negatives.test.ts's "happy path with one
 * repair" test at the bottom of that file: cursorRunner/chatgptReviewer are injected via
 * CourierLoopConfig seams (not vi.mock'd modules), wrapped here in vi.fn() so call
 * counts/order can be asserted. The one thing NOT reachable via config injection is the
 * deterministic verifier (verifyEvidencePack is imported directly inside
 * courier-loop.ts, not a config seam) — that one IS vi.mock'd below, delegating to the
 * real implementation, purely so R8 can capture its invocationCallOrder relative to the
 * reviewer mock.
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { runCourierLoop, type CourierLoopConfig } from '../courier/courier-loop.js';
import { computeEvidenceHash } from '../core-spine/evidence-pack-contract.js';
import { CURSOR_HEADLESS_ADAPTER_ID } from '../hands/cursor-headless-adapter.js';
import { CHATGPT_BROWSER_REVIEWER_ADAPTER_ID } from '../hands/chatgpt-browser-reviewer-adapter.js';
import * as spineVerifier from '../core-spine/spine-verifier.js';

vi.mock('../core-spine/spine-verifier.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../core-spine/spine-verifier.js')>();
  return { ...actual, verifyEvidencePack: vi.fn(actual.verifyEvidencePack) };
});

function makeGoodWorkspace(dir: string): string {
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
  return ws;
}

/** Workspace whose npm test script deterministically fails — for R3 (deterministic REJECT). */
function makeFailingTestWorkspace(dir: string): string {
  const ws = join(dir, 'ws');
  mkdirSync(join(ws, 'src'), { recursive: true });
  writeFileSync(join(ws, 'src', 'counter.js'), 'export function nextCount(n){return n+1}\n', 'utf8');
  writeFileSync(
    join(ws, 'package.json'),
    JSON.stringify({ type: 'module', scripts: { test: 'node -e "process.exit(1)"' } }),
    'utf8',
  );
  execFileSync('git', ['init'], { cwd: ws });
  execFileSync('git', ['-c', 'user.email=a@b', '-c', 'user.name=t', 'add', '-A'], { cwd: ws });
  execFileSync('git', ['-c', 'user.email=a@b', '-c', 'user.name=t', 'commit', '-m', 'init'], { cwd: ws });
  return ws;
}

function goodCursorRunner() {
  return vi.fn(async () => ({
    adapterId: CURSOR_HEADLESS_ADAPTER_ID,
    pid: 1,
    sessionId: 'sess-1',
    exitCode: 0,
    timedOut: false,
    killed: false,
    terminalEventPresent: true,
    events: [{ raw: '{"type":"result","result":"done"}', type: 'result', result: 'done' }],
    streamPath: join(tmpdir(), 's.jsonl'),
    metaPath: join(tmpdir(), 'm.json'),
    claimedResultText: 'done',
    error: null,
    durationMs: 10,
    appliedWrites: ['src/counter.js'],
    forceUsed: false,
  }));
}

/** Executor evidence that is itself incomplete/failed — for R6 (attributable to executor). */
function failingCursorRunner() {
  return vi.fn(async () => ({
    adapterId: CURSOR_HEADLESS_ADAPTER_ID,
    pid: 1,
    sessionId: 'sess-1',
    exitCode: 1,
    timedOut: false,
    killed: false,
    terminalEventPresent: false,
    events: [],
    streamPath: join(tmpdir(), 's.jsonl'),
    metaPath: join(tmpdir(), 'm.json'),
    claimedResultText: '',
    error: 'executor crashed',
    durationMs: 10,
    appliedWrites: [],
    forceUsed: false,
  }));
}

function acceptReview() {
  return {
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
  };
}

function repairReview(instruction = 'Tighten bound in src/counter.js') {
  return {
    adapterId: CHATGPT_BROWSER_REVIEWER_ADAPTER_ID,
    verdict: 'REPAIR' as const,
    repairInstruction: instruction,
    responseText: `VERDICT: REPAIR\nREPAIR_INSTRUCTION: ${instruction}`,
    responseHash: 'b'.repeat(64),
    submittedMessageHash: 'c'.repeat(64),
    screenshotPath: null,
    timestamps: { startedAt: new Date().toISOString(), completedAt: new Date().toISOString() },
    browserErrors: [],
    loginRequired: false,
    emptyOrDuplicate: false,
  };
}

function rejectReview() {
  return {
    adapterId: CHATGPT_BROWSER_REVIEWER_ADAPTER_ID,
    verdict: 'REJECT' as const,
    repairInstruction: null,
    responseText: 'VERDICT: REJECT',
    responseHash: 'a'.repeat(64),
    submittedMessageHash: '2'.repeat(64),
    screenshotPath: null,
    timestamps: { startedAt: new Date().toISOString(), completedAt: new Date().toISOString() },
    browserErrors: [],
    loginRequired: false,
    emptyOrDuplicate: false,
  };
}

/** Malformed reviewer response — parses to a null verdict (no VERDICT: line matched). */
function malformedReview() {
  return {
    adapterId: CHATGPT_BROWSER_REVIEWER_ADAPTER_ID,
    verdict: null,
    repairInstruction: null,
    responseText: 'Sure, this looks fine to me!',
    responseHash: 'f'.repeat(64),
    submittedMessageHash: '1'.repeat(64),
    screenshotPath: null,
    timestamps: { startedAt: new Date().toISOString(), completedAt: new Date().toISOString() },
    browserErrors: [],
    loginRequired: false,
    emptyOrDuplicate: false,
  };
}

function baseConfig(dir: string, ws: string, extra: Partial<CourierLoopConfig> = {}): CourierLoopConfig {
  return {
    disposableRepo: ws,
    evidenceDir: join(dir, 'ev'),
    agentBin: join(dir, 'agent.cmd'),
    browserProfileDir: join(dir, 'profile'),
    timeoutMs: 5000,
    ...extra,
  } as CourierLoopConfig;
}

describe('courier reviewer/verifier decoupling — RED (target contract not yet implemented)', () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it('R1: reviewer browser crash -> deterministic verified true, reviewerStatus ADVISORY_UNAVAILABLE, finalStatus VERIFIED_WITHOUT_ADVISORY_REVIEW', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'atlas-courier-r1-'));
    const ws = makeGoodWorkspace(dir);
    const cursorRunner = goodCursorRunner();
    const chatgptReviewer = vi.fn(async () => {
      throw new Error('playwright viewport crash: Target page, context or browser has been closed');
    });

    const receipt = (await runCourierLoop(
      baseConfig(dir, ws, { cursorRunner: cursorRunner as any, chatgptReviewer: chatgptReviewer as any }),
    )) as any;

    expect(receipt.deterministicVerdict).toBeTruthy();
    expect(receipt.deterministicVerdict?.verified).toBe(true);
    expect(receipt.reviewerStatus).toBe('ADVISORY_UNAVAILABLE');
    expect(receipt.finalStatus).toBe('VERIFIED_WITHOUT_ADVISORY_REVIEW');
  });

  it('R2: malformed reviewer response -> deterministic verified true, reviewerStatus MALFORMED_REVIEW, finalStatus VERIFIED_WITHOUT_ADVISORY_REVIEW', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'atlas-courier-r2-'));
    const ws = makeGoodWorkspace(dir);
    const cursorRunner = goodCursorRunner();
    const chatgptReviewer = vi.fn(async () => malformedReview());

    const receipt = (await runCourierLoop(
      baseConfig(dir, ws, { cursorRunner: cursorRunner as any, chatgptReviewer: chatgptReviewer as any }),
    )) as any;

    expect(receipt.deterministicVerdict).toBeTruthy();
    expect(receipt.deterministicVerdict?.verified).toBe(true);
    expect(receipt.reviewerStatus).toBe('MALFORMED_REVIEW');
    expect(receipt.finalStatus).toBe('VERIFIED_WITHOUT_ADVISORY_REVIEW');
  });

  it('R3: deterministic REJECT overrides reviewer ACCEPT -> final decision is REJECT, never authorized by the reviewer', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'atlas-courier-r3-'));
    const ws = makeFailingTestWorkspace(dir);
    const cursorRunner = goodCursorRunner();
    const chatgptReviewer = vi.fn(async () => acceptReview());

    const receipt = (await runCourierLoop(
      baseConfig(dir, ws, { cursorRunner: cursorRunner as any, chatgptReviewer: chatgptReviewer as any }),
    )) as any;

    expect(receipt.deterministicVerdict).toBeTruthy();
    expect(receipt.deterministicVerdict?.verified).toBe(false);
    expect(receipt.finalStatus).toBe('REJECT');
    // The reviewer's ACCEPT must not leak into the authoritative decision field.
    expect(receipt.finalStatus).not.toMatch(/ACCEPT/);
    expect(receipt.goRepairReject).not.toBe('GO');
  });

  it('R4: deterministic VERIFIED + reviewer REPAIR -> one bounded repair pass, then VERIFIED_WITH_ADVISORY_REPAIR_APPLIED', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'atlas-courier-r4-'));
    const ws = makeGoodWorkspace(dir);
    const cursorRunner = goodCursorRunner();
    let reviewCalls = 0;
    const chatgptReviewer = vi.fn(async () => {
      reviewCalls += 1;
      return reviewCalls === 1 ? repairReview() : acceptReview();
    });

    const receipt = (await runCourierLoop(
      baseConfig(dir, ws, { cursorRunner: cursorRunner as any, chatgptReviewer: chatgptReviewer as any }),
    )) as any;

    expect(cursorRunner).toHaveBeenCalledTimes(2);
    expect(receipt.repairsApplied).toBe(1);
    expect(receipt.finalStatus).toBe('VERIFIED_WITH_ADVISORY_REPAIR_APPLIED');
  });

  it('R5: a second repair request is refused -> capped at one repair pass, no third executor invocation', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'atlas-courier-r5-'));
    const ws = makeGoodWorkspace(dir);
    const cursorRunner = goodCursorRunner();
    const chatgptReviewer = vi.fn(async () => repairReview('keep asking for more repair'));

    const receipt = (await runCourierLoop(
      baseConfig(dir, ws, { cursorRunner: cursorRunner as any, chatgptReviewer: chatgptReviewer as any }),
    )) as any;

    expect(typeof receipt.repairsApplied).toBe('number');
    expect(receipt.repairsApplied).toBeLessThanOrEqual(1);
    expect(receipt.iterationCount).toBeLessThanOrEqual(2);
    expect(cursorRunner.mock.calls.length).toBeLessThanOrEqual(2);
  });

  it('R6: incomplete executor evidence fails the deterministic verifier, attributable to the executor not the reviewer', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'atlas-courier-r6-'));
    const ws = makeGoodWorkspace(dir);
    const cursorRunner = failingCursorRunner();
    const chatgptReviewer = vi.fn(async () => acceptReview());

    const receipt = (await runCourierLoop(
      baseConfig(dir, ws, { cursorRunner: cursorRunner as any, chatgptReviewer: chatgptReviewer as any }),
    )) as any;

    expect(receipt.deterministicVerdict).toBeTruthy();
    expect(receipt.deterministicVerdict?.verified).toBe(false);
    expect(String(receipt.deterministicVerdict?.reason ?? '')).not.toMatch(/reviewer/i);
    expect(String(receipt.deterministicVerdict?.reason ?? '')).toMatch(/command|exit|evidence/i);
    expect(receipt.finalStatus).toBe('REJECT');
  });

  it('R7: a review round cannot mutate or rehash the collected evidence pack', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'atlas-courier-r7-'));
    const ws = makeGoodWorkspace(dir);
    const cursorRunner = goodCursorRunner();
    const chatgptReviewer = vi.fn(async () => acceptReview());

    const receipt = (await runCourierLoop(
      baseConfig(dir, ws, { cursorRunner: cursorRunner as any, chatgptReviewer: chatgptReviewer as any }),
    )) as any;

    expect(receipt.evidencePack).toBeTruthy();
    const pack = receipt.evidencePack;
    expect(pack.collectedEvidenceHash).toMatch(/^[a-f0-9]{64}$/i);
    expect(Array.isArray(pack.commandsRun)).toBe(true);
    expect(pack.commandsRun.length).toBeGreaterThan(0);
    expect(computeEvidenceHash(pack)).toBe(pack.collectedEvidenceHash);
    expect(Object.isFrozen(pack.commandsRun)).toBe(true);
  });

  it('R9: deterministic verified true + reviewer REJECT (advisory) -> honest finalStatus, never claims ACCEPT', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'atlas-courier-r9-'));
    const ws = makeGoodWorkspace(dir);
    const cursorRunner = goodCursorRunner();
    const chatgptReviewer = vi.fn(async () => rejectReview());

    const receipt = (await runCourierLoop(
      baseConfig(dir, ws, { cursorRunner: cursorRunner as any, chatgptReviewer: chatgptReviewer as any }),
    )) as any;

    expect(receipt.deterministicVerdict).toBeTruthy();
    expect(receipt.deterministicVerdict?.verified).toBe(true);
    expect(receipt.reviewerStatus).toBe('ADVISORY_REJECT');
    // Deterministic authority holds (still a VERIFIED outcome), but the label must be honest:
    // the reviewer rejected, so it must never read as an "accept".
    expect(receipt.finalStatus).toMatch(/^VERIFIED/);
    expect(receipt.finalStatus).not.toMatch(/ACCEPT/);
  });

  it('R8: deterministic verification runs before any reviewer call', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'atlas-courier-r8-'));
    const ws = makeGoodWorkspace(dir);
    const cursorRunner = goodCursorRunner();
    const chatgptReviewer = vi.fn(async () => acceptReview());
    const verifySpy = vi.mocked(spineVerifier.verifyEvidencePack);

    await runCourierLoop(
      baseConfig(dir, ws, { cursorRunner: cursorRunner as any, chatgptReviewer: chatgptReviewer as any }),
    );

    expect(verifySpy).toHaveBeenCalled();
    expect(chatgptReviewer).toHaveBeenCalled();
    const verifyOrder = verifySpy.mock.invocationCallOrder[0];
    const reviewOrder = chatgptReviewer.mock.invocationCallOrder[0];
    expect(verifyOrder).toBeLessThan(reviewOrder);
  });
});
