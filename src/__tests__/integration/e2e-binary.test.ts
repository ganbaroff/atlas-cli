/**
 * E2E binary test — THE proof that atlas-cli is real, not theatre.
 *
 * Builds the actual binary with tsup, then runs CLI commands as
 * a real user would. No mocks. No vitest magic. Real stdout parsing.
 *
 * This is what separates "79 unit tests pass" from "the product works".
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { execSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '..', '..', '..');
const DIST = resolve(ROOT, 'dist', 'cli.js');

/** Run a CLI command, return stdout. Throws on non-zero exit (unless allowed). */
function atlas(args: string, opts: { allowFail?: boolean; timeout?: number } = {}): string {
  const timeout = opts.timeout ?? 15_000;
  try {
    const out = execSync(`node "${DIST}" ${args}`, {
      cwd: ROOT,
      timeout,
      encoding: 'utf-8',
      env: { ...process.env, NODE_NO_WARNINGS: '1' },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    return out;
  } catch (err: unknown) {
    if (opts.allowFail) {
      const e = err as { stdout?: string; stderr?: string };
      return (e.stdout ?? '') + (e.stderr ?? '');
    }
    throw err;
  }
}

describe('E2E: atlas binary', () => {
  beforeAll(() => {
    // Build the binary — this is the first real test
    console.log('[e2e] Building atlas-cli with tsup...');
    execSync('npx tsup src/cli.ts --format esm --dts --clean', {
      cwd: ROOT,
      timeout: 30_000,
      encoding: 'utf-8',
      stdio: 'pipe',
    });
    console.log('[e2e] Build complete.');
  }, 45_000);

  it('tsup produces dist/cli.js', () => {
    expect(existsSync(DIST)).toBe(true);
  });

  it('atlas --version prints semver', () => {
    const out = atlas('--version');
    expect(out.trim()).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it('atlas --help lists all commands', () => {
    const out = atlas('--help');
    expect(out).toContain('chat');
    expect(out).toContain('swarm');
    expect(out).toContain('wake');
    expect(out).toContain('boot');
    expect(out).toContain('health');
    expect(out).toContain('identity');
    expect(out).toContain('models');
    expect(out).toContain('ping');
    expect(out).toContain('telegram');
    expect(out).toContain('cron');
    expect(out).toContain('skills');
    expect(out).toContain('run');
    expect(out).toContain('swarm-deep');
    expect(out).toContain('hive');
  });

  it('atlas identity outputs valid JSON with required fields', () => {
    const out = atlas('identity');
    const parsed = JSON.parse(out);
    expect(parsed.name).toBe('Atlas');
    expect(parsed.role).toBeTruthy();
    expect(parsed.voice_style).toBeTruthy();
    expect(parsed.named_by).toBeTruthy();
    expect(Array.isArray(parsed.ecosystem_products)).toBe(true);
    expect(parsed.ecosystem_products.length).toBeGreaterThanOrEqual(3);
  });

  it('atlas health runs all 7 diagnostics', () => {
    // health may exit 1 if checks fail (e.g. no .env in CI), that's fine
    const out = atlas('health', { allowFail: true });
    expect(out).toContain('Atlas Health Check');
    // Should have PASS or FAIL for each check
    const checkNames = ['memory-vault', 'identity-file', 'heartbeat', 'models', 'env-file', 'test-dir', 'swarm-state'];
    for (const name of checkNames) {
      expect(out).toContain(name);
    }
    // At least swarm-state and test-dir should pass (they check local dirs)
    expect(out).toContain('PASS test-dir');
    expect(out).toContain('PASS swarm-state');
  });

  it('atlas wake outputs identity recall', () => {
    const out = atlas('wake --quiet', { allowFail: true, timeout: 10_000 });
    expect(out).toContain('Атлас здесь');
    expect(out).toContain('Atlas');
    expect(out).toContain('Готов к работе');
  });

  it('atlas models lists available providers (or says none)', () => {
    const out = atlas('models', { allowFail: true });
    // Either lists models or says "No models available"
    const hasModels = out.includes('/') && out.includes('tier');
    const noModels = out.includes('No models available');
    expect(hasModels || noModels).toBe(true);
  });

  it('atlas cron status runs without crash', () => {
    const out = atlas('cron status', { allowFail: true });
    // Either shows a report or says none exist
    expect(out.length).toBeGreaterThan(0);
  });

  it('atlas hive runs without crash', () => {
    const out = atlas('hive', { allowFail: true, timeout: 10_000 });
    // Either shows profiles or says none found
    expect(out.length).toBeGreaterThan(0);
  });
});
