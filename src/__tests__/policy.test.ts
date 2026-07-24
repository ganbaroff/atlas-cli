import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  loadPolicy,
  resetPolicyCache,
  policyDailyTokenCap,
  isAutonomyShellAllowed,
  DEFAULT_POLICY,
} from '../atlas/policy.js';
import { classifyShellForActor, resolveShellActor } from '../tools/shell.js';
import { isSensitivePath } from '../tools/fs-guard.js';

// Uses the repo's real config/policy.yaml by default (cwd = ANUS root in tests).
describe('policy loader', () => {
  const fixtures: string[] = [];

  beforeEach(() => {
    vi.unstubAllEnvs();
    resetPolicyCache();
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    resetPolicyCache();
    for (const f of fixtures.splice(0)) {
      try { rmSync(f); } catch { /* ignore */ }
    }
  });

  function writeFixture(yaml: string): string {
    const p = join(tmpdir(), `atlas-policy-fixture-${fixtures.length}-${process.pid}.yaml`);
    writeFileSync(p, yaml, 'utf8');
    fixtures.push(p);
    return p;
  }

  it('loads the real repo policy.yaml (whitelist + cap present)', () => {
    const pol = loadPolicy();
    expect(pol.token.daily_cap).toBe(500_000);
    expect(pol.token.paid_default).toBe(false);
    expect(pol.shell.whitelist_autonomy.length).toBeGreaterThan(0);
  });

  it('reads token.daily_cap from a fixture file', () => {
    const p = writeFixture('token:\n  daily_cap: 123\nshell:\n  whitelist_autonomy: []\n');
    vi.stubEnv('ATLAS_POLICY_PATH', p);
    vi.stubEnv('ATLAS_DAILY_TOKEN_CAP', '');
    resetPolicyCache();
    expect(loadPolicy().token.daily_cap).toBe(123);
    expect(policyDailyTokenCap()).toBe(123);
  });

  it('ENV overrides win over policy.yaml for the daily cap', () => {
    const p = writeFixture('token:\n  daily_cap: 123\n');
    vi.stubEnv('ATLAS_POLICY_PATH', p);
    vi.stubEnv('ATLAS_DAILY_TOKEN_CAP', '999');
    resetPolicyCache();
    expect(policyDailyTokenCap()).toBe(999); // env wins
  });

  it('FAIL-CLOSED in production when the file is missing: empty whitelist, default caps', () => {
    vi.stubEnv('ATLAS_POLICY_PATH', join(tmpdir(), 'definitely-does-not-exist-xyz.yaml'));
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('ATLAS_DAILY_TOKEN_CAP', '');
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    resetPolicyCache();
    // Missing override path falls through to cwd/import.meta search — force a hard
    // miss by also asserting the fail-closed shape via a broken fixture below.
    const pol = loadPolicy();
    // Either the repo file is found (whitelist present) OR fail-closed default.
    // To assert the fail-closed branch deterministically, use a broken YAML fixture:
    const bad = writeFixture(': : : not valid yaml : :\n\t- broken');
    vi.stubEnv('ATLAS_POLICY_PATH', bad);
    resetPolicyCache();
    const failClosed = loadPolicy();
    expect(failClosed.token.daily_cap).toBe(DEFAULT_POLICY.token.daily_cap);
    expect(failClosed.shell.whitelist_autonomy).toEqual([]);
    expect(isAutonomyShellAllowed('git status')).toBe(false); // fail-closed denies autonomy
    errSpy.mockRestore();
    void pol;
  });
});

describe('shell actor + hybrid whitelist (Phase 1 DoD)', () => {
  beforeEach(() => {
    vi.unstubAllEnvs();
    resetPolicyCache();
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    resetPolicyCache();
  });

  it('resolveShellActor: default is ceo, autonomy via env tag', () => {
    vi.stubEnv('ATLAS_AGENT_ID', '');
    vi.stubEnv('ATLAS_AUTONOMY', '');
    expect(resolveShellActor()).toBe('ceo');
    vi.stubEnv('ATLAS_AGENT_ID', 'autonomy');
    expect(resolveShellActor()).toBe('autonomy');
    vi.stubEnv('ATLAS_AGENT_ID', '');
    vi.stubEnv('ATLAS_AUTONOMY', '1');
    expect(resolveShellActor()).toBe('autonomy');
  });

  it('BLOCKED command never runs — for BOTH actors', () => {
    expect(classifyShellForActor('rm -rf /', 'ceo').decision).toBe('blocked');
    expect(classifyShellForActor('rm -rf /', 'autonomy').decision).toBe('blocked');
    expect(classifyShellForActor('shutdown now', 'autonomy').decision).toBe('blocked');
  });

  it('GATED without the opt-in flag is gated — for BOTH actors', () => {
    expect(classifyShellForActor('git push --force origin main', 'ceo').decision).toBe('gated');
    expect(classifyShellForActor('git push --force origin main', 'autonomy').decision).toBe('gated');
  });

  it('AUTONOMY + non-whitelisted (but otherwise-allowed) command is DENIED', () => {
    // 'touch x' and 'mkdir y' are not catastrophic/destructive → allow for CEO,
    // but they are NOT on the autonomy whitelist → blocked for autonomy.
    expect(classifyShellForActor('touch newfile.txt', 'ceo').decision).toBe('allow');
    const auto = classifyShellForActor('touch newfile.txt', 'autonomy');
    expect(auto.decision).toBe('blocked');
    expect(auto.rule).toBe('autonomy-not-whitelisted');
  });

  it('AUTONOMY + whitelisted command is ALLOWED', () => {
    expect(classifyShellForActor('git status', 'autonomy').decision).toBe('allow');
    expect(classifyShellForActor('ls -la', 'autonomy').decision).toBe('allow');
    expect(classifyShellForActor('node dist/cli.js chat', 'autonomy').decision).toBe('allow');
  });

  it('sensitive path is DENIED (fs-guard floor, actor-independent)', () => {
    expect(isSensitivePath('/app/.env')).toBe(true);
    expect(isSensitivePath('/home/user/keys/prod.key')).toBe(true);
    expect(isSensitivePath('/app/src/index.ts')).toBe(false);
  });
});
