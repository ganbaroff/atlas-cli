import { createTool } from '@mastra/core/tools';
import { z } from 'zod';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

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
  }),
  execute: async ({ pattern, paths }) => {
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
