const DEFAULT_TAIL_CHARS = 1200;

export function tailText(output: string, maxChars = DEFAULT_TAIL_CHARS): string {
  const normalized = output.trim();
  if (normalized.length <= maxChars) return normalized || '(empty output)';
  return `...(tail)\n${normalized.slice(-maxChars)}`;
}

export function formatReceipt(command: string, output: string, maxChars = DEFAULT_TAIL_CHARS): string {
  return [
    '---',
    'Receipt',
    `command: ${command}`,
    'output_tail:',
    tailText(output, maxChars),
  ].join('\n');
}
