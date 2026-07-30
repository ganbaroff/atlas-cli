/**
 * Sprint 3 — durable local state dir for learning receipts (Cloud Run /tmp).
 */

import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  isStateRootActivationRequired,
  resolveMigratingStateDir,
} from '../atlas/state-root.js';

type LearningSideEffectEnv =
  | 'ATLAS_EVIDENCE_DIR'
  | 'ATLAS_EXEC_GRAPH_DIR'
  | 'ATLAS_SPEND_RECEIPT_DIR';

interface LearningSideEffectBinding {
  readonly envName: LearningSideEffectEnv;
  readonly store: 'evidence' | 'exec-graph' | 'spend-receipts';
  readonly legacyDir: string;
}

function bindLearningSideEffectDirs(
  learningDir: string,
): void {
  const required = isStateRootActivationRequired();
  const bindings: LearningSideEffectBinding[] = [
    {
      envName: 'ATLAS_EVIDENCE_DIR',
      store: 'evidence',
      legacyDir: join(learningDir, 'evidence'),
    },
    {
      envName: 'ATLAS_EXEC_GRAPH_DIR',
      store: 'exec-graph',
      legacyDir: join(learningDir, 'exec-graph'),
    },
    {
      envName: 'ATLAS_SPEND_RECEIPT_DIR',
      store: 'spend-receipts',
      legacyDir: join(learningDir, 'spend'),
    },
  ];
  const resolved = bindings.map(({ envName, store, legacyDir }) => {
    const existing = process.env[envName];
    if (!required && existing) return [envName, existing] as const;
    return [
      envName,
      resolveMigratingStateDir(store, () => legacyDir),
    ] as const;
  });
  for (const [envName, dir] of resolved) {
    process.env[envName] = dir;
  }
}

/** Resolve state directory for learning receipts and Atlas side-effects. */
export function resolveLearningStateDir(explicitDir?: string): string {
  const dir = resolveMigratingStateDir(
    'learning',
    () => explicitDir
      ?? process.env.ATLAS_LEARNING_EXCHANGE_DIR
      ?? join(tmpdir(), 'atlas-learning-state'),
    explicitDir === undefined ? undefined : null,
  );
  bindLearningSideEffectDirs(dir);
  mkdirSync(join(dir, 'receipts'), { recursive: true });
  mkdirSync(join(dir, 'requests'), { recursive: true });
  return dir;
}

/** Preserve file-exchange semantics until required state-root activation. */
export function resolveLearningExchangeDir(explicitDir?: string): string {
  const dir = resolveMigratingStateDir(
    'learning',
    () => {
      const dir = explicitDir ?? process.env.ATLAS_LEARNING_EXCHANGE_DIR;
      if (!dir) throw new Error('ATLAS_LEARNING_EXCHANGE_DIR not set');
      return dir;
    },
    explicitDir === undefined ? 'ATLAS_LEARNING_EXCHANGE_DIR' : null,
  );
  if (isStateRootActivationRequired()) bindLearningSideEffectDirs(dir);
  mkdirSync(join(dir, 'requests'), { recursive: true });
  mkdirSync(join(dir, 'claims'), { recursive: true });
  return dir;
}

/** Preserve projection-lock precedence until required state-root activation. */
export function resolveLearningProjectionDir(): string {
  const dir = resolveMigratingStateDir(
    'learning',
    () => process.env.ATLAS_LEARNING_STATE_DIR
      ?? join(process.cwd(), 'state', 'learning'),
    'ATLAS_LEARNING_EXCHANGE_DIR',
  );
  if (isStateRootActivationRequired()) bindLearningSideEffectDirs(dir);
  return dir;
}
