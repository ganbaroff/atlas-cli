/**
 * runner-health-no-claim.test.ts — Wave 1 five-fixture chain + denial proofs.
 * Fixture roots live under os.tmpdir() only. Never touches production roots.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';

import {
  runRunnerHealth,
  type RunnerHealthReport,
} from '../atlas/runner-health.js';
import {
  shouldAcquireInstanceLease,
} from '../atlas/instance-lease.js';
import {
  STATE_ROOT_ACTIVATION_FILE,
  STATE_STORES,
} from '../atlas/state-root.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_SRC = join(HERE, '..');
const RUNNER_HEALTH_SRC = join(REPO_SRC, 'atlas', 'runner-health.ts');
const INSTANCE_LEASE_SRC = join(REPO_SRC, 'atlas', 'instance-lease.ts');
const CLI_SRC = join(REPO_SRC, 'cli.ts');

const MANAGED_ENV = [
  'ATLAS_STATE_ROOT',
  'ATLAS_STATE_ROOT_REQUIRED',
  'ATLAS_NODE_ROLE',
  'ATLAS_INSTANCE_LEASE_DIR',
  'ATLAS_EXEC_GRAPH_DIR',
  'ATLAS_EVIDENCE_DIR',
  'ATLAS_GOAL_BUDGET_DIR',
  'ATLAS_LEARNING_STATE_DIR',
  'ATLAS_STATE_DIR',
  'ATLAS_PROVIDER_HEALTH_DIR',
  'ATLAS_SPEND_RECEIPT_DIR',
  'ATLAS_BREADCRUMB_DIR',
  'ATLAS_OPSBOARD_EXCHANGE_DIR',
  'ATLAS_NOTIFY_QUEUE_PATH',
  'SUPABASE_URL',
  'SUPABASE_SERVICE_ROLE_KEY',
  'NEXT_PUBLIC_SUPABASE_URL',
] as const;

const BANLIST = [
  'claimNextCommand',
  'completeCommand',
  'failCommand',
  'runTask',
  'task-spawner',
  'peekQueue',
  'annotateInstanceLease',
  'acquireInstanceLease',
  'startInstanceLeaseHeartbeat',
  'supabase-memory',
  'createClient',
  '@supabase',
] as const;

type FsManifest = {
  files: Record<string, { sha256: string; mtimeMs: number; size: number }>;
  rootSha256: string;
};

function walkFiles(root: string): string[] {
  const out: string[] = [];
  const stack = [root];
  while (stack.length) {
    const cur = stack.pop()!;
    if (!existsSync(cur)) continue;
    const st = statSync(cur);
    if (st.isDirectory()) {
      for (const name of readdirSync(cur)) stack.push(join(cur, name));
    } else if (st.isFile()) {
      out.push(cur);
    }
  }
  return out.sort();
}

function fsManifest(root: string): FsManifest {
  const files: FsManifest['files'] = {};
  const hash = createHash('sha256');
  for (const abs of walkFiles(root)) {
    const rel = relative(root, abs).replace(/\\/g, '/');
    const buf = readFileSync(abs);
    const sha256 = createHash('sha256').update(buf).digest('hex');
    const st = statSync(abs);
    files[rel] = { sha256, mtimeMs: st.mtimeMs, size: st.size };
    hash.update(rel);
    hash.update('\0');
    hash.update(sha256);
    hash.update('\0');
    hash.update(String(st.mtimeMs));
    hash.update('\n');
  }
  return { files, rootSha256: hash.digest('hex') };
}

function expectUnchanged(before: FsManifest, after: FsManifest): void {
  expect(after.rootSha256).toBe(before.rootSha256);
  expect(after.files).toEqual(before.files);
}

function writeActivation(root: string): void {
  mkdirSync(root, { recursive: true });
  const receiptsDir = join(root, 'activation-receipts');
  mkdirSync(receiptsDir, { recursive: true });
  const receiptContent = 'm3c-preserved-state-rehearsal-fixture';
  writeFileSync(join(receiptsDir, 'm3c-preserved-state-rehearsal'), receiptContent, 'utf8');
  const receiptSha256 = createHash('sha256').update(receiptContent).digest('hex');
  writeFileSync(
    join(root, STATE_ROOT_ACTIVATION_FILE),
    `${JSON.stringify({
      schemaVersion: 1,
      nodeRole: 'local',
      activatedAt: '2026-08-02T00:00:00.000Z',
      stores: Object.keys(STATE_STORES),
      sourceReceipts: [{ kind: 'm3c-preserved-state-rehearsal', sha256: receiptSha256 }],
    }, null, 2)}\n`,
    'utf8',
  );
}

function writeLease(
  leaseDir: string,
  lease: Record<string, unknown>,
): void {
  mkdirSync(leaseDir, { recursive: true });
  writeFileSync(join(leaseDir, 'instance-lease.json'), `${JSON.stringify(lease, null, 2)}\n`, 'utf8');
}

function receiptOf(caseId: string, report: RunnerHealthReport, before: FsManifest, after: FsManifest) {
  return createHash('sha256')
    .update(JSON.stringify({
      caseId,
      verdict: report.verdict,
      exitCode: report.exitCode,
      before: before.rootSha256,
      after: after.rootSha256,
      lease: report.lease.status,
    }))
    .digest('hex');
}

describe('runner health --no-claim (Wave 1 five-fixture chain)', () => {
  let prior: Record<string, string | undefined>;
  let fixtureRoot: string;
  let caseReceipts: Array<{ caseId: string; receipt: string; pass: boolean }> = [];

  beforeEach(() => {
    prior = {};
    for (const key of MANAGED_ENV) {
      prior[key] = process.env[key];
      delete process.env[key];
    }
    fixtureRoot = mkdtempSync(join(tmpdir(), 'atlas-runner-health-'));
  });

  afterEach(() => {
    for (const key of MANAGED_ENV) {
      const value = prior[key];
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    rmSync(fixtureRoot, { recursive: true, force: true });
  });

  it('1 ACTIVATED + fresh lease → HEALTHY exit 0, zero writes', () => {
    const root = join(fixtureRoot, 'state');
    const leaseDir = join(root, 'instance-lease');
    writeActivation(root);
    const now = Date.parse('2026-08-02T12:00:00.000Z');
    writeLease(leaseDir, {
      instanceId: 'inst-healthy',
      pid: process.pid,
      startedAt: '2026-08-02T11:59:00.000Z',
      heartbeatAt: '2026-08-02T11:59:50.000Z',
      runner: { kind: 'runner', authEnforcement: 'on' },
    });
    process.env.ATLAS_STATE_ROOT = root;
    process.env.ATLAS_STATE_ROOT_REQUIRED = '1';
    process.env.ATLAS_NODE_ROLE = 'local';

    const before = fsManifest(fixtureRoot);
    const report = runRunnerHealth(true, {
      nowMs: now,
      cwd: fixtureRoot,
      tipSha: () => 'd1f0ebff125e6e9d734dae341e681f7848a18d75',
      entryPath: null,
      processAlive: () => true,
    });
    const after = fsManifest(fixtureRoot);
    expectUnchanged(before, after);
    expect(report.verdict).toBe('HEALTHY');
    expect(report.ok).toBe(true);
    expect(report.exitCode).toBe(0);
    expect(report.noClaim).toBe(true);
    expect(report.lease.status).toBe('running');
    expect(report.activation.asserted).toBe(true);
    const receipt = receiptOf('1-healthy', report, before, after);
    caseReceipts.push({ caseId: '1-healthy', receipt, pass: true });
    expect(receipt).toMatch(/^[0-9a-f]{64}$/);
  });

  it('2 ACTIVATED + stale lease → STALE exit 1, zero writes', () => {
    const root = join(fixtureRoot, 'state');
    const leaseDir = join(root, 'instance-lease');
    writeActivation(root);
    writeLease(leaseDir, {
      instanceId: 'inst-stale',
      pid: 999_999,
      startedAt: '2026-08-01T00:00:00.000Z',
      heartbeatAt: '2026-08-01T00:00:00.000Z',
      runner: { kind: 'runner' },
    });
    process.env.ATLAS_STATE_ROOT = root;
    process.env.ATLAS_STATE_ROOT_REQUIRED = '1';
    process.env.ATLAS_NODE_ROLE = 'local';

    const before = fsManifest(fixtureRoot);
    const report = runRunnerHealth(true, {
      nowMs: Date.parse('2026-08-02T12:00:00.000Z'),
      cwd: fixtureRoot,
      tipSha: () => 'd1f0ebf',
      entryPath: null,
      processAlive: () => false,
    });
    const after = fsManifest(fixtureRoot);
    expectUnchanged(before, after);
    expect(report.verdict).toBe('STALE');
    expect(report.exitCode).toBe(1);
    expect(report.ok).toBe(false);
    expect(report.earliestFailedStep).toBe('lease liveness');
    const receipt = receiptOf('2-stale', report, before, after);
    caseReceipts.push({ caseId: '2-stale', receipt, pass: true });
  });

  it('3 ACTIVATED + no lease → NOT_RUNNING exit 1, zero writes', () => {
    const root = join(fixtureRoot, 'state');
    writeActivation(root);
    mkdirSync(join(root, 'instance-lease'), { recursive: true });
    process.env.ATLAS_STATE_ROOT = root;
    process.env.ATLAS_STATE_ROOT_REQUIRED = '1';
    process.env.ATLAS_NODE_ROLE = 'local';

    const before = fsManifest(fixtureRoot);
    const report = runRunnerHealth(true, {
      nowMs: Date.parse('2026-08-02T12:00:00.000Z'),
      cwd: fixtureRoot,
      tipSha: () => 'd1f0ebf',
      entryPath: null,
    });
    const after = fsManifest(fixtureRoot);
    expectUnchanged(before, after);
    expect(report.verdict).toBe('NOT_RUNNING');
    expect(report.exitCode).toBe(1);
    expect(report.lease.status).toBe('not-started');
    // Readonly path must not create instance-lease.json
    expect(existsSync(join(root, 'instance-lease', 'instance-lease.json'))).toBe(false);
    const receipt = receiptOf('3-not-running', report, before, after);
    caseReceipts.push({ caseId: '3-not-running', receipt, pass: true });
  });

  it('4 missing/invalid activation OR wrong root → fail closed, zero writes', () => {
    const root = join(fixtureRoot, 'empty-root');
    mkdirSync(root, { recursive: true });
    process.env.ATLAS_STATE_ROOT = root;
    process.env.ATLAS_STATE_ROOT_REQUIRED = '1';
    process.env.ATLAS_NODE_ROLE = 'local';

    const before = fsManifest(fixtureRoot);
    const report = runRunnerHealth(true, {
      cwd: fixtureRoot,
      tipSha: () => 'd1f0ebf',
      entryPath: null,
    });
    const after = fsManifest(fixtureRoot);
    expectUnchanged(before, after);
    expect(report.verdict).toBe('ACTIVATION_FAILED');
    expect(report.exitCode).toBe(3);
    expect(report.earliestFailedStep).toBe('assertStateRootActivated');

    // Wrong root: REQUIRED but ATLAS_STATE_ROOT unset
    delete process.env.ATLAS_STATE_ROOT;
    const before2 = fsManifest(fixtureRoot);
    const report2 = runRunnerHealth(true, {
      cwd: fixtureRoot,
      tipSha: () => 'd1f0ebf',
      entryPath: null,
    });
    const after2 = fsManifest(fixtureRoot);
    expectUnchanged(before2, after2);
    expect(report2.verdict).toBe('ACTIVATION_FAILED');
    expect(report2.exitCode).toBe(3);
    expect(report2.earliestFailedStep).toBe('resolveStateRoot');

    const receipt = receiptOf('4-activation', report, before, after);
    caseReceipts.push({ caseId: '4-activation', receipt, pass: true });
  });

  it('5 --no-claim absent + import banlist + network denial', async () => {
    const root = join(fixtureRoot, 'state');
    writeActivation(root);
    process.env.ATLAS_STATE_ROOT = root;
    process.env.ATLAS_STATE_ROOT_REQUIRED = '1';
    process.env.ATLAS_NODE_ROLE = 'local';

    const before = fsManifest(fixtureRoot);
    const report = runRunnerHealth(false, {
      cwd: fixtureRoot,
      tipSha: () => 'd1f0ebf',
      entryPath: null,
    });
    const after = fsManifest(fixtureRoot);
    expectUnchanged(before, after);
    expect(report.verdict).toBe('FLAG_REQUIRED');
    expect(report.exitCode).toBe(2);
    expect(report.earliestFailedStep).toBe('require --no-claim');

    // Static banlist on health path sources
    for (const file of [RUNNER_HEALTH_SRC, INSTANCE_LEASE_SRC]) {
      const src = readFileSync(file, 'utf8');
      for (const banned of BANLIST) {
        if (file.endsWith('instance-lease.ts') && (
          banned === 'annotateInstanceLease' ||
          banned === 'acquireInstanceLease' ||
          banned === 'startInstanceLeaseHeartbeat'
        )) {
          // Definitions live in lease module; health must not call them.
          continue;
        }
        if (file.endsWith('runner-health.ts')) {
          expect(src.includes(banned), `${file} must not mention ${banned}`).toBe(false);
        }
      }
    }
    const healthSrc = readFileSync(RUNNER_HEALTH_SRC, 'utf8');
    expect(healthSrc).not.toMatch(/from ['"]\.\/atlas-runner/);
    expect(healthSrc).not.toMatch(/from ['"]\.\/.*task-spawner/);
    expect(healthSrc.includes('mkdirSync')).toBe(false);
    expect(healthSrc.includes('writeFileSync')).toBe(false);

    const cliSrc = readFileSync(CLI_SRC, 'utf8');
    expect(cliSrc).toMatch(/runnerCmd[\s\S]*?\.command\('health'\)/);
    const runnerHealthIdx = cliSrc.indexOf("No-claim runner diagnostic");
    expect(runnerHealthIdx).toBeGreaterThan(0);
    const peekIdx = cliSrc.indexOf(".command('peek')", runnerHealthIdx);
    const healthBlock = cliSrc.slice(runnerHealthIdx, peekIdx);
    expect(healthBlock).toMatch(/runner-health\.js/);
    for (const banned of ['claimNextCommand', 'runTask', 'task-spawner', 'supabase-memory', 'peekQueue']) {
      expect(healthBlock.includes(banned)).toBe(false);
    }

    expect(shouldAcquireInstanceLease(['runner', 'health'])).toBe(false);
    expect(shouldAcquireInstanceLease(['runner', 'health', '--no-claim'])).toBe(false);

    // Commander 12 negate semantics: `--no-claim` → opts.claim === false
    const { Command } = await import('commander');
    const probe = new Command();
    let seen: { claim?: boolean } | null = null;
    probe
      .command('health')
      .option('--no-claim')
      .action((opts: { claim?: boolean }) => {
        seen = opts;
      });
    await probe.parseAsync(['health'], { from: 'user' });
    expect(seen).toEqual({ claim: true });
    seen = null;
    await probe.parseAsync(['health', '--no-claim'], { from: 'user' });
    expect(seen).toEqual({ claim: false });
    // Gate used by CLI: only claim===false means no-claim authorized
    expect((seen as { claim?: boolean }).claim === false).toBe(true);

    // Network denial: trap outbound TCP while running health
    let connectAttempts = 0;
    const net = createRequire(import.meta.url)('node:net') as typeof import('node:net');
    const originalConnect = net.Socket.prototype.connect;
    (net.Socket.prototype as { connect: typeof originalConnect }).connect = function (
      this: import('node:net').Socket,
      ...args: Parameters<typeof originalConnect>
    ) {
      connectAttempts += 1;
      throw new Error('NETWORK_DENIED_BY_TEST');
    } as typeof originalConnect;

    try {
      // Also prove fetch/http would be denied if attempted: health must not call them.
      const beforeNet = fsManifest(fixtureRoot);
      const healthyAttempt = runRunnerHealth(true, {
        nowMs: Date.parse('2026-08-02T12:00:00.000Z'),
        cwd: fixtureRoot,
        tipSha: () => 'd1f0ebf',
        entryPath: null,
        readLease: () => null,
        processAlive: () => false,
      });
      const afterNet = fsManifest(fixtureRoot);
      expectUnchanged(beforeNet, afterNet);
      expect(healthyAttempt.verdict).toBe('NOT_RUNNING');
      expect(connectAttempts).toBe(0);

      // Subprocess with blocked env + trap script observing zero network
      const trap = join(fixtureRoot, 'net-trap.mjs');
      const healthModuleUrl = pathToFileURL(join(REPO_SRC, 'atlas', 'runner-health.ts')).href;
      writeFileSync(
        trap,
        `
import net from 'node:net';
let attempts = 0;
net.Socket.prototype.connect = function (...args) {
  attempts += 1;
  throw new Error('NETWORK_DENIED');
};
process.env.ATLAS_STATE_ROOT = ${JSON.stringify(root)};
process.env.ATLAS_STATE_ROOT_REQUIRED = '1';
process.env.ATLAS_NODE_ROLE = 'local';
delete process.env.SUPABASE_URL;
delete process.env.SUPABASE_SERVICE_ROLE_KEY;
const { runRunnerHealth } = await import(${JSON.stringify(healthModuleUrl)});
const report = runRunnerHealth(true, {
  tipSha: () => 'd1f0ebf',
  entryPath: null,
  cwd: ${JSON.stringify(fixtureRoot.replace(/\\/g, '/'))},
  readLease: () => null,
});
console.log(JSON.stringify({ attempts, verdict: report.verdict, exitCode: report.exitCode }));
`,
        'utf8',
      );

      // Prefer tsx if available via npx path from repo
      const repoRoot = join(REPO_SRC, '..');
      const tsxCli = join(repoRoot, 'node_modules', 'tsx', 'dist', 'cli.mjs');
      const result = spawnSync(
        process.execPath,
        [tsxCli, trap],
        {
          cwd: fixtureRoot,
          encoding: 'utf8',
          env: {
            PATH: process.env.PATH,
            SystemRoot: process.env.SystemRoot,
            NODE_PATH: join(repoRoot, 'node_modules'),
            SUPABASE_URL: '',
            HTTP_PROXY: 'http://127.0.0.1:9',
            HTTPS_PROXY: 'http://127.0.0.1:9',
            NO_PROXY: '*',
          },
          timeout: 30_000,
          windowsHide: true,
        },
      );
      expect(result.status, result.stderr + result.stdout).toBe(0);
      const line = (result.stdout ?? '').trim().split(/\r?\n/).pop()!;
      const parsed = JSON.parse(line) as { attempts: number; verdict: string; exitCode: number };
      expect(parsed.attempts).toBe(0);
      expect(parsed.verdict).toBe('NOT_RUNNING');
      expect(parsed.exitCode).toBe(1);
    } finally {
      net.Socket.prototype.connect = originalConnect;
    }

    const receipt = receiptOf('5-flag-banlist-net', report, before, after);
    caseReceipts.push({ caseId: '5-flag-banlist-net', receipt, pass: true });
  });
});
