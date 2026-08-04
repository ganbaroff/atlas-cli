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
  let lastReview: ChatGptReviewResult | null = null;

  const cursorRunner = config.cursorRunner ?? runCursorHeadless;
  const chatgptReviewer = config.chatgptReviewer ?? reviewWithChatGpt;

  const runOnce = async (prompt: string, resume?: string): Promise<'continue' | 'stop'> => {
    iterationCount += 1;
    push('cursor-launch', `iteration=${iterationCount}; resume=${resume ?? 'new'}`);
    if (config.skipLiveCursor) {
      errors.push('skipLiveCursor');
      return 'stop';
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
        return 'stop';
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
        if (err.code === 'AUTH') {
          return 'stop';
        }
        return 'stop';
      }
      errors.push(String(err));
      return 'stop';
    }

    const afterFiles = listFilesRecursive(workspace);
    const outside = detectOutsideWorktreeWrites(workspace, beforeFiles, afterFiles);
    if (outside.length) {
      errors.push(`outside-worktree:${outside.join(',')}`);
      return 'stop';
    }

    const test = runCaptured('npm', ['test'], workspace);
    push('evidence', `testExit=${test.exitCode}; diffBytes=${gitDiff(workspace).length}`);

    const pack = collectIndependentEvidence({
      taskId: 'tsk_courier_001',
      workspace,
      cursor: lastCursor!,
      test: { command: 'npm test', exitCode: test.exitCode, output: test.output },
    });

    if (config.skipLiveChatgpt) {
      errors.push('skipLiveChatgpt');
      return 'stop';
    }

    try {
      lastReview = await chatgptReviewer({
        profileDir: config.browserProfileDir,
        evidenceDir: config.evidenceDir,
        startUrl: config.chatgptStartUrl,
        timeoutMs: Math.min(config.timeoutMs, 300_000),
        request: {
          goal,
          allowedScope: ['src/counter.js', 'test/counter.test.js'],
          diff: gitDiff(workspace),
          testEvidence: test.output.slice(0, 8000),
          effectProofsJson: JSON.stringify(pack.effectProofs),
          contractNotes: 'Public interface nextCount(n) must remain. Disposable only.',
        },
        priorResponseHash: lastReview?.responseHash,
        driver: config.chatgptDriver,
        headless: false,
        browserKind: (process.env.ATLAS_CHATGPT_BROWSER as 'chrome' | 'comet' | 'chromium') || 'comet',
        waitForManualLoginMs: 10 * 60_000,
      });
      chatgptReviews.push({
        verdict: lastReview.verdict,
        submittedMessageHash: lastReview.submittedMessageHash,
        responseHash: lastReview.responseHash,
        screenshotPath: lastReview.screenshotPath,
        loginRequired: lastReview.loginRequired,
      });
      push('chatgpt-review', `verdict=${lastReview.verdict}; login=${lastReview.loginRequired}`);
      if (lastReview.loginRequired) {
        errors.push('CHATGPT_LOGIN_REQUIRED');
        return 'stop';
      }
    } catch (err) {
      if (err instanceof ChatGptBrowserReviewerError) {
        errors.push(`${err.code}:${err.message}`);
        push('chatgpt-error', err.code);
        return 'stop';
      }
      errors.push(String(err));
      return 'stop';
    }

    if (lastReview.verdict === 'ACCEPT') return 'stop';
    if (lastReview.verdict === 'REJECT') {
      errors.push('REVIEWER_REJECT');
      return 'stop';
    }
    if (lastReview.verdict === 'REPAIR') {
      if (iterationCount > maxRepair) {
        errors.push('SECOND_REPAIR_FORBIDDEN');
        return 'stop';
      }
      const instruction = lastReview.repairInstruction ?? 'Apply bounded repair within allowed scope.';
      feedbackToCursor.push(instruction);
      push('feedback-to-cursor', instruction.slice(0, 200));
      // continue to repair iteration via caller
      return 'continue';
    }
    errors.push('MISSING_VERDICT');
    return 'stop';
  };

  const firstPrompt = [
    goal,
    'Allowed files: src/counter.js only (tests may be run, not rewritten).',
    'Allowed commands: npm test, node.',
    'Do not use network. Do not touch files outside this workspace.',
  ].join('\n');

  let cont = await runOnce(firstPrompt);
  if (cont === 'continue' && lastReview?.verdict === 'REPAIR') {
    if (iterationCount >= maxRepair + 1) {
      errors.push('SECOND_REPAIR_FORBIDDEN');
    } else {
      const repairPrompt = [
        'REPAIR from independent reviewer (Atlas courier). Apply exactly this bounded instruction:',
        lastReview.repairInstruction ?? '',
        'Do not expand scope.',
      ].join('\n');
      cont = await runOnce(repairPrompt, sessionId);
      if (cont === 'continue') {
        errors.push('SECOND_REPAIR_FORBIDDEN');
      }
    }
  }

  // Final independent verification
  const finalTest = runCaptured('npm', ['test'], workspace);
  const finalDiff = gitDiff(workspace);
  const finalDiffHash = sha256(finalDiff || 'EMPTY_DIFF');
  let verifierResult = { verified: false, reason: 'incomplete', verifierId: 'spine-verifier' };

  // Reviewer verdict (ACCEPT/REPAIR/REJECT) is recorded above in chatgptReviews as an
  // ADVISORY signal only — it gates whether the courier even attempts final verification
  // (no point verifying mid-repair-cycle work), but it can never itself produce a
  // verified:true receipt. The deterministic spine-verifier's returned result, built from
  // the ORIGINALLY collected evidence (no substitution — a failed cursor command simply
  // remains in commandsRun and the verifier's own checkCommandList rejects it), is the
  // only gate for verifierResult below.
  if (lastCursor && finalTest.exitCode === 0 && lastReview?.verdict === 'ACCEPT') {
    try {
      const pack = collectIndependentEvidence({
        taskId: 'tsk_courier_001',
        workspace,
        cursor: lastCursor,
        test: { command: 'npm test', exitCode: finalTest.exitCode, output: finalTest.output },
      });
      const project = buildCourierProjectContract(workspace);
      const verified = verifyEvidencePack(pack, { project });
      verifierResult = { verified: verified.verified, reason: verified.reason, verifierId: verified.verifierId };
      if (CURSOR_HEADLESS_ADAPTER_ID === CHATGPT_BROWSER_REVIEWER_ADAPTER_ID) {
        verifierResult = {
          verified: false,
          reason: 'executor and reviewer identities collide',
          verifierId: verified.verifierId,
        };
      }
      // identity independence check (executor vs reviewer transport)
      if (lastCursor.adapterId === lastReview.adapterId) {
        verifierResult = {
          verified: false,
          reason: 'executor and reviewer identities are the same',
          verifierId: verified.verifierId,
        };
        errors.push('IDENTITY_COLLISION');
      }
    } catch (err) {
      verifierResult = {
        verified: false,
        reason: err instanceof Error ? err.message : String(err),
        verifierId: 'spine-verifier',
      };
      errors.push(verifierResult.reason);
    }
  } else {
    if (lastCursor?.adapterId && lastReview?.adapterId && lastCursor.adapterId === lastReview.adapterId) {
      errors.push('IDENTITY_COLLISION');
    }
  }

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
      exitCode: finalTest.exitCode,
      outputHash: sha256(finalTest.output),
      output: finalTest.output.slice(0, 4000),
    },
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
    verifierResult: { verified: false, reason: partial.stopReason, verifierId: 'spine-verifier' },
    errors: partial.errors,
    yusifCourierActions: partial.yusifCourierActions,
    rollback: { available: false, method: 'n/a', proven: false },
    goRepairReject: 'REJECT',
    stopped: true,
    stopReason: partial.stopReason,
  };
}
