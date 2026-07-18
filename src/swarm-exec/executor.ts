/**
 * swarm-exec/executor.ts — the CORE executor: wires a swarm run to an
 * exec-graph task through the existing Hand Contract (see
 * ../hands/exec-graph-adapter.ts).
 *
 * WHAT THIS IS: `runSwarmForTask(taskId, opts?) -> RunSwarmForTaskResult`.
 * The orchestrator that ties three already-independent layers together:
 *   1. exec-graph (../exec-graph/api.ts) — the ONE task authority. This
 *      module never writes exec-graph state directly; every write goes
 *      through ../hands/exec-graph-adapter.ts's submitReceipt() /
 *      verifyAndTransition() / abortHandTask(), exactly like every other
 *      Hand.
 *   2. the swarm (../swarm.ts) — runs the actual (real or injected) model
 *      calls and produces a SwarmRunDetail.
 *   3. the deterministic, no-LLM completion gate (./completion-policy.ts)
 *      and the durable run-bundle writer (./run-bundle.ts) — turn that
 *      SwarmRunDetail into an honest CompletionVerdict and a
 *      SWARM-VERIFIED/SWARM-REJECTED proof token on disk.
 *
 * THE LOAD-BEARING INVARIANT: the swarm run NEVER self-declares success.
 * runSwarmForTask() only ever SUBMITS a receipt (a `file-contains` claim
 * that bundle.json contains `SWARM-VERIFIED:<runId>`) — that receipt is
 * then checked by ../hands/verifier.ts (via verifyAndTransition()), the
 * SAME deterministic verifier every other Hand goes through. Only
 * verifyAndTransition() sets the task's final state ('verified' /
 * 'rejected'). A swarm run that produces a 'partial'/'failed' completion
 * verdict gets a SWARM-REJECTED token instead of SWARM-VERIFIED written
 * into its own bundle.json (see ./run-bundle.ts's proof-token rule) — so
 * the file-contains check against SWARM-VERIFIED naturally fails and the
 * task is honestly rejected, not silently passed. This module does not
 * special-case that path or try to "fix" the rejection; a failed swarm run
 * staying REJECTED is the correct, intended outcome.
 *
 * CONTROL GATE: before running anything, this checks
 * controlAllowsModelCalls() (../atlas/control-plane.ts). If control is
 * paused/stopped, the swarm never runs and the task is moved straight to
 * 'blocked' via abortHandTask() — proving a paused/stopped run can never
 * become VERIFIED. The same abort path is taken on any swarm-run exception
 * (a hand that errors must never be read as having succeeded either).
 *
 * Precondition: taskId must already be owned by 'hand:swarm-local' and sit
 * in 'delegated' or 'in-progress' — i.e. the caller (CLI or another
 * orchestrator) must already have called assignHand(taskId, 'swarm-local',
 * ...). This module never assigns the hand itself; that stays a separate,
 * explicit step, same as every other Hand delegation.
 *
 * Determinism for tests: every external effect (the swarm call itself, the
 * control gate, the clock, the completion evaluator, the run id, and the
 * bundle root directory) is injectable via RunSwarmForTaskOptions, so
 * ../__tests__/swarm-executor.test.ts can prove all three terminal outcomes
 * (verified / rejected / blocked) with zero real model calls and zero
 * writes outside a tmp dir.
 *
 * Tests: ../__tests__/swarm-executor.test.ts.
 */

import { runSwarmDetailed, type SwarmRunDetail, type WorkerResult } from '../swarm.js';
import { controlAllowsModelCalls } from '../atlas/control-plane.js';
import { getTask } from '../exec-graph/api.js';
import { submitReceipt, verifyAndTransition, abortHandTask } from '../hands/exec-graph-adapter.js';
import type { Receipt } from '../hands/contract.js';
import {
  evaluateCompletion,
  type CompletionPolicy,
  type CompletionVerdict,
  type ResponderResult,
} from './completion-policy.js';
import {
  writeRunBundle,
  type ProviderHealthSnapshot,
  type ProviderHealthState,
  type ResponderSummary,
} from './run-bundle.js';

const SWARM_HAND_ID = 'swarm-local';
const SWARM_HAND_OWNER = `hand:${SWARM_HAND_ID}`;

export interface EvaluateResult {
  evaluatorPassed: boolean;
  promotionPassed: boolean;
  evidenceTokens: string[];
  evaluation?: unknown;
  promotion?: unknown;
}

export interface RunSwarmForTaskOptions {
  /** Defaults to 'atlas'. */
  actor?: string;
  /** Defaults to `${taskId}-${now}` (sanitized); inject for deterministic tests. */
  runId?: string;
  /** Defaults to defaultSwarmPolicy(totalResponders). */
  policy?: CompletionPolicy;
  /** Defaults to undefined -> writeRunBundle()'s own default ('state/swarm-runs'); tests pass a tmp dir. */
  bundleRootDir?: string;
  /** Defaults to runSwarmDetailed. Inject a stub in tests — never make a real LLM call from a test. */
  runSwarm?: (task: string, useCustom?: boolean) => Promise<SwarmRunDetail>;
  /** Defaults to controlAllowsModelCalls. */
  controlAllows?: () => boolean;
  /** Defaults to a deterministic evaluator derived from responder counts + jidoka (see defaultEvaluate). */
  evaluate?: (detail: SwarmRunDetail, ctx: { respondersOk: number; policy: CompletionPolicy }) => EvaluateResult;
  /** Defaults to () => new Date().toISOString(). */
  now?: () => string;
}

export interface RunSwarmForTaskResult {
  status: 'verified' | 'rejected' | 'blocked';
  taskId: string;
  runId: string;
  bundlePath: string | null;
  completion: CompletionVerdict | null;
  reason: string;
}

/**
 * Default completion policy for a swarm run of `totalResponders` workers: a
 * strict majority must come back OK (requiredResponders), every non-OK
 * responder up to the remainder is tolerated (failureBudget), and evidence
 * tokens + evaluator + promotion are all required for a 'done' verdict.
 */
export function defaultSwarmPolicy(totalResponders: number): CompletionPolicy {
  const requiredResponders = Math.max(1, Math.ceil(totalResponders / 2));
  const failureBudget = Math.max(0, totalResponders - requiredResponders);
  return {
    requiredResponders,
    failureBudget,
    requireEvidenceTokens: true,
    requireEvaluator: true,
    requirePromotion: true,
  };
}

function defaultNow(): string {
  return new Date().toISOString();
}

/** A worker result counts as OK iff it carries no error AND non-empty trimmed output. */
function isWorkerOk(r: WorkerResult): boolean {
  return !r.error && !!r.output?.trim();
}

function buildResponders(detail: SwarmRunDetail): ResponderResult[] {
  return detail.results.map((r) => {
    const subtask = detail.subtasks.find((s) => s.id === r.id);
    return {
      id: r.id,
      perspective: subtask?.perspective,
      provider: r.provider,
      ok: isWorkerOk(r),
      output: r.output,
      error: r.error,
    };
  });
}

function buildResponderSummaries(responders: ResponderResult[], detail: SwarmRunDetail): ResponderSummary[] {
  return responders.map((r) => {
    const wr = detail.results.find((x) => x.id === r.id);
    return {
      id: r.id,
      perspective: r.perspective,
      provider: r.provider,
      ok: r.ok,
      durationMs: wr?.durationMs ?? 0,
      error: r.error,
    };
  });
}

/** Map a failed provider's error message to a ProviderHealthState — fixed rule set, no LLM. */
function classifyProviderError(error: string): ProviderHealthState {
  if (/401|403|unauth/i.test(error)) return 'auth-failed';
  if (/429|rate/i.test(error)) return 'cooldown';
  if (/timeout|timed out/i.test(error)) return 'unavailable';
  return 'degraded';
}

function buildProviderHealth(detail: SwarmRunDetail): ProviderHealthSnapshot[] {
  const providers = Array.from(new Set(detail.results.map((r) => r.provider)));
  return providers.map((provider) => {
    const providerResults = detail.results.filter((r) => r.provider === provider);
    const anyHealthy = providerResults.some((r) => !r.error);
    const responded = providerResults.some((r) => isWorkerOk(r));
    if (anyHealthy) {
      return { provider, state: 'healthy', responded };
    }
    const firstError = providerResults.find((r) => r.error)?.error ?? '';
    return { provider, state: classifyProviderError(firstError), responded, error: firstError || undefined };
  });
}

/**
 * Deterministic default evaluator: a swarm run "passes evaluation" iff a
 * majority of responders came back OK (per the policy's requiredResponders)
 * AND jidoka didn't flag the synthesis. Promotion mirrors evaluation for V0
 * — no separate operator-promotion step exists yet for swarm runs.
 */
function defaultEvaluate(
  detail: SwarmRunDetail,
  ctx: { respondersOk: number; policy: CompletionPolicy },
): EvaluateResult {
  const evaluatorPassed = ctx.respondersOk >= ctx.policy.requiredResponders && !detail.jidokaViolation;
  const uniqueProviderCount = new Set(detail.results.map((r) => r.provider)).size;
  return {
    evaluatorPassed,
    promotionPassed: evaluatorPassed,
    evidenceTokens: [
      `responders-ok:${ctx.respondersOk}`,
      `synthesis-chars:${detail.synthesis.length}`,
      `providers:${uniqueProviderCount}`,
    ],
  };
}

/**
 * Delegate a swarm run FROM an already-assigned exec-graph task, run it,
 * evaluate it honestly, and verify it through the Hand Contract. See the
 * top-of-file doc comment for the full chain — ONLY verifyAndTransition()
 * (called at the very end) sets the task's final state.
 */
export async function runSwarmForTask(
  taskId: string,
  opts: RunSwarmForTaskOptions = {},
): Promise<RunSwarmForTaskResult> {
  const actor = opts.actor ?? 'atlas';
  const now = opts.now ?? defaultNow;
  const controlAllows = opts.controlAllows ?? controlAllowsModelCalls;
  const runSwarm = opts.runSwarm ?? runSwarmDetailed;
  const evaluate = opts.evaluate ?? defaultEvaluate;

  const task = getTask(taskId);
  if (!task) {
    throw new Error(`unknown task ${taskId}`);
  }
  if (task.owner !== SWARM_HAND_OWNER || (task.status !== 'delegated' && task.status !== 'in-progress')) {
    throw new Error(
      `runSwarmForTask requires task ${taskId} to be owned by '${SWARM_HAND_OWNER}' and in status `
      + `'delegated' or 'in-progress' (owner=${task.owner}, status=${task.status}) — `
      + "the caller must assignHand(taskId, 'swarm-local', ...) first",
    );
  }

  // CONTROL GATE — a paused/stopped run never touches the swarm and never
  // reaches verification. Moves the task to 'blocked', never 'verified'.
  if (!controlAllows()) {
    abortHandTask(taskId, { actor, reason: 'control_not_active' });
    return { status: 'blocked', taskId, runId: '', bundlePath: null, completion: null, reason: 'control_not_active' };
  }

  const startedAt = now();

  let detail: SwarmRunDetail;
  try {
    detail = await runSwarm(task.title);
  } catch {
    abortHandTask(taskId, { actor, reason: 'swarm_run_error' });
    return { status: 'blocked', taskId, runId: '', bundlePath: null, completion: null, reason: 'swarm_run_error' };
  }

  const responders = buildResponders(detail);
  const responderSummaries = buildResponderSummaries(responders, detail);
  const providerHealth = buildProviderHealth(detail);
  const respondersOk = responders.filter((r) => r.ok).length;
  const policy = opts.policy ?? defaultSwarmPolicy(responders.length);

  const ev = evaluate(detail, { respondersOk, policy });

  const completion = evaluateCompletion({
    responders,
    policy,
    evidenceTokens: ev.evidenceTokens,
    evaluatorPassed: ev.evaluatorPassed,
    promotionPassed: ev.promotionPassed,
    jidokaViolation: detail.jidokaViolation,
  });

  // runId is derived from taskId (always 'tsk_<hex>...', letters first) so
  // it can never collide with the SECRET_SHAPE_PATTERNS Telegram-token guard
  // (`/\d{8,10}:[A-Za-z0-9_-]{30,}/`) that exec-graph-adapter.ts's
  // assertReceiptHasNoSecrets() runs over the receipt below — no digits ever
  // sit immediately before the ':' in `SWARM-VERIFIED:${runId}`.
  const runId = opts.runId ?? `${taskId}-${now().replace(/[:.]/g, '-')}`;
  const completedAt = now();

  const written = writeRunBundle(
    {
      runId,
      parentTaskId: taskId,
      policy,
      completion,
      responders: responderSummaries,
      providerHealth,
      result: detail.synthesis,
      trace: detail.results,
      evidenceTokens: ev.evidenceTokens,
      evaluation: ev.evaluation,
      promotion: ev.promotion,
      startedAt,
      completedAt,
      provenance: { runtime: 'anus-ts-swarm', hand: SWARM_HAND_ID, actor },
    },
    { rootDir: opts.bundleRootDir },
  );

  // The receipt only ever CLAIMS the run finished a certain way — the claim
  // is meaningless until ../hands/verifier.ts independently re-reads
  // bundle.json off disk and checks the substring itself (see
  // verifyAndTransition() below).
  const receipt: Receipt = {
    taskId,
    handId: SWARM_HAND_ID,
    submittedBy: actor,
    kind: 'file-contains',
    ref: written.bundlePath,
    expectedSubstring: `SWARM-VERIFIED:${runId}`,
    claimedResult:
      `swarm run ${runId}: ${completion.completion} `
      + `(${completion.respondersOk}/${completion.respondersTotal} ok, reason=${completion.reason})`,
  };

  submitReceipt(taskId, receipt);
  const vt = verifyAndTransition(taskId, { actor });

  return {
    status: vt.finalStatus === 'verified' ? 'verified' : 'rejected',
    taskId,
    runId,
    bundlePath: written.bundlePath,
    completion,
    reason: vt.verdict.reason,
  };
}
