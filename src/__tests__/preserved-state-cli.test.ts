import { spawnSync } from 'node:child_process';
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { writeExecGraphFixture } from './fixtures/exec-graph-shadow-fixture.js';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const SCRIPT = join(ROOT, 'scripts', 'rehearse-preserved-exec-graph.mts');
const TSX_CLI = join(ROOT, 'node_modules', 'tsx', 'dist', 'cli.mjs');
const NETWORK_GUARD_URL = pathToFileURL(
  join(ROOT, 'src', '__tests__', 'fixtures', 'forbid-network.mjs'),
).href;
const ARTIFACT_NAME = 'atlas-exec-graph-m3c-20260730T174900Z-cafebabe';

interface ChildResult {
  readonly status: number | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly error?: Error;
}

function runCli(args: readonly string[], forbidNetwork = false): ChildResult {
  const result = spawnSync(process.execPath, [TSX_CLI, SCRIPT, ...args], {
    cwd: ROOT,
    encoding: 'utf8',
    env: {
      ...process.env,
      NODE_NO_WARNINGS: '1',
      NODE_OPTIONS: forbidNetwork ? `--import=${NETWORK_GUARD_URL}` : '',
    },
    maxBuffer: 1024 * 1024,
    timeout: 30_000,
    windowsHide: true,
  });
  return {
    status: result.status,
    stdout: result.stdout,
    stderr: result.stderr,
    ...(result.error ? { error: result.error } : {}),
  };
}

function parseOnlyJsonLine(value: string): Record<string, unknown> {
  const lines = value.trim().split(/\r?\n/);
  expect(lines).toHaveLength(1);
  return JSON.parse(lines[0] ?? '') as Record<string, unknown>;
}

describe('preserved-state drill CLI', () => {
  let sandboxDirectory: string;

  beforeEach(() => {
    sandboxDirectory = mkdtempSync(join(tmpdir(), 'atlas-preserved-cli-'));
  });

  afterEach(() => {
    rmSync(sandboxDirectory, { recursive: true, force: true });
  });

  it('refuses missing run arguments before creating an artifact', () => {
    const sourceDirectory = writeExecGraphFixture(sandboxDirectory, 'missing-source');
    const preservationParentDirectory = join(sandboxDirectory, 'missing-parent');
    mkdirSync(preservationParentDirectory);

    const child = runCli([
      'run',
      '--source',
      sourceDirectory,
      '--preservation-parent',
      preservationParentDirectory,
    ]);

    expect(child.error).toBeUndefined();
    expect(child.status).not.toBe(0);
    expect(child.stdout).toBe('');
    expect(parseOnlyJsonLine(child.stderr)).toEqual({
      status: 'refused',
      code: 'path_invalid',
      message: expect.any(String),
    });
    expect(readdirSync(preservationParentDirectory)).toEqual([]);
  });

  it.each([
    ['unknown mode', ['destroy']],
    ['missing option value', ['run', '--source']],
    [
      'relative run source',
      [
        'run',
        '--source',
        'relative-source',
        '--preservation-parent',
        'C:\\absolute-placeholder',
        '--artifact-name',
        ARTIFACT_NAME,
      ],
    ],
    ['relative verify artifact', ['verify', '--artifact', 'relative-artifact']],
  ])('refuses %s with one sanitized path_invalid error', (_label, args) => {
    const child = runCli(args);

    expect(child.error).toBeUndefined();
    expect(child.status).not.toBe(0);
    expect(child.stdout).toBe('');
    expect(parseOnlyJsonLine(child.stderr)).toEqual({
      status: 'refused',
      code: 'path_invalid',
      message: expect.any(String),
    });
  });

  it('runs and independently verifies one preserved copy with network denied', () => {
    const sourceDirectory = writeExecGraphFixture(
      sandboxDirectory,
      'source',
      'ledger-content-must-not-print',
    );
    const preservationParentDirectory = join(sandboxDirectory, 'preservation');
    mkdirSync(preservationParentDirectory);

    const run = runCli(
      [
        'run',
        '--source',
        sourceDirectory,
        '--preservation-parent',
        preservationParentDirectory,
        '--artifact-name',
        ARTIFACT_NAME,
      ],
      true,
    );

    expect(run.error).toBeUndefined();
    expect(run.status).toBe(0);
    expect(run.stderr).toBe('');
    const runSummary = parseOnlyJsonLine(run.stdout);
    expect(Object.keys(runSummary).sort()).toEqual(
      [
        'status',
        'artifactDirectory',
        'manifestSha256',
        'eventCount',
        'goalCount',
        'taskCount',
        'rollbackVerified',
        'workDirectoryAbsent',
      ].sort(),
    );
    expect(runSummary).toEqual({
      status: 'accepted',
      artifactDirectory: join(preservationParentDirectory, ARTIFACT_NAME),
      manifestSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
      eventCount: 2,
      goalCount: 1,
      taskCount: 1,
      rollbackVerified: true,
      workDirectoryAbsent: true,
    });
    expect(run.stdout).not.toContain('ledger-content-must-not-print');

    const verify = runCli(
      ['verify', '--artifact', String(runSummary.artifactDirectory)],
      true,
    );

    expect(verify.error).toBeUndefined();
    expect(verify.status).toBe(0);
    expect(verify.stderr).toBe('');
    const verifySummary = parseOnlyJsonLine(verify.stdout);
    expect(Object.keys(verifySummary).sort()).toEqual(
      [
        'status',
        'artifactDirectory',
        'manifestSha256',
        'eventCount',
        'goalCount',
        'taskCount',
        'verified',
      ].sort(),
    );
    expect(verifySummary).toEqual({
      status: 'verified',
      artifactDirectory: runSummary.artifactDirectory,
      manifestSha256: runSummary.manifestSha256,
      eventCount: 2,
      goalCount: 1,
      taskCount: 1,
      verified: true,
    });
    expect(verify.stdout).not.toContain('ledger-content-must-not-print');
  });
});
