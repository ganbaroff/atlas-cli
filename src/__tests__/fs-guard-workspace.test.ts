/**
 * Acceptance tests for P0.3 Wave B — actor-scoped file writes.
 *
 * Autonomy actor writes are confined to the workspace root (ATLAS_WORKSPACE_ROOT
 * or process.cwd()). Non-autonomy actors keep current behavior. Sensitive-path
 * rules from fs-guard remain in force for all actors.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { writeFileTool } from '../tools/write-file.js';

const CTX = {} as never;

describe('P0.3 actor-scoped workspace confinement (write-file)', () => {
  let workspaceRoot: string;
  let outsideDir: string;
  const savedEnv: Record<string, string | undefined> = {};

  beforeEach(() => {
    // Two isolated temp dirs: one is the "workspace", one is "outside"
    workspaceRoot = mkdtempSync(join(tmpdir(), 'ws-root-'));
    outsideDir = mkdtempSync(join(tmpdir(), 'ws-outside-'));

    // Save and set env
    for (const k of ['ATLAS_AGENT_ID', 'ATLAS_AUTONOMY', 'ATLAS_WORKSPACE_ROOT', 'ATLAS_SHELL_ALLOW_DESTRUCTIVE']) {
      savedEnv[k] = process.env[k];
    }
    process.env.ATLAS_WORKSPACE_ROOT = workspaceRoot;
  });

  afterEach(() => {
    // Restore env
    for (const [k, v] of Object.entries(savedEnv)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  // ── Acceptance 1: Autonomy actor, path inside workspace root => write succeeds ──
  it('autonomy actor: write inside workspace root succeeds', async () => {
    process.env.ATLAS_AGENT_ID = 'autonomy';
    const target = join(workspaceRoot, 'subdir', 'file.txt');

    const result = await writeFileTool.execute!({ path: target, content: 'hello' }, CTX);

    expect(result.written).toBe(true);
    expect(existsSync(target)).toBe(true);
    expect(readFileSync(target, 'utf-8')).toBe('hello');
  });

  // ── Acceptance 2: Autonomy actor, absolute path outside root => refused ──
  it('autonomy actor: absolute path outside workspace root is refused with policy reason', async () => {
    process.env.ATLAS_AGENT_ID = 'autonomy';
    const target = join(outsideDir, 'escape.txt');

    const result = await writeFileTool.execute!({ path: target, content: 'pwned' }, CTX);

    expect(result.written).toBe(false);
    expect(result.error).toMatch(/workspace/i);
    expect(existsSync(target)).toBe(false);
  });

  // ── Acceptance 3: Autonomy actor, ../ traversal escaping root => refused ──
  it('autonomy actor: ../ traversal escaping workspace root is refused (resolved path check)', async () => {
    process.env.ATLAS_AGENT_ID = 'autonomy';
    // Construct a path that starts inside the root but traverses out
    const target = join(workspaceRoot, 'a', '..', '..', 'escape.txt');

    const result = await writeFileTool.execute!({ path: target, content: 'pwned' }, CTX);

    expect(result.written).toBe(false);
    expect(result.error).toMatch(/workspace/i);
  });

  // ── Acceptance 4: Non-autonomy actor, path outside root => behaves as today ──
  it('non-autonomy actor: write outside workspace root succeeds (regression)', async () => {
    process.env.ATLAS_AGENT_ID = 'ceo';
    const target = join(outsideDir, 'ceo-file.txt');

    const result = await writeFileTool.execute!({ path: target, content: 'allowed' }, CTX);

    expect(result.written).toBe(true);
    expect(existsSync(target)).toBe(true);
    expect(readFileSync(target, 'utf-8')).toBe('allowed');
  });

  // ── Acceptance 5: Existing fs-guard sensitive-path rules still hold ──
  it('sensitive path is still refused for any actor (existing behavior preserved)', async () => {
    process.env.ATLAS_AGENT_ID = 'ceo';
    delete process.env.ATLAS_SHELL_ALLOW_DESTRUCTIVE;
    const target = join(workspaceRoot, '.env');

    const result = await writeFileTool.execute!({ path: target, content: 'SECRET=x' }, CTX);

    expect(result.written).toBe(false);
    expect(result.error).toMatch(/sensitive/i);
  });

  it('sensitive path is also refused for autonomy actor', async () => {
    process.env.ATLAS_AGENT_ID = 'autonomy';
    delete process.env.ATLAS_SHELL_ALLOW_DESTRUCTIVE;
    const target = join(workspaceRoot, '.env.local');

    const result = await writeFileTool.execute!({ path: target, content: 'SECRET=x' }, CTX);

    expect(result.written).toBe(false);
    expect(result.error).toMatch(/sensitive/i);
  });

  // ── Edge: ATLAS_AUTONOMY=1 also triggers confinement ──
  it('ATLAS_AUTONOMY=1 triggers workspace confinement same as ATLAS_AGENT_ID=autonomy', async () => {
    delete process.env.ATLAS_AGENT_ID;
    process.env.ATLAS_AUTONOMY = '1';
    const target = join(outsideDir, 'autonomy-flag.txt');

    const result = await writeFileTool.execute!({ path: target, content: 'pwned' }, CTX);

    expect(result.written).toBe(false);
    expect(result.error).toMatch(/workspace/i);
  });
});
