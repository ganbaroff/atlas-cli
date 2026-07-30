import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  preserveExecGraphSnapshot,
  preservedExecGraphManifestSchema,
} from '../atlas/preserved-state-rehearsal.js';
import { withShadowRehearsalTestOverrides } from '../atlas/shadow-rehearsal-test-seam.js';
import { writeExecGraphFixture } from './fixtures/exec-graph-shadow-fixture.js';

const ARTIFACT_NAME = 'atlas-exec-graph-m3c-20260730T174900Z-deadbeef';

describe('atlas/preserved-state preservation', () => {
  let sandboxDirectory: string;

  beforeEach(() => {
    sandboxDirectory = mkdtempSync(join(tmpdir(), 'atlas-preserved-state-'));
  });

  afterEach(() => {
    rmSync(sandboxDirectory, { recursive: true, force: true });
  });

  function createPreservationParent(name = 'preservation'): string {
    const directory = join(sandboxDirectory, name);
    mkdirSync(directory);
    return directory;
  }

  function expectNoPreservationResidue(
    preservationParentDirectory: string,
    artifactName = ARTIFACT_NAME,
  ): void {
    expect(existsSync(join(preservationParentDirectory, artifactName))).toBe(false);
    expect(
      readdirSync(preservationParentDirectory).filter((entry) =>
        entry.startsWith('.m3c-staging-'),
      ),
    ).toEqual([]);
  }

  it('atomically preserves a stable exec graph with a strict manifest', () => {
    const sourceDirectory = writeExecGraphFixture(sandboxDirectory, 'source');
    const preservationParentDirectory = createPreservationParent();
    const artifactDirectory = join(preservationParentDirectory, ARTIFACT_NAME);

    const manifest = preserveExecGraphSnapshot({
      sourceDirectory,
      preservationParentDirectory,
      artifactName: ARTIFACT_NAME,
    });

    expect(manifest).toMatchObject({
      schemaVersion: 1,
      kind: 'atlas.exec-graph-preservation',
      sourceDirectory: resolve(sourceDirectory),
      artifactDirectory: resolve(artifactDirectory),
      preservedDirectory: resolve(artifactDirectory, 'exec-graph'),
      sourceStable: true,
      preservationAccepted: true,
      comparison: {
        ledgerBytesEqual: true,
        semanticStateEqual: true,
        countsEqual: true,
        accepted: true,
      },
    });
    expect(readdirSync(artifactDirectory).sort()).toEqual([
      'exec-graph',
      'preservation-manifest.json',
    ]);
    const persisted = JSON.parse(
      readFileSync(join(artifactDirectory, 'preservation-manifest.json'), 'utf8'),
    ) as unknown;
    expect(preservedExecGraphManifestSchema.parse(persisted)).toEqual(manifest);
    expect(() =>
      preservedExecGraphManifestSchema.parse({
        ...(persisted as Record<string, unknown>),
        unexpected: true,
      }),
    ).toThrow();
    expect(JSON.stringify(manifest)).not.toContain('.m3c-staging-');
    expect(manifest.sourceBefore).toEqual(manifest.sourceAfterCopy);
    expect(manifest.sourceAfterCopy).toEqual(manifest.sourceDuringComparison);
    expect(manifest.preserved).toMatchObject({
      directory: resolve(artifactDirectory, 'exec-graph'),
      ledgerSha256: manifest.sourceBefore.ledgerSha256,
      snapshotSha256: manifest.sourceBefore.snapshotSha256,
      semanticSha256: manifest.sourceBefore.semanticSha256,
      eventCount: 2,
      goalCount: 1,
      taskCount: 1,
    });
  });

  it('fails source mutation closed and removes its exact staging directory', () => {
    const sourceDirectory = writeExecGraphFixture(sandboxDirectory, 'source-mutation');
    const changedDirectory = writeExecGraphFixture(
      sandboxDirectory,
      'changed-source',
      'changed after copy',
    );
    const preservationParentDirectory = createPreservationParent('mutation-parent');
    let writes = 0;

    const fileWriter = (destinationPath: string, contents: Buffer): void => {
      writeFileSync(destinationPath, contents, { flush: true });
      writes += 1;
      if (writes === 2) {
        for (const name of ['ledger.jsonl', 'graph.json']) {
          writeFileSync(
            join(sourceDirectory, name),
            readFileSync(join(changedDirectory, name)),
            { flush: true },
          );
        }
      }
    };

    withShadowRehearsalTestOverrides({ fileWriter }, () => {
      expect(() =>
        preserveExecGraphSnapshot({
          sourceDirectory,
          preservationParentDirectory,
          artifactName: ARTIFACT_NAME,
        }),
      ).toThrow(expect.objectContaining({ code: 'source_mutated' }));
    });
    expectNoPreservationResidue(preservationParentDirectory);
  });

  it('fails divergent preserved bytes closed and removes staging', () => {
    const sourceDirectory = writeExecGraphFixture(sandboxDirectory, 'source-divergence');
    const divergentDirectory = writeExecGraphFixture(
      sandboxDirectory,
      'divergent-copy',
      'divergent copy',
    );
    const preservationParentDirectory = createPreservationParent('divergence-parent');
    const fileWriter = (destinationPath: string): void => {
      writeFileSync(
        destinationPath,
        readFileSync(join(divergentDirectory, basename(destinationPath))),
        { flush: true },
      );
    };

    withShadowRehearsalTestOverrides({ fileWriter }, () => {
      expect(() =>
        preserveExecGraphSnapshot({
          sourceDirectory,
          preservationParentDirectory,
          artifactName: ARTIFACT_NAME,
        }),
      ).toThrow(expect.objectContaining({ code: 'preservation_mismatch' }));
    });
    expectNoPreservationResidue(preservationParentDirectory);
  });

  it('refuses an existing artifact without changing it', () => {
    const sourceDirectory = writeExecGraphFixture(sandboxDirectory, 'existing-source');
    const preservationParentDirectory = createPreservationParent('existing-parent');
    const artifactDirectory = join(preservationParentDirectory, ARTIFACT_NAME);
    const sentinelPath = join(artifactDirectory, 'sentinel.txt');
    mkdirSync(artifactDirectory);
    writeFileSync(sentinelPath, 'owned elsewhere', 'utf8');

    expect(() =>
      preserveExecGraphSnapshot({
        sourceDirectory,
        preservationParentDirectory,
        artifactName: ARTIFACT_NAME,
      }),
    ).toThrow(expect.objectContaining({ code: 'artifact_exists' }));
    expect(readFileSync(sentinelPath, 'utf8')).toBe('owned elsewhere');
    expect(readdirSync(preservationParentDirectory)).toEqual([ARTIFACT_NAME]);
  });

  it.each([
    ['missing', 'directory_missing'],
    ['malformed', 'ledger_invalid'],
    ['empty', 'ledger_empty'],
  ] as const)('preserves M3A %s-source error code %s before staging', (kind, code) => {
    const sourceDirectory = join(sandboxDirectory, `${kind}-source`);
    if (kind !== 'missing') {
      mkdirSync(sourceDirectory);
      writeFileSync(
        join(sourceDirectory, 'ledger.jsonl'),
        kind === 'malformed' ? '{broken\n' : '',
        'utf8',
      );
      writeFileSync(join(sourceDirectory, 'graph.json'), '{"goals":[],"tasks":[]}\n', 'utf8');
    }
    const preservationParentDirectory = createPreservationParent(`${kind}-parent`);

    expect(() =>
      preserveExecGraphSnapshot({
        sourceDirectory,
        preservationParentDirectory,
        artifactName: ARTIFACT_NAME,
      }),
    ).toThrow(expect.objectContaining({ code }));
    expectNoPreservationResidue(preservationParentDirectory);
  });

  it.each([
    {
      label: 'relative source',
      source: 'relative-source',
      parent: 'valid',
      artifactName: ARTIFACT_NAME,
    },
    {
      label: 'relative parent',
      source: 'valid',
      parent: 'relative-parent',
      artifactName: ARTIFACT_NAME,
    },
    { label: 'simple name', source: 'valid', parent: 'valid', artifactName: 'artifact' },
    { label: 'traversal name', source: 'valid', parent: 'valid', artifactName: '..' },
    {
      label: 'slash name',
      source: 'valid',
      parent: 'valid',
      artifactName: `${ARTIFACT_NAME}/nested`,
    },
    {
      label: 'backslash name',
      source: 'valid',
      parent: 'valid',
      artifactName: `${ARTIFACT_NAME}\\nested`,
    },
  ])('rejects $label before filesystem creation', ({ source, parent, artifactName }) => {
    const validSource = writeExecGraphFixture(sandboxDirectory, `path-source-${artifactName.length}`);
    const validParent = createPreservationParent(`path-parent-${artifactName.length}`);
    const sourceDirectory = source === 'valid' ? validSource : source;
    const preservationParentDirectory = parent === 'valid' ? validParent : parent;
    const before = readdirSync(validParent);

    expect(() =>
      preserveExecGraphSnapshot({
        sourceDirectory,
        preservationParentDirectory,
        artifactName,
      }),
    ).toThrow(expect.objectContaining({ code: 'path_invalid' }));
    expect(readdirSync(validParent)).toEqual(before);
  });

  it.each([
    ['sourceDirectory', undefined],
    ['preservationParentDirectory', 42],
    ['artifactName', null],
  ] as const)('rejects malformed cast %s before filesystem creation', (key, value) => {
    const sourceDirectory = writeExecGraphFixture(sandboxDirectory, `cast-${key}`);
    const preservationParentDirectory = createPreservationParent(`cast-parent-${key}`);
    const castOptions = {
      sourceDirectory,
      preservationParentDirectory,
      artifactName: ARTIFACT_NAME,
      [key]: value,
    } as unknown as Parameters<typeof preserveExecGraphSnapshot>[0];

    expect(() => preserveExecGraphSnapshot(castOptions)).toThrow(
      expect.objectContaining({ code: 'path_invalid' }),
    );
    expect(readdirSync(preservationParentDirectory)).toEqual([]);
  });

  it.each(['same', 'parent-inside-source', 'source-inside-parent'] as const)(
    'rejects %s source and preservation overlap before staging',
    (shape) => {
      let sourceDirectory: string;
      let preservationParentDirectory: string;

      if (shape === 'source-inside-parent') {
        preservationParentDirectory = createPreservationParent('overlap-parent');
        sourceDirectory = writeExecGraphFixture(preservationParentDirectory, 'nested-source');
      } else {
        sourceDirectory = writeExecGraphFixture(sandboxDirectory, `overlap-${shape}`);
        preservationParentDirectory =
          shape === 'same' ? sourceDirectory : join(sourceDirectory, 'nested-parent');
        if (shape === 'parent-inside-source') mkdirSync(preservationParentDirectory);
      }

      const before = readdirSync(preservationParentDirectory);
      expect(() =>
        preserveExecGraphSnapshot({
          sourceDirectory,
          preservationParentDirectory,
          artifactName: ARTIFACT_NAME,
        }),
      ).toThrow(expect.objectContaining({ code: 'path_invalid' }));
      expect(readdirSync(preservationParentDirectory)).toEqual(before);
    },
  );
});
