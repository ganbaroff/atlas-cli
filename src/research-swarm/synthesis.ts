/**
 * Honest synthesis — deduped claims, dissent, bounded judge.
 */

import { Agent } from '@mastra/core/agent';
import { dedupFindings } from '../atlas/dedup.js';
import { buildAtlasBrainPlan } from '../atlas/brain-planner.js';
import { recordAgentSpend } from '../agent.js';
import { modelFamily } from './model-family.js';
import { routeJudgeProvider } from './provider-routing.js';
import { withTimeoutOutcome } from './timeouts.js';
import type { JudgeEvidence, SwarmClaim, WorkerEvidence } from './types.js';

export interface SynthesisInput {
  task: string;
  workers: WorkerEvidence[];
  judgeTimeoutMs: number;
}

export interface SynthesisOutput {
  synthesis: string;
  judge: JudgeEvidence;
  claims: SwarmClaim[];
  dissent: SwarmClaim[];
  consensus: string | null;
}

function workerStatusLabel(w: WorkerEvidence): string {
  if (w.status === 'ok') return 'OK';
  return w.error ?? w.status;
}

export function buildClaimsFromWorkers(workers: WorkerEvidence[]): { claims: SwarmClaim[]; dissent: SwarmClaim[] } {
  const okOutputs = workers.filter((w) => w.status === 'ok' && w.output.trim()).map((w) => w.output);
  const dedup = okOutputs.length > 1 ? dedupFindings(okOutputs) : { unique: okOutputs, duplicatesRemoved: 0, totalInput: okOutputs.length };

  const claims: SwarmClaim[] = dedup.unique.map((text, idx) => ({
    text,
    sources: workers
      .filter((w) => w.status === 'ok' && w.output.includes(text.slice(0, 40)))
      .map((w) => w.id)
      .filter((id, i, arr) => arr.indexOf(id) === i)
      .concat(idx === 0 && workers.some((w) => w.status === 'ok') ? [workers.find((w) => w.status === 'ok')!.id] : [])
      .filter((id, i, arr) => arr.indexOf(id) === i),
  }));

  const dissent: SwarmClaim[] = workers
    .filter((w) => w.status !== 'ok')
    .map((w) => ({
      text: `[${w.perspective ?? w.id}] failed: ${workerStatusLabel(w)}`,
      sources: [w.id],
      dissent: true,
    }));

  return { claims, dissent };
}

export function buildJudgePrompt(input: SynthesisInput, claims: SwarmClaim[], dissent: SwarmClaim[]): string {
  const workerBlock = input.workers
    .map((w) => `### Worker ${w.id}${w.perspective ? ` (${w.perspective})` : ''} [${w.actualProvider}/${w.actualModelId}, ${w.durationMs}ms] ${workerStatusLabel(w)}\n${w.output || '(no output)'}`)
    .join('\n\n');

  const claimsBlock = claims.length
    ? claims.map((c, i) => `${i + 1}. ${c.text}`).join('\n')
    : '(no successful worker claims — do NOT invent findings)';

  const dissentBlock = dissent.length
    ? dissent.map((d) => `- ${d.text}`).join('\n')
    : '(none)';

  return [
    `Original task: ${input.task}`,
    '',
    'Worker results (with provenance):',
    workerBlock,
    '',
    'Deduped unique claims from successful workers:',
    claimsBlock,
    '',
    'Dissent / failures (must acknowledge):',
    dissentBlock,
    '',
    'Rules:',
    '- Synthesize ONLY from successful worker evidence above.',
    '- If no successful workers, state that evidence is insufficient — do NOT recommend actions.',
    '- Acknowledge dissent and gaps explicitly.',
    '- Separate verified facts, inference, and unknowns.',
    '',
    'Produce one coherent research synthesis.',
  ].join('\n');
}

export async function runJudge(input: SynthesisInput): Promise<SynthesisOutput> {
  const { claims, dissent } = buildClaimsFromWorkers(input.workers);
  const prompt = buildJudgePrompt(input, claims, dissent);
  const t0 = Date.now();

  let route;
  try {
    route = routeJudgeProvider();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      synthesis: `[JUDGE ROUTING FAILED: ${msg}]`,
      judge: {
        provider: 'none',
        modelId: 'none',
        modelFamily: 'none',
        status: 'provider_error',
        output: '',
        durationMs: Date.now() - t0,
        error: msg,
        independent: false,
      },
      claims,
      dissent,
      consensus: null,
    };
  }

  const plan = await buildAtlasBrainPlan({ channel: 'cli', role: 'JUDGE' });
  const agent = new Agent({
    id: 'atlas-judge',
    name: 'Atlas Judge',
    instructions: plan.systemPrompt,
    model: route.model,
  });

  const outcome = await withTimeoutOutcome(agent.generate(prompt), input.judgeTimeoutMs);
  const durationMs = Date.now() - t0;
  const family = modelFamily(route.provider, route.modelId);

  if (outcome.kind === 'timeout') {
    return {
      synthesis: `[JUDGE TIMEOUT after ${input.judgeTimeoutMs}ms — insufficient evidence to synthesize]`,
      judge: {
        provider: route.provider,
        modelId: route.modelId,
        modelFamily: family,
        status: 'timeout',
        output: '',
        durationMs,
        error: `judge_timeout_${input.judgeTimeoutMs}ms`,
        independent: false,
      },
      claims,
      dissent,
      consensus: null,
    };
  }

  if (outcome.kind === 'rejected') {
    const msg = outcome.error instanceof Error ? outcome.error.message : String(outcome.error);
    return {
      synthesis: `[JUDGE FAILED: ${msg.slice(0, 200)}]`,
      judge: {
        provider: route.provider,
        modelId: route.modelId,
        modelFamily: family,
        status: 'provider_error',
        output: '',
        durationMs,
        error: msg.slice(0, 200),
        independent: false,
      },
      claims,
      dissent,
      consensus: null,
    };
  }

  recordAgentSpend(outcome.value, route, 'research-swarm-judge');
  const text = outcome.value.text;
  const okCount = input.workers.filter(
    (w) => w.status === 'ok' && w.output.trim() && !(w.error?.startsWith('jidoka:')),
  ).length;

  // Post-check: judge must not invent findings when no deduped claims exist
  if (claims.length === 0 || okCount === 0) {
    return {
      synthesis: 'Insufficient worker evidence — judge output rejected (no grounded claims).',
      judge: {
        provider: route.provider,
        modelId: route.modelId,
        modelFamily: family,
        status: 'provider_error',
        output: text.slice(0, 500),
        durationMs,
        error: 'judge_ungrounded_no_claims',
        independent: false,
      },
      claims,
      dissent,
      consensus: null,
    };
  }

  const consensus = okCount >= 2 ? text.slice(0, 500) : null;

  return {
    synthesis: text,
    judge: {
      provider: route.provider,
      modelId: route.modelId,
      modelFamily: family,
      status: 'ok',
      output: text,
      durationMs,
      independent: false,
    },
    claims,
    dissent,
    consensus,
  };
}
