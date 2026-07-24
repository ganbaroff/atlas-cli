/**
 * Structured evidence artifact — schema v1 writer.
 */

import { createHash, randomUUID } from 'node:crypto';
import { writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { getMemoryRoot } from '../atlas/path-util.js';
import { scanForSecrets } from './secret-scan.js';
import {
  RESEARCH_SWARM_SCHEMA_VERSION,
  type ResearchSwarmArtifact,
  type ResearchSwarmStatus,
} from './types.js';

export function taskHash(task: string): string {
  return createHash('sha256').update(task.trim()).digest('hex').slice(0, 16);
}

export function newRunId(): string {
  return randomUUID();
}

export function exitCodeForStatus(status: ResearchSwarmStatus): number {
  return status === 'SUCCESS' ? 0 : 1;
}

export function buildArtifact(
  partial: Omit<ResearchSwarmArtifact, 'schemaVersion' | 'secretScan'> & { secretScan?: ResearchSwarmArtifact['secretScan'] },
): ResearchSwarmArtifact {
  const blob = JSON.stringify(partial);
  const secretScan = partial.secretScan ?? scanForSecrets(blob);
  return { schemaVersion: RESEARCH_SWARM_SCHEMA_VERSION, ...partial, secretScan };
}

function artifactDir(): string {
  return join(getMemoryRoot(), 'memory', 'atlas', 'swarm-runs');
}

/** Persist artifact; returns path. Never throws on write failure — returns null. */
export async function writeArtifact(artifact: ResearchSwarmArtifact): Promise<string | null> {
  try {
    const dir = artifactDir();
    if (!existsSync(dir)) await mkdir(dir, { recursive: true });
    const safe = artifact.startedAt.replace(/[:.]/g, '-').slice(0, 19);
    const fp = join(dir, `${safe}-${artifact.runId.slice(0, 8)}.json`);
    await writeFile(fp, JSON.stringify(artifact, null, 2), 'utf-8');
    return fp;
  } catch {
    return null;
  }
}
