/**
 * Jidoka gate — tool-call-before-claim.
 */

const DONE_MARKERS = [
  'done', 'готово', 'завершено', 'completed', 'shipped', 'fixed',
  'проверено', 'verified', 'закрыто', 'closed',
];

const TOOL_EVIDENCE = [
  'Read', 'Bash', 'Grep', 'Glob', 'Edit', 'Write',
  'read-file', 'shell', 'glob', 'grep', 'load-skill',
  'npx', 'npm', 'git', 'curl', 'cat', 'ls',
];

export function hasDoneClaim(text: string): boolean {
  const lower = text.toLowerCase();
  return DONE_MARKERS.some((m) => lower.includes(m));
}

export function hasToolEvidence(text: string): boolean {
  return TOOL_EVIDENCE.some((t) => text.includes(t));
}

export function validateCompletion(response: string): {
  passed: boolean;
  violation: string | null;
} {
  if (!hasDoneClaim(response)) return { passed: true, violation: null };
  if (hasToolEvidence(response)) return { passed: true, violation: null };
  return {
    passed: false,
    violation: 'JIDOKA: completion claim without tool evidence. Prove or remove.',
  };
}
