import type { OperatorEvidence, OperatorResult } from './contracts.js';

export interface BrowserSessionTraceInput {
  taskId: string;
  tracePath: string;
  evidence: OperatorEvidence[];
}

export function buildBrowserSessionTraceEvidence(input: BrowserSessionTraceInput): OperatorEvidence[] {
  if (!input.tracePath.trim()) return [];

  return input.evidence
    .filter((item) => item.type === 'browser_observation')
    .map((item) => ({
      id: `${item.id}.trace`,
      task_id: input.taskId,
      type: 'browser_session_trace',
      source: input.tracePath,
      observed_at: item.observed_at,
      summary: `Browser observation persisted in ${input.tracePath}`,
      data: {
        trace_path: input.tracePath,
        browser_observation_id: item.id,
        browser_source: item.source,
        browser_summary: item.summary,
      },
      proof_token: `${item.id}.trace`,
      verifier: 'atlas-operator-dispatcher',
    }));
}

export function withBrowserSessionTrace(result: OperatorResult): OperatorResult {
  if (!result.trace_path) return result;
  if (result.evidence.some((item) => item.type === 'browser_session_trace')) return result;
  const browserTraces = buildBrowserSessionTraceEvidence({
    taskId: result.task_id,
    tracePath: result.trace_path,
    evidence: result.evidence,
  });

  if (browserTraces.length === 0) return result;
  return {
    ...result,
    evidence: [...result.evidence, ...browserTraces],
  };
}
