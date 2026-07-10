import { createTool } from '@mastra/core/tools';
import { z } from 'zod';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

/**
 * Pure, testable ReDoS guard. True if the pattern is unreasonably long, or
 * contains a classic nested-quantifier catastrophic-backtracking shape —
 * e.g. (a+)+, (a*)*, (a+)*, (.*){2,} — the textbook ReDoS payload shapes.
 * Heuristic, not a full regex parser: it can't catch every pathological
 * pattern, but it blocks the well-known families before they ever reach
 * RegExp execution against untrusted (e.g. web-surfed) file content.
 */
export function isRiskyPattern(pattern: string): boolean {
  if (pattern.length > 512) return true;

  const nestedQuantifier =
    /\([^()]*[+*][^()]*\)[+*]|\([^()]*\{\d*,?\d*\}[^()]*\)[+*]|\([^()]*[+*][^()]*\)\{\d*,?\d*\}/;

  return nestedQuantifier.test(pattern);
}

export const grepTool = createTool({
  id: 'grep',
  description: 'Search for a regex pattern in files. Returns matching lines with file paths.',
  inputSchema: z.object({
    pattern: z.string().describe('Regex pattern to search for'),
    paths: z.array(z.string()).describe('File paths to search in'),
  }),
  outputSchema: z.object({
    matches: z.array(z.object({
      file: z.string(),
      line: z.number(),
      text: z.string(),
    })),
    error: z.string().optional(),
  }),
  execute: async ({ pattern, paths }) => {
    if (isRiskyPattern(pattern)) {
      return { matches: [], error: 'pattern rejected: possible ReDoS' };
    }

    const regex = new RegExp(pattern, 'gi');
    const matches: { file: string; line: number; text: string }[] = [];

    for (const p of paths.slice(0, 20)) {
      try {
        const content = await readFile(resolve(p), 'utf-8');
        const lines = content.split('\n');
        for (let i = 0; i < lines.length; i++) {
          if (regex.test(lines[i])) {
            matches.push({ file: p, line: i + 1, text: lines[i].trim() });
            regex.lastIndex = 0;
          }
        }
      } catch {
        // skip unreadable files
      }
    }

    return { matches: matches.slice(0, 50) };
  },
});
