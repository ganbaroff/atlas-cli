/**
 * swarm-exec/intake.ts — the intake compiler: turns freeform CEO intent into
 * a STRUCTURED draft, and (only on an explicit second step) into an
 * exec-graph task.
 *
 * WHAT THIS IS: the gate between "raw natural language" and "an executing
 * task." Raw freeform intent must NEVER become an executing exec-graph task
 * directly — it has to pass through two explicit steps:
 *
 *   1. compileIntake(freeform) -> IntakeDraft   (+ writeDraft() to persist it)
 *   2. commitDraft(draftId, { goalId }) -> exec-graph Task via createTask()
 *
 * `commitDraft()` is the ONLY path from a draft to an exec-graph task in this
 * module — there is no shortcut from compileIntake() straight into
 * createTask(). A caller (CLI, hand, anything) that wants a freeform intent
 * to actually run has to go through both steps, and step 2 is always an
 * explicit, separately-invoked call.
 *
 * DETERMINISM: compileIntake() is pure keyword/string logic — no LLM call, no
 * network, no Date.now(), no Math.random(). The objective is the trimmed/
 * normalized freeform text itself; every other structured field is a safe,
 * fixed default; riskClass is derived by a keyword scan (see
 * deriveRiskClass() below for the exact mapping). draftId is a sha256-derived
 * id of the normalized objective, so the SAME intent always compiles to the
 * SAME draftId — compiling (and writing) the same intent twice is idempotent
 * by construction, not by caller discipline.
 *
 * ATOMICITY: writeDraft() follows the same tmp-file + renameSync pattern as
 * ../swarm-exec/run-bundle.ts's writeAtomic — a reader (readDraft) never
 * observes a half-written draft file.
 *
 * Tests: ../__tests__/swarm-intake.test.ts.
 */

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { resolveMigratingStateDir } from '../atlas/state-root.js';
import type { RiskClass } from '../exec-graph/contracts.js';
import { createTask } from '../exec-graph/api.js';

export interface IntakeDraft {
  draftId: string;
  objective: string;
  scope: string[];
  exclusions: string[];
  acceptanceCriteria: string[];
  dependencies: string[];
  riskClass: RiskClass;
  proofSpec: string;
  executor: string; // 'swarm-local'
  timeoutMs: number;
  retryPolicy: string;
  costClass: string;
  rollback: string;
  createdFrom: string; // the raw freeform intent, verbatim
}

export interface IntakeOpts {
  /** Pre-activation legacy/test override; ignored under required activation. */
  rootDir?: string;
  /** Injectable draftId override — tests only; compileIntake() otherwise derives it deterministically. */
  draftId?: string;
}

// ── Risk classification ────────────────────────────────────────────────────
//
// contracts.ts's RiskClass enum is `'low' | 'medium' | 'high' | 'irreversible'`
// (see riskClassSchema in ../exec-graph/contracts.ts — NOT the same enum as
// ../hands/risk.ts's classifyRisk(), which returns a different, hand-specific
// risk vocabulary for refuter triggering). The mapping used here:
//
//   - escalation keywords (deploy / migrat[e|ion] / prod / secret /
//     credential / api key / delete / `rm -rf` / drop table) -> 'irreversible',
//     the HIGHEST-severity value in the 4-level enum. Any of these signal the
//     freeform intent touches deploys, prod, secrets, or destructive ops.
//   - mutation keywords (write / edit / mutate / update db) -> 'medium', the
//     mid-level / data-mutation-adjacent value (checked only when no
//     escalation keyword already matched).
//   - otherwise -> 'low' (the lowest value), the default for read-only/
//     analysis-shaped intents.
//   - 'high' is intentionally never emitted by this deterministic scan; it is
//     reserved in the enum for a future finer-grained signal (e.g. an
//     explicit caller-supplied risk override), not for keyword inference.

const ESCALATION_KEYWORDS = [
  'deploy',
  'migrat',
  'prod',
  'secret',
  'credential',
  'api key',
  'delete',
  'rm -rf',
  'drop table',
];

const MUTATION_KEYWORDS = ['write', 'edit', 'mutate', 'update db'];

function deriveRiskClass(freeform: string): RiskClass {
  const lower = freeform.toLowerCase();
  if (ESCALATION_KEYWORDS.some((kw) => lower.includes(kw))) return 'irreversible';
  if (MUTATION_KEYWORDS.some((kw) => lower.includes(kw))) return 'medium';
  return 'low';
}

function deriveDraftId(objective: string): string {
  const hash = createHash('sha256').update(objective).digest('hex');
  return `dft_${hash.slice(0, 16)}`;
}

// ── Compile ─────────────────────────────────────────────────────────────────

/**
 * Compile freeform CEO intent into a structured IntakeDraft. Deterministic —
 * no LLM, no network, no clock, no randomness. Throws a clear Error if
 * `freeform` is empty/whitespace-only.
 */
export function compileIntake(freeform: string, opts?: IntakeOpts): IntakeDraft {
  if (!freeform || !freeform.trim()) {
    throw new Error('intake: freeform intent is required (cannot be empty or whitespace-only)');
  }

  const objective = freeform.trim().replace(/\s+/g, ' ');
  const draftId = opts?.draftId ?? deriveDraftId(objective);
  const riskClass = deriveRiskClass(freeform);

  return {
    draftId,
    objective,
    scope: [objective],
    // Standing mission NON-GOALS, as safe defaults for any compiled draft.
    exclusions: ['no deploy', 'no VOLAURA product code', 'no credentials/keys', 'no prod DB/migration'],
    acceptanceCriteria: [
      'swarm run bundle carries SWARM-VERIFIED token',
      'deterministic verifier (hands/verifier) transitions the task to verified',
    ],
    dependencies: [],
    riskClass,
    proofSpec:
      'state/swarm-runs/<runId>/bundle.json contains SWARM-VERIFIED:<runId>, checked by a file-contains receipt via hands/verifier',
    executor: 'swarm-local',
    timeoutMs: 300000,
    retryPolicy: 'none',
    costClass: 'FOREGROUND-CEO-SUPERVISED',
    rollback: 'none (read-only analysis; no external side effects)',
    createdFrom: freeform,
  };
}

// ── Persist ─────────────────────────────────────────────────────────────────

/** Migration-aware root directory all intake drafts live under. */
export function draftsRoot(opts?: IntakeOpts): string {
  return resolveMigratingStateDir(
    'intake-drafts',
    () => resolve(opts?.rootDir ?? 'state/intake-drafts'),
  );
}

// Module-level counter for temp-file suffixes, combined with process.pid so
// concurrent processes can't collide either. Never Math.random() — mirrors
// ../swarm-exec/run-bundle.ts's determinism convention.
let tmpCounter = 0;

function nextTmpSuffix(): string {
  tmpCounter += 1;
  return `${process.pid}-${tmpCounter}`;
}

function writeAtomic(filePath: string, payload: string): void {
  const tmpPath = `${filePath}.${nextTmpSuffix()}.tmp`;
  writeFileSync(tmpPath, payload, 'utf8');
  renameSync(tmpPath, filePath);
}

/**
 * Write `draft` atomically to `draftsRoot(opts)/<draftId>.json` (tmp file +
 * renameSync onto the final path, same pattern as run-bundle.ts's
 * writeAtomic). Same draft -> same bytes on disk, every time. Returns the
 * written file path. Never throws on well-formed input; a real fs failure
 * (disk full, permissions) propagates as-is.
 */
export function writeDraft(draft: IntakeDraft, opts?: IntakeOpts): string {
  const dir = draftsRoot(opts);
  mkdirSync(dir, { recursive: true });
  const filePath = join(dir, `${draft.draftId}.json`);
  const payload = `${JSON.stringify(draft, null, 2)}\n`;
  writeAtomic(filePath, payload);
  return filePath;
}

/**
 * Read back the draft for `draftId`, if it exists and parses cleanly. Never
 * throws — missing file, unreadable file, or corrupt/malformed JSON all
 * resolve to `null`.
 */
export function readDraft(draftId: string, opts?: IntakeOpts): IntakeDraft | null {
  try {
    const filePath = join(draftsRoot(opts), `${draftId}.json`);
    if (!existsSync(filePath)) return null;
    const raw = readFileSync(filePath, 'utf8');
    const parsed = JSON.parse(raw) as IntakeDraft;
    if (!parsed || typeof parsed !== 'object' || typeof parsed.draftId !== 'string') return null;
    return parsed;
  } catch {
    return null;
  }
}

// ── Commit ──────────────────────────────────────────────────────────────────

/**
 * Commit a previously-written draft into a real exec-graph task via
 * createTask(). This is the ONLY path from an IntakeDraft to an exec-graph
 * task — see the top-of-file doc comment. Throws if the draft cannot be
 * found (call writeDraft() first).
 *
 * idempotencyKey is derived by createTask() from `source.ref`
 * (`intake:<draftId>`), so committing the same draft twice dedupes onto the
 * SAME task (created: false the second time) rather than creating a second
 * one — this is createTask()'s existing dedup guarantee, reused here rather
 * than reimplemented.
 */
export function commitDraft(
  draftId: string,
  args: { goalId: string; actor?: string },
  opts?: IntakeOpts,
): { taskId: string; created: boolean } {
  const draft = readDraft(draftId, opts);
  if (!draft) {
    throw new Error(`intake: draft ${draftId} not found under ${draftsRoot(opts)} (call writeDraft first)`);
  }

  const result = createTask({
    goalId: args.goalId,
    title: draft.objective,
    riskClass: draft.riskClass,
    source: { kind: 'exec-graph', ref: `intake:${draftId}` },
    actor: args.actor ?? 'atlas',
  });

  return { taskId: result.task.id, created: result.created };
}
