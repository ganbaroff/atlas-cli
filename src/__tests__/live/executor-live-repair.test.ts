/**
 * LIVE Wave 5 — a planted acceptance condition and exactly one repair.
 *
 * The executor is told to add /health. Atlas's acceptance ALSO requires /ready,
 * which the executor is never told up front. So attempt 1 must fail on disk,
 * Atlas must generate one bounded repair naming only the unmet condition, and
 * attempt 2 must close it. A second failure would have to be an honest REJECT —
 * the runner has no code path for a third attempt.
 */

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { ClineExecutorAdapter, type VendorAgent, type VendorAgentConfig } from '../../atlas/executor/cline-adapter.js';
import { AtlasToolBroker } from '../../atlas/executor/tool-broker.js';
import { approveProvider } from '../../atlas/executor/provider-authority.js';
import { runMissionWithBoundedRepair, type AcceptanceCheck } from '../../atlas/executor/mission-runner.js';
import { hmacSigner, hmacVerifier, signWorkOrder } from '../../atlas/work-order/sign.js';
import {
  acquireRepoWriterLease,
  clearRepoWriterLeaseForTests,
  releaseRepoWriterLease,
} from '../../atlas/work-order/repo-writer-lock.js';
import type { SignedWorkOrder, WorkOrder } from '../../atlas/work-order/types.js';

const SDK_ENTRY = 'C:/Projects/ATLAS/scratch/cline-probe/node_modules/@cline/agents/dist/index.js';
const FIXTURE = 'C:/Projects/ATLAS/scratch/mission-fixture';
const SECRET_SOURCE = 'C:/Users/user/OneDrive/Documents/GitHub/ANUS/.env';
const SIGNING_KEY = 'live-repair-signing-key';
const MISSION_ID = 'mission-live-repair-1';
const EXECUTOR_IDENTITY = 'atlas-executor:live-repair';
const evidenceDir = path.join(FIXTURE, '.atlas-evidence');

const runLive = existsSync(SDK_ENTRY) && existsSync(path.join(FIXTURE, 'server.js')) && existsSync(SECRET_SOURCE);

function resolveSecret(name: string): string | undefined {
  const raw = readFileSync(SECRET_SOURCE, 'utf8');
  for (const line of raw.split(/\r?\n/)) {
    const m = /^([A-Z_][A-Z0-9_]*)=(.*)$/.exec(line.trim());
    if (m && m[1] === name) return m[2].replace(/^["']|["']$/g, '');
  }
  return undefined;
}

function serverSource(): string {
  return readFileSync(path.join(FIXTURE, 'server.js'), 'utf8');
}

function testExitCode(): number {
  try {
    execFileSync('node', ['--test'], { cwd: FIXTURE, encoding: 'utf8', windowsHide: true });
    return 0;
  } catch (err) {
    return (err as { status?: number })?.status ?? 1;
  }
}

let signed: SignedWorkOrder;

beforeAll(() => {
  if (!runLive) return;
  execFileSync('git', ['-C', FIXTURE, 'checkout', '--', '.'], { windowsHide: true });
  execFileSync('git', ['-C', FIXTURE, 'clean', '-fdq', '-e', 'node_modules', '-e', '.atlas-evidence'], {
    windowsHide: true,
  });
  mkdirSync(evidenceDir, { recursive: true });
  clearRepoWriterLeaseForTests(FIXTURE);

  const baseHead = execFileSync('git', ['-C', FIXTURE, 'rev-parse', 'HEAD'], {
    encoding: 'utf8',
    windowsHide: true,
  }).trim();
  const now = Date.now();
  const order: WorkOrder = {
    workOrderId: 'wo-live-repair-1',
    goalId: 'goal-health-and-ready',
    taskId: 'task-health-and-ready',
    issuerIdentity: 'atlas-issuer:live-repair',
    executorIdentity: EXECUTOR_IDENTITY,
    repoCanonicalPath: FIXTURE,
    baseBranch: 'master',
    baseHead,
    worktreePath: FIXTURE,
    issuedAt: new Date(now - 1000).toISOString(),
    expiresAt: new Date(now + 1_800_000).toISOString(),
    nonce: `nonce-repair-${now}`,
    allowedPaths: ['server.js', 'server.test.js'],
    forbiddenPaths: ['package.json', 'node_modules/**', '.atlas-evidence/**'],
    forbiddenActions: [],
    allowedCommandClasses: ['filesystem', 'node', 'git'],
    maxAttempts: 2,
    maxWallClockMs: 900_000,
    expectedTests: ['node --test'],
    evidenceRequirements: ['changed-files', 'test-exit-code'],
    rollbackMethod: 'git-checkout--',
  };
  signed = signWorkOrder(order, hmacSigner(SIGNING_KEY));
});

afterAll(() => {
  if (!runLive) return;
  try {
    releaseRepoWriterLease({
      repoPath: FIXTURE,
      owner: { missionId: MISSION_ID, workOrderId: 'wo-live-repair-1' },
    });
  } catch {
    /* never mask the verdict */
  }
  if (existsSync(evidenceDir)) rmSync(evidenceDir, { recursive: true, force: true });
});

describe.skipIf(!runLive)('LIVE: planted acceptance failure and one bounded repair', () => {
  it('fails attempt 1 on the hidden condition and closes it on the single repair', async () => {
    const lease = acquireRepoWriterLease({
      repoPath: FIXTURE,
      owner: { missionId: MISSION_ID, workOrderId: 'wo-live-repair-1' },
    });
    expect(lease.ok).toBe(true);

    const provider = approveProvider({
      providerId: 'openai-compatible',
      modelId: 'gemini-2.5-flash',
      missionId: MISSION_ID,
      workOrderId: 'wo-live-repair-1',
      caller: 'live-repair-test',
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

    // Atlas's acceptance. /ready is the planted condition — the executor's
    // first instruction never mentions it.
    const checks: AcceptanceCheck[] = [
      {
        id: 'health-route',
        repairHint: 'server.js routes() must expose "/health" returning { status: "ok" }',
        run: () => ({ ok: serverSource().includes('/health'), detail: 'server.js scanned for /health' }),
      },
      {
        id: 'ready-route',
        repairHint: 'server.js routes() must ALSO expose "/ready" returning { ready: true }',
        run: () => ({ ok: serverSource().includes('/ready'), detail: 'server.js scanned for /ready' }),
      },
      {
        id: 'tests-green',
        repairHint: 'the fixture test suite must exit 0 under `node --test`',
        run: () => {
          const code = testExitCode();
          return { ok: code === 0, detail: `node --test exit=${code}` };
        },
      },
    ];

    const context = {
      missionId: MISSION_ID,
      signedWorkOrder: signed,
      worktreeRoot: FIXTURE,
      instruction:
        'Add a "/health" route to server.js returning { status: "ok" }, add a matching test to ' +
        'server.test.js, then run the test with run_command "node --test".',
      broker: new AtlasToolBroker({
        missionId: MISSION_ID,
        signedWorkOrder: signed,
        worktreeRoot: FIXTURE,
        executorIdentity: EXECUTOR_IDENTITY,
        startedAtMs: Date.now(),
        attemptNumber: 1,
        verifier: hmacVerifier(SIGNING_KEY),
      }),
      provider: routedProvider,
    };

    const adapter = new ClineExecutorAdapter({
      agentFactory: (config: VendorAgentConfig) => new mod.Agent(config),
    });

    const outcome = await runMissionWithBoundedRepair({
      adapter,
      context,
      checks,
      runAttempt: async (instruction, attempt) => {
        // A fresh adapter per attempt: a repair is a new bounded run, not a
        // continuation of a session that already believes it succeeded.
        const attemptAdapter = new ClineExecutorAdapter({
          agentFactory: (config: VendorAgentConfig) => new mod.Agent(config),
        });
        return attemptAdapter.execute({ ...context, instruction, broker: context.broker });
      },
    });

    // eslint-disable-next-line no-console -- this IS the mission receipt
    console.log(
      JSON.stringify(
        {
          repairMissionReceipt: {
            verdict: outcome.verdict,
            repairCycles: outcome.repairCycles,
            attempts: outcome.attempts.map((a) => ({
              attempt: a.attempt,
              executorStatus: a.executorStatus,
              toolCalls: a.toolCallsRequested,
              refused: a.toolCallsRefused,
              failedChecks: a.failedChecks.map((f) => f.id),
              repairNamed: a.repairInstruction
                ? a.repairInstruction.match(/- ([a-z-]+):/g)?.map((s) => s.slice(2, -1))
                : undefined,
            })),
            stillFailing: outcome.failedChecks.map((f) => f.id),
            healthPresent: serverSource().includes('/health'),
            readyPresent: serverSource().includes('/ready'),
            independentTestExitCode: testExitCode(),
            ceoCourierActions: 0,
          },
        },
        null,
        2,
      ),
    );

    // Structural guarantees, whatever the model did:
    expect(outcome.repairCycles).toBeLessThanOrEqual(1);
    expect(outcome.attempts.length).toBeLessThanOrEqual(2);
    // Attempt 1 must have missed the planted condition — otherwise the test
    // proved nothing about repair.
    expect(outcome.attempts[0]?.failedChecks.map((f) => f.id)).toContain('ready-route');
    // The repair instruction must name the planted condition and nothing else
    // that already passed.
    expect(outcome.attempts[0]?.repairInstruction).toContain('ready-route');
  }, 900_000);
});

describe.skipIf(runLive)('LIVE repair mission skipped', () => {
  it('states what was missing', () => {
    // eslint-disable-next-line no-console -- a skip must never read as a pass
    console.log(`LIVE REPAIR SKIPPED — sdk:${existsSync(SDK_ENTRY)} fixture:${existsSync(FIXTURE)}`);
    expect(runLive).toBe(false);
  });
});
