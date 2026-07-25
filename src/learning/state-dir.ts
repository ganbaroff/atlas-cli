/**
 * Sprint 3 — durable local state dir for learning receipts (Cloud Run /tmp).
 */

import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

/** Resolve state directory for learning receipts and Atlas side-effects. */
export function resolveLearningStateDir(): string {
  const dir =
    process.env.ATLAS_LEARNING_STATE_DIR
    ?? process.env.ATLAS_LEARNING_EXCHANGE_DIR
    ?? join(tmpdir(), 'atlas-learning-state');
  mkdirSync(join(dir, 'receipts'), { recursive: true });
  mkdirSync(join(dir, 'requests'), { recursive: true });
  if (!process.env.ATLAS_EVIDENCE_DIR) {
    process.env.ATLAS_EVIDENCE_DIR = join(dir, 'evidence');
  }
  if (!process.env.ATLAS_EXEC_GRAPH_DIR) {
    process.env.ATLAS_EXEC_GRAPH_DIR = join(dir, 'exec-graph');
  }
  if (!process.env.ATLAS_SPEND_RECEIPT_DIR) {
    process.env.ATLAS_SPEND_RECEIPT_DIR = join(dir, 'spend');
  }
  return dir;
}
