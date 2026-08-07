/**
 * LIVE Wave 10 — the first mission against ANUS itself.
 *
 * Debt chosen deliberately narrow: one of the three pre-existing typecheck
 * errors, `src/courier/courier-loop.ts(549,23) TS2367`, where a defence-in-depth
 * identity check compares two literal adapter-id types that tsc can prove never
 * overlap. One file, one expression, no security surface, no architecture.
 * DEBT-6 (deleting the dead OpenManus path) was rejected as the first ANUS
 * proof: it touches six files, which the execution order excludes.
 *
 * Acceptance is deterministic and Atlas-owned: the repo's typecheck error count
 * must drop from the recorded baseline of 3 to 2, the runtime identity check
 * must still exist, and the courier tests must not regress. No merge, no push —
 * the mission runs in its own throwaway worktree so ANUS itself is untouched.
 */

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { ClineExecutorAdapter, type VendorAgent, type VendorAgentConfig } from '../../atlas/executor/cline-adapter.js';
import { AtlasToolBroker } from '../../atlas/executor/tool-broker.js';
import { approveProvider } from '../../atlas/executor/provider-authority.js';
import { runMissionWithBoundedRepair, type AcceptanceCheck } from '../../atlas/executor/mission-runner.js';
import { parsePorcelain, rollbackMission } from '../../atlas/executor/rollback.js';
import { hmacSigner, hmacVerifier, signWorkOrder } from '../../atlas/work-order/sign.js';
import {
  acquireRepoWriterLease,
  clearRepoWriterLeaseForTests,
  releaseRepoWriterLease,
} from '../../atlas/work-order/repo-writer-lock.js';
import type { SignedWorkOrder, WorkOrder } from '../../atlas/work-order/types.js';

const SDK_ENTRY = 'C:/Projects/ATLAS/scratch/cline-probe/node_modules/@cline/agents/dist/index.js';
const SECRET_SOURCE = 'C:/Users/user/OneDrive/Documents/GitHub/ANUS/.env';
const ANUS_ROOT = 'C:/Users/user/OneDrive/Documents/GitHub/ANUS';
const MISSION_WORKTREE = `${ANUS_ROOT}/.worktrees/atlas-mission-courier-ts2367`;
const MISSION_BRANCH = 'atlas/mission-courier-ts2367';
const TARGET_FILE = 'src/courier/courier-loop.ts';
const SIGNING_KEY = 'live-anus-signing-key';
const MISSION_ID = 'mission-live-anus-1';
const WORK_ORDER_ID = 'wo-live-anus-1';
const EXECUTOR_IDENTITY = 'atlas-executor:live-anus';
const EVIDENCE_DIRNAME = '.atlas-evidence';

const runLive = existsSync(SDK_ENTRY) && existsSync(SECRET_SOURCE) && existsSync(ANUS_ROOT);

function resolveSecret(name: string): string | undefined {
  const raw = readFileSync(SECRET_SOURCE, 'utf8');
  for (const line of raw.split(/\r?\n/)) {
    const m = /^([A-Z_][A-Z0-9_]*)=(.*)$/.exec(line.trim());
    if (m && m[1] === name) return m[2].replace(/^["']|["']$/g, '');
  }
  return undefined;
}

function gitIn(repo: string, args: string[]): string {
  return execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8', windowsHide: true });
}

/** Typecheck error count in the mission worktree. Atlas's own measurement. */
function typecheckErrors(): number {
  try {
    execFileSync(process.execPath, ['node_modules/typescript/bin/tsc', '--noEmit'], {
      cwd: MISSION_WORKTREE,
      encoding: 'utf8',
      windowsHide: true,
    });
    return 0;
  } catch (err) {
    const out = `${(err as { stdout?: string })?.stdout ?? ''}`;
    return out.split(/\r?\n/).filter((l) => /error TS\d+/.test(l)).length;
  }
}

let signed: SignedWorkOrder;
let baselineErrors = 0;
let evidenceDir = '';

beforeAll(() => {
  if (!runLive) return;
  if (existsSync(MISSION_WORKTREE)) {
    try {
      gitIn(ANUS_ROOT, ['worktree', 'remove', '--force', MISSION_WORKTREE]);
    } catch {
      rmSync(MISSION_WORKTREE, { recursive: true, force: true });
    }
  }
  try {
    gitIn(ANUS_ROOT, ['branch', '-D', MISSION_BRANCH]);
  } catch {
    /* branch may not exist */
  }
  gitIn(ANUS_ROOT, ['worktree', 'add', '-b', MISSION_BRANCH, MISSION_WORKTREE, 'HEAD']);

  // The mission worktree needs the toolchain to run its own typecheck.
  execFileSync(
    'cmd',
    ['/c', 'mklink', '/J', path.join(MISSION_WORKTREE, 'node_modules'), path.join(ANUS_ROOT, 'node_modules')],
    { encoding: 'utf8', windowsHide: true },
  );

  evidenceDir = path.join(MISSION_WORKTREE, EVIDENCE_DIRNAME);
  mkdirSync(evidenceDir, { recursive: true });
  clearRepoWriterLeaseForTests(MISSION_WORKTREE);

  baselineErrors = typecheckErrors();

  const baseHead = gitIn(MISSION_WORKTREE, ['rev-parse', 'HEAD']).trim();
  const now = Date.now();
  const order: WorkOrder = {
    workOrderId: WORK_ORDER_ID,
    goalId: 'goal-courier-ts2367',
    taskId: 'task-courier-ts2367',
    issuerIdentity: 'atlas-issuer:live-anus',
    executorIdentity: EXECUTOR_IDENTITY,
    repoCanonicalPath: MISSION_WORKTREE,
    baseBranch: MISSION_BRANCH,
    baseHead,
    worktreePath: MISSION_WORKTREE,
    issuedAt: new Date(now - 1000).toISOString(),
    expiresAt: new Date(now + 1_800_000).toISOString(),
    nonce: `nonce-anus-${now}`,
    // One file. Nothing else in ANUS is reachable from this mission.
    allowedPaths: [TARGET_FILE],
    forbiddenPaths: ['package.json', 'node_modules/**', '.git/**', `${EVIDENCE_DIRNAME}/**`],
    forbiddenActions: [],
    allowedCommandClasses: ['filesystem'],
    maxAttempts: 2,
    maxWallClockMs: 1_800_000,
    expectedTests: ['tsc --noEmit'],
    evidenceRequirements: ['typecheck-error-count', 'changed-files'],
    rollbackMethod: 'git-checkout--',
  };
  signed = signWorkOrder(order, hmacSigner(SIGNING_KEY));
}, 300_000);

afterAll(() => {
  if (!runLive) return;
  try {
    releaseRepoWriterLease({ repoPath: MISSION_WORKTREE, owner: { missionId: MISSION_ID, workOrderId: WORK_ORDER_ID } });
  } catch {
    /* never mask the verdict */
  }
}, 120_000);

describe.skipIf(!runLive)('LIVE: first mission against ANUS itself', () => {
  it('fixes a real typecheck debt in an isolated worktree, or REJECTs honestly', async () => {
    expect(baselineErrors).toBeGreaterThan(0);

    const lease = acquireRepoWriterLease({
      repoPath: MISSION_WORKTREE,
      owner: { missionId: MISSION_ID, workOrderId: WORK_ORDER_ID },
    });
    expect(lease.ok).toBe(true);

    const provider = approveProvider({
      providerId: 'openai-compatible',
      modelId: 'gemini-3.5-flash',
      missionId: MISSION_ID,
      workOrderId: WORK_ORDER_ID,
      caller: 'live-anus-test',
      resolveSecret,
      evidenceDir,
    });
    const routedProvider = {
      ...provider,
      baseUrl: (resolveSecret('FREELLMAPI_BASE_URL') ?? '').replace(/\/+$/, ''),
    };

    const broker = new AtlasToolBroker({
      missionId: MISSION_ID,
      signedWorkOrder: signed,
      worktreeRoot: MISSION_WORKTREE,
      executorIdentity: EXECUTOR_IDENTITY,
      startedAtMs: Date.now(),
      attemptNumber: 1,
      verifier: hmacVerifier(SIGNING_KEY),
    });

    const mod = (await import(/* @vite-ignore */ `file:///${SDK_ENTRY}`)) as {
      Agent: new (config: unknown) => VendorAgent;
    };

    const checks: AcceptanceCheck[] = [
      {
        id: 'typecheck-error-reduced',
        repairHint: `the repo's tsc error count must drop below ${baselineErrors}; fix the TS2367 in ${TARGET_FILE} without deleting the check`,
        run: () => {
          const now = typecheckErrors();
          return { ok: now < baselineErrors, detail: `tsc errors ${baselineErrors} -> ${now}` };
        },
      },
      {
        id: 'identity-check-preserved',
        repairHint: 'the runtime IDENTITY_COLLISION guard must still exist — do not delete the check to silence tsc',
        run: () => {
          const src = readFileSync(path.join(MISSION_WORKTREE, TARGET_FILE), 'utf8');
          return { ok: src.includes('IDENTITY_COLLISION'), detail: 'guard presence scanned' };
        },
      },
    ];

    const context = {
      missionId: MISSION_ID,
      signedWorkOrder: signed,
      worktreeRoot: MISSION_WORKTREE,
      instruction:
        `In ${TARGET_FILE} around line 549 there is a TypeScript error TS2367: a comparison between ` +
        `two adapter id literal types that TypeScript proves can never overlap. The comparison is a ` +
        `deliberate defence-in-depth runtime check that an executor is not also the reviewer, so it ` +
        `must KEEP working at runtime and the IDENTITY_COLLISION branch must stay. Fix only the type ` +
        `error — for example by comparing the two ids as plain strings — using read_file then ` +
        `apply_patch. Change nothing else in the file.`,
      broker,
      provider: routedProvider,
    };

    const outcome = await runMissionWithBoundedRepair({
      adapter: new ClineExecutorAdapter({ agentFactory: (c: VendorAgentConfig) => new mod.Agent(c) }),
      context,
      checks,
      runAttempt: async (instruction) => {
        const attemptAdapter = new ClineExecutorAdapter({
          agentFactory: (c: VendorAgentConfig) => new mod.Agent(c),
        });
        return attemptAdapter.execute({ ...context, instruction });
      },
    });

    const finalErrors = typecheckErrors();
    const changed = gitIn(MISSION_WORKTREE, ['status', '--porcelain']).trim().split('\n').filter(Boolean);
    const canonicalDirty = gitIn(ANUS_ROOT, ['status', '--porcelain']).trim().split('\n').filter(Boolean);

    // eslint-disable-next-line no-console -- this IS the mission receipt
    console.log(
      JSON.stringify(
        {
          anusMissionReceipt: {
            verdict: outcome.verdict,
            repairCycles: outcome.repairCycles,
            attempts: outcome.attempts.map((a) => ({
              attempt: a.attempt,
              executorStatus: a.executorStatus,
              toolCalls: a.toolCallsRequested,
              refused: a.toolCallsRefused,
              failedChecks: a.failedChecks.map((f) => f.id),
            })),
            brokerRefusals: broker.auditTrail.filter((e) => !e.allowed).map((e) => e.reason),
            typecheckErrors: { baseline: baselineErrors, final: finalErrors },
            changedFilesInMissionWorktree: changed,
            canonicalAnusDirtyFiles: canonicalDirty.length,
            missionWorktree: MISSION_WORKTREE,
            missionBranch: MISSION_BRANCH,
            pushed: false,
            merged: false,
            ceoCourierActions: 0,
          },
        },
        null,
        2,
      ),
    );

    // Isolation is non-negotiable regardless of the verdict: the mission may
    // only have touched its own worktree, and only the one allowed file.
    // Uses the shared porcelain parser — hand-slicing the status prefix ate a
    // character off the path and failed this assertion on a mission that had
    // actually succeeded.
    for (const entry of parsePorcelain(gitIn(MISSION_WORKTREE, ['status', '--porcelain']))) {
      const isEvidence = entry.path.startsWith(EVIDENCE_DIRNAME);
      expect(isEvidence || entry.path === TARGET_FILE).toBe(true);
    }

    if (outcome.verdict === 'REJECT') {
      const rollback = rollbackMission({
        signedWorkOrder: signed,
        worktreeRoot: MISSION_WORKTREE,
        preservePaths: [`${EVIDENCE_DIRNAME}/`],
      });
      expect(rollback.ok).toBe(true);
      expect(typecheckErrors()).toBe(baselineErrors);
    } else {
      expect(finalErrors).toBeLessThan(baselineErrors);
      expect(readFileSync(path.join(MISSION_WORKTREE, TARGET_FILE), 'utf8')).toContain('IDENTITY_COLLISION');
    }
  }, 1_800_000);
});

describe.skipIf(runLive)('LIVE ANUS mission skipped', () => {
  it('states what was missing', () => {
    // eslint-disable-next-line no-console -- a skip must never read as a pass
    console.log(`LIVE ANUS SKIPPED — sdk:${existsSync(SDK_ENTRY)} anus:${existsSync(ANUS_ROOT)}`);
    expect(runLive).toBe(false);
  });
});
