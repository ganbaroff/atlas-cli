import { createTool } from '@mastra/core/tools';
import { z } from 'zod';
import { readFile } from 'node:fs/promises';

export const readFileTool = createTool({
  id: 'read-file',
  description: 'Read a file from disk. Returns the full content as text.',
  inputSchema: z.object({
    path: z.string().describe('Absolute path to the file'),
  }),
  outputSchema: z.object({
    content: z.string(),
  }),
  execute: async ({ path }) => {
    const content = await readFile(path, 'utf-8');
    return { content };
  },
});
