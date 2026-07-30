import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { STATE_STORES, type StateStore } from '../atlas/state-root.js';
import {
  EXTERNAL_STATE_WRITERS,
  STATE_WRITER_INVENTORY,
} from '../atlas/state-writer-inventory.js';

const SRC_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const MUTATING_FS_CALLS = [
  'writeFile',
  'writeFileSync',
  'appendFile',
  'appendFileSync',
  'rename',
  'renameSync',
  'mkdir',
  'mkdirSync',
  'unlink',
  'unlinkSync',
  'rm',
  'rmSync',
  'copyFile',
  'copyFileSync',
  'createWriteStream',
  'openSync',
] as const;

function productionTypeScriptFiles(dir: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === '__tests__') continue;
    const path = resolve(dir, entry.name);
    if (entry.isDirectory()) files.push(...productionTypeScriptFiles(path));
    else if (entry.isFile() && entry.name.endsWith('.ts')) files.push(path);
  }
  return files;
}

function scannedFilesystemWriters(): string[] {
  return productionTypeScriptFiles(SRC_ROOT)
    .filter((path) => {
      const source = readFileSync(path, 'utf8');
      if (!source.includes('node:fs')) return false;
      // Match the imported primitive name too, so `writeFile as wf` and
      // namespace-style calls cannot evade classification by changing the
      // local call spelling.
      return MUTATING_FS_CALLS.some((name) => new RegExp(`\\b${name}\\b`).test(source));
    })
    .map((path) => `src/${relative(SRC_ROOT, path).replaceAll('\\', '/')}`)
    .sort();
}

describe('state writer inventory', () => {
  it('classifies every production TypeScript file that calls a filesystem mutator', () => {
    expect(Object.keys(STATE_WRITER_INVENTORY).sort()).toEqual(scannedFilesystemWriters());
  });

  it('routes every authoritative mutation surface through a registered state-root store', () => {
    for (const [file, surfaces] of Object.entries(STATE_WRITER_INVENTORY)) {
      expect(surfaces.length, file).toBeGreaterThan(0);
      for (const surface of surfaces) {
        if (surface.location === 'state-root') {
          expect(surface.stores?.length ?? 0, `${file}: ${surface.reason}`).toBeGreaterThan(0);
        }
        if (surface.classification !== 'authoritative') continue;
        expect(surface.location, `${file}: ${surface.reason}`).toBe('state-root');
        expect(surface.stores?.length ?? 0, file).toBeGreaterThan(0);
      }
    }
  });

  it('references only registered stores and accounts for every registered store', () => {
    const referenced = new Set<StateStore>();
    for (const surfaces of Object.values(STATE_WRITER_INVENTORY)) {
      for (const surface of surfaces) {
        for (const store of surface.stores ?? []) {
          expect(store in STATE_STORES).toBe(true);
          referenced.add(store);
        }
      }
    }
    for (const [store, writer] of Object.entries(EXTERNAL_STATE_WRITERS) as Array<
      [StateStore, NonNullable<(typeof EXTERNAL_STATE_WRITERS)[StateStore]>]
    >) {
      expect(store in STATE_STORES).toBe(true);
      expect(['authoritative', 'operational']).toContain(writer.classification);
      expect(writer.reason.length).toBeGreaterThan(0);
      referenced.add(store);
    }
    expect([...referenced].sort()).toEqual((Object.keys(STATE_STORES) as StateStore[]).sort());
  });
});
