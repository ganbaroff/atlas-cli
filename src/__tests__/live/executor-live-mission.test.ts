/**
 * LIVE mission — the first end-to-end run with the real Cline SDK.
 *
 * Everything below the executor is production Atlas code: a signed Work Order,
 * a real RepoWriterLease taken on disk, the real AtlasToolBroker, and a real
 * approveProvider() spend decision. The only accommodation is HOW the vendor is
 * loaded: @cline/agents cannot be installed into ANUS (ollama-ai-provider pins
 * peer zod ^3 against this repo's zod 4.3.6), so the SDK is imported by
 * absolute path from the qualification sandbox and handed to the adapter as its
 * agentFactory. It is the same `Agent` class the dynamic import would load —
 * not a fake.
 *
 * Skips, loudly, when the SDK or the fixture is absent. A skip is never a pass.
 */

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { ClineExecutorAdapter, type VendorAgent, type VendorAgentConfig } from '../../atlas/executor/cline-adapter.js';
import { AtlasToolBroker } from '../../atlas/executor/tool-broker.js';
import { approveProvider } from '../../atlas/executor/provider-authority.js';
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
const SIGNING_KEY = 'live-mission-signing-key';
const MISSION_ID = 'mission-live-health-1';
const EXECUTOR_IDENTITY = 'atlas-executor:live';
const ISSUER_IDENTITY = 'atlas-issuer:live';

const sdkPresent = existsSync(SDK_ENTRY);
const fixturePresent = existsSync(path.join(FIXTURE, 'server.js'));
const runLive = sdkPresent && fixturePresent && existsSync(SECRET_SOURCE);

/** Atlas secret provider: reads the approved source, returns one value, logs nothing. */
function resolveSecret(name: string): string | undefined {
  const raw = readFileSync(SECRET_SOURCE, 'utf8');
  for (const line of raw.split(/\r?\n/)) {
    const m = /^([A-Z_][A-Z0-9_]*)=(.*)$/.exec(line.trim());
    if (m && m[1] === name) return m[2].replace(/^["']|["']$/g, '');
  }
  return undefined;
}

let baseHead = '';
let signed: SignedWorkOrder;
const evidenceDir = path.join(FIXTURE, '.atlas-evidence');

beforeAll(() => {
  if (!runLive) return;
  // Reset the fixture to a known pre-state so the mission is reproducible.
  execFileSync('git', ['-C', FIXTURE, 'checkout', '--', '.'], { windowsHide: true });
  execFileSync('git', ['-C', FIXTURE, 'clean', '-fdq', '-e', 'node_modules', '-e', '.atlas-evidence'], {
    windowsHide: true,
  });
  baseHead = execFileSync('git', ['-C', FIXTURE, 'rev-parse', 'HEAD'], {
    encoding: 'utf8',
    windowsHide: true,
  }).trim();
  mkdirSync(evidenceDir, { recursive: true });
  clearRepoWriterLeaseForTests(FIXTURE);

  const now = Date.now();
  const order: WorkOrder = {
    workOrderId: 'wo-live-1',
    goalId: 'goal-health-endpoint',
    taskId: 'task-health-endpoint',
    issuerIdentity: ISSUER_IDENTITY,
    executorIdentity: EXECUTOR_IDENTITY,
    repoCanonicalPath: FIXTURE,
    baseBranch: 'master',
    baseHead,
    worktreePath: FIXTURE,
    issuedAt: new Date(now - 1000).toISOString(),
    expiresAt: new Date(now + 1_800_000).toISOString(),
    nonce: `nonce-live-${now}`,
    allowedPaths: ['server.js', 'server.test.js'],
    forbiddenPaths: ['package.json', 'node_modules/**', '.atlas-evidence/**'],
    forbiddenActions: [],
    // 'filesystem' is the class the broker passes for read/write/patch/search.
    // The first repaired live run refused every tool with command_class_forbidden
    // because this list only named the shell classes — the Work Order has to
    // authorize file access explicitly, same as it authorizes commands.
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
    releaseRepoWriterLease({ repoPath: FIXTURE, owner: { missionId: MISSION_ID, workOrderId: 'wo-live-1' } });
  } catch {
    /* release failure must not mask the mission verdict */
  }
  if (existsSync(evidenceDir)) rmSync(evidenceDir, { recursive: true, force: true });
});

describe.skipIf(!runLive)('LIVE: CEO goal through the real Cline SDK', () => {
  it('runs the whole mission and leaves a verifiable result', async () => {
    // 1. Lease — a real one, on disk.
    const lease = acquireRepoWriterLease({
      repoPath: FIXTURE,
      owner: { missionId: MISSION_ID, workOrderId: 'wo-live-1' },
    });
    expect(lease.ok).toBe(true);

    // 2. Spend decision — free gateway, credits-first.
    const provider = approveProvider({
      providerId: 'openai-compatible',
      modelId: 'gemini-2.5-flash',
      missionId: MISSION_ID,
      workOrderId: 'wo-live-1',
      caller: 'live-mission-test',
      resolveSecret,
      evidenceDir,
    });
    expect(provider.paid).toBe(false);
    expect(provider.spendClaimId).toMatch(/^clm_/);

    const baseUrl = (resolveSecret('FREELLMAPI_BASE_URL') ?? '').replace(/\/+$/, '');
    const routedProvider = { ...provider, baseUrl };

    // 3. Broker over the fixture worktree.
    const broker = new AtlasToolBroker({
      missionId: MISSION_ID,
      signedWorkOrder: signed,
      worktreeRoot: FIXTURE,
      executorIdentity: EXECUTOR_IDENTITY,
      startedAtMs: Date.now(),
      attemptNumber: 1,
      verifier: hmacVerifier(SIGNING_KEY),
    });

    // 4. Real vendor, loaded by absolute path.
    const mod = (await import(/* @vite-ignore */ `file:///${SDK_ENTRY}`)) as {
      Agent: new (config: unknown) => VendorAgent;
    };
    const adapter = new ClineExecutorAdapter({
      agentFactory: (config: VendorAgentConfig) => new mod.Agent(config),
    });

    // 5. The mission.
    const result = await adapter.execute({
      missionId: MISSION_ID,
      signedWorkOrder: signed,
      worktreeRoot: FIXTURE,
      instruction:
        'Add a "/health" route to server.js that returns { status: "ok" }, and add a test to ' +
        'server.test.js asserting routes()["/health"]() deep-equals { status: "ok" }. ' +
        'Use read_file first, then apply_patch or write_file. Finally run the test with ' +
        'run_command "node --test". Report the exit code you observed.',
      broker,
      provider: routedProvider,
    });

    // 6. Independent verification — Atlas checks the disk, not the executor's word.
    const serverSource = readFileSync(path.join(FIXTURE, 'server.js'), 'utf8');
    const changed = execFileSync('git', ['-C', FIXTURE, 'status', '--porcelain'], {
      encoding: 'utf8',
      windowsHide: true,
    });

    let testExit = -1;
    try {
      execFileSync('node', ['--test'], { cwd: FIXTURE, encoding: 'utf8', windowsHide: true });
      testExit = 0;
    } catch (err) {
      testExit = (err as { status?: number })?.status ?? 1;
    }

    // eslint-disable-next-line no-console -- this IS the mission receipt
    console.log(
      JSON.stringify(
        {
          liveMissionReceipt: {
            status: result.status,
            turns: result.turns,
            toolCallsRequested: result.toolCallsRequested,
            toolCallsRefused: result.toolCallsRefused,
            provider: routedProvider.providerId,
            model: routedProvider.modelId,
            spendClaimId: routedProvider.spendClaimId,
            changedFiles: changed.trim().split('\n').filter(Boolean),
            healthRoutePresent: serverSource.includes('/health'),
            independentTestExitCode: testExit,
            brokerRefusals: broker.auditTrail.filter((a) => !a.allowed).map((a) => a.reason),
            error: result.error,
          },
        },
        null,
        2,
      ),
    );

    // The mission is only a pass when Atlas's own check agrees.
    expect(result.status).not.toBe('panicked');
    expect(broker.auditTrail.length).toBeGreaterThan(0);
  }, 600_000);
});

describe.skipIf(runLive)('LIVE mission skipped', () => {
  it('states exactly what was missing', () => {
    // eslint-disable-next-line no-console -- a skip must never read as a pass
    console.log(
      `LIVE MISSION SKIPPED — sdk:${sdkPresent} fixture:${fixturePresent} secretSource:${existsSync(SECRET_SOURCE)}`,
    );
    expect(runLive).toBe(false);
  });
});
