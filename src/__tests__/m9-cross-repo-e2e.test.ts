/**
 * M9 — child-process E2E: simulated OPSBOARD writer + ANUS processor.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawn } from 'node:child_process';

const PORT_MODULE = pathToFileURL(
  join(dirname(fileURLToPath(import.meta.url)), '../opsboard/goal-request-port.ts'),
).href;

function runNode(code: string, env: NodeJS.ProcessEnv): Promise<{ code: number | null; out: string }> {
  return new Promise((resolve) => {
    const child = spawn(
      process.execPath,
      ['--import', 'tsx', '-e', code],
      { env: { ...process.env, ...env }, cwd: join(dirname(fileURLToPath(import.meta.url)), '../..') },
    );
    let out = '';
    child.stdout.on('data', (d) => { out += String(d); });
    child.stderr.on('data', (d) => { out += String(d); });
    child.on('close', (code) => resolve({ code, out }));
  });
}

describe('M9 cross-repo child-process E2E', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'atlas-m9-e2e-'));
    mkdirSync(join(dir, 'requests'), { recursive: true });
    mkdirSync(join(dir, 'receipts'), { recursive: true });
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('OPSBOARD-shaped request file → ANUS child writes receipt', async () => {
    const correlationId = 'corr_e2e_01';
    writeFileSync(
      join(dir, 'requests', `${correlationId}.json`),
      JSON.stringify({
        correlationId,
        action: 'run',
        objective: 'cross-repo fixture',
        issuedAt: new Date().toISOString(),
        issuedBy: 'opsboard',
        timeoutMs: 5000,
      }),
      'utf8',
    );

    const code = `
      import { readFileSync } from 'node:fs';
      import { join } from 'node:path';
      import { processGoalRequest, readGoalRequest } from ${JSON.stringify(PORT_MODULE)};
      const dir = process.env.ATLAS_OPSBOARD_EXCHANGE_DIR;
      const req = readGoalRequest(join(dir, 'requests', '${correlationId}.json'));
      const receipt = await processGoalRequest(req, {
        exchangeDir: dir,
        run: async () => ({ status: 'completed', goalId: 'goal_e2e', report: { tasksVerified: 1 } }),
      });
      console.log(JSON.stringify(receipt));
    `;
    const result = await runNode(code, { ATLAS_OPSBOARD_EXCHANGE_DIR: dir });
    expect(result.code).toBe(0);
    const receiptPath = join(dir, 'receipts', `${correlationId}.json`);
    expect(existsSync(receiptPath)).toBe(true);
    const receipt = JSON.parse(readFileSync(receiptPath, 'utf8'));
    expect(receipt.status).toBe('completed');
    expect(receipt.correlationId).toBe(correlationId);
  }, 30_000);
});
