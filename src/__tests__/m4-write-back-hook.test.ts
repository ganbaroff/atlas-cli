import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  assertBreadcrumbBeforeExit,
  resetBreadcrumbStateForTests,
  writeSessionBreadcrumb,
} from '../atlas/write-back-hook.js';

describe('M4-D write-back breadcrumb hook', () => {
  let crumbDir: string;

  beforeEach(() => {
    crumbDir = mkdtempSync(join(tmpdir(), 'atlas-breadcrumb-'));
    process.env.ATLAS_BREADCRUMB_DIR = crumbDir;
    resetBreadcrumbStateForTests();
  });

  afterEach(() => {
    delete process.env.ATLAS_BREADCRUMB_DIR;
    rmSync(crumbDir, { recursive: true, force: true });
  });

  it('blocks exit when no breadcrumb written', () => {
    const check = assertBreadcrumbBeforeExit();
    expect(check.ok).toBe(false);
    expect(check.message).toMatch(/no session breadcrumb/);
  });

  it('allows exit after writeSessionBreadcrumb', () => {
    writeSessionBreadcrumb('goal-run-complete');
    expect(assertBreadcrumbBeforeExit().ok).toBe(true);
    const fp = join(crumbDir, 'session-breadcrumb.jsonl');
    expect(existsSync(fp)).toBe(true);
    expect(readFileSync(fp, 'utf8')).toContain('goal-run-complete');
  });
});
