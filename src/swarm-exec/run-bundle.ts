/**
 * swarm-exec/run-bundle.ts — writes ONE correlated, durable "run bundle" for
 * a completed (or rejected) swarm run to `state/swarm-runs/<runId>/`.
 *
 * WHAT THIS IS: a swarm run touches many providers, many responders, a
 * completion verdict, evidence tokens, and (later) an operator evaluation/
 * promotion verdict. Instead of scattering those across ad-hoc files that
 * can drift out of sync, `writeRunBundle()` correlates all of it under one
 * `runId` directory and writes one authoritative `bundle.json` that a later
 * reader (a human, a verifier, an evaluator) can trust as the single source
 * of truth for "what actually happened in this run."
 *
 * Atomicity: every artifact (the 5 sub-artifacts and bundle.json itself) is
 * written by the same pattern this repo already uses elsewhere (see
 * ../atlas/control-plane.ts writeOperatorState): write the full payload to a
 * sibling `<name>.<suffix>.tmp` file, then `renameSync` it onto the final
 * path. A rename onto an existing path is atomic on the filesystems this
 * runs on, so a reader never observes a half-written file.
 *
 * Write order IS the durability guarantee: the 5 sub-artifacts
 * (result.json, trace.jsonl, provider-health.json, evidence-manifest.json,
 * responder-summary.json) are written FIRST, and `bundle.json` — the file
 * that flips `complete: true` and carries the proof token — is written
 * LAST. If the process crashes or the write fails partway through, the run
 * directory may contain some sub-artifacts but will NEVER contain a
 * `bundle.json` reflecting that partial state, because bundle.json only
 * ever lands after every sub-artifact has already landed. `readBundle()`
 * enforces this: no bundle.json, or a bundle.json that fails to parse, or
 * one without `complete === true`, all read as `null` — a crashed run is
 * VISIBLY incomplete, never mistaken for a finished one.
 *
 * Proof token semantics: `proof` inside bundle.json is
 * `SWARM-VERIFIED:<runId>` if and only if `completion.completion === 'done'`
 * — any other verdict ('partial' | 'failed') gets `SWARM-REJECTED:<runId>`
 * instead. A later deterministic verifier (in the style of
 * ../hands/verifier.ts's 'file-contains' receipt kind) does a substring
 * check on bundle.json for `SWARM-VERIFIED:<runId>`; because the VERIFIED
 * token is only ever written on a genuine 'done' verdict, that check can't
 * be satisfied by a partial/failed run, a stale bundle, or a crash-partial
 * directory.
 *
 * Determinism/idempotency: same `RunBundleInput` -> same bytes on disk,
 * every time, for both the sub-artifacts and bundle.json. No `Date.now()`,
 * no `Math.random()`, no clock of any kind lives in this module —
 * `startedAt`/`completedAt` are caller-supplied ISO strings. The only
 * per-write-call randomness-adjacent value is the temp-file suffix used to
 * avoid colliding with a concurrent write of the same artifact; that suffix
 * is derived from `process.pid` plus a module-level incrementing counter,
 * never `Math.random()`, and never appears in the payload written to the
 * final path. Re-writing the same `runId` with the same input overwrites
 * every file with byte-identical content.
 *
 * Failure behavior: `writeRunBundle` never throws on well-formed input, and
 * never wraps/swallows a real fs failure — if a sub-write's `writeFileSync`
 * or `renameSync` throws (disk full, permissions, etc.), that throw
 * propagates to the caller as-is. That IS the crash path this module is
 * designed around: a caller that crashes mid-write leaves an incomplete run
 * directory, which is exactly what `readBundle()` is built to recognize.
 * `readBundle` itself never throws — every fs/parse failure resolves to
 * `null`, mirroring ../hands/verifier.ts's and
 * ../swarm-exec/completion-policy.ts's "reads/pure functions never throw"
 * convention.
 *
 * Tests: ../__tests__/swarm-run-bundle.test.ts.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { CompletionPolicy, CompletionVerdict } from './completion-policy.js';

export type ProviderHealthState = 'healthy' | 'degraded' | 'cooldown' | 'auth-failed' | 'unavailable';

export interface ProviderHealthSnapshot {
  provider: string;
  state: ProviderHealthState;
  responded: boolean;
  error?: string;
}

export interface ResponderSummary {
  id: number;
  perspective?: string;
  provider: string;
  ok: boolean;
  durationMs: number;
  error?: string;
}

export interface RunBundleInput {
  runId: string; // stable id -> idempotency
  parentTaskId: string; // exec-graph tsk_...
  policy: CompletionPolicy; // normalized policy actually applied
  completion: CompletionVerdict; // verdict from evaluateCompletion()
  responders: ResponderSummary[];
  providerHealth: ProviderHealthSnapshot[];
  result: string; // synthesis text
  trace: unknown[]; // per-perspective trace entries
  evidenceTokens: string[];
  evaluation?: unknown; // operator evaluation verdict (optional this wave)
  promotion?: unknown; // operator promotion verdict (optional this wave)
  startedAt: string; // ISO, caller-supplied (NO clock in this module)
  completedAt: string; // ISO, caller-supplied
  provenance: { runtime: 'anus-ts-swarm'; hand: string; actor: string };
}

export interface WrittenBundle {
  runId: string;
  dir: string;
  bundlePath: string;
  proofToken: string; // see rules in the top-of-file doc comment
  complete: boolean;
}

export interface WriteOpts {
  rootDir?: string; // default 'state/swarm-runs' (cwd-relative) — override for tests
}

/** Fixed, ordered list of the 5 sub-artifact filenames every bundle carries. */
const ARTIFACT_FILENAMES = [
  'result.json',
  'trace.jsonl',
  'provider-health.json',
  'evidence-manifest.json',
  'responder-summary.json',
] as const;

const BUNDLE_FILENAME = 'bundle.json';

// Module-level counter for temp-file suffixes. Combined with process.pid so
// concurrent processes can't collide either. Never Math.random() — see the
// determinism note in the top-of-file doc comment.
let tmpCounter = 0;

function nextTmpSuffix(): string {
  tmpCounter += 1;
  return `${process.pid}-${tmpCounter}`;
}

/** Write `payload` to `filePath` atomically: tmp file + renameSync onto the final path. */
function writeAtomic(filePath: string, payload: string): void {
  const tmpPath = `${filePath}.${nextTmpSuffix()}.tmp`;
  writeFileSync(tmpPath, payload, 'utf8');
  renameSync(tmpPath, filePath);
}

function toJsonl(entries: unknown[]): string {
  if (entries.length === 0) return '';
  return `${entries.map((entry) => JSON.stringify(entry)).join('\n')}\n`;
}

function toJson(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

/** Resolved root directory all run bundles live under. */
export function bundleRoot(opts?: WriteOpts): string {
  return resolve(opts?.rootDir ?? 'state/swarm-runs');
}

/**
 * Write one correlated run bundle for `input.runId` under
 * `bundleRoot(opts)/<runId>/`. Writes the 5 sub-artifacts first (each
 * atomically), then `bundle.json` last (also atomically) — see the
 * top-of-file doc comment for why that order is the durability guarantee.
 *
 * Never throws on well-formed input; a real fs failure propagates as-is
 * (that is the crash path `readBundle()` is designed to detect).
 */
export function writeRunBundle(input: RunBundleInput, opts?: WriteOpts): WrittenBundle {
  const dir = resolve(bundleRoot(opts), input.runId);
  mkdirSync(dir, { recursive: true });

  const proofToken =
    input.completion.completion === 'done'
      ? `SWARM-VERIFIED:${input.runId}`
      : `SWARM-REJECTED:${input.runId}`;

  writeAtomic(join(dir, 'result.json'), toJson({ result: input.result }));
  writeAtomic(join(dir, 'trace.jsonl'), toJsonl(input.trace));
  writeAtomic(join(dir, 'provider-health.json'), toJson(input.providerHealth));
  writeAtomic(
    join(dir, 'evidence-manifest.json'),
    toJson({ evidenceTokens: input.evidenceTokens, artifacts: ARTIFACT_FILENAMES }),
  );
  writeAtomic(join(dir, 'responder-summary.json'), toJson(input.responders));

  const bundlePath = join(dir, BUNDLE_FILENAME);
  const bundle = {
    schemaVersion: 1,
    runId: input.runId,
    parentTaskId: input.parentTaskId,
    policy: input.policy,
    completion: input.completion,
    respondersSummaryRef: 'responder-summary.json',
    providerHealth: input.providerHealth,
    evidenceTokens: input.evidenceTokens,
    evaluation: input.evaluation,
    promotion: input.promotion,
    proof: proofToken,
    finalReason: input.completion.reason,
    startedAt: input.startedAt,
    completedAt: input.completedAt,
    provenance: input.provenance,
    complete: true,
    artifacts: ARTIFACT_FILENAMES,
  };
  writeAtomic(bundlePath, toJson(bundle));

  return { runId: input.runId, dir, bundlePath, proofToken, complete: true };
}

/**
 * Read back the bundle for `runId`, if it exists and is genuinely complete.
 * Returns `null` — never throws — when: the run dir doesn't exist, there is
 * no bundle.json, bundle.json fails to parse, or bundle.json parses but
 * `complete !== true`. A dir with only partial sub-artifacts (no
 * bundle.json yet, e.g. a crashed write) reads as `null` by construction.
 */
export function readBundle(runId: string, opts?: WriteOpts): Record<string, unknown> | null {
  try {
    const bundlePath = join(resolve(bundleRoot(opts), runId), BUNDLE_FILENAME);
    if (!existsSync(bundlePath)) return null;
    const raw = readFileSync(bundlePath, 'utf8');
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    if (parsed['complete'] !== true) return null;
    return parsed;
  } catch {
    return null;
  }
}
