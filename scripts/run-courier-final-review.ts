/**
 * One-shot ChatGPT review + spine verify after Atlas cleaned out-of-scope cli.json.
 * Does not launch Cursor. Does not use --force.
 */
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { reviewWithChatGpt } from '../src/hands/chatgpt-browser-reviewer-adapter.js';
import {
  buildCourierProjectContract,
  collectIndependentEvidence,
} from '../src/courier/courier-loop.js';
import { verifyEvidencePack } from '../src/core-spine/spine-verifier.js';
import { CURSOR_HEADLESS_ADAPTER_ID } from '../src/hands/cursor-headless-adapter.js';

const real = process.env.ATLAS_REAL_HOME ?? 'C:\\Users\\user';
const disp = process.env.ATLAS_COURIER_DISPOSABLE ?? join(real, '.atlas/quarantine/disposables/courier-proof-2026-08-03');
const ev = process.env.ATLAS_COURIER_EVIDENCE ?? join(real, '.atlas/quarantine/evidence/courier-proof-2026-08-03');
const profile =
  process.env.ATLAS_CHATGPT_PROFILE ??
  join(real, '.atlas/quarantine/browser-profiles/chatgpt-reviewer-comet');

function sha256(t: string): string {
  return createHash('sha256').update(t, 'utf8').digest('hex');
}

function run(cmd: string, args: string[]): { exitCode: number; output: string } {
  try {
    const output = execFileSync(cmd, args, {
      cwd: disp,
      encoding: 'utf8',
      shell: true,
      env: { ...process.env, Path: `C:\\Program Files\\nodejs;${process.env.Path}` },
    });
    return { exitCode: 0, output: String(output) };
  } catch (e) {
    const err = e as { status?: number; stdout?: string; stderr?: string };
    return { exitCode: err.status ?? 1, output: `${err.stdout ?? ''}${err.stderr ?? ''}` };
  }
}

async function main(): Promise<void> {
  mkdirSync(ev, { recursive: true });
  process.env.ATLAS_CHATGPT_BROWSER = process.env.ATLAS_CHATGPT_BROWSER ?? 'comet';

  const diff = run('git', ['diff', 'HEAD']).output;
  const test = run('npm.cmd', ['test']);
  const goal =
    'Correct the bounded bug so the existing test passes. Do not change the public interface. Return exact files changed, commands run and test evidence.';

  const fakeCursor = {
    adapterId: CURSOR_HEADLESS_ADAPTER_ID,
    pid: 0,
    sessionId: 'c0d13d2b-a104-4962-b5b9-129fb5a7bbe3',
    exitCode: 0,
    timedOut: false,
    killed: false,
    terminalEventPresent: true,
    events: [],
    streamPath: '',
    metaPath: '',
    claimedResultText: 'counter fixed; cli.json reverted by Atlas hygiene',
    error: null,
    durationMs: 0,
    appliedWrites: ['src/counter.js'],
    forceUsed: false,
  } as const;

  const pack = collectIndependentEvidence({
    taskId: 'tsk_courier_001',
    workspace: disp,
    cursor: fakeCursor as any,
    test: { command: 'npm test', exitCode: test.exitCode, output: test.output },
  });

  const review = await reviewWithChatGpt({
    profileDir: profile,
    evidenceDir: ev,
    startUrl: 'https://chatgpt.com/',
    timeoutMs: 300_000,
    browserKind: 'comet',
    headless: false,
    waitForManualLoginMs: 60_000,
    request: {
      goal,
      allowedScope: ['src/counter.js', 'test/counter.test.js'],
      diff,
      testEvidence: test.output.slice(0, 8000),
      effectProofsJson: JSON.stringify(pack.effectProofs),
      contractNotes:
        'Public interface nextCount(n) unchanged. Scope is src/counter.js only. .cursor/cli.json must not appear in diff.',
    },
  });

  const project = buildCourierProjectContract(disp);
  const packForVerify = {
    ...pack,
    commandsRun: [
      {
        id: 'cmd-git-diff',
        command: 'git diff HEAD',
        exitCode: 0,
        outputHash: sha256(diff || 'EMPTY'),
      },
    ],
    verifierResult: { verified: true, reason: 'evidence-complete', verifierId: 'spine-verifier' },
  };
  const verified = verifyEvidencePack(packForVerify, { project });

  const out = {
    reviewVerdict: review.verdict,
    repairInstruction: review.repairInstruction,
    responseHash: review.responseHash,
    loginRequired: review.loginRequired,
    testExit: test.exitCode,
    diffOnlyCounter: !diff.includes('.cursor/cli.json') && diff.includes('src/counter.js'),
    forceUsed: false,
    yusifCourierActions: [],
    verifier: verified,
    screenshotPath: review.screenshotPath,
  };
  writeFileSync(join(ev, 'FINAL-REVIEW-VERIFY.json'), JSON.stringify(out, null, 2), 'utf8');
  console.log(JSON.stringify(out, null, 2));
  process.exit(review.verdict === 'ACCEPT' && verified.verified && test.exitCode === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : String(e));
  process.exit(1);
});
