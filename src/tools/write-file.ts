import { createTool } from '@mastra/core/tools';
import { z } from 'zod';
import { writeFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';

export const writeFileTool = createTool({
  id: 'write-file',
  description: 'Write content to a file. Creates parent directories if needed.',
  inputSchema: z.object({
    path: z.string().describe('Absolute path to the file'),
    content: z.string().describe('Content to write'),
  }),
  outputSchema: z.object({
    written: z.boolean(),
    path: z.string(),
  }),
  execute: async ({ path, content }) => {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, content, 'utf-8');
    return { written: true, path };
  },
});
