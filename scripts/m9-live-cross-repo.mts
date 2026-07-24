/**
 * One-shot live M9 cross-repo proof runner (OPSBOARD bridge → ANUS drain).
 * Run from ANUS repo root after build.
 */
import { mkdtempSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const BRIDGE = pathToFileURL('C:/Projects/OPSBOARD-PRO/modules/atlas-bridge/index.ts').href;
const exchange = mkdtempSync(join(tmpdir(), 'atlas-m9-live-'));
process.env.ATLAS_OPSBOARD_EXCHANGE_DIR = exchange;

const { issueAtlasGoal, readAtlasReceipt } = await import(BRIDGE);
const req = issueAtlasGoal('live cross-repo fixture proof');
console.log(JSON.stringify({ phase: 'issued', correlationId: req.correlationId, exchange }));

execSync('node dist/cli.js opsboard drain', {
  cwd: ROOT,
  env: { ...process.env, ATLAS_OPSBOARD_EXCHANGE_DIR: exchange },
  stdio: 'inherit',
});

const receiptIds = readdirSync(join(exchange, 'receipts')).map((f) => f.replace('.json', ''));
const receipt = readAtlasReceipt(receiptIds[0]!);
console.log(JSON.stringify({ phase: 'verified', receiptCount: receiptIds.length, receipt, exchange }));
