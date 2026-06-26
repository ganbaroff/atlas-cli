export interface TurnEvidenceStep {
  toolCalls?: unknown[];
  toolResults?: unknown[];
}

export interface TurnEvidenceSource {
  steps?: TurnEvidenceStep[];
  toolCalls?: unknown[];
  toolResults?: unknown[];
}

export interface TurnEvidenceSnapshot {
  source: TurnEvidenceSource;
  proofTokens: string[];
}

type TurnEvidenceLike = Partial<TurnEvidenceSource> & {
  steps?: unknown;
};

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object') return null;
  return value as Record<string, unknown>;
}

function toArray(value: unknown): unknown[] | undefined {
  return Array.isArray(value) ? value : undefined;
}

function firstString(record: Record<string, unknown>, keys: string[]): string | undefined {
  for (const key of keys) {
    const raw = record[key];
    if (typeof raw !== 'string') continue;
    const trimmed = raw.trim();
    if (trimmed.length > 0) return trimmed;
  }
  return undefined;
}

function normalizeProofToken(item: unknown): string | undefined {
  const record = asRecord(item);
  if (!record) return undefined;

  const explicit = firstString(record, ['proof_token', 'proofToken', 'proof']);
  if (explicit) {
    return explicit.startsWith('proof:') ? explicit : `proof:${explicit}`;
  }

  const toolCallId = firstString(record, ['toolCallId', 'tool_call_id', 'callId']);
  if (toolCallId) return `proof:${toolCallId}`;

  const toolName = firstString(record, ['toolName', 'name', 'tool']);
  if (toolName) return `proof:${toolName}`;

  const id = firstString(record, ['id']);
  if (id) return `proof:${id}`;

  return undefined;
}

function pushTokens(tokens: Set<string>, items: unknown[] | undefined): void {
  for (const item of items ?? []) {
    const token = normalizeProofToken(item);
    if (token) tokens.add(token);
  }
}

export function collectProofTokens(evidence?: TurnEvidenceSource): string[] {
  if (!evidence) return [];

  const tokens = new Set<string>();
  pushTokens(tokens, evidence.toolCalls);
  pushTokens(tokens, evidence.toolResults);

  for (const step of evidence.steps ?? []) {
    pushTokens(tokens, step.toolCalls);
    pushTokens(tokens, step.toolResults);
  }

  return [...tokens];
}

function normalizeStep(step: unknown): TurnEvidenceStep | undefined {
  const record = asRecord(step);
  if (!record) return undefined;

  const toolCalls = toArray(record.toolCalls);
  const toolResults = toArray(record.toolResults);
  if (!toolCalls && !toolResults) return undefined;

  return {
    toolCalls,
    toolResults,
  };
}

export function extractTurnEvidence(response: TurnEvidenceLike | undefined): TurnEvidenceSource {
  if (!response || typeof response !== 'object') return {};

  const source: TurnEvidenceSource = {};
  const steps = toArray(response.steps)?.map(normalizeStep).filter((step): step is TurnEvidenceStep => !!step);
  const toolCalls = toArray(response.toolCalls);
  const toolResults = toArray(response.toolResults);

  if (steps && steps.length > 0) source.steps = steps;
  if (toolCalls && toolCalls.length > 0) source.toolCalls = toolCalls;
  if (toolResults && toolResults.length > 0) source.toolResults = toolResults;

  return source;
}

export function matchProofTokens(reply: string, proofTokens: string[]): string[] {
  return proofTokens.filter((token) => reply.includes(token));
}

export function hasProofCitation(reply: string, proofTokens: string[]): boolean {
  return matchProofTokens(reply, proofTokens).length > 0;
}
