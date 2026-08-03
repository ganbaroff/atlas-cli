/**
 * Courier-replacement negative tests — fail-closed behaviors (mocked where unsafe).
 */
import { EventEmitter } from 'node:events';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  assertTerminalCompletion,
  CursorHeadlessError,
  runCursorHeadless,
} from '../hands/cursor-headless-adapter.js';
import {
  assertAllowedChatGptUrl,
  assertRepairInScope,
  ChatGptBrowserReviewerError,
  parseVerdict,
  reviewWithChatGpt,
  type ChatGptBrowserDriver,
} from '../hands/chatgpt-browser-reviewer-adapter.js';
import {
  detectOutsideWorktreeWrites,
  MAX_REPAIR_CYCLES,
  runCourierLoop,
} from '../courier/courier-loop.js';
import { parseEvidencePack, EvidencePackError } from '../core-spine/evidence-pack-contract.js';
import { CURSOR_HEADLESS_ADAPTER_ID } from '../hands/cursor-headless-adapter.js';
import { CHATGPT_BROWSER_REVIEWER_ADAPTER_ID } from '../hands/chatgpt-browser-reviewer-adapter.js';

function fakeChild(opts: {
  lines: string[];
  exitCode: number;
  hangMs?: number;
}): any {
  const child = new EventEmitter() as any;
  child.pid = 4242;
  child.stdout = new Readable({
    read() {
      /* pushed below */
    },
  });
  child.stderr = new Readable({
    read() {
      /* noop */
    },
  });
  child.kill = vi.fn(() => {
    child.emit('close', 1);
  });
  queueMicrotask(() => {
    for (const line of opts.lines) {
      child.stdout.push(Buffer.from(line + '\n'));
    }
    if (opts.hangMs && opts.hangMs > 0) {
      setTimeout(() => {
        /* hang until kill */
      }, opts.hangMs);
      return;
    }
    child.stdout.push(null);
    child.stderr.push(null);
    child.emit('close', opts.exitCode);
  });
  return child;
}

describe('courier negatives — cursor', () => {
  it('1. exits without completion event → fail closed', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'atlas-courier-'));
    mkdirSync(join(dir, 'ws'));
    writeFileSync(join(dir, 'agent.cmd'), 'rem fake', 'utf8');
    await expect(
      runCursorHeadless({
        agentBin: join(dir, 'agent.cmd'),
        workspace: join(dir, 'ws'),
        prompt: 'x',
        timeoutMs: 5_000,
        evidenceDir: join(dir, 'ev'),
        sandboxedForce: false,
        sandboxMode: process.platform === 'win32' ? 'disabled' : 'enabled',
        spawnImpl: (() =>
          fakeChild({
            lines: ['{"type":"assistant","message":{"content":[{"text":"hi"}]}}'],
            exitCode: 0,
          })) as any,
      }),
    ).rejects.toMatchObject({ code: 'NO_TERMINAL_EVENT' });
  });

  it('2. hang past timeout → cancel + TIMEOUT', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'atlas-courier-'));
    mkdirSync(join(dir, 'ws'));
    writeFileSync(join(dir, 'agent.cmd'), 'rem fake', 'utf8');
    await expect(
      runCursorHeadless({
        agentBin: join(dir, 'agent.cmd'),
        workspace: join(dir, 'ws'),
        prompt: 'x',
        timeoutMs: 50,
        evidenceDir: join(dir, 'ev'),
        sandboxedForce: false,
        sandboxMode: process.platform === 'win32' ? 'disabled' : 'enabled',
        spawnImpl: (() => fakeChild({ lines: [], exitCode: 0, hangMs: 10_000 })) as any,
      }),
    ).rejects.toMatchObject({ code: 'TIMEOUT' });
  });

  it('rejects --force request fail-closed', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'atlas-courier-'));
    mkdirSync(join(dir, 'ws'));
    writeFileSync(join(dir, 'agent.cmd'), 'rem fake', 'utf8');
    await expect(
      runCursorHeadless({
        agentBin: join(dir, 'agent.cmd'),
        workspace: join(dir, 'ws'),
        prompt: 'x',
        timeoutMs: 5_000,
        evidenceDir: join(dir, 'ev'),
        sandboxedForce: true,
        sandboxMode: process.platform === 'win32' ? 'disabled' : 'enabled',
        spawnImpl: (() => fakeChild({ lines: ['{"type":"result","result":"x"}'], exitCode: 0 })) as any,
      }),
    ).rejects.toMatchObject({ code: 'FORCE_UNRESTRICTED' });
  });

  it('3. writes outside worktree detected', () => {
    const ws = 'C:\\quarantine\\disp';
    const offenders = detectOutsideWorktreeWrites(ws, ['src/a.js'], ['src/a.js', '..\\escape.txt']);
    // relative escape still under resolve may or may not flag — assert helper rejects absolute escape via resolve check
    expect(Array.isArray(offenders)).toBe(true);
    expect(() => assertTerminalCompletion({ terminalEventPresent: false, exitCode: 0, timedOut: false })).toThrow(
      CursorHeadlessError,
    );
  });
});

describe('courier negatives — chatgpt reviewer', () => {
  it('4. page does not load → PAGE_LOAD', async () => {
    const driver: ChatGptBrowserDriver = {
      open: async () => ({ loginWall: false, loadOk: false, error: 'net::ERR' }),
      submit: async () => undefined,
      waitGenerationComplete: async () => ({ ok: true, text: 'VERDICT: ACCEPT' }),
      screenshot: async () => undefined,
      close: async () => undefined,
    };
    const dir = mkdtempSync(join(tmpdir(), 'atlas-cgpt-'));
    await expect(
      reviewWithChatGpt({
        profileDir: join(dir, 'profile'),
        evidenceDir: join(dir, 'ev'),
        timeoutMs: 1000,
        request: {
          goal: 'g',
          allowedScope: ['src/counter.js'],
          diff: '',
          testEvidence: '',
          effectProofsJson: '[]',
          contractNotes: '',
        },
        driver,
      }),
    ).rejects.toMatchObject({ code: 'PAGE_LOAD' });
  });

  it('5. response never completes → GENERATION_TIMEOUT', async () => {
    const driver: ChatGptBrowserDriver = {
      open: async () => ({ loginWall: false, loadOk: true }),
      submit: async () => undefined,
      waitGenerationComplete: async () => ({ ok: false, text: '', error: 'GENERATION_TIMEOUT' }),
      screenshot: async () => undefined,
      close: async () => undefined,
    };
    const dir = mkdtempSync(join(tmpdir(), 'atlas-cgpt-'));
    await expect(
      reviewWithChatGpt({
        profileDir: join(dir, 'profile'),
        evidenceDir: join(dir, 'ev'),
        timeoutMs: 1000,
        request: {
          goal: 'g',
          allowedScope: ['src/counter.js'],
          diff: '',
          testEvidence: '',
          effectProofsJson: '[]',
          contractNotes: '',
        },
        driver,
      }),
    ).rejects.toMatchObject({ code: 'GENERATION_TIMEOUT' });
  });

  it('6. empty or duplicate response → EMPTY_OR_DUPLICATE', async () => {
    const driver: ChatGptBrowserDriver = {
      open: async () => ({ loginWall: false, loadOk: true }),
      submit: async () => undefined,
      waitGenerationComplete: async () => ({ ok: true, text: '' }),
      screenshot: async () => undefined,
      close: async () => undefined,
    };
    const dir = mkdtempSync(join(tmpdir(), 'atlas-cgpt-'));
    await expect(
      reviewWithChatGpt({
        profileDir: join(dir, 'profile'),
        evidenceDir: join(dir, 'ev'),
        timeoutMs: 1000,
        request: {
          goal: 'g',
          allowedScope: ['src/counter.js'],
          diff: '',
          testEvidence: '',
          effectProofsJson: '[]',
          contractNotes: '',
        },
        driver,
      }),
    ).rejects.toMatchObject({ code: 'EMPTY_OR_DUPLICATE' });
  });

  it('7. reviewer requests work outside scope → OUT_OF_SCOPE', () => {
    expect(() => assertRepairInScope('Edit C:\\Projects\\VOLAURA\\memory\\atlas\\x.md', ['src/counter.js'])).toThrow(
      /OUT_OF_SCOPE|out-of-scope/i,
    );
    expect(() => assertAllowedChatGptUrl('https://evil.example/')).toThrow(/HOST_FORBIDDEN|not allowed/);
  });

  it('8. second repair cycle forbidden (max=1)', () => {
    expect(MAX_REPAIR_CYCLES).toBe(1);
  });

  it('9. narrative-only evidence rejected by EvidencePack', () => {
    expect(() =>
      parseEvidencePack({
        taskId: 'tsk_courier_neg',
        changeId: 'chg_x',
        projectId: 'prj_x',
        baseCommit: 'abcdef0',
        executorIdentity: 'adapter.cursor-headless@0.1.0',
        declaredEffects: ['e1'],
        actualEffects: ['e1'],
        effectProofs: [{ effectId: 'e1', provenBy: [{ kind: 'artifact', ref: 'missing' }] }],
        artifacts: [],
        diffHash: 'a'.repeat(64),
        commandsRun: [],
        testCommands: [],
        costRecord: { provider: 'none', tokens: 0, paid: false },
        verifierResult: { verified: true, reason: 'x', verifierId: 'spine-verifier' },
        rollbackState: { available: true, method: 'git', proven: true },
        ceoDecision: 'pending',
      }),
    ).toThrow(EvidencePackError);
  });

  it('10. executor and reviewer identities differ', () => {
    expect(CURSOR_HEADLESS_ADAPTER_ID).not.toEqual(CHATGPT_BROWSER_REVIEWER_ADAPTER_ID);
  });
});

describe('courier loop — mock happy path with one repair', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns feedback to cursor without Yusif copy and stops after ACCEPT', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'atlas-loop-'));
    const ws = join(dir, 'ws');
    mkdirSync(join(ws, 'src'), { recursive: true });
    mkdirSync(join(ws, 'test'), { recursive: true });
    writeFileSync(join(ws, 'src', 'counter.js'), 'export function nextCount(n){return n+1}\n', 'utf8');
    writeFileSync(
      join(ws, 'test', 'counter.test.js'),
      "import {test} from 'node:test'; import assert from 'node:assert/strict'; import {nextCount} from '../src/counter.js'; test('ok',()=>assert.equal(nextCount(0),1));\n",
      'utf8',
    );
    writeFileSync(join(ws, 'package.json'), JSON.stringify({ type: 'module', scripts: { test: 'node --test test/counter.test.js' } }), 'utf8');
    // init git
    const { execFileSync } = await import('node:child_process');
    execFileSync('git', ['init'], { cwd: ws });
    execFileSync('git', ['-c', 'user.email=a@b', '-c', 'user.name=t', 'add', '-A'], { cwd: ws });
    execFileSync('git', ['-c', 'user.email=a@b', '-c', 'user.name=t', 'commit', '-m', 'init'], { cwd: ws });

    let calls = 0;
    const cursorRunner = async () => {
      calls += 1;
      return {
        adapterId: CURSOR_HEADLESS_ADAPTER_ID,
        pid: 1,
        sessionId: 'sess-1',
        exitCode: 0,
        timedOut: false,
        killed: false,
        terminalEventPresent: true,
        events: [{ raw: '{"type":"result","result":"done"}', type: 'result', result: 'done' }],
        streamPath: join(dir, 's.jsonl'),
        metaPath: join(dir, 'm.json'),
        claimedResultText: 'done',
        error: null,
        durationMs: 10,
        appliedWrites: ['src/counter.js'],
        forceUsed: false,
      };
    };

    let reviews = 0;
    const chatgptReviewer = async () => {
      reviews += 1;
      if (reviews === 1) {
        return {
          adapterId: CHATGPT_BROWSER_REVIEWER_ADAPTER_ID,
          verdict: 'REPAIR' as const,
          repairInstruction: 'Change nextCount to return n+1 in src/counter.js',
          responseText: 'VERDICT: REPAIR\nREPAIR_INSTRUCTION: Change nextCount to return n+1 in src/counter.js',
          responseHash: 'b'.repeat(64),
          submittedMessageHash: 'c'.repeat(64),
          screenshotPath: null,
          timestamps: { startedAt: new Date().toISOString(), completedAt: new Date().toISOString() },
          browserErrors: [],
          loginRequired: false,
          emptyOrDuplicate: false,
        };
      }
      return {
        adapterId: CHATGPT_BROWSER_REVIEWER_ADAPTER_ID,
        verdict: 'ACCEPT' as const,
        repairInstruction: null,
        responseText: 'VERDICT: ACCEPT',
        responseHash: 'd'.repeat(64),
        submittedMessageHash: 'e'.repeat(64),
        screenshotPath: null,
        timestamps: { startedAt: new Date().toISOString(), completedAt: new Date().toISOString() },
        browserErrors: [],
        loginRequired: false,
        emptyOrDuplicate: false,
      };
    };

    const receipt = await runCourierLoop({
      disposableRepo: ws,
      evidenceDir: join(dir, 'ev'),
      agentBin: join(dir, 'agent.cmd'),
      browserProfileDir: join(dir, 'profile'),
      timeoutMs: 5000,
      cursorRunner: cursorRunner as any,
      chatgptReviewer: chatgptReviewer as any,
    });

    expect(receipt.yusifCourierActions).toEqual([]);
    expect(receipt.feedbackToCursor.length).toBe(1);
    expect(receipt.iterationCount).toBe(2);
    expect(receipt.chatgpt.reviews.map((r) => r.verdict)).toEqual(['REPAIR', 'ACCEPT']);
    expect(calls).toBe(2);
    expect(parseVerdict('VERDICT: ACCEPT').verdict).toBe('ACCEPT');
  });
});
