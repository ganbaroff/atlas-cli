/**
 * verify_completion_walk — emit decision for completion claims.
 *
 * If reply claims completion but current turn has no tool evidence, downgrade
 * claim before emit. No retry loop here. Substrate only.
 */

export interface TurnEvidenceSource {
  steps?: Array<{
    toolCalls?: unknown[];
    toolResults?: unknown[];
  }>;
  toolCalls?: unknown[];
  toolResults?: unknown[];
}

export interface CompletionEmitDecision {
  emitReply: string;
  emitOriginalReply: boolean;
  claimDetected: boolean;
  proofTokens: string[];
  reason?: string;
}

const COMPLETION_CLAIM_KEYWORDS = [
  'done',
  'готово',
  'completed',
  'shipped',
  'fixed',
  'verified',
  'passed',
  'works',
  'work',
  'worked',
  'success',
  'successful',
  'successfully',
  'закрыто',
  'closed',
  'проверено',
  'сделано',
];
const SAFE_DOWNGRADE = 'Не подтверждено. Проверю.';

function getEvidenceName(item: unknown): string | undefined {
  if (!item || typeof item !== 'object') return undefined;
  const record = item as Record<string, unknown>;
  const raw = record['toolName'] ?? record['name'];
  if (typeof raw !== 'string') return undefined;
  const trimmed = raw.trim();
  return trimmed || undefined;
}

function pushToken(tokens: string[], kind: string, item: unknown): void {
  const name = getEvidenceName(item);
  if (!name) return;
  tokens.push(`${kind}:${name}`);
}

function hasCompletionClaim(reply: string): boolean {
  const lower = reply.toLowerCase();
  if (lower.includes('✅')) return true;
  return COMPLETION_CLAIM_KEYWORDS.some((keyword) => lower.includes(keyword));
}

function pushTokensFromList(tokens: string[], kind: string, items: unknown[] | undefined): void {
  for (const item of items ?? []) {
    pushToken(tokens, kind, item);
  }
}

export function collectProofTokens(evidence: TurnEvidenceSource | undefined): string[] {
  const tokens: string[] = [];
  if (!evidence) return tokens;

  pushTokensFromList(tokens, 'tool', evidence.toolCalls);
  pushTokensFromList(tokens, 'result', evidence.toolResults);
  for (const step of evidence.steps ?? []) {
    pushTokensFromList(tokens, 'step-tool', step.toolCalls);
    pushTokensFromList(tokens, 'step-result', step.toolResults);
  }

  return [...new Set(tokens)];
}

export function decideCompletionEmit(
  reply: string,
  evidence?: TurnEvidenceSource,
): CompletionEmitDecision {
  const claimDetected = hasCompletionClaim(reply);
  const proofTokens = collectProofTokens(evidence);

  if (!claimDetected) {
    return {
      emitReply: reply,
      emitOriginalReply: true,
      claimDetected: false,
      proofTokens,
    };
  }

  if (proofTokens.length > 0) {
    return {
      emitReply: reply,
      emitOriginalReply: true,
      claimDetected: true,
      proofTokens,
    };
  }

  return {
    emitReply: SAFE_DOWNGRADE,
    emitOriginalReply: false,
    claimDetected: true,
    proofTokens,
    reason: 'completion claim without proof-token',
  };
}

export const verifyCompletionWalk = decideCompletionEmit;
