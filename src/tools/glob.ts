import { createTool } from '@mastra/core/tools';
import { z } from 'zod';
import { glob } from 'node:fs/promises';
import { resolve } from 'node:path';

export const globTool = createTool({
  id: 'glob',
  description: 'Find files matching a glob pattern. Returns list of paths.',
  inputSchema: z.object({
    pattern: z.string().describe('Glob pattern, e.g. "src/**/*.ts"'),
    cwd: z.string().optional().describe('Working directory, defaults to process.cwd()'),
  }),
  outputSchema: z.object({
    files: z.array(z.string()),
  }),
  execute: async ({ pattern, cwd }) => {
    const dir = cwd || process.cwd();
    const files: string[] = [];
    for await (const entry of glob(pattern, { cwd: dir })) {
      files.push(resolve(dir, entry));
    }
    return { files: files.slice(0, 100) };
  },
});
