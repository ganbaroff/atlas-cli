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
import { basename, dirname, join, sep } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  preserveExecGraphSnapshot,
  rehearsePreservedExecGraph,
  verifyPreservedStateRehearsal,
} from '../atlas/preserved-state-rehearsal.js';
import { withShadowRehearsalTestOverrides } from '../atlas/shadow-rehearsal-test-seam.js';
import { writeExecGraphFixture } from './fixtures/exec-graph-shadow-fixture.js';

const ARTIFACT_NAME = 'atlas-exec-graph-m3c-20260730T181500Z-cafebabe';
const CHILD_TEST_TIMEOUT = 20_000;

describe('atlas/preserved-state rehearsal', () => {
  let sandboxDirectory: string;
  let sourceDirectory: string;
  let preservationParentDirectory: string;
  let artifactDirectory: string;

  beforeEach(() => {
    sandboxDirectory = mkdtempSync(join(tmpdir(), 'atlas-preserved-rehearsal-'));
    sourceDirectory = writeExecGraphFixture(sandboxDirectory, 'source');
    preservationParentDirectory = join(sandboxDirectory, 'preservation');
    mkdirSync(preservationParentDirectory);
    artifactDirectory = join(preservationParentDirectory, ARTIFACT_NAME);
    preserveExecGraphSnapshot({
      sourceDirectory,
      preservationParentDirectory,
      artifactName: ARTIFACT_NAME,
    });
  });

  afterEach(() => {
    rmSync(sandboxDirectory, { recursive: true, force: true });
  });

  function receiptPath(): string {
    return join(artifactDirectory, 'rehearsal-receipt.json');
  }

  function manifestPath(): string {
    return join(artifactDirectory, 'preservation-manifest.json');
  }

  function preservedDirectory(): string {
    return join(artifactDirectory, 'exec-graph');
  }

  function workEntries(): string[] {
    return readdirSync(preservationParentDirectory).filter((entry) =>
      entry.startsWith('.m3c-work-'),
    );
  }

  function replacePreservedState(title: string): void {
    const alternate = writeExecGraphFixture(sandboxDirectory, `alternate-${title}`, title);
    for (const name of ['ledger.jsonl', 'graph.json']) {
      writeFileSync(
        join(preservedDirectory(), name),
        readFileSync(join(alternate, name)),
        { flush: true },
      );
    }
  }

  it(
    'rehearses only the preserved copy, cleans work, writes a bound receipt, and verifies read-only',
    () => {
      const sourceBefore = readFileSync(join(sourceDirectory, 'ledger.jsonl'), 'utf8');

      const receipt = rehearsePreservedExecGraph({ artifactDirectory });

      expect(receipt).toMatchObject({
        schemaVersion: 1,
        kind: 'atlas.m3c-preserved-state-rehearsal',
        artifactDirectory,
        preservedDirectory: join(artifactDirectory, 'exec-graph'),
        preservationAccepted: true,
        coldReplayAccepted: true,
        rollbackVerified: true,
        preservedStateUnchanged: true,
        workDirectoryAbsent: true,
      });
      expect(existsSync(receipt.workDirectory)).toBe(false);
      expect(existsSync(receipt.m3bReceipt.shadowRoot)).toBe(false);
      expect(existsSync(receiptPath())).toBe(true);
      expect(workEntries()).toEqual([]);
      expect(readFileSync(join(sourceDirectory, 'ledger.jsonl'), 'utf8')).toBe(sourceBefore);

      const verified = verifyPreservedStateRehearsal(artifactDirectory);
      expect(verified).toEqual({
        verified: true,
        manifestSha256: receipt.manifestSha256,
        manifest: expect.objectContaining({ artifactDirectory }),
        receipt,
      });
      expect(workEntries()).toEqual([]);
    },
    CHILD_TEST_TIMEOUT,
  );

  it.each([0, 30_001, 1.5, Number.NaN, Number.POSITIVE_INFINITY])(
    'rejects invalid child timeout %s before creating work or receipt',
    (childTimeoutMs) => {
      expect(() =>
        rehearsePreservedExecGraph({ artifactDirectory, childTimeoutMs }),
      ).toThrow(expect.objectContaining({ code: 'timeout_invalid' }));
      expect(workEntries()).toEqual([]);
      expect(existsSync(receiptPath())).toBe(false);
    },
  );

  it.each([
    ['null options', null],
    ['relative artifact', { artifactDirectory: 'relative-artifact' }],
  ] as const)('rejects malformed %s before filesystem mutation', (_label, castOptions) => {
    expect(() =>
      rehearsePreservedExecGraph(
        castOptions as unknown as Parameters<typeof rehearsePreservedExecGraph>[0],
      ),
    ).toThrow(expect.objectContaining({ code: 'path_invalid' }));
    expect(workEntries()).toEqual([]);
    expect(existsSync(receiptPath())).toBe(false);
  });

  it('rejects preserved-state tamper before creating work', () => {
    replacePreservedState('tampered-before-rehearsal');

    expect(() => rehearsePreservedExecGraph({ artifactDirectory })).toThrow(
      expect.objectContaining({ code: 'preserved_state_tampered' }),
    );
    expect(workEntries()).toEqual([]);
    expect(existsSync(receiptPath())).toBe(false);
  });

  it(
    'writes no receipt when preserved state changes during rollback',
    () => {
      withShadowRehearsalTestOverrides(
        {
          executeRollback: (shadowRoot) => {
            replacePreservedState('tampered-during-rollback');
            rmSync(shadowRoot, { recursive: true, force: true });
          },
        },
        () => {
          expect(() => rehearsePreservedExecGraph({ artifactDirectory })).toThrow(
            expect.objectContaining({ code: 'rehearsal_failed' }),
          );
        },
      );
      expect(workEntries()).toEqual([]);
      expect(existsSync(receiptPath())).toBe(false);
    },
    CHILD_TEST_TIMEOUT,
  );

  it.each(['malformed', 'unknown-field', 'path-mismatch'] as const)(
    'rejects %s manifest before cold replay child spawn',
    (shape) => {
      const childMarker = join(sandboxDirectory, `child-marker-${shape}.txt`);
      const childScriptPath = join(sandboxDirectory, `child-marker-${shape}.mjs`);
      writeFileSync(
        childScriptPath,
        `import { writeFileSync } from 'node:fs';\nwriteFileSync(${JSON.stringify(childMarker)}, 'spawned');\nprocess.exit(0);\n`,
        'utf8',
      );
      if (shape === 'malformed') {
        writeFileSync(manifestPath(), '{broken\n', 'utf8');
      } else {
        const manifest = JSON.parse(readFileSync(manifestPath(), 'utf8')) as Record<
          string,
          unknown
        >;
        if (shape === 'unknown-field') manifest.unexpected = true;
        if (shape === 'path-mismatch') {
          manifest.preservedDirectory = join(sandboxDirectory, 'forged-preserved');
        }
        writeFileSync(manifestPath(), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
      }

      withShadowRehearsalTestOverrides({ childScriptPath }, () => {
        expect(() => rehearsePreservedExecGraph({ artifactDirectory })).toThrow(
          expect.objectContaining({ code: 'manifest_invalid' }),
        );
      });
      expect(existsSync(childMarker)).toBe(false);
      expect(workEntries()).toEqual([]);
      expect(existsSync(receiptPath())).toBe(false);
    },
  );

  it(
    'refuses a second rehearsal without changing the first receipt or creating work',
    () => {
      rehearsePreservedExecGraph({ artifactDirectory });
      const originalReceipt = readFileSync(receiptPath(), 'utf8');

      expect(() => rehearsePreservedExecGraph({ artifactDirectory })).toThrow(
        expect.objectContaining({ code: 'receipt_exists' }),
      );
      expect(readFileSync(receiptPath(), 'utf8')).toBe(originalReceipt);
      expect(workEntries()).toEqual([]);
    },
    CHILD_TEST_TIMEOUT,
  );

  it(
    'ignores cast work, child, receipt, and name destinations',
    () => {
      const forgedWork = join(sandboxDirectory, 'forged-work');
      const forgedReceipt = join(sandboxDirectory, 'forged-receipt.json');
      const forgedChild = join(sandboxDirectory, 'forged-child.mjs');
      writeFileSync(forgedChild, 'process.exit(61);\n', 'utf8');

      const receipt = rehearsePreservedExecGraph({
        artifactDirectory,
        workDirectory: forgedWork,
        receiptPath: forgedReceipt,
        childScriptPath: forgedChild,
        workDirectoryName: 'forged-name',
      } as unknown as Parameters<typeof rehearsePreservedExecGraph>[0]);

      expect(receipt.rollbackVerified).toBe(true);
      expect(existsSync(forgedWork)).toBe(false);
      expect(existsSync(forgedReceipt)).toBe(false);
      expect(receipt.workDirectory).not.toContain('forged-name');
    },
    CHILD_TEST_TIMEOUT,
  );

  it(
    'ignores CWD and ATLAS_EXEC_GRAPH_DIR when explicit artifact path is supplied',
    () => {
      const originalCwd = process.cwd();
      const originalExecGraphDir = process.env.ATLAS_EXEC_GRAPH_DIR;
      const unrelatedCwd = join(sandboxDirectory, 'unrelated-cwd');
      mkdirSync(unrelatedCwd);

      try {
        process.chdir(unrelatedCwd);
        process.env.ATLAS_EXEC_GRAPH_DIR = join(sandboxDirectory, 'forged-live-state');
        const receipt = rehearsePreservedExecGraph({ artifactDirectory });
        expect(receipt.artifactDirectory).toBe(artifactDirectory);
        expect(receipt.preservedDirectory).toBe(preservedDirectory());
      } finally {
        process.chdir(originalCwd);
        if (originalExecGraphDir === undefined) {
          delete process.env.ATLAS_EXEC_GRAPH_DIR;
        } else {
          process.env.ATLAS_EXEC_GRAPH_DIR = originalExecGraphDir;
        }
      }
    },
    CHILD_TEST_TIMEOUT,
  );

  it(
    'detects manifest SHA tamper after receipt',
    () => {
      rehearsePreservedExecGraph({ artifactDirectory });
      writeFileSync(manifestPath(), `${readFileSync(manifestPath(), 'utf8')}\n`, 'utf8');

      expect(() => verifyPreservedStateRehearsal(artifactDirectory)).toThrow(
        expect.objectContaining({ code: 'manifest_tampered' }),
      );
    },
    CHILD_TEST_TIMEOUT,
  );

  it(
    'classifies an unknown-field manifest after receipt as bound manifest tamper',
    () => {
      rehearsePreservedExecGraph({ artifactDirectory });
      const manifest = JSON.parse(readFileSync(manifestPath(), 'utf8')) as Record<
        string,
        unknown
      >;
      manifest.unexpected = true;
      writeFileSync(manifestPath(), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');

      expect(() => verifyPreservedStateRehearsal(artifactDirectory)).toThrow(
        expect.objectContaining({ code: 'manifest_tampered' }),
      );
    },
    CHILD_TEST_TIMEOUT,
  );

  it(
    'detects strict receipt tamper after receipt',
    () => {
      rehearsePreservedExecGraph({ artifactDirectory });
      const receipt = JSON.parse(readFileSync(receiptPath(), 'utf8')) as Record<
        string,
        unknown
      >;
      receipt.unexpected = true;
      writeFileSync(receiptPath(), `${JSON.stringify(receipt, null, 2)}\n`, 'utf8');

      expect(() => verifyPreservedStateRehearsal(artifactDirectory)).toThrow(
        expect.objectContaining({ code: 'receipt_invalid' }),
      );
    },
    CHILD_TEST_TIMEOUT,
  );

  it(
    'rejects a non-canonical work directory even when it resolves to the recorded path',
    () => {
      rehearsePreservedExecGraph({ artifactDirectory });
      const receipt = JSON.parse(readFileSync(receiptPath(), 'utf8')) as Record<
        string,
        unknown
      >;
      const workDirectory = String(receipt.workDirectory);
      receipt.workDirectory = `${dirname(workDirectory)}${sep}alias${sep}..${sep}${basename(workDirectory)}`;
      writeFileSync(receiptPath(), `${JSON.stringify(receipt, null, 2)}\n`, 'utf8');

      expect(() => verifyPreservedStateRehearsal(artifactDirectory)).toThrow(
        expect.objectContaining({ code: 'receipt_invalid' }),
      );
    },
    CHILD_TEST_TIMEOUT,
  );

  it(
    'detects preserved-file tamper after receipt',
    () => {
      rehearsePreservedExecGraph({ artifactDirectory });
      replacePreservedState('tampered-after-receipt');

      expect(() => verifyPreservedStateRehearsal(artifactDirectory)).toThrow(
        expect.objectContaining({ code: 'preserved_state_tampered' }),
      );
    },
    CHILD_TEST_TIMEOUT,
  );

  it(
    'writes no M3C receipt when the fixed cold replay child exits nonzero',
    () => {
      const childScriptPath = join(sandboxDirectory, 'child-exit.mjs');
      writeFileSync(childScriptPath, 'process.exit(47);\n', 'utf8');

      withShadowRehearsalTestOverrides({ childScriptPath }, () => {
        expect(() => rehearsePreservedExecGraph({ artifactDirectory })).toThrow(
          expect.objectContaining({ code: 'rehearsal_failed' }),
        );
      });
      expect(existsSync(receiptPath())).toBe(false);
      expect(workEntries()).toEqual([]);
    },
    CHILD_TEST_TIMEOUT,
  );

  it(
    'writes no M3C receipt when rollback is not executed',
    () => {
      withShadowRehearsalTestOverrides({ executeRollback: () => undefined }, () => {
        expect(() => rehearsePreservedExecGraph({ artifactDirectory })).toThrow(
          expect.objectContaining({ code: 'rehearsal_failed' }),
        );
      });
      expect(existsSync(receiptPath())).toBe(false);
      expect(workEntries()).toEqual([]);
    },
    CHILD_TEST_TIMEOUT,
  );
});
