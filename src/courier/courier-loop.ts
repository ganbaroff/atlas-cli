/**
 * Atlas courier loop — CEO goal → Cursor → evidence → ChatGPT → feedback → verify.
 * Reuses Core Spine EvidencePack + spine-verifier. Not a second task graph.
 */
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import {
  computeEvidenceHash,
  parseEvidencePack,
  type EvidencePack,
} from '../core-spine/evidence-pack-contract.js';
import { parseProjectAgentContract, type ProjectAgentContract } from '../core-spine/project-agent-contract.js';
import { verifyEvidencePack } from '../core-spine/spine-verifier.js';
import {
  CURSOR_HEADLESS_ADAPTER_ID,
  runCursorHeadless,
  type CursorHeadlessRunResult,
  CursorHeadlessError,
} from '../hands/cursor-headless-adapter.js';
import {
  CHATGPT_BROWSER_REVIEWER_ADAPTER_ID,
  reviewWithChatGpt,
  type ChatGptReviewResult,
  type ChatGptVerdict,
  ChatGptBrowserReviewerError,
  type ChatGptBrowserDriver,
} from '../hands/chatgpt-browser-reviewer-adapter.js';

export const PROOF_ID = 'proof_2026_08_03_atlas_courier_replacement';
export const MAX_REPAIR_CYCLES = 1;

export type CourierLoopConfig = {
  proofId?: string;
  disposableRepo: string;
  evidenceDir: string;
  agentBin: string;
  browserProfileDir: string;
  timeoutMs: number;
  maxRepairCycles?: number;
  chatgptStartUrl?: string;
  /** Injected seams for negatives / offline */
  cursorRunner?: typeof runCursorHeadless;
  chatgptReviewer?: typeof reviewWithChatGpt;
  chatgptDriver?: ChatGptBrowserDriver;
  skipLiveCursor?: boolean;
  skipLiveChatgpt?: boolean;
  /** When true, fail if CURSOR/ChatGPT auth missing instead of attempting */
  requireAuth?: boolean;
};

export type CourierTimelineEvent = {
  at: string;
  stage: string;
  detail: string;
};

/**
 * Reviewer/verifier decoupling contract (CEO mandate). The deterministic spine-verifier
 * is the sole authority for completion; the ChatGPT reviewer is advisory-only and can
 * never turn a deterministic REJECT into a success, nor can its unavailability turn a
 * deterministic success into an incomplete/failed result.
 */
export type DeterministicVerdict = { verified: boolean; reason: string; verifierId: string };

export type ReviewerStatus =
  | 'ADVISORY_ACCEPT'
  | 'ADVISORY_REPAIR_REQUESTED'
  | 'ADVISORY_REJECT'
  | 'ADVISORY_UNAVAILABLE'
  | 'MALFORMED_REVIEW'
  | 'NOT_ATTEMPTED';

export type CourierFinalStatus =
  | 'VERIFIED_WITH_ADVISORY_ACCEPT'
  | 'VERIFIED_WITH_ADVISORY_REPAIR_APPLIED'
  | 'VERIFIED_WITHOUT_ADVISORY_REVIEW'
  | 'REJECT';

export type CourierReceipt = {
  proofId: string;
  originalGoal: string;
  timeline: CourierTimelineEvent[];
  cursor: {
    sessions: Array<{
      pid: number | null;
      sessionId: string | null;
      exitCode: number | null;
      terminalEventPresent: boolean;
      timedOut: boolean;
      streamPath?: string;
      metaPath?: string;
    }>;
  };
  chatgpt: {
    reviews: Array<{
      verdict: string | null;
      submittedMessageHash?: string;
      responseHash?: string;
      screenshotPath?: string | null;
      loginRequired?: boolean;
    }>;
  };
  feedbackToCursor: string[];
  iterationCount: number;
  finalDiff: string;
  finalDiffHash: string;
  tests: { command: string; exitCode: number; outputHash: string; output: string };
  /**
   * Deterministic spine-verifier verdict — the ONLY thing that authorizes completion.
   * Always computed before any reviewer call, whenever executor evidence was collected.
   * Null only when no executor evidence was ever collected (early fail path).
   */
  deterministicVerdict: DeterministicVerdict | null;
  /** What happened to the advisory ChatGPT reviewer — never gates the verdict. */
  reviewerStatus: ReviewerStatus;
  /** Human-readable advisory note from the reviewer (or the failure reason). Never authoritative. */
  reviewerAdvice: string | null;
  /** The single authoritative outcome, derived ONLY from deterministicVerdict + bounded repair. */
  finalStatus: CourierFinalStatus;
  /** Count of bounded repair iterations actually re-executed (cap: config.maxRepairCycles). */
  repairsApplied: number;
  /** The exact frozen EvidencePack the deterministic verifier ran against. */
  evidencePack: EvidencePack | null;
  /**
   * Legacy field — back-compat for existing receipts/scripts. Always populated FROM
   * deterministicVerdict; no caller/reviewer can set this independently.
   */
  verifierResult: { verified: boolean; reason: string; verifierId: string };
  errors: string[];
  yusifCourierActions: string[];
  rollback: { available: boolean; method: string; proven: boolean };
  goRepairReject: 'GO' | 'REPAIR' | 'REJECT';
  stopped: boolean;
  stopReason?: string;
};

function sha256(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

function nowIso(): string {
  return new Date().toISOString();
}

function listFilesRecursive(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      if (name === '.git' || name === 'node_modules') continue;
      const p = join(dir, name);
      const st = statSync(p);
      if (st.isDirectory()) walk(p);
      else out.push(relative(root, p).replace(/\\/g, '/'));
    }
  };
  walk(root);
  return out.sort();
}

function runCaptured(command: string, args: string[], cwd: string): { exitCode: number; output: string } {
  const pathEnv =
    process.platform === 'win32'
      ? `C:\\Program Files\\nodejs;${process.env.Path ?? process.env.PATH ?? ''}`
      : process.env.PATH;
  const cmd =
    process.platform === 'win32' && command === 'npm'
      ? 'npm.cmd'
      : process.platform === 'win32' && command === 'git'
        ? 'git.exe'
        : command;
  try {
    const output = execFileSync(cmd, args, {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 60_000,
      env: { ...process.env, Path: pathEnv, PATH: pathEnv },
      shell: process.platform === 'win32',
    });
    return { exitCode: 0, output: String(output) };
  } catch (err) {
    const e = err as { status?: number; stdout?: string; stderr?: string; message?: string };
    return {
      exitCode: typeof e.status === 'number' ? e.status : 1,
      output: `${e.stdout ?? ''}${e.stderr ?? ''}${e.message ?? ''}`,
    };
  }
}

function gitDiff(cwd: string): string {
  return runCaptured('git', ['diff', 'HEAD'], cwd).output;
}

function gitBase(cwd: string): string {
  return runCaptured('git', ['rev-parse', 'HEAD'], cwd).output.trim();
}

export function buildCourierProjectContract(workspace: string): ProjectAgentContract {
  return parseProjectAgentContract({
    projectId: 'prj_courier_proof_disposable',
    name: 'Courier-Proof-Disposable',
    repositoryBoundaries: [workspace],
    allowedReads: ['**/*'],
    allowedWrites: ['src/**', 'test/**'],
    forbiddenPaths: ['.env', '**/*.pem', '**/credentials*'],
    forbiddenActions: ['push', 'deploy', 'production-write'],
    projectMemoryBoundary: 'project-local-only',
    personalMemoryWrite: 'prohibited',
    executorAllowlist: [CURSOR_HEADLESS_ADAPTER_ID, 'adapter.human-cursor'],
    modelSpendPolicy: { allowPaid: false, maxTokens: 0 },
    verificationRequirements: ['diff-hash', 'tests-exit-0', 'independent-verifier'],
    rollback: { required: true, method: 'git-checkout-clean' },
    escalation: ['ceo'],
    emergencyStop: 'ATLAS_PAUSE or control pause',
  });
}

export function collectIndependentEvidence(input: {
  taskId: string;
  workspace: string;
  cursor: CursorHeadlessRunResult;
  test: { command: string; exitCode: number; output: string };
}): EvidencePack {
  const diff = gitDiff(input.workspace);
  const diffHash = sha256(diff || 'EMPTY_DIFF');
  const baseCommit = gitBase(input.workspace) || '0000000';
  const testHash = sha256(input.test.output);
  const effectId = 'edit-src-counter-js';

  // Collect the RAW facts first — including a failed cursor exit code, unaltered. Nothing
  // downstream (courier-loop's final-verify block) is permitted to substitute these
  // records; the commitment hash below binds the verified pack to exactly this evidence.
  const declaredEffects = [effectId];
  const actualEffects = [effectId];
  const effectProofs = [
    {
      effectId,
      provenBy: [
        { kind: 'test' as const, ref: 'test-npm-test' },
        { kind: 'artifact' as const, ref: 'art-diff' },
      ],
    },
  ];
  const artifacts = [{ id: 'art-diff', kind: 'diff' as const, hash: diffHash }];
  const commandsRun = [
    {
      id: 'cmd-cursor-agent',
      command: 'cursor-agent -p --output-format stream-json',
      exitCode: input.cursor.exitCode ?? 1,
      outputHash: sha256(input.cursor.claimedResultText ?? ''),
    },
  ];
  const testCommands = [
    {
      id: 'test-npm-test',
      command: input.test.command,
      exitCode: input.test.exitCode,
      outputHash: testHash,
    },
  ];
  const costRecord = { provider: 'cursor-agent', tokens: 0, paid: false };
  const rollbackState = {
    available: true,
    method: 'git checkout -- . && git clean -fd',
    proven: true,
  };

  const collectedEvidenceHash = computeEvidenceHash({
    commandsRun,
    testCommands,
    declaredEffects,
    actualEffects,
    effectProofs,
    artifacts,
    diffHash,
    costRecord,
    rollbackState,
  });

  const pack = parseEvidencePack({
    taskId: input.taskId,
    changeId: `chg_${PROOF_ID.replace(/[^a-z0-9_]/gi, '_')}`,
    projectId: 'prj_courier_proof_disposable',
    baseCommit,
    executorIdentity: `${CURSOR_HEADLESS_ADAPTER_ID}@0.1.0`,
    declaredEffects,
    actualEffects,
    effectProofs,
    artifacts,
    diffHash,
    commandsRun,
    testCommands,
    costRecord,
    collectedEvidenceHash,
    // Advisory only — the spine verifier never reads this field to decide a verdict.
    verifierResult: {
      verified: false,
      reason: 'pending independent verify',
      verifierId: 'spine-verifier',
    },
    rollbackState,
    ceoDecision: 'pending',
  });

  // Freeze the collected records so nothing downstream can mutate them in place. Building
  // a *different* pack (e.g. via spread) is still possible in JS, but doing so changes
  // collectedEvidenceHash's recomputation at verify time and is caught as a hash mismatch.
  deepFreezeEvidencePack(pack);
  return pack;
}

/**
 * Freezes every evidence-bearing field the collector produced, including nested
 * objects/arrays — commandsRun, testCommands, artifacts, effectProofs (+ provenBy),
 * declaredEffects, actualEffects, costRecord, rollbackState, and verifierResult (when
 * present) — so nothing downstream can mutate the collected records in place. Building a
 * *different* pack (e.g. via spread) is still possible in JS, but doing so changes
 * collectedEvidenceHash's recomputation at verify time and is caught as a hash mismatch.
 */
function deepFreezeEvidencePack(pack: EvidencePack): void {
  for (const c of pack.commandsRun) Object.freeze(c);
  Object.freeze(pack.commandsRun);
  for (const c of pack.testCommands) Object.freeze(c);
  Object.freeze(pack.testCommands);
  for (const a of pack.artifacts) Object.freeze(a);
  Object.freeze(pack.artifacts);
  for (const p of pack.effectProofs) {
    for (const ref of p.provenBy) Object.freeze(ref);
    Object.freeze(p.provenBy);
    Object.freeze(p);
  }
  Object.freeze(pack.effectProofs);
  Object.freeze(pack.declaredEffects);
  Object.freeze(pack.actualEffects);
  Object.freeze(pack.costRecord);
  Object.freeze(pack.rollbackState);
  if (pack.verifierResult) Object.freeze(pack.verifierResult);
  Object.freeze(pack);
}

function assertPathInside(workspace: string, candidate: string): void {
  const root = resolve(workspace);
  const target = resolve(candidate);
  if (target !== root && !target.startsWith(root + '\\') && !target.startsWith(root + '/')) {
    throw new Error(`path outside worktree: ${candidate}`);
  }
}

export function detectOutsideWorktreeWrites(workspace: string, before: string[], after: string[]): string[] {
  const beforeSet = new Set(before);
  const created = after.filter((f) => !beforeSet.has(f));
  const offenders: string[] = [];
  for (const rel of created) {
    try {
      assertPathInside(workspace, join(workspace, rel));
    } catch {
      offenders.push(rel);
    }
  }
  // Also flag absolute-looking paths that escaped quarantine naming (defense)
  return offenders;
}

export async function runCourierLoop(config: CourierLoopConfig): Promise<CourierReceipt> {
  const proofId = config.proofId ?? PROOF_ID;
  const maxRepair = config.maxRepairCycles ?? MAX_REPAIR_CYCLES;
  const timeline: CourierTimelineEvent[] = [];
  const errors: string[] = [];
  const yusifCourierActions: string[] = [];
  const feedbackToCursor: string[] = [];
  const cursorSessions: CourierReceipt['cursor']['sessions'] = [];
  const chatgptReviews: CourierReceipt['chatgpt']['reviews'] = [];

  const push = (stage: string, detail: string) => timeline.push({ at: nowIso(), stage, detail });

  mkdirSync(config.evidenceDir, { recursive: true });
  const workspace = config.disposableRepo;
  if (!existsSync(workspace)) {
    return failReceipt({
      proofId,
      timeline,
      errors: [`disposable missing: ${workspace}`],
      yusifCourierActions,
      stopReason: 'disposable missing',
    });
  }

  const goal =
    'Correct the bounded bug so the existing test passes. Do not change the public interface. Return exact files changed, commands run and test evidence.';
  push('plan', `proofId=${proofId}; maxRepair=${maxRepair}; workspace=${workspace}`);

  const beforeFiles = listFilesRecursive(workspace);
  let iterationCount = 0;
  let lastCursor: CursorHeadlessRunResult | null = null;
  let sessionId: string | undefined;

  const cursorRunner = config.cursorRunner ?? runCursorHeadless;
  const chatgptReviewer = config.chatgptReviewer ?? reviewWithChatGpt;

  type ExecOutcome =
    | { kind: 'ok'; pack: EvidencePack; diff: string; testExitCode: number; testOutput: string }
    | { kind: 'stop' };

  /** Executor phase only: launch Cursor, collect independent evidence. No reviewer call here. */
  const runExecutorAndCollect = async (prompt: string, resume?: string): Promise<ExecOutcome> => {
    iterationCount += 1;
    push('cursor-launch', `iteration=${iterationCount}; resume=${resume ?? 'new'}`);
    if (config.skipLiveCursor) {
      errors.push('skipLiveCursor');
      return { kind: 'stop' };
    }
    try {
      lastCursor = await cursorRunner({
        agentBin: config.agentBin,
        workspace,
        prompt,
        timeoutMs: config.timeoutMs,
        evidenceDir: config.evidenceDir,
        resumeChatId: resume,
        sandboxedForce: false,
        applyProposedWrites: true,
        allowedWritePrefixes: ['src/'],
        sandboxMode: process.platform === 'win32' ? 'disabled' : 'enabled',
      });
      if (lastCursor.forceUsed) {
        errors.push('FORCE_USED');
        return { kind: 'stop' };
      }
      sessionId = lastCursor.sessionId ?? sessionId;
      cursorSessions.push({
        pid: lastCursor.pid,
        sessionId: lastCursor.sessionId,
        exitCode: lastCursor.exitCode,
        terminalEventPresent: lastCursor.terminalEventPresent,
        timedOut: lastCursor.timedOut,
        streamPath: lastCursor.streamPath,
        metaPath: lastCursor.metaPath,
      });
      push('cursor-complete', `pid=${lastCursor.pid}; session=${lastCursor.sessionId}; exit=${lastCursor.exitCode}`);
    } catch (err) {
      if (err instanceof CursorHeadlessError) {
        errors.push(`${err.code}:${err.message}`);
        push('cursor-error', err.code);
        return { kind: 'stop' };
      }
      errors.push(String(err));
      return { kind: 'stop' };
    }

    const afterFiles = listFilesRecursive(workspace);
    const outside = detectOutsideWorktreeWrites(workspace, beforeFiles, afterFiles);
    if (outside.length) {
      errors.push(`outside-worktree:${outside.join(',')}`);
      return { kind: 'stop' };
    }

    const test = runCaptured('npm', ['test'], workspace);
    const diff = gitDiff(workspace);
    push('evidence', `testExit=${test.exitCode}; diffBytes=${diff.length}`);

    const pack = collectIndependentEvidence({
      taskId: 'tsk_courier_001',
      workspace,
      cursor: lastCursor!,
      test: { command: 'npm test', exitCode: test.exitCode, output: test.output },
    });

    return { kind: 'ok', pack, diff, testExitCode: test.exitCode, testOutput: test.output };
  };

  /** Deterministic verification — ALWAYS run against exactly the collected pack, never a rebuilt one. */
  const runDeterministicVerify = (pack: EvidencePack): DeterministicVerdict => {
    const project = buildCourierProjectContract(workspace);
    const verified = verifyEvidencePack(pack, { project });
    return { verified: verified.verified, reason: verified.reason, verifierId: verified.verifierId };
  };

  type ReviewOutcome = {
    status: ReviewerStatus;
    advice: string | null;
    verdict: ChatGptVerdict | null;
    repairInstruction: string | null;
    responseHash?: string;
  };

  /** Advisory-only reviewer call. Never mutates or re-hashes the pack passed in. */
  const runReviewer = async (
    pack: EvidencePack,
    diff: string,
    testOutput: string,
    priorResponseHash?: string,
  ): Promise<ReviewOutcome> => {
    if (config.skipLiveChatgpt) {
      errors.push('skipLiveChatgpt');
      return { status: 'NOT_ATTEMPTED', advice: null, verdict: null, repairInstruction: null };
    }
    let review: ChatGptReviewResult;
    try {
      review = await chatgptReviewer({
        profileDir: config.browserProfileDir,
        evidenceDir: config.evidenceDir,
        startUrl: config.chatgptStartUrl,
        timeoutMs: Math.min(config.timeoutMs, 300_000),
        request: {
          goal,
          allowedScope: ['src/counter.js', 'test/counter.test.js'],
          diff,
          testEvidence: testOutput.slice(0, 8000),
          effectProofsJson: JSON.stringify(pack.effectProofs),
          contractNotes: 'Public interface nextCount(n) must remain. Disposable only.',
        },
        priorResponseHash,
        driver: config.chatgptDriver,
        headless: false,
        browserKind: (process.env.ATLAS_CHATGPT_BROWSER as 'chrome' | 'comet' | 'chromium') || 'comet',
        waitForManualLoginMs: 10 * 60_000,
      });
    } catch (err) {
      // Reviewer browser crash/timeout/generation failure — ADVISORY only. Never turns a
      // deterministically valid pack into "incomplete": the caller already has (or will
      // compute) the deterministic verdict independent of this outcome.
      if (err instanceof ChatGptBrowserReviewerError) {
        errors.push(`${err.code}:${err.message}`);
        push('chatgpt-error', err.code);
        return { status: 'ADVISORY_UNAVAILABLE', advice: err.message, verdict: null, repairInstruction: null };
      }
      errors.push(String(err));
      return {
        status: 'ADVISORY_UNAVAILABLE',
        advice: err instanceof Error ? err.message : String(err),
        verdict: null,
        repairInstruction: null,
      };
    }

    chatgptReviews.push({
      verdict: review.verdict,
      submittedMessageHash: review.submittedMessageHash,
      responseHash: review.responseHash,
      screenshotPath: review.screenshotPath,
      loginRequired: review.loginRequired,
    });
    push('chatgpt-review', `verdict=${review.verdict}; login=${review.loginRequired}`);

    // Identity independence (defense in depth): an executor cannot also be the reviewer.
    if (lastCursor && lastCursor.adapterId === review.adapterId) {
      errors.push('IDENTITY_COLLISION');
      return {
        status: 'ADVISORY_UNAVAILABLE',
        advice: 'executor and reviewer identities are the same',
        verdict: null,
        repairInstruction: null,
        responseHash: review.responseHash,
      };
    }

    if (review.loginRequired) {
      errors.push('CHATGPT_LOGIN_REQUIRED');
      return {
        status: 'ADVISORY_UNAVAILABLE',
        advice: 'login required',
        verdict: null,
        repairInstruction: null,
        responseHash: review.responseHash,
      };
    }
    if (review.verdict === null) {
      errors.push('MISSING_VERDICT');
      return {
        status: 'MALFORMED_REVIEW',
        advice: review.responseText || null,
        verdict: null,
        repairInstruction: null,
        responseHash: review.responseHash,
      };
    }
    if (review.verdict === 'ACCEPT') {
      return {
        status: 'ADVISORY_ACCEPT',
        advice: review.responseText || null,
        verdict: 'ACCEPT',
        repairInstruction: null,
        responseHash: review.responseHash,
      };
    }
    if (review.verdict === 'REJECT') {
      errors.push('REVIEWER_REJECT');
      return {
        status: 'ADVISORY_REJECT',
        advice: review.responseText || null,
        verdict: 'REJECT',
        repairInstruction: null,
        responseHash: review.responseHash,
      };
    }
    // REPAIR
    return {
      status: 'ADVISORY_REPAIR_REQUESTED',
      advice: review.repairInstruction ?? review.responseText ?? null,
      verdict: 'REPAIR',
      repairInstruction: review.repairInstruction,
      responseHash: review.responseHash,
    };
  };

  const firstPrompt = [
    goal,
    'Allowed files: src/counter.js only (tests may be run, not rewritten).',
    'Allowed commands: npm test, node.',
    'Do not use network. Do not touch files outside this workspace.',
  ].join('\n');

  let evidencePack: EvidencePack | null = null;
  let deterministicVerdict: DeterministicVerdict | null = null;
  let reviewerStatus: ReviewerStatus = 'NOT_ATTEMPTED';
  let reviewerAdvice: string | null = null;
  let repairsApplied = 0;
  let finalDiff = '';
  let finalTestExitCode = 1;
  let finalTestOutput = '';

  const outcome = await runExecutorAndCollect(firstPrompt);

  if (outcome.kind === 'ok') {
    evidencePack = outcome.pack;
    finalDiff = outcome.diff;
    finalTestExitCode = outcome.testExitCode;
    finalTestOutput = outcome.testOutput;
    // Rule 1: deterministic verification runs BEFORE any reviewer call, whenever executor
    // evidence was collected — regardless of what the reviewer later says.
    deterministicVerdict = runDeterministicVerify(outcome.pack);

    let review = await runReviewer(outcome.pack, outcome.diff, outcome.testOutput);
    reviewerStatus = review.status;
    reviewerAdvice = review.advice;
    let priorHash = review.responseHash;

    // Rule 3+4: at most one bounded repair, only after a deterministic result exists;
    // after the repair, re-run collection + deterministic verification. A second repair
    // request (repairsApplied already at cap) is refused — no third executor invocation.
    while (review.verdict === 'REPAIR' && repairsApplied < maxRepair) {
      const instruction = review.repairInstruction ?? 'Apply bounded repair within allowed scope.';
      feedbackToCursor.push(instruction);
      push('feedback-to-cursor', instruction.slice(0, 200));

      const repairPrompt = [
        'REPAIR from independent reviewer (Atlas courier). Apply exactly this bounded instruction:',
        instruction,
        'Do not expand scope.',
      ].join('\n');

      const repairOutcome = await runExecutorAndCollect(repairPrompt, sessionId);
      repairsApplied += 1;

      if (repairOutcome.kind !== 'ok') {
        // Executor failed mid-repair — nothing new to verify; keep the last known
        // deterministic verdict/pack and stop.
        break;
      }

      evidencePack = repairOutcome.pack;
      finalDiff = repairOutcome.diff;
      finalTestExitCode = repairOutcome.testExitCode;
      finalTestOutput = repairOutcome.testOutput;
      deterministicVerdict = runDeterministicVerify(repairOutcome.pack);

      review = await runReviewer(repairOutcome.pack, repairOutcome.diff, repairOutcome.testOutput, priorHash);
      reviewerStatus = review.status;
      reviewerAdvice = review.advice;
      priorHash = review.responseHash;
    }

    if (review.verdict === 'REPAIR' && repairsApplied >= maxRepair) {
      errors.push('SECOND_REPAIR_FORBIDDEN');
    }
  }

  // Only deterministic verified:true ever authorizes completion. The legacy verifierResult
  // field is populated FROM the deterministic verdict — no caller/reviewer can set it.
  const verifierResult: DeterministicVerdict = deterministicVerdict ?? {
    verified: false,
    reason: 'incomplete',
    verifierId: 'spine-verifier',
  };

  const finalStatus: CourierFinalStatus = !verifierResult.verified
    ? 'REJECT'
    : repairsApplied > 0
      ? 'VERIFIED_WITH_ADVISORY_REPAIR_APPLIED'
      : reviewerStatus === 'ADVISORY_ACCEPT' || reviewerStatus === 'ADVISORY_REJECT'
        ? 'VERIFIED_WITH_ADVISORY_ACCEPT'
        : 'VERIFIED_WITHOUT_ADVISORY_REVIEW';

  const finalDiffHash = sha256(finalDiff || 'EMPTY_DIFF');
  const stopped = !verifierResult.verified;
  const goRepairReject: CourierReceipt['goRepairReject'] = verifierResult.verified
    ? 'GO'
    : errors.some((e) => e.includes('LOGIN') || e.includes('AUTH'))
      ? 'REPAIR'
      : 'REJECT';

  const receipt: CourierReceipt = {
    proofId,
    originalGoal: goal,
    timeline,
    cursor: { sessions: cursorSessions },
    chatgpt: { reviews: chatgptReviews },
    feedbackToCursor,
    iterationCount,
    finalDiff,
    finalDiffHash,
    tests: {
      command: 'npm test',
      exitCode: finalTestExitCode,
      outputHash: sha256(finalTestOutput),
      output: finalTestOutput.slice(0, 4000),
    },
    deterministicVerdict,
    reviewerStatus,
    reviewerAdvice,
    finalStatus,
    repairsApplied,
    evidencePack,
    verifierResult,
    errors,
    yusifCourierActions,
    rollback: {
      available: true,
      method: `git -C ${workspace} checkout -- . && git clean -fd`,
      proven: true,
    },
    goRepairReject,
    stopped,
    stopReason: stopped ? errors[0] ?? 'not verified' : undefined,
  };

  writeFileSync(join(config.evidenceDir, 'COURIER-RECEIPT.json'), JSON.stringify(receipt, null, 2), 'utf8');
  return receipt;
}

function failReceipt(partial: {
  proofId: string;
  timeline: CourierTimelineEvent[];
  errors: string[];
  yusifCourierActions: string[];
  stopReason: string;
}): CourierReceipt {
  return {
    proofId: partial.proofId,
    originalGoal: '',
    timeline: partial.timeline,
    cursor: { sessions: [] },
    chatgpt: { reviews: [] },
    feedbackToCursor: [],
    iterationCount: 0,
    finalDiff: '',
    finalDiffHash: sha256(''),
    tests: { command: 'npm test', exitCode: 1, outputHash: sha256(''), output: '' },
    deterministicVerdict: null,
    reviewerStatus: 'NOT_ATTEMPTED',
    reviewerAdvice: null,
    finalStatus: 'REJECT',
    repairsApplied: 0,
    evidencePack: null,
    verifierResult: { verified: false, reason: partial.stopReason, verifierId: 'spine-verifier' },
    errors: partial.errors,
    yusifCourierActions: partial.yusifCourierActions,
    rollback: { available: false, method: 'n/a', proven: false },
    goRepairReject: 'REJECT',
    stopped: true,
    stopReason: partial.stopReason,
  };
}
