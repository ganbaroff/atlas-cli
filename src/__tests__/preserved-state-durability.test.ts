import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const observations = vi.hoisted(
  () =>
    [] as Array<
      | { readonly kind: 'write'; readonly path: string; readonly options: unknown }
      | {
          readonly kind: 'promotion';
          readonly stagingPath: string;
          readonly finalPath: string;
          readonly manifestPresent: boolean;
          readonly finalAbsent: boolean;
        }
    >,
);
const faults = vi.hoisted(() => ({
  createCollision: false,
  unsafePromotionCleanup: false,
  tamperAfterPromotion: false,
  realpathOverlap: false,
  swapArtifactBeforeRead: false,
  createArtifactDuringPromotion: false,
  collisionPath: '',
  unsafeTarget: '',
  overlapSource: '',
  overlapParent: '',
  replacementPath: '',
  concurrentArtifactPath: '',
  recursiveRemovals: [] as string[],
}));

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  const mockedRealpathSync = ((...args: unknown[]) =>
    Reflect.apply(actual.realpathSync, actual, args)) as typeof actual.realpathSync;
  mockedRealpathSync.native = ((...args: unknown[]) => {
    const path = args[0];
    if (
      faults.realpathOverlap &&
      typeof path === 'string' &&
      path === faults.overlapSource
    ) {
      return join(faults.overlapParent, 'aliased-source');
    }
    return Reflect.apply(actual.realpathSync.native, actual.realpathSync, args);
  }) as typeof actual.realpathSync.native;
  return {
    ...actual,
    realpathSync: mockedRealpathSync,
    mkdirSync: (...args: unknown[]) => {
      const path = args[0];
      if (
        faults.createCollision &&
        typeof path === 'string' &&
        basename(path).startsWith('.m3c-staging-')
      ) {
        Reflect.apply(actual.mkdirSync, actual, args);
        actual.writeFileSync(join(path, 'sentinel.txt'), 'external owner', 'utf8');
        faults.collisionPath = path;
        throw new Error('synthetic staging creation race');
      }
      return Reflect.apply(actual.mkdirSync, actual, args);
    },
    lstatSync: (...args: unknown[]) => {
      const path = args[0];
      const stat = Reflect.apply(actual.lstatSync, actual, args);
      if (
        faults.unsafePromotionCleanup &&
        typeof path === 'string' &&
        path === faults.unsafeTarget
      ) {
        return new Proxy(stat, {
          get(target, property, receiver) {
            if (property === 'isDirectory') return () => true;
            if (property === 'isSymbolicLink') return () => true;
            return Reflect.get(target, property, receiver);
          },
        });
      }
      return stat;
    },
    rmSync: (...args: unknown[]) => {
      const path = args[0];
      const options = args[1];
      if (
        typeof path === 'string' &&
        typeof options === 'object' &&
        options !== null &&
        'recursive' in options &&
        options.recursive === true
      ) {
        faults.recursiveRemovals.push(path);
        if (faults.unsafePromotionCleanup && path === faults.unsafeTarget) return;
        if (faults.swapArtifactBeforeRead && path === faults.replacementPath) return;
      }
      return Reflect.apply(actual.rmSync, actual, args);
    },
    readFileSync: (...args: unknown[]) => {
      const path = args[0];
      if (
        faults.swapArtifactBeforeRead &&
        typeof path === 'string' &&
        basename(path) === 'preservation-manifest.json' &&
        !basename(dirname(path)).startsWith('.m3c-staging-') &&
        faults.replacementPath === ''
      ) {
        const artifactDirectory = dirname(path);
        actual.renameSync(artifactDirectory, `${artifactDirectory}.owned-moved`);
        actual.mkdirSync(artifactDirectory);
        actual.writeFileSync(
          join(artifactDirectory, 'sentinel.txt'),
          'replacement owner',
          'utf8',
        );
        faults.replacementPath = artifactDirectory;
      }
      return Reflect.apply(actual.readFileSync, actual, args);
    },
    writeFileSync: (...args: unknown[]) => {
      const path = args[0];
      if (typeof path === 'string') {
        observations.push({ kind: 'write', path, options: args[2] });
      }
      return Reflect.apply(actual.writeFileSync, actual, args);
    },
    renameSync: (...args: unknown[]) => {
      const source = args[0];
      const destination = args[1];
      if (
        typeof source === 'string' &&
        typeof destination === 'string' &&
        basename(source).startsWith('.m3c-staging-')
      ) {
        observations.push({
          kind: 'promotion',
          stagingPath: source,
          finalPath: destination,
          manifestPresent: actual.existsSync(join(source, 'preservation-manifest.json')),
          finalAbsent: !actual.existsSync(destination),
        });
      }
      if (
        faults.unsafePromotionCleanup &&
        typeof source === 'string' &&
        basename(source).startsWith('.m3c-staging-')
      ) {
        faults.unsafeTarget = source;
        throw new Error('synthetic promotion failure before unsafe cleanup');
      }
      if (
        faults.createArtifactDuringPromotion &&
        typeof source === 'string' &&
        typeof destination === 'string' &&
        basename(source).startsWith('.m3c-staging-')
      ) {
        actual.mkdirSync(destination);
        actual.writeFileSync(join(destination, 'sentinel.txt'), 'concurrent owner', 'utf8');
        faults.concurrentArtifactPath = destination;
      }
      const result = Reflect.apply(actual.renameSync, actual, args);
      if (
        faults.tamperAfterPromotion &&
        typeof source === 'string' &&
        typeof destination === 'string' &&
        basename(source).startsWith('.m3c-staging-')
      ) {
        const manifestPath = join(destination, 'preservation-manifest.json');
        const manifest = JSON.parse(actual.readFileSync(manifestPath, 'utf8')) as {
          sourceBefore: { eventCount: number };
        };
        manifest.sourceBefore.eventCount += 1;
        actual.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
      }
      return result;
    },
  };
});

import { preserveExecGraphSnapshot } from '../atlas/preserved-state-rehearsal.js';
import { writeExecGraphFixture } from './fixtures/exec-graph-shadow-fixture.js';

const ARTIFACT_NAME = 'atlas-exec-graph-m3c-20260730T174900Z-feedface';

describe('atlas/preserved-state preservation durability', () => {
  let sandboxDirectory: string;

  beforeEach(() => {
    observations.length = 0;
    faults.createCollision = false;
    faults.unsafePromotionCleanup = false;
    faults.tamperAfterPromotion = false;
    faults.realpathOverlap = false;
    faults.swapArtifactBeforeRead = false;
    faults.createArtifactDuringPromotion = false;
    faults.collisionPath = '';
    faults.unsafeTarget = '';
    faults.overlapSource = '';
    faults.overlapParent = '';
    faults.replacementPath = '';
    faults.concurrentArtifactPath = '';
    faults.recursiveRemovals.length = 0;
    sandboxDirectory = mkdtempSync(join(tmpdir(), 'atlas-preserved-durability-'));
  });

  afterEach(() => {
    rmSync(sandboxDirectory, { recursive: true, force: true });
  });

  it('flushes the manifest before one atomic staging promotion', () => {
    const sourceDirectory = writeExecGraphFixture(sandboxDirectory, 'source');
    const preservationParentDirectory = join(sandboxDirectory, 'preservation');
    mkdirSync(preservationParentDirectory);

    const manifest = preserveExecGraphSnapshot({
      sourceDirectory,
      preservationParentDirectory,
      artifactName: ARTIFACT_NAME,
    });

    const manifestWrites = observations.filter(
      (item) => item.kind === 'write' && basename(item.path) === 'preservation-manifest.json',
    );
    expect(manifestWrites).toEqual([
      expect.objectContaining({
        kind: 'write',
        options: { encoding: 'utf8', flush: true },
      }),
    ]);
    expect(observations.filter((item) => item.kind === 'promotion')).toEqual([
      expect.objectContaining({
        kind: 'promotion',
        finalPath: manifest.artifactDirectory,
        manifestPresent: true,
        finalAbsent: true,
      }),
    ]);
    expect(existsSync(manifest.artifactDirectory)).toBe(true);
  });

  it('does not delete a staging path when creation lost a race', () => {
    const sourceDirectory = writeExecGraphFixture(sandboxDirectory, 'collision-source');
    const preservationParentDirectory = join(sandboxDirectory, 'collision-parent');
    mkdirSync(preservationParentDirectory);
    faults.createCollision = true;

    expect(() =>
      preserveExecGraphSnapshot({
        sourceDirectory,
        preservationParentDirectory,
        artifactName: ARTIFACT_NAME,
      }),
    ).toThrow(expect.objectContaining({ code: 'preservation_failed' }));
    expect(readFileSync(join(faults.collisionPath, 'sentinel.txt'), 'utf8')).toBe(
      'external owner',
    );
    expect(faults.recursiveRemovals).not.toContain(faults.collisionPath);
  });

  it('refuses recursive cleanup when the generated staging path is a link', () => {
    const sourceDirectory = writeExecGraphFixture(sandboxDirectory, 'unsafe-source');
    const preservationParentDirectory = join(sandboxDirectory, 'unsafe-parent');
    mkdirSync(preservationParentDirectory);
    faults.unsafePromotionCleanup = true;

    expect(() =>
      preserveExecGraphSnapshot({
        sourceDirectory,
        preservationParentDirectory,
        artifactName: ARTIFACT_NAME,
      }),
    ).toThrow(expect.objectContaining({ code: 'cleanup_unsafe' }));
    expect(faults.recursiveRemovals).not.toContain(faults.unsafeTarget);
    expect(existsSync(faults.unsafeTarget)).toBe(true);
  });

  it('rejects altered manifest bytes after promotion and removes its artifact', () => {
    const sourceDirectory = writeExecGraphFixture(sandboxDirectory, 'tamper-source');
    const preservationParentDirectory = join(sandboxDirectory, 'tamper-parent');
    mkdirSync(preservationParentDirectory);
    faults.tamperAfterPromotion = true;
    const artifactDirectory = join(preservationParentDirectory, ARTIFACT_NAME);

    expect(() =>
      preserveExecGraphSnapshot({
        sourceDirectory,
        preservationParentDirectory,
        artifactName: ARTIFACT_NAME,
      }),
    ).toThrow(expect.objectContaining({ code: 'manifest_invalid' }));
    expect(existsSync(artifactDirectory)).toBe(false);
  });

  it('rejects source and preservation overlap through resolved aliases', () => {
    const sourceDirectory = writeExecGraphFixture(sandboxDirectory, 'alias-source');
    const preservationParentDirectory = join(sandboxDirectory, 'alias-parent');
    mkdirSync(preservationParentDirectory);
    faults.realpathOverlap = true;
    faults.overlapSource = sourceDirectory;
    faults.overlapParent = preservationParentDirectory;

    expect(() =>
      preserveExecGraphSnapshot({
        sourceDirectory,
        preservationParentDirectory,
        artifactName: ARTIFACT_NAME,
      }),
    ).toThrow(expect.objectContaining({ code: 'path_invalid' }));
    expect(readdirSync(preservationParentDirectory)).toEqual([]);
  });

  it('does not recursively delete a replacement at the promoted artifact path', () => {
    const sourceDirectory = writeExecGraphFixture(sandboxDirectory, 'replacement-source');
    const preservationParentDirectory = join(sandboxDirectory, 'replacement-parent');
    mkdirSync(preservationParentDirectory);
    faults.swapArtifactBeforeRead = true;

    expect(() =>
      preserveExecGraphSnapshot({
        sourceDirectory,
        preservationParentDirectory,
        artifactName: ARTIFACT_NAME,
      }),
    ).toThrow(expect.objectContaining({ code: 'cleanup_unsafe' }));
    expect(readFileSync(join(faults.replacementPath, 'sentinel.txt'), 'utf8')).toBe(
      'replacement owner',
    );
    expect(faults.recursiveRemovals).not.toContain(faults.replacementPath);
  });

  it('does not clobber a nonempty artifact created during promotion', () => {
    const sourceDirectory = writeExecGraphFixture(sandboxDirectory, 'promotion-race-source');
    const preservationParentDirectory = join(sandboxDirectory, 'promotion-race-parent');
    mkdirSync(preservationParentDirectory);
    faults.createArtifactDuringPromotion = true;

    expect(() =>
      preserveExecGraphSnapshot({
        sourceDirectory,
        preservationParentDirectory,
        artifactName: ARTIFACT_NAME,
      }),
    ).toThrow(expect.objectContaining({ code: 'artifact_exists' }));
    expect(
      readFileSync(join(faults.concurrentArtifactPath, 'sentinel.txt'), 'utf8'),
    ).toBe('concurrent owner');
    expect(faults.recursiveRemovals).not.toContain(faults.concurrentArtifactPath);
  });
});
