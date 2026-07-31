/**
 * M3D Task 6 — physical cutover packet tests (disposable fixtures only).
 */

import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import {
  PHYSICAL_CUTOVER_EXECUTE_TOKEN,
  assertJunctionRealpathSafe,
  assertPathContained,
  CutoverPacketError,
  executeCutoverPacket,
  generateDisposableCutoverPacket,
  renderCutoverCommandFile,
  validateCutoverPacket,
  writeCutoverPacketArtifact,
} from '../atlas/cutover-packet.js';

const tempRoots: string[] = [];

function tempDir(prefix = 'atlas-cutover-'): string {
  const root = mkdtempSync(join(tmpdir(), prefix));
  tempRoots.push(root);
  return root;
}

afterEach(() => {
  delete process.env[PHYSICAL_CUTOVER_EXECUTE_TOKEN];
  while (tempRoots.length > 0) {
    const root = tempRoots.pop();
    if (root) rmSync(root, { recursive: true, force: true });
  }
});

describe('path and junction guards', () => {
  it('accepts contained paths and refuses escapes', () => {
    const sandbox = tempDir();
    mkdirSync(join(sandbox, 'child'), { recursive: true });
    expect(() => assertPathContained(sandbox, join(sandbox, 'child'))).not.toThrow();
    expect(() => assertPathContained(sandbox, join(sandbox, '..', 'escape'))).toThrow(
      /path_escape/,
    );
  });

  it('proves junction realpath stays inside the sandbox', () => {
    const sandbox = tempDir();
    const target = join(sandbox, 'target');
    const link = join(sandbox, 'link');
    mkdirSync(target);
    writeFileSync(join(target, 'x.txt'), 'x\n');
    symlinkSync(target, link, process.platform === 'win32' ? 'junction' : 'dir');
    expect(() => assertJunctionRealpathSafe(link, target, sandbox)).not.toThrow();

    const outside = tempDir('atlas-cutover-outside-');
    const badLink = join(sandbox, 'bad-link');
    symlinkSync(outside, badLink, process.platform === 'win32' ? 'junction' : 'dir');
    expect(() => assertJunctionRealpathSafe(badLink, outside, sandbox)).toThrow(
      /junction_unsafe|path_escape/,
    );
  });
});

describe('disposable cutover packet', () => {
  it('generates a schema-valid packet with gated destructive steps', () => {
    const sandbox = tempDir('atlas-cutover-packet-');
    const packet = generateDisposableCutoverPacket({ sandboxRoot: sandbox });
    expect(packet.kind).toBe('atlas.m3d-physical-cutover-packet');
    expect(packet.executeTokenName).toBe(PHYSICAL_CUTOVER_EXECUTE_TOKEN);
    expect(packet.steps.some((s) => s.destructive && s.requiresToken)).toBe(true);
    expect(
      packet.steps.filter((s) => s.destructive).every((s) => s.requiresToken),
    ).toBe(true);
    validateCutoverPacket(packet);

    const artifact = writeCutoverPacketArtifact(packet);
    expect(existsSync(artifact)).toBe(true);
    const rendered = renderCutoverCommandFile(packet);
    expect(rendered).toContain(PHYSICAL_CUTOVER_EXECUTE_TOKEN);
    expect(rendered).toContain('[DESTRUCTIVE');
  });

  it('refuses execute without the token', () => {
    const sandbox = tempDir();
    const packet = generateDisposableCutoverPacket({ sandboxRoot: sandbox });
    delete process.env[PHYSICAL_CUTOVER_EXECUTE_TOKEN];
    expect(() => executeCutoverPacket(packet, 'cutover')).toThrow(CutoverPacketError);
    expect(() => executeCutoverPacket(packet, 'cutover')).toThrow(/token_missing/);
  });

  it('runs disposable cutover then rollback end-to-end with the token', () => {
    const sandbox = tempDir('atlas-cutover-e2e-');
    const packet = generateDisposableCutoverPacket({ sandboxRoot: sandbox });
    process.env[PHYSICAL_CUTOVER_EXECUTE_TOKEN] = '1';

    const cut = executeCutoverPacket(packet, 'cutover');
    expect(cut.completedStepIds).toContain('post-verify');
    expect(existsSync(packet.roots.finalAtlasRoot)).toBe(true);
    expect(existsSync(packet.roots.quarantineSibling)).toBe(true);
    expect(existsSync(packet.roots.anusCodeRoot)).toBe(false);
    expect(existsSync(packet.roots.legacyAtlasRoot)).toBe(false);
    expect(existsSync(join(packet.roots.stateRoot, 'writer-stopped.json'))).toBe(
      true,
    );
    const scheduler = readFileSync(packet.scheduler.path, 'utf8');
    expect(scheduler).toContain(packet.roots.finalAtlasRoot);

    const rb = executeCutoverPacket(packet, 'rollback');
    expect(rb.completedStepIds).toContain('rollback-worktree');
    expect(existsSync(packet.roots.anusCodeRoot)).toBe(true);
    expect(existsSync(packet.roots.legacyAtlasRoot)).toBe(true);
    expect(existsSync(packet.roots.finalAtlasRoot)).toBe(false);
    expect(existsSync(packet.roots.quarantineSibling)).toBe(false);
    for (const junction of packet.junctions) {
      expect(existsSync(junction.linkPath)).toBe(true);
      assertJunctionRealpathSafe(
        junction.linkPath,
        junction.expectedTarget,
        packet.sandboxRoot,
      );
    }
  });

  it('refuses a packet whose mutation path escapes the sandbox', () => {
    const sandbox = tempDir();
    const packet = generateDisposableCutoverPacket({ sandboxRoot: sandbox });
    const forged = {
      ...packet,
      steps: packet.steps.map((step) =>
        step.id === 'stop-writers'
          ? {
              ...step,
              mutationPaths: [join(sandbox, '..', 'escape-receipt.json')],
            }
          : step,
      ),
    };
    expect(() => validateCutoverPacket(forged as typeof packet)).toThrow(/path_escape/);
  });

  it('refuses sandboxes under known live roots', () => {
    const packet = generateDisposableCutoverPacket({
      sandboxRoot: tempDir(),
    });
    const forged = {
      ...packet,
      sandboxRoot: join('C:', 'Projects', 'ATLAS', 'fake-cutover-sandbox'),
    };
    process.env[PHYSICAL_CUTOVER_EXECUTE_TOKEN] = '1';
    expect(() => executeCutoverPacket(forged as typeof packet, 'cutover')).toThrow(
      /live_path_refused/,
    );
  });
});
