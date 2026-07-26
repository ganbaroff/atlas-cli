/**
 * Test isolation — unique Atlas side-effect dirs per test run.
 */

import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

/** Pin all learning side-effect dirs under one temp root (CI/dev). */
export function isolateLearningTestEnv(rootDir: string): void {
  process.env.ATLAS_LEARNING_EXCHANGE_DIR = rootDir;
  process.env.ATLAS_LEARNING_STATE_DIR = rootDir;
  process.env.ATLAS_EVIDENCE_DIR = join(rootDir, 'evidence');
  process.env.ATLAS_EXEC_GRAPH_DIR = join(rootDir, 'exec-graph');
  process.env.ATLAS_SPEND_RECEIPT_DIR = join(rootDir, 'spend');
  delete process.env.ATLAS_LEARNING_RECEIPTS_BUCKET;
  mkdirSync(join(rootDir, 'claims'), { recursive: true });
  mkdirSync(join(rootDir, 'receipts'), { recursive: true });
  mkdirSync(process.env.ATLAS_EVIDENCE_DIR, { recursive: true });
  mkdirSync(process.env.ATLAS_EXEC_GRAPH_DIR, { recursive: true });
  mkdirSync(process.env.ATLAS_SPEND_RECEIPT_DIR, { recursive: true });
}
