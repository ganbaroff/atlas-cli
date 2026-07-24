/**
 * Research swarm lifecycle — bounded orchestration with honest evidence.
 */

import { Agent } from '@mastra/core/agent';
import { createHash } from 'node:crypto';
import { PERSPECTIVES } from '../atlas/perspectives.js';
import { controlAllowsModelCalls, describeControlBlock } from '../atlas/control-plane.js';
import { isPaused } from '../atlas/spend-policy.js';
import { validateCompletion } from '../gates/verify-before-done.js';
import { buildAtlasBrainPlan } from '../atlas/brain-planner.js';
import { recordAgentSpend } from '../agent.js';
import type { ProviderName } from '../model-router.js';
import type { Subtask, WorkerResult, SwarmRunDetail } from '../swarm.js';
import { buildArtifact, exitCodeForStatus, newRunId, taskHash, writeArtifact } from './artifact.js';
import { deriveStatusFromDiversity, evaluateDiversity } from './diversity.js';
import { modelFamily } from './model-family.js';
import { probeMemoryState } from './memory-state.js';
import {
  ProviderRoutingError,
  routeWorkerProvider,
} from './provider-routing.js';
import {
  auditPerspectiveConfig,
  validateDeclaredWorkerProvider,
} from './perspective-config.js';
import { runJudge } from './synthesis.js';
import {
  isPastDeadline,
  readTimeoutConfig,
  remainingMs,
  withTimeoutOutcome,
} from './timeouts.js';
import type {
  ResearchSwarmResult,
  ResearchSwarmStatus,
  WorkerEvidence,
} from './types.js';

export interface ResearchSwarmOptions {
  useCustomDecompose?: boolean;
  bridgeSource?: 'typescript' | 'python' | 'typescript-fallback';
}

function decomposeWithPerspectives(task: string): Subtask[] {
  return PERSPECTIVES.map((p, i) => ({
    id: i,
    description: `${p.instruction}\n\nAnalyze this task from your perspective:\n${task}`,
    perspective: p.name,
    provider: p.provider as ProviderName | undefined,
  }));
}

async function runWorkerBounded(
  subtask: Subtask,
  workerTimeoutMs: number,
  routingTimeoutMs: number,
): Promise<WorkerEvidence> {
  const t0 = Date.now();
  const declared = subtask.provider;

  const preflight = validateDeclaredWorkerProvider(declared);
  if (!preflight.ok) {
    return {
      id: subtask.id,
      perspective: subtask.perspective,
      declaredProvider: declared,
      actualProvider: declared ?? 'none',
      actualModelId: 'none',
      modelFamily: 'none',
      status: preflight.status,
      output: '',
      durationMs: Date.now() - t0,
      error: preflight.error.slice(0, 200),
    };
  }

  let route;
  try {
    const routingOutcome = await withTimeoutOutcome(
      Promise.resolve().then(() =>
        routeWorkerProvider(
          { preferred: declared as ProviderName | undefined, required: undefined },
          'WORKER',
        ),
      ),
      routingTimeoutMs,
    );
    if (routingOutcome.kind === 'timeout') {
      return {
        id: subtask.id,
        perspective: subtask.perspective,
        declaredProvider: declared,
        actualProvider: declared ?? 'none',
        actualModelId: 'none',
        modelFamily: 'none',
        status: 'routing_error',
        output: '',
        durationMs: Date.now() - t0,
        error: `routing_timeout_${routingTimeoutMs}ms`,
      };
    }
    if (routingOutcome.kind === 'rejected') {
      const msg = routingOutcome.error instanceof Error ? routingOutcome.error.message : String(routingOutcome.error);
      return {
        id: subtask.id,
        perspective: subtask.perspective,
        declaredProvider: declared,
        actualProvider: declared ?? 'none',
        actualModelId: 'none',
        modelFamily: 'none',
        status: routingOutcome.error instanceof ProviderRoutingError ? 'blocked' : 'routing_error',
        output: '',
        durationMs: Date.now() - t0,
        error: msg.slice(0, 200),
      };
    }
    route = routingOutcome.value;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      id: subtask.id,
      perspective: subtask.perspective,
      declaredProvider: declared,
      actualProvider: declared ?? 'none',
      actualModelId: 'none',
      modelFamily: 'none',
      status: err instanceof ProviderRoutingError ? 'blocked' : 'routing_error',
      output: '',
      durationMs: Date.now() - t0,
      error: msg.slice(0, 200),
    };
  }

  const plan = await buildAtlasBrainPlan({ channel: 'cli', role: 'WORKER' });
  const agent = new Agent({
    id: 'atlas-worker',
    name: 'Atlas Worker',
    instructions: plan.systemPrompt,
    model: route.model,
  });

  const genOutcome = await withTimeoutOutcome(agent.generate(subtask.description), workerTimeoutMs);
  const durationMs = Date.now() - t0;
  const family = modelFamily(route.provider, route.modelId);

  if (genOutcome.kind === 'timeout') {
    return {
      id: subtask.id,
      perspective: subtask.perspective,
      declaredProvider: declared,
      actualProvider: route.provider,
      actualModelId: route.modelId,
      modelFamily: family,
      status: 'timeout',
      output: '',
      durationMs,
      error: `worker_timeout_${workerTimeoutMs}ms`,
    };
  }

  if (genOutcome.kind === 'rejected') {
    const msg = genOutcome.error instanceof Error ? genOutcome.error.message : String(genOutcome.error);
    return {
      id: subtask.id,
      perspective: subtask.perspective,
      declaredProvider: declared,
      actualProvider: route.provider,
      actualModelId: route.modelId,
      modelFamily: family,
      status: 'provider_error',
      output: '',
      durationMs,
      error: msg.slice(0, 200),
    };
  }

  recordAgentSpend(genOutcome.value, route, 'research-swarm-worker');
  const jidoka = validateCompletion(genOutcome.value.text);
  const output = jidoka.passed
    ? genOutcome.value.text
    : `${genOutcome.value.text}\n\n[WORKER JIDOKA: ${jidoka.violation}]`;

  return {
    id: subtask.id,
    perspective: subtask.perspective,
    declaredProvider: declared,
    actualProvider: route.provider,
    actualModelId: route.modelId,
    modelFamily: family,
    status: 'ok',
    output,
    durationMs,
    error: jidoka.passed ? undefined : `jidoka:${jidoka.violation}`,
  };
}

function toLegacyResults(workers: WorkerEvidence[]): WorkerResult[] {
  return workers.map((w) => ({
    id: w.id,
    output: w.output,
    provider: w.actualProvider,
    durationMs: w.durationMs,
    error: w.status === 'ok' && !w.error?.startsWith('jidoka:') ? undefined : w.error,
  }));
}

function resolveFinalStatus(
  okCount: number,
  diversity: ReturnType<typeof evaluateDiversity>,
  judgeOk: boolean,
  globalTimedOut: boolean,
  allTimedOut: boolean,
): { status: ResearchSwarmStatus; exitReason: string } {
  if (globalTimedOut) {
    return { status: 'TIMEOUT', exitReason: 'global_timeout' };
  }
  if (allTimedOut && okCount === 0) {
    return { status: 'TIMEOUT', exitReason: 'all_workers_timeout' };
  }
  if (okCount === 0) {
    return { status: 'PROVIDER_FAILURE', exitReason: 'no_workers_ok' };
  }
  if (!judgeOk) {
    return { status: 'JUDGE_FAILURE', exitReason: 'judge_failed' };
  }
  return deriveStatusFromDiversity(okCount, diversity, judgeOk);
}

/** Main research swarm entry — replaces ad-hoc runSwarmDetailed logic. */
export async function runResearchSwarm(
  task: string,
  opts: ResearchSwarmOptions = {},
): Promise<ResearchSwarmResult> {
  if (isPaused()) {
    throw new Error('Swarm refused: ATLAS_PAUSE=1 is set. Unset ATLAS_PAUSE to resume autonomy.');
  }
  if (!controlAllowsModelCalls()) {
    throw new Error(describeControlBlock());
  }

  const timeouts = readTimeoutConfig();
  const startedAt = new Date().toISOString();
  const runId = newRunId();
  const deadline = Date.now() + timeouts.globalMs;
  const memoryState = await probeMemoryState();

  const configAudit = auditPerspectiveConfig(PERSPECTIVES);
  for (const issue of configAudit.issues) {
    console.warn(
      `[research-swarm] perspective '${issue.perspective}' provider=${issue.provider}: ${issue.code} — ${issue.message}`,
    );
  }
  console.log(
    `[research-swarm] worker providers available: ${configAudit.availableWorkerProviders.join(', ') || 'none'}`,
  );

  if (configAudit.availableWorkerProviders.length === 0) {
    const completedAt = new Date().toISOString();
    const durationMs = Date.parse(completedAt) - Date.parse(startedAt);
    const artifact = buildArtifact({
      runId,
      taskHash: taskHash(task),
      task,
      startedAt,
      completedAt,
      durationMs,
      status: 'MULTIMODEL_UNAVAILABLE',
      exitReason: 'no_worker_providers_available',
      memoryState,
      workers: [],
      judge: null,
      claims: [],
      dissent: configAudit.issues.map((i) => ({
        text: `[${i.perspective}] ${i.code}: ${i.message}`,
        sources: [],
        dissent: true,
      })),
      diversity: evaluateDiversity([]),
      consensus: null,
      synthesis:
        'No WORKER providers are configured and available on this machine. Fix API keys or perspectives config.',
      bridgeSource: opts.bridgeSource ?? 'typescript',
    });
    await writeArtifact(artifact);
    return {
      artifact,
      synthesis: artifact.synthesis,
      exitCode: exitCodeForStatus('MULTIMODEL_UNAVAILABLE'),
    };
  }

  const subtasks = decomposeWithPerspectives(task);
  console.log(`[research-swarm] runId=${runId.slice(0, 8)} perspectives=${subtasks.length}`);

  const workerMs = Math.min(timeouts.workerMs, remainingMs(deadline));
  const workers: WorkerEvidence[] = await Promise.all(
    subtasks.map((st) => runWorkerBounded(st, workerMs, timeouts.routingMs)),
  );

  const okCount = workers.filter(
    (w) => w.status === 'ok' && w.output.trim() && !(w.error?.startsWith('jidoka:')),
  ).length;
  const allTimedOut = workers.length > 0 && workers.every((w) => w.status === 'timeout');
  const globalTimedOut = isPastDeadline(deadline);

  let synthesisOut;
  if (!globalTimedOut && okCount > 0) {
    const judgeMs = Math.min(timeouts.judgeMs, remainingMs(deadline));
    synthesisOut = await runJudge({ task, workers, judgeTimeoutMs: judgeMs });
  } else if (okCount === 0) {
    synthesisOut = {
      synthesis: allTimedOut
        ? 'All workers timed out — no evidence collected. Check provider health and timeout settings.'
        : 'No workers produced evidence — cannot synthesize.',
      judge: null,
      claims: [],
      dissent: workers.map((w) => ({
        text: `[${w.perspective ?? w.id}] ${w.error ?? w.status}`,
        sources: [w.id],
        dissent: true,
      })),
      consensus: null,
    };
  } else {
    synthesisOut = {
      synthesis: 'Global timeout reached before judge synthesis.',
      judge: null,
      claims: [],
      dissent: [],
      consensus: null,
    };
  }

  const diversity = evaluateDiversity(workers);
  const judgeOk = synthesisOut.judge?.status === 'ok';
  const { status, exitReason } = resolveFinalStatus(
    okCount,
    diversity,
    !!judgeOk,
    globalTimedOut,
    allTimedOut,
  );

  const completedAt = new Date().toISOString();
  const durationMs = Date.parse(completedAt) - Date.parse(startedAt);

  const jidoka = validateCompletion(synthesisOut.synthesis);
  let finalSynthesis = synthesisOut.synthesis;
  if (!jidoka.passed) {
    finalSynthesis += '\n\n[JIDOKA: unverified completion claim detected]';
  }

  const artifact = buildArtifact({
    runId,
    taskHash: taskHash(task),
    task,
    startedAt,
    completedAt,
    durationMs,
    status,
    exitReason,
    memoryState,
    workers,
    judge: synthesisOut.judge,
    claims: synthesisOut.claims,
    dissent: synthesisOut.dissent,
    diversity,
    consensus: synthesisOut.consensus,
    synthesis: finalSynthesis,
    bridgeSource: opts.bridgeSource ?? 'typescript',
  });

  if (!artifact.secretScan.clean) {
    artifact.status = 'PROVIDER_FAILURE';
    artifact.exitReason = 'secret_scan_failed';
    artifact.synthesis = '[REDACTED: artifact failed secret scan]';
  }

  const artifactPath = await writeArtifact(artifact);
  if (artifactPath) {
    console.log(`[research-swarm] artifact: ${artifactPath}`);
  } else if (memoryState !== 'DEGRADED_MEMORY') {
    console.warn('[research-swarm] failed to persist artifact locally');
  }

  console.log(`[research-swarm] status=${status} exitReason=${exitReason} ok=${okCount}/${workers.length} providers=${diversity.providerCount} families=${diversity.familyCount}`);

  return {
    artifact,
    synthesis: artifact.secretScan.clean ? finalSynthesis : artifact.synthesis,
    exitCode: exitCodeForStatus(artifact.status),
  };
}

/** Backward-compatible SwarmRunDetail for existing callers/tests. */
export async function runResearchSwarmLegacyDetail(
  task: string,
  opts: ResearchSwarmOptions = {},
): Promise<SwarmRunDetail & { exitCode: number; status: ResearchSwarmStatus; exitReason: string; runId: string }> {
  const result = await runResearchSwarm(task, opts);
  const subtasks = decomposeWithPerspectives(task);
  const jidoka = validateCompletion(result.synthesis);
  return {
    subtasks,
    results: toLegacyResults(result.artifact.workers),
    synthesis: result.synthesis,
    durationMs: result.artifact.durationMs,
    jidokaViolation: jidoka.passed ? null : (jidoka.violation ?? 'unknown'),
    exitCode: result.exitCode,
    status: result.artifact.status,
    exitReason: result.artifact.exitReason,
    runId: result.artifact.runId,
  };
}

export function stableFixtureHash(text: string): string {
  return createHash('sha256').update(text).digest('hex').slice(0, 12);
}
