/**
 * Resume entry for courier-replacement proof after CEO auth.
 * Usage (from ANUS): npx tsx scripts/run-courier-proof.ts
 * Does not print secrets. Stops if Cursor Agent not authenticated.
 */
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import {
  runCourierLoop,
  buildCourierProjectContract,
  collectIndependentEvidence,
} from '../src/courier/courier-loop.js';
import { verifyEvidencePack } from '../src/core-spine/spine-verifier.js';
import { computeEvidenceHash } from '../src/core-spine/evidence-pack-contract.js';
import { CURSOR_HEADLESS_ADAPTER_ID } from '../src/hands/cursor-headless-adapter.js';

const AGENT =
  process.env.ATLAS_CURSOR_AGENT_BIN ??
  join(
    process.env.USERPROFILE ?? '',
    '.atlas',
    'tools',
    'cursor-agent-cli-2026.07.23-e383d2b',
    'dist-package',
    'cursor-agent.cmd',
  );
const DISPOSABLE =
  process.env.ATLAS_COURIER_DISPOSABLE ??
  join(process.env.USERPROFILE ?? '', '.atlas', 'quarantine', 'disposables', 'courier-proof-2026-08-03');
const EVIDENCE =
  process.env.ATLAS_COURIER_EVIDENCE ??
  join(process.env.USERPROFILE ?? '', '.atlas', 'quarantine', 'evidence', 'courier-proof-2026-08-03');
const REAL_HOME =
  process.env.ATLAS_REAL_HOME ??
  (process.env.USERPROFILE?.includes('fake-home')
    ? `C:\\Users\\${process.env.USERNAME ?? 'user'}`
    : process.env.USERPROFILE ?? '');
const PROFILE =
  process.env.ATLAS_CHATGPT_PROFILE ??
  join(REAL_HOME, '.atlas', 'quarantine', 'browser-profiles', 'chatgpt-reviewer-comet');
// Prefer Comet for ChatGPT login (Playwright Chromium often blocked)
if (!process.env.ATLAS_CHATGPT_BROWSER) process.env.ATLAS_CHATGPT_BROWSER = 'comet';

function authOk(): boolean {
  if (process.env.CURSOR_API_KEY) return true;
  try {
    const out = execFileSync(AGENT, ['status'], {
      encoding: 'utf8',
      shell: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const text = String(out);
    if (/not logged in/i.test(text)) return false;
    return /logged in/i.test(text);
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string };
    const text = `${e.stdout ?? ''}${e.stderr ?? ''}`;
    if (/logged in/i.test(text) && !/not logged in/i.test(text)) return true;
    return false;
  }
}

function runCommand(cmd: string, args: string[], cwd: string): { exitCode: number; output: string } {
  try {
    const output = execFileSync(cmd, args, {
      cwd,
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

/**
 * Post-verify tamper/hash-match proof step. Only invoked when the courier receipt's own
 * verifierResult already came back verified — this is an additional harness-level check,
 * not a substitute for the courier loop's own verification. Collects a FRESH evidence pack
 * from the disposable workspace's current (real) state — real `npm test`, real git diff via
 * collectIndependentEvidence, nothing fabricated — verifies it as collected, then verifies a
 * deep-cloned copy with commandsRun[0].outputHash flipped to 64 zeros WITHOUT recomputing
 * collectedEvidenceHash. The spine verifier must reject that tampered clone fail-closed.
 */
function runTamperRejectCheck(): {
  original: { verified: boolean; reason: string; verifierId: string };
  collectedEvidenceHash: string;
  recomputedEvidenceHash: string;
  hashesMatch: boolean;
  tampered: { verified: boolean; reason: string; verifierId: string };
  tamperRejected: boolean;
} {
  const test = runCommand('npm.cmd', ['test'], DISPOSABLE);

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
    claimedResultText: 'tamper-reject-check: fresh pack from disposable workspace state',
    error: null,
    durationMs: 0,
    appliedWrites: ['src/counter.js'],
    forceUsed: false,
  } as const;

  const pack = collectIndependentEvidence({
    taskId: 'tsk_courier_tamper_check',
    workspace: DISPOSABLE,
    cursor: fakeCursor as any,
    test: { command: 'npm test', exitCode: test.exitCode, output: test.output },
  });

  const project = buildCourierProjectContract(DISPOSABLE);
  const original = verifyEvidencePack(pack, { project });
  const recomputedEvidenceHash = computeEvidenceHash(pack);
  const hashesMatch = recomputedEvidenceHash.toLowerCase() === pack.collectedEvidenceHash.toLowerCase();

  const tamperedPack = structuredClone(pack) as typeof pack;
  (tamperedPack.commandsRun[0] as { outputHash: string }).outputHash = '0'.repeat(64);
  // collectedEvidenceHash intentionally left untouched — that is the tamper under test.
  const tampered = verifyEvidencePack(tamperedPack, { project });

  return {
    original,
    collectedEvidenceHash: pack.collectedEvidenceHash,
    recomputedEvidenceHash,
    hashesMatch,
    tampered,
    tamperRejected: tampered.verified === false && /hash/i.test(tampered.reason),
  };
}

async function main(): Promise<void> {
  mkdirSync(EVIDENCE, { recursive: true });
  if (!existsSync(AGENT)) {
    console.error('STOP: Cursor Agent CLI missing at', AGENT);
    process.exit(2);
  }
  if (!authOk()) {
    const msg = [
      'STOP: Cursor Agent not authenticated.',
      `Run once (CEO): "${AGENT}" login`,
      'Or set CURSOR_API_KEY in this shell only — never paste into chat.',
      'Do not copy task/diff/verdict messages — Atlas courier owns that.',
    ].join('\n');
    writeFileSync(join(EVIDENCE, 'AUTH-STOP-RESUME.txt'), msg, 'utf8');
    console.error(msg);
    process.exit(3);
  }
  const receipt = await runCourierLoop({
    disposableRepo: DISPOSABLE,
    evidenceDir: EVIDENCE,
    agentBin: AGENT,
    browserProfileDir: PROFILE,
    timeoutMs: 600_000,
    chatgptStartUrl: 'https://chatgpt.com/',
  });
  writeFileSync(join(EVIDENCE, 'COURIER-RECEIPT.json'), JSON.stringify(receipt, null, 2), 'utf8');

  let tamperCheck: ReturnType<typeof runTamperRejectCheck> | { skipped: string } = {
    skipped: 'receipt not verified; tamper-reject check only runs on a verified receipt',
  };
  const deterministicVerified =
    receipt.deterministicVerdict?.verified === true || receipt.verifierResult?.verified === true;
  if (deterministicVerified) {
    tamperCheck = runTamperRejectCheck();
    writeFileSync(join(EVIDENCE, 'TAMPER-REJECT-CHECK.json'), JSON.stringify(tamperCheck, null, 2), 'utf8');
  }

  console.log(
    JSON.stringify(
      {
        stopped: receipt.stopped,
        goRepairReject: receipt.goRepairReject,
        iterationCount: receipt.iterationCount,
        verifierVerified: receipt.verifierResult.verified,
        deterministicVerdict: receipt.deterministicVerdict,
        reviewerStatus: receipt.reviewerStatus,
        finalStatus: receipt.finalStatus,
        repairsApplied: receipt.repairsApplied,
        yusifCourierActions: receipt.yusifCourierActions,
        errors: receipt.errors,
        tamperCheck,
      },
      null,
      2,
    ),
  );
  process.exit(receipt.verifierResult.verified ? 0 : 1);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
