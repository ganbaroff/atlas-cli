import { afterEach, describe, expect, it } from 'vitest';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import {
  bundleRoot,
  readBundle,
  writeRunBundle,
  type ProviderHealthSnapshot,
  type ResponderSummary,
  type RunBundleInput,
} from '../swarm-exec/run-bundle.js';
import type { CompletionPolicy, CompletionVerdict } from '../swarm-exec/completion-policy.js';

// Each test gets its own temp root via mkdtempSync so the repo's real
// state/swarm-runs/ is never touched; every created dir is torn down here.
const tmpDirs: string[] = [];

function makeTmpRoot(): string {
  const dir = mkdtempSync(join(tmpdir(), 'anus-run-bundle-'));
  tmpDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tmpDirs.length > 0) {
    const dir = tmpDirs.pop();
    if (!dir) continue;
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* ignore cleanup failures */
    }
  }
});

const policy: CompletionPolicy = {
  requiredResponders: 1,
  failureBudget: 0,
  requireEvidenceTokens: false,
  requireEvaluator: false,
  requirePromotion: false,
};

function doneVerdict(): CompletionVerdict {
  return {
    completion: 'done',
    reason: 'all_gates_passed',
    respondersTotal: 1,
    respondersOk: 1,
    respondersFailed: 0,
  };
}

function failedVerdict(): CompletionVerdict {
  return {
    completion: 'failed',
    reason: 'no_responders_ok',
    respondersTotal: 1,
    respondersOk: 0,
    respondersFailed: 1,
  };
}

function makeResponders(): ResponderSummary[] {
  return [{ id: 0, perspective: 'analysis', provider: 'nvidia', ok: true, durationMs: 120 }];
}

function makeProviderHealth(): ProviderHealthSnapshot[] {
  return [{ provider: 'nvidia', state: 'healthy', responded: true }];
}

function makeInput(runId: string, completion: CompletionVerdict): RunBundleInput {
  return {
    runId,
    parentTaskId: 'tsk_abc123',
    policy,
    completion,
    responders: makeResponders(),
    providerHealth: makeProviderHealth(),
    result: 'synthesized result text',
    trace: [
      { perspective: 'analysis', note: 'trace entry one' },
      { perspective: 'critique', note: 'trace entry two' },
    ],
    evidenceTokens: ['receipt:file-exists:foo.ts'],
    startedAt: '2026-07-18T00:00:00.000Z',
    completedAt: '2026-07-18T00:00:05.000Z',
    provenance: { runtime: 'anus-ts-swarm', hand: 'sonnet', actor: 'atlas' },
  };
}

const ARTIFACT_FILENAMES = [
  'result.json',
  'trace.jsonl',
  'provider-health.json',
  'evidence-manifest.json',
  'responder-summary.json',
];

describe('run-bundle', () => {
  it('bundleRoot() resolves the given rootDir', () => {
    const rootDir = makeTmpRoot();
    expect(bundleRoot({ rootDir })).toBe(resolve(rootDir));
  });

  it("completion 'done' => bundle.json exists, proof is SWARM-VERIFIED, complete=true, all 5 sub-artifacts exist", () => {
    const rootDir = makeTmpRoot();
    const runId = 'run-done';
    const input = makeInput(runId, doneVerdict());
    const written = writeRunBundle(input, { rootDir });

    expect(written.complete).toBe(true);
    expect(written.proofToken).toBe(`SWARM-VERIFIED:${runId}`);
    expect(existsSync(written.bundlePath)).toBe(true);

    const bundle = JSON.parse(readFileSync(written.bundlePath, 'utf8'));
    expect(bundle.complete).toBe(true);
    expect(bundle.proof).toBe(`SWARM-VERIFIED:${runId}`);

    for (const name of ARTIFACT_FILENAMES) {
      expect(existsSync(join(written.dir, name))).toBe(true);
    }
  });

  it("completion 'failed' => proof is SWARM-REJECTED and bundle.json does NOT contain the SWARM-VERIFIED token", () => {
    const rootDir = makeTmpRoot();
    const runId = 'run-failed';
    const input = makeInput(runId, failedVerdict());
    const written = writeRunBundle(input, { rootDir });

    expect(written.proofToken).toBe(`SWARM-REJECTED:${runId}`);
    const raw = readFileSync(written.bundlePath, 'utf8');
    expect(raw.includes('SWARM-VERIFIED')).toBe(false);
    expect(raw.includes(`SWARM-REJECTED:${runId}`)).toBe(true);
  });

  it('idempotent: writing the same input twice yields deep-equal readBundle results', () => {
    const rootDir = makeTmpRoot();
    const runId = 'run-idempotent';
    const input = makeInput(runId, doneVerdict());

    writeRunBundle(input, { rootDir });
    const first = readBundle(runId, { rootDir });
    writeRunBundle(input, { rootDir });
    const second = readBundle(runId, { rootDir });

    expect(first).not.toBeNull();
    expect(second).toEqual(first);
  });

  it('no leftover .tmp files remain in the run dir after a successful write', () => {
    const rootDir = makeTmpRoot();
    const runId = 'run-clean';
    writeRunBundle(makeInput(runId, doneVerdict()), { rootDir });

    const dir = join(rootDir, runId);
    const entries = readdirSync(dir);
    const tmpFiles = entries.filter((name) => name.endsWith('.tmp'));
    expect(tmpFiles).toEqual([]);
  });

  it("readBundle('nonexistent') => null", () => {
    const rootDir = makeTmpRoot();
    expect(readBundle('nonexistent-run-id', { rootDir })).toBeNull();
  });

  it('incomplete visibility: a run dir with a sub-artifact but no bundle.json => readBundle => null', () => {
    const rootDir = makeTmpRoot();
    const runId = 'run-partial';
    const dir = join(rootDir, runId);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'result.json'), JSON.stringify({ result: 'partial' }), 'utf8');

    expect(readBundle(runId, { rootDir })).toBeNull();
  });

  it('provider-health.json is persisted with the snapshot passed in', () => {
    const rootDir = makeTmpRoot();
    const runId = 'run-health';
    const providerHealth: ProviderHealthSnapshot[] = [
      { provider: 'nvidia', state: 'degraded', responded: true, error: 'slow response' },
      { provider: 'groq', state: 'auth-failed', responded: false, error: '401' },
    ];
    const input: RunBundleInput = { ...makeInput(runId, doneVerdict()), providerHealth };
    const written = writeRunBundle(input, { rootDir });

    const persisted = JSON.parse(readFileSync(join(written.dir, 'provider-health.json'), 'utf8'));
    expect(persisted).toEqual(providerHealth);
  });
});
