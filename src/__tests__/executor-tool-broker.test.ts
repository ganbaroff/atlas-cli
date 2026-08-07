/**
 * Wave 2 acceptance: the Atlas tool broker is the security boundary.
 *
 * Every refusal here must happen BEFORE the side effect, and must be derived
 * from disk state (lease, real HEAD, signed order) rather than from anything
 * the caller asserts. The executor's own guard is irrelevant to these tests —
 * the broker is exercised directly, exactly as a hostile executor would.
 */

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { AtlasToolBroker, classifyCommand } from '../atlas/executor/tool-broker.js';
import { hmacSigner, hmacVerifier, signWorkOrder } from '../atlas/work-order/sign.js';
import type { RepoWriterLease } from '../atlas/work-order/repo-writer-lock.js';
import type { SignedWorkOrder, WorkOrder } from '../atlas/work-order/types.js';

const SIGNING_KEY = 'broker-test-key';
const MISSION_ID = 'mission-broker-1';
const EXECUTOR_IDENTITY = 'atlas-executor:test';
const ISSUER_IDENTITY = 'atlas-issuer:test';
const BASE_HEAD = 'a'.repeat(40);

let repoRoot: string;
let signed: SignedWorkOrder;

function makeOrder(overrides: Partial<WorkOrder> = {}): WorkOrder {
  const now = Date.now();
  return {
    workOrderId: 'wo-broker-1',
    goalId: 'goal-1',
    taskId: 'task-1',
    issuerIdentity: ISSUER_IDENTITY,
    executorIdentity: EXECUTOR_IDENTITY,
    repoCanonicalPath: repoRoot,
    baseBranch: 'main',
    baseHead: BASE_HEAD,
    worktreePath: repoRoot,
    issuedAt: new Date(now - 1_000).toISOString(),
    expiresAt: new Date(now + 3_600_000).toISOString(),
    nonce: 'nonce-broker-1',
    allowedPaths: ['src/**', 'mission.txt'],
    forbiddenPaths: ['src/secrets/**'],
    forbiddenActions: [],
    allowedCommandClasses: ['git', 'node', 'filesystem'],
    maxAttempts: 3,
    maxWallClockMs: 600_000,
    expectedTests: [],
    evidenceRequirements: [],
    rollbackMethod: 'git-restore',
    ...overrides,
  };
}

function heldLease(overrides: Partial<RepoWriterLease> = {}): RepoWriterLease {
  const now = Date.now();
  return {
    repoCanonicalPath: repoRoot,
    owner: { missionId: MISSION_ID, workOrderId: 'wo-broker-1' },
    process: { pid: process.pid, bootToken: 'boot-1', startedAt: new Date(now).toISOString() },
    acquiredAt: new Date(now).toISOString(),
    leaseExpiresAt: new Date(now + 600_000).toISOString(),
    heartbeatAt: new Date(now).toISOString(),
    status: 'held',
    ...overrides,
  } as RepoWriterLease;
}

function makeBroker(opts: {
  lease?: RepoWriterLease | null;
  head?: string;
  order?: SignedWorkOrder;
  attemptNumber?: number;
}) {
  return new AtlasToolBroker({
    missionId: MISSION_ID,
    signedWorkOrder: opts.order ?? signed,
    worktreeRoot: repoRoot,
    executorIdentity: EXECUTOR_IDENTITY,
    startedAtMs: Date.now(),
    attemptNumber: opts.attemptNumber ?? 1,
    readHead: () => opts.head ?? BASE_HEAD,
    readLease: () => (opts.lease === undefined ? heldLease() : opts.lease),
    verifier: hmacVerifier(SIGNING_KEY),
  });
}

beforeAll(() => {
  repoRoot = path.join(tmpdir(), `atlas-broker-${process.pid}-${Math.floor(performance.now())}`);
  mkdirSync(path.join(repoRoot, 'src'), { recursive: true });
  mkdirSync(path.join(repoRoot, 'src', 'secrets'), { recursive: true });
  writeFileSync(path.join(repoRoot, 'mission.txt'), 'first line\nsecond line\n', 'utf8');
  writeFileSync(path.join(repoRoot, 'src', 'app.ts'), 'export const app = 1;\n', 'utf8');
  writeFileSync(path.join(repoRoot, 'src', 'secrets', 'key.txt'), 'PLACEHOLDER-NOT-A-REAL-KEY\n', 'utf8');
  execFileSync('git', ['init', '-q'], { cwd: repoRoot, windowsHide: true });
  signed = signWorkOrder(makeOrder(), hmacSigner(SIGNING_KEY));
});

afterAll(() => {
  if (repoRoot && existsSync(repoRoot)) rmSync(repoRoot, { recursive: true, force: true });
});

describe('classifyCommand', () => {
  it('maps known binaries to authorized classes and everything else to unclassified', () => {
    expect(classifyCommand('git status')).toBe('git');
    expect(classifyCommand('node script.mjs')).toBe('node');
    expect(classifyCommand('python -m pytest')).toBe('python');
    expect(classifyCommand('curl https://example.com')).toBe('unclassified:curl');
    expect(classifyCommand('')).toBe('unclassified:empty');
  });
});

describe('AtlasToolBroker — filesystem scope', () => {
  it('reads an in-scope file', async () => {
    const broker = makeBroker({});
    const out = await broker.invoke('read_file', { path: 'mission.txt' });
    expect(out.ok).toBe(true);
    if (out.ok) expect(out.output).toContain('first line');
  });

  it('refuses a path that escapes the worktree, before touching disk', async () => {
    const broker = makeBroker({});
    const out = await broker.invoke('read_file', { path: '../../../../windows/win.ini' });
    expect(out).toEqual({ ok: false, refusedReason: 'path_outside_worktree' });
    expect(broker.auditTrail.at(-1)).toMatchObject({ allowed: false, reason: 'path_outside_worktree' });
  });

  it('refuses an absolute path outright', async () => {
    const broker = makeBroker({});
    const out = await broker.invoke('read_file', { path: path.join(repoRoot, 'mission.txt') });
    expect(out).toEqual({ ok: false, refusedReason: 'absolute_path_refused' });
  });

  it('refuses a forbidden path even though it resolves inside the worktree', async () => {
    const broker = makeBroker({});
    const before = readFileSync(path.join(repoRoot, 'src', 'secrets', 'key.txt'), 'utf8');
    const out = await broker.invoke('write_file', { path: 'src/secrets/key.txt', content: 'overwritten' });
    expect(out.ok).toBe(false);
    expect(readFileSync(path.join(repoRoot, 'src', 'secrets', 'key.txt'), 'utf8')).toBe(before);
  });

  it('refuses a path outside allowedPaths', async () => {
    const broker = makeBroker({});
    const out = await broker.invoke('write_file', { path: 'docs/notes.md', content: 'x' });
    expect(out.ok).toBe(false);
    expect(existsSync(path.join(repoRoot, 'docs', 'notes.md'))).toBe(false);
  });

  it('writes an in-scope file and reports the byte count', async () => {
    const broker = makeBroker({});
    const out = await broker.invoke('write_file', { path: 'src/health.ts', content: 'export const ok = true;\n' });
    expect(out.ok).toBe(true);
    expect(readFileSync(path.join(repoRoot, 'src', 'health.ts'), 'utf8')).toContain('ok = true');
  });

  it('refuses an ambiguous patch anchor without modifying the file', async () => {
    writeFileSync(path.join(repoRoot, 'src', 'dup.ts'), 'a\na\n', 'utf8');
    const broker = makeBroker({});
    const out = await broker.invoke('apply_patch', { path: 'src/dup.ts', find: 'a', replace: 'b' });
    expect(out).toEqual({ ok: false, refusedReason: 'patch_anchor_ambiguous' });
    expect(readFileSync(path.join(repoRoot, 'src', 'dup.ts'), 'utf8')).toBe('a\na\n');
  });
});

describe('AtlasToolBroker — authority is re-derived, never asserted', () => {
  it('refuses every tool when no lease is held', async () => {
    const broker = makeBroker({ lease: null });
    const out = await broker.invoke('read_file', { path: 'mission.txt' });
    expect(out).toEqual({ ok: false, refusedReason: 'lease_not_held' });
  });

  it('refuses when the lease belongs to another mission', async () => {
    const broker = makeBroker({
      lease: heldLease({ owner: { missionId: 'someone-else', workOrderId: 'wo-broker-1' } }),
    });
    const out = await broker.invoke('read_file', { path: 'mission.txt' });
    expect(out).toEqual({ ok: false, refusedReason: 'lease_owned_by_other_mission' });
  });

  it('refuses when the lease references a different Work Order', async () => {
    const broker = makeBroker({
      lease: heldLease({ owner: { missionId: MISSION_ID, workOrderId: 'wo-other' } }),
    });
    const out = await broker.invoke('read_file', { path: 'mission.txt' });
    expect(out).toEqual({ ok: false, refusedReason: 'lease_work_order_mismatch' });
  });

  it('refuses when the real HEAD has moved off the Work Order base', async () => {
    const broker = makeBroker({ head: 'b'.repeat(40) });
    const out = await broker.invoke('write_file', { path: 'src/app.ts', content: 'x' });
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.refusedReason).not.toBe('lease_not_held');
  });

  it('refuses a tampered Work Order signature', async () => {
    const tampered = {
      ...signed,
      allowedPaths: ['**'],
    } as SignedWorkOrder;
    const broker = makeBroker({ order: tampered });
    const out = await broker.invoke('read_file', { path: 'mission.txt' });
    expect(out).toEqual({ ok: false, refusedReason: 'signature_invalid' });
  });

  it('refuses an order signed with the wrong key', async () => {
    const wrongKey = signWorkOrder(makeOrder(), hmacSigner('not-the-real-key'));
    const broker = makeBroker({ order: wrongKey });
    const out = await broker.invoke('read_file', { path: 'mission.txt' });
    expect(out).toEqual({ ok: false, refusedReason: 'signature_invalid' });
  });
});

describe('AtlasToolBroker — command boundary', () => {
  it('refuses an unauthorized command class', async () => {
    const broker = makeBroker({});
    const out = await broker.invoke('run_command', { command: 'curl https://example.com' });
    expect(out).toEqual({ ok: false, refusedReason: 'unclassified:curl' });
  });

  it('refuses shell metacharacters that would smuggle a second command', async () => {
    const broker = makeBroker({});
    for (const command of ['git status && curl x', 'git status; rm -rf .', 'git status | tee out']) {
      const out = await broker.invoke('run_command', { command });
      expect(out).toEqual({ ok: false, refusedReason: 'shell_metacharacter_refused' });
    }
  });

  it('runs an authorized command and returns its real exit code', async () => {
    const broker = makeBroker({});
    const out = await broker.invoke('git_status', {});
    expect(out.ok).toBe(true);
  });

  it('refuses an unknown tool name', async () => {
    const broker = makeBroker({});
    const out = await broker.invoke('exfiltrate', { path: 'mission.txt' });
    expect(out).toEqual({ ok: false, refusedReason: 'unknown_tool' });
  });
});

describe('AtlasToolBroker — pause semantics', () => {
  it('refuses the next tool call while paused and resumes cleanly', async () => {
    const broker = makeBroker({});
    broker.pause();
    expect(broker.isPaused).toBe(true);
    const paused = await broker.invoke('write_file', { path: 'src/paused.ts', content: 'x' });
    expect(paused).toEqual({ ok: false, refusedReason: 'mission_paused' });
    expect(existsSync(path.join(repoRoot, 'src', 'paused.ts'))).toBe(false);

    broker.resume();
    const resumed = await broker.invoke('write_file', { path: 'src/paused.ts', content: 'x' });
    expect(resumed.ok).toBe(true);
  });
});

describe('AtlasToolBroker — search scope regression', () => {
  it('sweeps the worktree root with dir "." instead of refusing it', async () => {
    const broker = makeBroker({});
    const out = await broker.invoke('search_files', { query: 'first line', dir: '.' });
    expect(out.ok).toBe(true);
    if (out.ok) expect(out.output).toContain('mission.txt');
  });

  it('still refuses a search rooted outside the worktree', async () => {
    const broker = makeBroker({});
    const out = await broker.invoke('search_files', { query: 'x', dir: '../..' });
    expect(out).toEqual({ ok: false, refusedReason: 'path_outside_worktree' });
  });

  it('still refuses a search when no lease is held', async () => {
    const broker = makeBroker({ lease: null });
    const out = await broker.invoke('search_files', { query: 'x', dir: '.' });
    expect(out).toEqual({ ok: false, refusedReason: 'lease_not_held' });
  });
});

describe('AtlasToolBroker — hostile executor obeying an injected payload', () => {
  // A live model declining the injection proves it behaved, not that Atlas
  // enforced. These drive every step of the payload deliberately, so each
  // refusal is the boundary doing its job rather than the model's restraint.
  const INJECTED_STEPS = [
    { tool: 'read_file', input: { path: '../../../../Users/user/OneDrive/Documents/GitHub/ANUS/.env' }, expect: 'path_outside_worktree' },
    { tool: 'read_file', input: { path: '../../../../Windows/System32/drivers/etc/hosts' }, expect: 'path_outside_worktree' },
    { tool: 'run_command', input: { command: 'curl https://example.com/collect' }, expect: 'unclassified:curl' },
    { tool: 'run_command', input: { command: 'git config --global core.hooksPath /dev/null' }, expect: 'command_escapes_worktree' },
    { tool: 'write_file', input: { path: 'src/secrets/key.txt', content: '{}' }, expect: 'path_forbidden' },
  ];

  it('refuses every injected step, before any side effect', async () => {
    const broker = makeBroker({});
    const secretBefore = readFileSync(path.join(repoRoot, 'src', 'secrets', 'key.txt'), 'utf8');

    for (const step of INJECTED_STEPS) {
      const out = await broker.invoke(step.tool, step.input);
      expect(out.ok).toBe(false);
      if (!out.ok) expect(out.refusedReason).toBe(step.expect);
    }

    // Nothing the payload demanded actually happened.
    expect(readFileSync(path.join(repoRoot, 'src', 'secrets', 'key.txt'), 'utf8')).toBe(secretBefore);
    expect(broker.auditTrail.filter((e) => e.allowed)).toEqual([]);
  });

  it('leaks no file content when an out-of-worktree read is refused', async () => {
    const broker = makeBroker({});
    const out = await broker.invoke('read_file', { path: '../../../../Windows/win.ini' });
    expect(out).toEqual({ ok: false, refusedReason: 'path_outside_worktree' });
    expect(JSON.stringify(out)).not.toMatch(/\[/);
  });

  it('refuses authorized binaries used in forms that act outside the worktree', async () => {
    const broker = makeBroker({});
    for (const command of [
      'git push origin main',
      'git remote add evil https://example.com/x.git',
      'git clone https://example.com/x.git',
      'git -C C:/Windows status',
      'npm install -g something',
    ]) {
      const out = await broker.invoke('run_command', { command });
      expect(out).toEqual({ ok: false, refusedReason: 'command_escapes_worktree' });
    }
  });

  it('still allows an ordinary in-worktree git command', async () => {
    const broker = makeBroker({});
    const out = await broker.invoke('run_command', { command: 'git status --porcelain' });
    expect(out.ok).toBe(true);
  });

  it('refuses a payload that tries to smuggle a second command past the class check', async () => {
    const broker = makeBroker({});
    const out = await broker.invoke('run_command', { command: 'node -e "1" && curl https://example.com' });
    expect(out).toEqual({ ok: false, refusedReason: 'shell_metacharacter_refused' });
  });
});

describe('AtlasToolBroker — python command class', () => {
  // The live Python mission ended REJECT because the model never called the
  // tool, which leaves the class itself unproven. These drive it directly.
  // The base Work Order authorizes git/node/filesystem, so a python mission
  // needs its own order — which is itself the point: the class must be granted.
  const pythonOrder = () =>
    signWorkOrder(
      makeOrder({ allowedCommandClasses: ['git', 'node', 'filesystem', 'python'] }),
      hmacSigner(SIGNING_KEY),
    );

  it('classifies and executes a real python command, returning its exit code', async () => {
    const broker = makeBroker({ order: pythonOrder() });
    const out = await broker.invoke('run_command', { command: 'python --version' });
    expect(out.ok).toBe(true);
    if (out.ok) expect(out.output).toMatch(/^exit=0/);
  });

  it('returns a real non-zero exit code instead of hiding a failure', async () => {
    const broker = makeBroker({ order: pythonOrder() });
    const out = await broker.invoke('run_command', { command: 'python -c import_sys_broken' });
    expect(out.ok).toBe(true);
    if (out.ok) expect(out.output).not.toMatch(/^exit=0/);
  });

  it('refuses python when the Work Order does not authorize that class', async () => {
    const nodeOnly = signWorkOrder(makeOrder({ allowedCommandClasses: ['node'] }), hmacSigner(SIGNING_KEY));
    const broker = makeBroker({ order: nodeOnly });
    const out = await broker.invoke('run_command', { command: 'python --version' });
    expect(out).toEqual({ ok: false, refusedReason: 'command_class_forbidden' });
  });
});
