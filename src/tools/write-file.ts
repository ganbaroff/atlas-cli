import { createTool } from '@mastra/core/tools';
import { z } from 'zod';
import { writeFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { isSensitivePath, auditFsOp, checkWorkspaceConfinement } from './fs-guard.js';

const destructiveAllowed = (): boolean => process.env.ATLAS_SHELL_ALLOW_DESTRUCTIVE === '1';

export const writeFileTool = createTool({
  id: 'write-file',
  description:
    'Write content to a file. Creates parent directories if needed. Refuses sensitive paths ' +
    '(.env*, secrets/keys dirs, *.pem, *.key, id_rsa, .git/) unless ATLAS_SHELL_ALLOW_DESTRUCTIVE=1.',
  inputSchema: z.object({
    path: z.string().describe('Absolute path to the file'),
    content: z.string().describe('Content to write'),
  }),
  outputSchema: z.object({
    written: z.boolean(),
    path: z.string(),
    error: z.string().optional(),
  }),
  execute: async ({ path, content }) => {
    const agent = process.env.ATLAS_AGENT_ID || 'unknown';
    const sensitive = isSensitivePath(path);

    if (sensitive && !destructiveAllowed()) {
      await auditFsOp({ agent, op: 'write', path, sensitive, decision: 'refused' });
      return {
        written: false,
        path,
        error: '[atlas-fs] REFUSED: sensitive path blocked by default. Set ATLAS_SHELL_ALLOW_DESTRUCTIVE=1 to permit.',
      };
    }

    const confinement = checkWorkspaceConfinement(path);
    if (!confinement.allowed) {
      await auditFsOp({ agent, op: 'write', path, sensitive, decision: 'refused', rule: 'workspace-confinement' });
      return {
        written: false,
        path,
        error: confinement.reason!,
      };
    }

    await auditFsOp({ agent, op: 'write', path, sensitive, decision: 'allow' });
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, content, 'utf-8');
    return { written: true, path };
  },
});
