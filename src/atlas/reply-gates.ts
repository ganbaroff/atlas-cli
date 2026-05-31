/**
 * Atlas reply gates — voice + completion checks with one retry path.
 */

import { validateCompletion } from '../gates/verify-before-done.js';
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
  firstPass: ReplyGateCheck;
  retryPass: ReplyGateCheck | null;
  retried: boolean;
}

function formatVoiceBreaches(breaches: Breach[]): string {
  if (breaches.length === 0) return '- none';
  return breaches
    .map((breach) => `- ${breach.type} (${breach.rule_ref}): ${breach.sample}`)
    .join('\n');
}

function buildRepairPrompt(check: ReplyGateCheck, originalReply: string): string {
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
    '',
    'Voice breaches:',
    formatVoiceBreaches(check.voice.breaches),
    '',
    'Completion gate:',
    completionLine,
    '',
    'Original reply:',
    originalReply.trim(),
    '',
    'Return only final reply.',
  ].join('\n');
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
  retry: (prompt: string) => Promise<string>,
): Promise<ReplyGateRepairResult> {
  const firstPass = validateReply(reply);
  if (firstPass.voice.passed && firstPass.completion.passed) {
    return {
      reply: reply.trim(),
      firstPass,
      retryPass: null,
      retried: false,
    };
  }

  const prompt = buildRepairPrompt(firstPass, reply);
  const retryReply = (await retry(prompt)).trim();
  const retryPass = validateReply(retryReply);

  return {
    reply: retryPass.voice.passed && retryPass.completion.passed
      ? retryReply
      : retryReply || reply.trim(),
    firstPass,
    retryPass,
    retried: true,
  };
}
