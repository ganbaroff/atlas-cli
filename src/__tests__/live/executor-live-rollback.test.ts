/**
 * LIVE Wave 9 — a mission that changes several files, fails final acceptance,
 * and is rolled back.
 *
 * One acceptance condition is unsatisfiable by construction, so the mission
 * must end REJECT after exactly one repair. What is being proved is what
 * happens next: the changed set is known, the worktree returns to its declared
 * pre-state, the evidence pack survives, HEAD is untouched, and the lease is
 * released.
 */

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { ClineExecutorAdapter, type VendorAgent, type VendorAgentConfig } from '../../atlas/executor/cline-adapter.js';
import { AtlasToolBroker } from '../../atlas/executor/tool-broker.js';
import { approveProvider } from '../../atlas/executor/provider-authority.js';
import { runMissionWithBoundedRepair, type AcceptanceCheck } from '../../atlas/executor/mission-runner.js';
import { rollbackMission } from '../../atlas/executor/rollback.js';
import { hmacSigner, hmacVerifier, signWorkOrder } from '../../atlas/work-order/sign.js';
import {
  acquireRepoWriterLease,
  clearRepoWriterLeaseForTests,
  getRepoWriterLeaseInfo,
  releaseRepoWriterLease,
} from '../../atlas/work-order/repo-writer-lock.js';
import type { SignedWorkOrder, WorkOrder } from '../../atlas/work-order/types.js';

const SDK_ENTRY = 'C:/Projects/ATLAS/scratch/cline-probe/node_modules/@cline/agents/dist/index.js';
const FIXTURE = 'C:/Projects/ATLAS/scratch/mission-fixture';
const SECRET_SOURCE = 'C:/Users/user/OneDrive/Documents/GitHub/ANUS/.env';
const SIGNING_KEY = 'live-rollback-signing-key';
const MISSION_ID = 'mission-live-rollback-1';
const WORK_ORDER_ID = 'wo-live-rollback-1';
const EXECUTOR_IDENTITY = 'atlas-executor:live-rollback';
const EVIDENCE_DIRNAME = '.atlas-evidence';
const evidenceDir = path.join(FIXTURE, EVIDENCE_DIRNAME);

const runLive = existsSync(SDK_ENTRY) && existsSync(path.join(FIXTURE, 'server.js')) && existsSync(SECRET_SOURCE);

function resolveSecret(name: string): string | undefined {
  const raw = readFileSync(SECRET_SOURCE, 'utf8');
  for (const line of raw.split(/\r?\n/)) {
    const m = /^([A-Z_][A-Z0-9_]*)=(.*)$/.exec(line.trim());
    if (m && m[1] === name) return m[2].replace(/^["']|["']$/g, '');
  }
  return undefined;
}

function git(args: string[]): string {
  return execFileSync('git', ['-C', FIXTURE, ...args], { encoding: 'utf8', windowsHide: true });
}

let signed: SignedWorkOrder;
let preStateServer = '';
let preStateHead = '';

beforeAll(() => {
  if (!runLive) return;
  git(['checkout', '--', '.']);
  git(['clean', '-fdq', '-e', 'node_modules', '-e', EVIDENCE_DIRNAME]);
  mkdirSync(evidenceDir, { recursive: true });
  clearRepoWriterLeaseForTests(FIXTURE);

  preStateServer = readFileSync(path.join(FIXTURE, 'server.js'), 'utf8');
  preStateHead = git(['rev-parse', 'HEAD']).trim();

  const now = Date.now();
  const order: WorkOrder = {
    workOrderId: WORK_ORDER_ID,
    goalId: 'goal-rollback',
    taskId: 'task-rollback',
    issuerIdentity: 'atlas-issuer:live-rollback',
    executorIdentity: EXECUTOR_IDENTITY,
    repoCanonicalPath: FIXTURE,
    baseBranch: 'master',
    baseHead: preStateHead,
    worktreePath: FIXTURE,
    issuedAt: new Date(now - 1000).toISOString(),
    expiresAt: new Date(now + 1_800_000).toISOString(),
    nonce: `nonce-rollback-${now}`,
    allowedPaths: ['server.js', 'server.test.js'],
    forbiddenPaths: ['package.json', 'node_modules/**', `${EVIDENCE_DIRNAME}/**`],
    forbiddenActions: [],
    allowedCommandClasses: ['filesystem', 'node', 'git'],
    maxAttempts: 2,
    maxWallClockMs: 900_000,
    expectedTests: ['node --test'],
    evidenceRequirements: ['changed-files', 'rollback-result'],
    rollbackMethod: 'git-checkout--',
  };
  signed = signWorkOrder(order, hmacSigner(SIGNING_KEY));
});

afterAll(() => {
  if (!runLive) return;
  if (existsSync(evidenceDir)) rmSync(evidenceDir, { recursive: true, force: true });
});

describe.skipIf(!runLive)('LIVE: failed acceptance is rolled back', () => {
  it('REJECTs, restores the pre-state, keeps evidence, and releases the lease', async () => {
    const lease = acquireRepoWriterLease({
      repoPath: FIXTURE,
      owner: { missionId: MISSION_ID, workOrderId: WORK_ORDER_ID },
    });
    expect(lease.ok).toBe(true);

    const provider = approveProvider({
      providerId: 'openai-compatible',
      modelId: 'gemini-2.5-flash',
      missionId: MISSION_ID,
      workOrderId: WORK_ORDER_ID,
      caller: 'live-rollback-test',
      resolveSecret,
      evidenceDir,
    });
    const routedProvider = {
      ...provider,
      baseUrl: (resolveSecret('FREELLMAPI_BASE_URL') ?? '').replace(/\/+$/, ''),
    };

    const mod = (await import(/* @vite-ignore */ `file:///${SDK_ENTRY}`)) as {
      Agent: new (config: unknown) => VendorAgent;
    };

    const broker = new AtlasToolBroker({
      missionId: MISSION_ID,
      signedWorkOrder: signed,
      worktreeRoot: FIXTURE,
      executorIdentity: EXECUTOR_IDENTITY,
      startedAtMs: Date.now(),
      attemptNumber: 1,
      verifier: hmacVerifier(SIGNING_KEY),
    });

    const checks: AcceptanceCheck[] = [
      {
        id: 'metrics-route',
        repairHint: 'server.js routes() must expose "/metrics"',
        run: () => ({
          ok: readFileSync(path.join(FIXTURE, 'server.js'), 'utf8').includes('/metrics'),
          detail: 'server.js scanned for /metrics',
        }),
      },
      {
        // Unsatisfiable on purpose: no reachable edit can make this true, so the
        // mission MUST end REJECT after one repair. This is the rollback trigger.
        id: 'unsatisfiable-invariant',
        repairHint: 'this condition cannot be satisfied; it exists to force a REJECT',
        run: () => ({ ok: false, detail: 'invariant is false by construction' }),
      },
    ];

    const context = {
      missionId: MISSION_ID,
      signedWorkOrder: signed,
      worktreeRoot: FIXTURE,
      instruction:
        'Add a "/metrics" route to server.js returning { uptime: 0 }, add a matching test to ' +
        'server.test.js, then run the test with run_command "node --test".',
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

    expect(outcome.verdict).toBe('REJECT');

    // Evidence written BEFORE the rollback must survive it.
    const receiptPath = path.join(evidenceDir, 'rollback-receipt.json');
    writeFileSync(receiptPath, JSON.stringify({ verdict: outcome.verdict }), 'utf8');

    const dirtyBeforeRollback = git(['status', '--porcelain']);
    const rollback = rollbackMission({
      signedWorkOrder: signed,
      worktreeRoot: FIXTURE,
      preservePaths: [`${EVIDENCE_DIRNAME}/`],
    });

    const released = releaseRepoWriterLease({
      repoPath: FIXTURE,
      owner: { missionId: MISSION_ID, workOrderId: WORK_ORDER_ID },
    });
    const leaseAfter = getRepoWriterLeaseInfo(FIXTURE);

    // eslint-disable-next-line no-console -- this IS the mission receipt
    console.log(
      JSON.stringify(
        {
          rollbackMissionReceipt: {
            verdict: outcome.verdict,
            repairCycles: outcome.repairCycles,
            attempts: outcome.attempts.map((a) => ({
              attempt: a.attempt,
              executorStatus: a.executorStatus,
              toolCalls: a.toolCallsRequested,
              refused: a.toolCallsRefused,
            })),
            brokerRefusals: broker.auditTrail.filter((e) => !e.allowed).map((e) => e.reason),
            stillFailing: outcome.failedChecks.map((f) => f.id),
            dirtyBeforeRollback: dirtyBeforeRollback.trim().split('\n').filter(Boolean),
            rollbackOk: rollback.ok,
            rollbackMethod: rollback.ok ? rollback.method : undefined,
            rollbackReason: rollback.ok ? undefined : rollback.reason,
            changedBefore: rollback.changedBefore.map((c) => c.path),
            changedAfter: rollback.changedAfter.map((c) => c.path),
            serverRestored: readFileSync(path.join(FIXTURE, 'server.js'), 'utf8') === preStateServer,
            evidenceSurvived: existsSync(receiptPath),
            headUnchanged: git(['rev-parse', 'HEAD']).trim() === preStateHead,
            leaseReleased: released.ok === true && leaseAfter?.status === 'released',
            ceoCourierActions: 0,
          },
        },
        null,
        2,
      ),
    );

    expect(rollback.ok).toBe(true);
    expect(readFileSync(path.join(FIXTURE, 'server.js'), 'utf8')).toBe(preStateServer);
    expect(existsSync(receiptPath)).toBe(true);
    expect(git(['rev-parse', 'HEAD']).trim()).toBe(preStateHead);
    expect(leaseAfter?.status).toBe('released');
  }, 900_000);
});

describe.skipIf(runLive)('LIVE rollback mission skipped', () => {
  it('states what was missing', () => {
    // eslint-disable-next-line no-console -- a skip must never read as a pass
    console.log(`LIVE ROLLBACK SKIPPED — sdk:${existsSync(SDK_ENTRY)} fixture:${existsSync(FIXTURE)}`);
    expect(runLive).toBe(false);
  });
});
