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
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { ledgerEventSchema, type LedgerEvent } from '../exec-graph/contracts.js';
import { foldEvents } from '../exec-graph/ledger.js';
import { inspectExecGraphDirectory } from '../atlas/shadow-state.js';
import {
  assertStrictParity,
  copyExecGraphDirectoryAtomic,
  coldReplayExecGraphDirectory,
  runShadowRehearsal,
  verifyRollback,
  writeRehearsalReceipt,
  type ChildReplayResult,
} from '../atlas/shadow-rehearsal.js';

const NOW = '2026-07-30T00:00:00.000Z';
const CHILD_TEST_TIMEOUT = 20_000;

describe('atlas/shadow-rehearsal', () => {
  let sandboxDir: string;

  beforeEach(() => {
    sandboxDir = mkdtempSync(join(tmpdir(), 'atlas-shadow-rehearsal-'));
  });

  afterEach(() => {
    rmSync(sandboxDir, { recursive: true, force: true });
  });

  function fixtureEvents(title = 'shadow task'): LedgerEvent[] {
    return [
      ledgerEventSchema.parse({
        eventId: 'evt-rehearsal-goal',
        kind: 'goal-created',
        ts: NOW,
        actor: 'atlas',
        payload: {
          goal: {
            id: 'gol_rehearsal',
            title: 'rehearsal goal',
            source: { kind: 'exec-graph', ref: 'rehearsal-goal' },
            status: 'open',
            createdAt: NOW,
          },
        },
      }),
      ledgerEventSchema.parse({
        eventId: 'evt-rehearsal-task',
        kind: 'task-created',
        ts: NOW,
        actor: 'atlas',
        payload: {
          task: {
            id: 'tsk_rehearsal',
            goalId: 'gol_rehearsal',
            title,
            source: { kind: 'exec-graph', ref: 'rehearsal-task' },
            owner: 'atlas',
            status: 'proposed',
            riskClass: 'low',
            idempotencyKey: 'exec-graph:rehearsal-task',
            evidence: [],
            createdAt: NOW,
            transitions: [{ from: null, to: 'proposed', ts: NOW, actor: 'atlas' }],
          },
        },
      }),
    ];
  }

  function writeValidGraphFixture(name: string, title = 'shadow task'): string {
    const directory = join(sandboxDir, name);
    const events = fixtureEvents(title);
    const snapshot = foldEvents(events);
    mkdirSync(directory, { recursive: true });
    writeFileSync(
      join(directory, 'ledger.jsonl'),
      `${events.map((event) => JSON.stringify(event)).join('\n')}\n`,
      'utf8',
    );
    writeFileSync(
      join(directory, 'graph.json'),
      `${JSON.stringify(
        { goals: Object.values(snapshot.goals), tasks: Object.values(snapshot.tasks) },
        null,
        2,
      )}\n`,
      'utf8',
    );
    return directory;
  }

  function writeFaultScript(name: string, body: string): string {
    const path = join(sandboxDir, name);
    writeFileSync(path, body, 'utf8');
    return path;
  }

  // --- happy path -----------------------------------------------------------

  it(
    'runs copy -> unchanged source -> cold replay -> parity -> rollback -> verified rollback -> receipt in order',
    () => {
      const source = writeValidGraphFixture('source');
      const sourceBefore = inspectExecGraphDirectory(source);
      const workDir = mkdtempSync(join(tmpdir(), 'atlas-shadow-work-'));
      const receiptPath = join(sandboxDir, 'receipt.json');

      try {
        const receipt = runShadowRehearsal(source, {
          workDirectory: workDir,
          shadowRootName: 'shadow',
          receiptPath,
        });

        expect(receipt.parityAccepted).toBe(true);
        expect(receipt.rollbackVerified).toBe(true);
        expect(receipt.sourceLedgerSha256).toBe(sourceBefore.ledgerSha256);
        expect(receipt.sourceSnapshotSha256).toBe(sourceBefore.snapshotSha256);
        expect(receipt.sourceSemanticSha256).toBe(sourceBefore.semanticSha256);
        expect(receipt.childReplayEventCount).toBe(2);
        expect(receipt.childReplayGoalCount).toBe(1);
        expect(receipt.childReplayTaskCount).toBe(1);

        // Source untouched by the whole rehearsal.
        const sourceAfter = inspectExecGraphDirectory(source);
        expect(sourceAfter.ledgerSha256).toBe(sourceBefore.ledgerSha256);
        expect(sourceAfter.snapshotSha256).toBe(sourceBefore.snapshotSha256);
        expect(sourceAfter.semanticSha256).toBe(sourceBefore.semanticSha256);

        // Rollback executed for real: shadow root gone.
        expect(existsSync(join(workDir, 'shadow'))).toBe(false);

        // Receipt actually written to disk, only after all of the above.
        expect(existsSync(receiptPath)).toBe(true);
        const persisted = JSON.parse(readFileSync(receiptPath, 'utf8'));
        expect(persisted.rollbackVerified).toBe(true);
      } finally {
        rmSync(workDir, { recursive: true, force: true });
      }
    },
    CHILD_TEST_TIMEOUT,
  );

  // --- atomic copy ------------------------------------------------------------

  it('leaves no partial destination when the copy is interrupted mid-way', () => {
    const source = writeValidGraphFixture('source');
    const workDir = mkdtempSync(join(tmpdir(), 'atlas-shadow-work-'));
    try {
      let writeCount = 0;
      const faultyWriter = (destinationPath: string, contents: Buffer): void => {
        writeCount += 1;
        if (writeCount === 2) throw new Error('synthetic mid-copy failure');
        writeFileSync(destinationPath, contents);
      };

      expect(() =>
        copyExecGraphDirectoryAtomic(source, workDir, 'shadow', faultyWriter),
      ).toThrow(expect.objectContaining({ code: 'copy_interrupted' }));

      expect(existsSync(join(workDir, 'shadow'))).toBe(false);
      const leftovers = readdirSync(workDir).filter((entry) => entry.startsWith('.staging-'));
      expect(leftovers).toEqual([]);
    } finally {
      rmSync(workDir, { recursive: true, force: true });
    }
  });

  // --- rollback token -----------------------------------------------------

  it('refuses verifyRollback when the shadow root was never removed', () => {
    const source = writeValidGraphFixture('source');
    const workDir = mkdtempSync(join(tmpdir(), 'atlas-shadow-work-'));
    try {
      const shadowRoot = copyExecGraphDirectoryAtomic(source, workDir, 'shadow');
      const sourceInspection = inspectExecGraphDirectory(source);

      expect(() => verifyRollback(shadowRoot, sourceInspection)).toThrow(
        expect.objectContaining({ code: 'rollback_not_executed' }),
      );
    } finally {
      rmSync(workDir, { recursive: true, force: true });
    }
  });

  it('refuses a receipt built from a fabricated token', () => {
    const source = writeValidGraphFixture('source');
    const sourceInspection = inspectExecGraphDirectory(source);
    const parity = assertStrictParity(source, source, {
      directory: source,
      ledgerSha256: sourceInspection.ledgerSha256,
      snapshotSha256: sourceInspection.snapshotSha256,
      semanticSha256: sourceInspection.semanticSha256,
      eventCount: sourceInspection.eventCount,
      goalCount: sourceInspection.goalCount,
      taskCount: sourceInspection.taskCount,
    });

    const fabricated = { shadowRoot: source, verifiedAt: NOW } as unknown as Parameters<
      typeof writeRehearsalReceipt
    >[0];

    expect(() =>
      writeRehearsalReceipt(fabricated, {
        sourceDirectory: source,
        shadowRoot: source,
        source: sourceInspection,
        childReplay: parity.candidate,
        parity,
      }),
    ).toThrow(expect.objectContaining({ code: 'rollback_token_invalid' }));
  });

  it('refuses a receipt built from a spread copy of a genuine token', () => {
    const source = writeValidGraphFixture('source');
    const workDir = mkdtempSync(join(tmpdir(), 'atlas-shadow-work-'));
    try {
      const shadowRoot = copyExecGraphDirectoryAtomic(source, workDir, 'shadow');
      const sourceInspection = inspectExecGraphDirectory(source);
      rmSync(shadowRoot, { recursive: true, force: true });
      const genuineToken = verifyRollback(shadowRoot, sourceInspection);

      const spreadCopy = { ...genuineToken } as unknown as Parameters<
        typeof writeRehearsalReceipt
      >[0];
      const assignCopy = Object.assign({}, genuineToken) as unknown as Parameters<
        typeof writeRehearsalReceipt
      >[0];

      const parity = assertStrictParity(source, source, {
        directory: source,
        ledgerSha256: sourceInspection.ledgerSha256,
        snapshotSha256: sourceInspection.snapshotSha256,
        semanticSha256: sourceInspection.semanticSha256,
        eventCount: sourceInspection.eventCount,
        goalCount: sourceInspection.goalCount,
        taskCount: sourceInspection.taskCount,
      });
      const payload = {
        sourceDirectory: source,
        shadowRoot,
        source: sourceInspection,
        childReplay: parity.candidate,
        parity,
      };

      expect(() => writeRehearsalReceipt(spreadCopy, payload)).toThrow(
        expect.objectContaining({ code: 'rollback_token_invalid' }),
      );
      expect(() => writeRehearsalReceipt(assignCopy, payload)).toThrow(
        expect.objectContaining({ code: 'rollback_token_invalid' }),
      );

      // The genuine token, unmodified, still works.
      const receipt = writeRehearsalReceipt(genuineToken, payload);
      expect(receipt.rollbackVerified).toBe(true);
    } finally {
      rmSync(workDir, { recursive: true, force: true });
    }
  });

  // --- strict parity ------------------------------------------------------

  it('fails parity and never reaches a receipt when the candidate represents different state', () => {
    const source = writeValidGraphFixture('source');
    const candidate = writeValidGraphFixture('candidate', 'a different shadow task');
    const candidateInspection = inspectExecGraphDirectory(candidate);

    expect(() => assertStrictParity(source, candidate, candidateInspection)).toThrow(
      expect.objectContaining({ code: 'parity_mismatch' }),
    );
  });

  it('fails parity when the child replay output disagrees with the parent-side inspection', () => {
    const source = writeValidGraphFixture('source');
    const candidate = writeValidGraphFixture('candidate');
    const forgedChildReplay: ChildReplayResult = {
      directory: candidate,
      ledgerSha256: 'f'.repeat(64),
      snapshotSha256: 'f'.repeat(64),
      semanticSha256: 'f'.repeat(64),
      eventCount: 999,
      goalCount: 999,
      taskCount: 999,
    };

    expect(() => assertStrictParity(source, candidate, forgedChildReplay)).toThrow(
      expect.objectContaining({ code: 'parity_mismatch' }),
    );
  });

  // --- fail-closed on bad source input, existing M3A codes ------------------

  it('fails closed with the existing M3A directory_missing code and creates nothing', () => {
    const workDir = mkdtempSync(join(tmpdir(), 'atlas-shadow-work-'));
    try {
      expect(() =>
        runShadowRehearsal(join(sandboxDir, 'does-not-exist'), {
          workDirectory: workDir,
          shadowRootName: 'shadow',
        }),
      ).toThrow(expect.objectContaining({ code: 'directory_missing' }));
      expect(existsSync(join(workDir, 'shadow'))).toBe(false);
    } finally {
      rmSync(workDir, { recursive: true, force: true });
    }
  });

  it('fails closed with the existing M3A ledger_empty code and creates nothing', () => {
    const directory = join(sandboxDir, 'empty-source');
    mkdirSync(directory, { recursive: true });
    writeFileSync(join(directory, 'ledger.jsonl'), '', 'utf8');
    writeFileSync(join(directory, 'graph.json'), '{"goals":[],"tasks":[]}\n', 'utf8');
    const workDir = mkdtempSync(join(tmpdir(), 'atlas-shadow-work-'));
    try {
      expect(() =>
        runShadowRehearsal(directory, { workDirectory: workDir, shadowRootName: 'shadow' }),
      ).toThrow(expect.objectContaining({ code: 'ledger_empty' }));
      expect(existsSync(join(workDir, 'shadow'))).toBe(false);
    } finally {
      rmSync(workDir, { recursive: true, force: true });
    }
  });

  // --- cold replay failure modes, end to end through the orchestrator -------

  it(
    'fails the rehearsal and leaves no shadow root when the child process exits non-zero',
    () => {
      const source = writeValidGraphFixture('source');
      const workDir = mkdtempSync(join(tmpdir(), 'atlas-shadow-work-'));
      const faultScript = writeFaultScript(
        'nonzero-exit.ts',
        [
          "process.stdout.write(JSON.stringify({directory:'x',ledgerSha256:'a'.repeat(64),snapshotSha256:'a'.repeat(64),semanticSha256:'a'.repeat(64),eventCount:1,goalCount:1,taskCount:1}));",
          'process.exit(1);',
          '',
        ].join('\n'),
      );
      try {
        expect(() =>
          runShadowRehearsal(source, {
            workDirectory: workDir,
            shadowRootName: 'shadow',
            childScriptPath: faultScript,
          }),
        ).toThrow(expect.objectContaining({ code: 'replay_nonzero_exit' }));
        expect(existsSync(join(workDir, 'shadow'))).toBe(false);
      } finally {
        rmSync(workDir, { recursive: true, force: true });
      }
    },
    CHILD_TEST_TIMEOUT,
  );

  it(
    'fails the rehearsal and leaves no shadow root when the child process prints nothing',
    () => {
      const source = writeValidGraphFixture('source');
      const workDir = mkdtempSync(join(tmpdir(), 'atlas-shadow-work-'));
      const faultScript = writeFaultScript('empty-output.ts', 'process.exit(0);\n');
      try {
        expect(() =>
          runShadowRehearsal(source, {
            workDirectory: workDir,
            shadowRootName: 'shadow',
            childScriptPath: faultScript,
          }),
        ).toThrow(expect.objectContaining({ code: 'replay_empty_output' }));
        expect(existsSync(join(workDir, 'shadow'))).toBe(false);
      } finally {
        rmSync(workDir, { recursive: true, force: true });
      }
    },
    CHILD_TEST_TIMEOUT,
  );

  it(
    'fails the rehearsal and leaves no shadow root when the child process prints unparseable output',
    () => {
      const source = writeValidGraphFixture('source');
      const workDir = mkdtempSync(join(tmpdir(), 'atlas-shadow-work-'));
      const faultScript = writeFaultScript(
        'unparseable-output.ts',
        "process.stdout.write('not-json-at-all');\n",
      );
      try {
        expect(() =>
          runShadowRehearsal(source, {
            workDirectory: workDir,
            shadowRootName: 'shadow',
            childScriptPath: faultScript,
          }),
        ).toThrow(expect.objectContaining({ code: 'replay_unparseable_output' }));
        expect(existsSync(join(workDir, 'shadow'))).toBe(false);
      } finally {
        rmSync(workDir, { recursive: true, force: true });
      }
    },
    CHILD_TEST_TIMEOUT,
  );

  it(
    'fails the rehearsal and leaves no shadow root when the child process times out',
    () => {
      const source = writeValidGraphFixture('source');
      const workDir = mkdtempSync(join(tmpdir(), 'atlas-shadow-work-'));
      const faultScript = writeFaultScript('timeout.ts', 'setInterval(() => {}, 1000);\n');
      try {
        expect(() =>
          runShadowRehearsal(source, {
            workDirectory: workDir,
            shadowRootName: 'shadow',
            childScriptPath: faultScript,
            childTimeoutMs: 500,
          }),
        ).toThrow(expect.objectContaining({ code: 'replay_timeout' }));
        expect(existsSync(join(workDir, 'shadow'))).toBe(false);
      } finally {
        rmSync(workDir, { recursive: true, force: true });
      }
    },
    CHILD_TEST_TIMEOUT,
  );

  it(
    'fails cold replay when the child process crashes inspecting a broken shadow root',
    () => {
      const brokenDirectory = join(sandboxDir, 'broken-shadow');
      mkdirSync(brokenDirectory, { recursive: true });
      // No ledger.jsonl / graph.json at all: inspectExecGraphDirectory inside
      // the child throws directory-content errors and the child exits 1.
      expect(() => coldReplayExecGraphDirectory(brokenDirectory)).toThrow(
        expect.objectContaining({ code: 'replay_nonzero_exit' }),
      );
    },
    CHILD_TEST_TIMEOUT,
  );
});
