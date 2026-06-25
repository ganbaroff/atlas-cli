/**
 * Atlas reply gates — voice + completion checks with one retry path.
 */

import { validateCompletion } from '../gates/verify-before-done.js';
import { collectProofTokens, type TurnEvidenceSource } from '../gates/verify-completion-walk.js';
import { validateVoice, type Breach, type VoiceCheckResult } from './voice.js';

export interface CompletionCheck {
  passed: boolean;
  violation: string | null;
}

export interface ReplyGateCheck {
  voice: VoiceCheckResult;
  completion: CompletionCheck;
}

export interface ReplyGateRepairResult {
  reply: string;
  replyEvidence?: TurnEvidenceSource;
  firstPass: ReplyGateCheck;
  retryPass: ReplyGateCheck | null;
  retried: boolean;
}

export interface ReplyAttempt {
  reply: string;
  evidence?: TurnEvidenceSource;
}

export interface ReplyGateEvidence {
  evidence?: TurnEvidenceSource;
}

function formatVoiceBreaches(breaches: Breach[]): string {
  if (breaches.length === 0) return '- none';
  return breaches
    .map((breach) => `- ${breach.type} (${breach.rule_ref}): ${breach.sample}`)
    .join('\n');
}

function formatProofTokens(tokens: string[]): string {
  if (tokens.length === 0) return '- none';
  return tokens.map((token) => `- ${token}`).join('\n');
}

function buildRepairPrompt(check: ReplyGateCheck, originalReply: string, proofTokens: string[]): string {
  const completionLine = check.completion.passed
    ? '- passed'
    : `- ${check.completion.violation ?? 'completion gate violation'}`;

  return [
    'Previous reply broke Atlas gates.',
    'Rewrite for user-facing chat.',
    '',
    'Rules:',
    '- Russian',
    '- short paragraphs',
    '- no bullet walls',
    '- no markdown tables',
    '- no bold header walls',
    '- no banned openers',
    '- no trailing question on irreversible action',
    '- no completion claim without proof',
    '- if you keep completion claim, cite one exact proof token from Current turn proof tokens',
    '- end substantive work/status replies with "Мини-урок:" and one practical explanation',
    '',
    'Voice breaches:',
    formatVoiceBreaches(check.voice.breaches),
    '',
    'Completion gate:',
    completionLine,
    '',
    'Current turn proof tokens:',
    formatProofTokens(proofTokens),
    '',
    'Original reply:',
    originalReply.trim(),
    '',
    'Return only final reply.',
  ].join('\n');
}

function normalizeReplyAttempt(value: string | ReplyAttempt): ReplyAttempt {
  return typeof value === 'string' ? { reply: value } : value;
}

export function validateReply(reply: string): ReplyGateCheck {
  return {
    voice: validateVoice(reply),
    completion: validateCompletion(reply),
  };
}

export function summarizeReplyGate(check: ReplyGateCheck): string {
  const notes: string[] = [];
  if (!check.voice.passed) {
    notes.push(`voice=${check.voice.breaches.map((breach) => breach.type).join(',')}`);
  }
  if (!check.completion.passed) {
    notes.push(`completion=${check.completion.violation ?? 'blocked'}`);
  }
  return notes.length === 0 ? 'ok' : notes.join(' | ');
}

export async function repairReply(
  reply: string,
  retry: (prompt: string) => Promise<string | ReplyAttempt>,
  evidence?: TurnEvidenceSource,
): Promise<ReplyGateRepairResult> {
  const firstPass = validateReply(reply);
  if (firstPass.voice.passed && firstPass.completion.passed) {
    return {
      reply: reply.trim(),
      replyEvidence: evidence,
      firstPass,
      retryPass: null,
      retried: false,
    };
  }

  const prompt = buildRepairPrompt(firstPass, reply, collectProofTokens(evidence));
  const retryAttempt = normalizeReplyAttempt(await retry(prompt));
  const retryReply = retryAttempt.reply.trim();
  const retryPass = validateReply(retryReply);

  return {
    reply: retryPass.voice.passed && retryPass.completion.passed
      ? retryReply
      : retryReply || reply.trim(),
    replyEvidence: retryAttempt.evidence ?? evidence,
    firstPass,
    retryPass,
    retried: true,
  };
}
