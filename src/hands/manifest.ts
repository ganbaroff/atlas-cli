/**
 * M5 — Hand Manifest SDK: load HandSpec from JSON files without editing REGISTRY.
 */

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { handSpecSchema, type HandSpec } from './hand-spec.js';

export class ManifestValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ManifestValidationError';
  }
}

const DEFAULT_MANIFEST_DIR = resolveDefaultManifestDir();

function resolveDefaultManifestDir(): string {
  const bundled = join(dirname(fileURLToPath(import.meta.url)), 'manifests');
  if (existsSync(bundled)) return bundled;
  const fromSrc = join(process.cwd(), 'src/hands/manifests');
  if (existsSync(fromSrc)) return fromSrc;
  return bundled;
}

let cached: Map<string, HandSpec> | null = null;

function manifestDir(): string {
  return process.env.ATLAS_HAND_MANIFEST_DIR ?? DEFAULT_MANIFEST_DIR;
}

/** Load + validate all `*.json` manifests. Fail-closed on malformed. */
export function loadHandManifests(dir = manifestDir()): Map<string, HandSpec> {
  const out = new Map<string, HandSpec>();
  if (!existsSync(dir)) return out;
  const files = readdirSync(dir).filter((f) => f.endsWith('.json'));
  for (const file of files) {
    const raw = JSON.parse(readFileSync(join(dir, file), 'utf8')) as unknown;
    let spec: HandSpec;
    try {
      spec = handSpecSchema.parse(raw);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new ManifestValidationError(`hands manifest '${file}' invalid: ${msg}`);
    }
    if (out.has(spec.handId)) {
      throw new ManifestValidationError(`duplicate handId '${spec.handId}' in manifests`);
    }
    out.set(spec.handId, spec);
  }
  return out;
}

export function getManifestHands(): Map<string, HandSpec> {
  if (!cached) cached = loadHandManifests();
  return cached;
}

/** Test helper — force reload. */
export function resetManifestCacheForTests(): void {
  cached = null;
}

/** Capability escalation: allowedActions must be subset of capabilities. */
export function assertManifestCapabilitiesConsistent(spec: HandSpec): void {
  const caps = new Set(spec.capabilities);
  for (const action of spec.allowedActions) {
    if (!caps.has(action)) {
      throw new ManifestValidationError(
        `hand '${spec.handId}' allowedAction '${action}' not in capabilities`,
      );
    }
  }
}
