import { createTool } from '@mastra/core/tools';
import { z } from 'zod';
import { readFile } from 'node:fs/promises';
import { isSensitivePath, auditFsOp } from './fs-guard.js';

const destructiveAllowed = (): boolean => process.env.ATLAS_SHELL_ALLOW_DESTRUCTIVE === '1';

export const readFileTool = createTool({
  id: 'read-file',
  description:
    'Read a file from disk. Returns the full content as text. Refuses sensitive paths ' +
    '(.env*, secrets/keys dirs, *.pem, *.key, id_rsa, .git/) unless ATLAS_SHELL_ALLOW_DESTRUCTIVE=1.',
  inputSchema: z.object({
    path: z.string().describe('Absolute path to the file'),
  }),
  outputSchema: z.object({
    content: z.string(),
    error: z.string().optional(),
  }),
  execute: async ({ path }) => {
    const agent = process.env.ATLAS_AGENT_ID || 'unknown';
    const sensitive = isSensitivePath(path);

    if (sensitive && !destructiveAllowed()) {
      await auditFsOp({ agent, op: 'read', path, sensitive, decision: 'refused' });
      return {
        content: '',
        error: '[atlas-fs] REFUSED: sensitive path blocked by default. Set ATLAS_SHELL_ALLOW_DESTRUCTIVE=1 to permit.',
      };
    }

    await auditFsOp({ agent, op: 'read', path, sensitive, decision: 'allow' });
    const content = await readFile(path, 'utf-8');
    return { content };
  },
});
