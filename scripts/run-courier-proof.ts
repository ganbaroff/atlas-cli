/**
 * Resume entry for courier-replacement proof after CEO auth.
 * Usage (from ANUS): npx tsx scripts/run-courier-proof.ts
 * Does not print secrets. Stops if Cursor Agent not authenticated.
 */
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { runCourierLoop } from '../src/courier/courier-loop.js';

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
  console.log(
    JSON.stringify(
      {
        stopped: receipt.stopped,
        goRepairReject: receipt.goRepairReject,
        iterationCount: receipt.iterationCount,
        verifierVerified: receipt.verifierResult.verified,
        yusifCourierActions: receipt.yusifCourierActions,
        errors: receipt.errors,
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
