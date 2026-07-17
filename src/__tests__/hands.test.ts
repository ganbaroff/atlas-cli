import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';

import {
  handSpecSchema,
  getHand,
  listHands,
  validateRegistry,
  HandNotFoundError,
} from '../hands/registry.js';
import { classifyRisk, needsRefuter } from '../hands/risk.js';
import { runRefuter } from '../hands/refuter.js';
import { verify } from '../hands/verifier.js';
import type { Receipt } from '../hands/contract.js';
import {
  assertHandAllowedInContext,
  assignHand,
  submitReceipt,
  verifyAndTransition,
  abortHandTask,
  HandContextError,
  HandAdapterError,
} from '../hands/exec-graph-adapter.js';
import { createGoal, createTask, moveTask, getTask, listTasks, statusSummary } from '../exec-graph/api.js';
import { formatStatusMessage } from '../exec-graph/brief.js';

const NOW = '2026-07-18T00:00:00.000Z';
const HANDS_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '../hands');

describe('Hand Contract V0 (isolated temp exec-graph dir per test)', () => {
  let dir: string;
  let prior: string | undefined;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'atlas-hands-'));
    prior = process.env.ATLAS_EXEC_GRAPH_DIR;
    process.env.ATLAS_EXEC_GRAPH_DIR = dir;
  });

  afterEach(() => {
    if (prior === undefined) delete process.env.ATLAS_EXEC_GRAPH_DIR;
    else process.env.ATLAS_EXEC_GRAPH_DIR = prior;
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  });

  /** Creates a goal + task and walks it to 'planned' — the only status assignHand() can move -> 'delegated' from. */
  function planTask(title: string): string {
    const goal = createGoal({ title: `goal for ${title}`, actor: 'atlas', ts: NOW });
    // Explicit idempotencyKey per title — createTask's default derives from
    // source (always 'exec-graph:cli' here), which would dedupe every
    // planTask() call in a test onto the SAME task.
    const { task } = createTask({ goalId: goal.id, title, actor: 'atlas', ts: NOW, idempotencyKey: `exec-graph:${title}` });
    moveTask({ taskId: task.id, to: 'accepted', actor: 'atlas', ts: NOW });
    moveTask({ taskId: task.id, to: 'planned', actor: 'atlas', ts: NOW });
    return task.id;
  }

  // ── 1. malformed registry entry rejected (schema) ───────────────────────
  it('1. a malformed HandSpec entry is rejected by handSpecSchema / validateRegistry', () => {
    const bad = { handId: 'incomplete-hand', purpose: 'missing everything else' };
    expect(() => handSpecSchema.parse(bad)).toThrow();
    expect(() => validateRegistry([bad])).toThrow();
    // The real REGISTRY itself must still validate cleanly.
    expect(() => validateRegistry()).not.toThrow();
  });

  // ── 2. unknown hand rejected (getHand) ───────────────────────────────────
  it('2. getHand throws HandNotFoundError for an unknown or unsafe hand id', () => {
    expect(() => getHand('does-not-exist')).toThrow(HandNotFoundError);
    expect(() => getHand('__proto__')).toThrow(HandNotFoundError);
    expect(() => getHand('toString')).toThrow(HandNotFoundError);
    expect(getHand('sonnet-foreground').handId).toBe('sonnet-foreground');
    expect(listHands().map((h) => h.handId).sort()).toEqual(['local-readonly', 'sonnet-foreground']);
  });

  // ── 3. sonnet-foreground denied when unattended:true ─────────────────────
  it('3. assertHandAllowedInContext denies a foreground-only hand when unattended', () => {
    const hand = getHand('sonnet-foreground');
    expect(() => assertHandAllowedInContext(hand, { unattended: true })).toThrow(HandContextError);
    expect(() => assertHandAllowedInContext(hand, { unattended: false })).not.toThrow();

    // local-readonly is read-only-unattended — unattended is fine for it.
    const readonlyHand = getHand('local-readonly');
    expect(() => assertHandAllowedInContext(readonlyHand, { unattended: true })).not.toThrow();
  });

  // ── 4. action outside allowlist denied ───────────────────────────────────
  it('4. assertHandAllowedInContext denies an action outside the hand allowlist', () => {
    const hand = getHand('local-readonly');
    expect(() => assertHandAllowedInContext(hand, { actions: ['write'] })).toThrow(HandContextError);
    expect(() => assertHandAllowedInContext(hand, { actions: ['read-file', 'grep'] })).not.toThrow();
  });

  // ── 5. one task cannot have two active delegated hands ───────────────────
  it('5. assignHand rejects a second delegation while one is already active', () => {
    const taskId = planTask('two-hands-task');
    const first = assignHand(taskId, 'sonnet-foreground', { actor: 'atlas' });
    expect(first.owner).toBe('hand:sonnet-foreground');
    expect(first.status).toBe('delegated');

    expect(() => assignHand(taskId, 'local-readonly', { actor: 'atlas' })).toThrow(HandContextError);
    // Unchanged after the rejected attempt.
    expect(getTask(taskId)?.owner).toBe('hand:sonnet-foreground');
  });

  // ── 6. structural — only exec-graph-adapter.ts writes exec-graph state ───
  describe('6. structural — only exec-graph-adapter.ts touches exec-graph state', () => {
    const handRoleFiles = ['registry.ts', 'contract.ts', 'risk.ts', 'verifier.ts', 'refuter.ts'];

    for (const file of handRoleFiles) {
      it(`${file} does not import exec-graph/api.js or call moveTask/addEvidence/reassignOwner`, () => {
        const src = readFileSync(resolve(HANDS_DIR, file), 'utf8');
        expect(src).not.toMatch(/exec-graph\/api\.js/);
        expect(src).not.toMatch(/\bmoveTask\s*\(/);
        expect(src).not.toMatch(/\baddEvidence\s*\(/);
        expect(src).not.toMatch(/\breassignOwner\s*\(/);
      });
    }

    it('exec-graph-adapter.ts is the only Hand-layer file importing exec-graph/api.js', () => {
      const src = readFileSync(resolve(HANDS_DIR, 'exec-graph-adapter.ts'), 'utf8');
      expect(src).toMatch(/exec-graph\/api\.js/);
    });

    it("only verifyAndTransition's function body cites to:'verified'/'rejected' moveTask targets", () => {
      const src = readFileSync(resolve(HANDS_DIR, 'exec-graph-adapter.ts'), 'utf8');
      const fnStart = src.indexOf('export function verifyAndTransition');
      expect(fnStart).toBeGreaterThan(-1);
      const before = src.slice(0, fnStart);
      expect(before).not.toMatch(/to:\s*'verified'/);
      expect(before).not.toMatch(/to:\s*'rejected'/);
    });
  });

  // ── 7. valid receipt -> verified ──────────────────────────────────────────
  it('7. a valid file-exists receipt verifies and transitions the task to verified', () => {
    const taskId = planTask('valid-receipt-task');
    assignHand(taskId, 'local-readonly', { actor: 'atlas' });

    const filePath = join(dir, 'proof.txt');
    writeFileSync(filePath, 'proof');
    submitReceipt(taskId, {
      taskId,
      handId: 'local-readonly',
      submittedBy: 'local-readonly',
      kind: 'file-exists',
      ref: filePath,
      claimedResult: 'the proof file exists',
    });

    const result = verifyAndTransition(taskId, { actor: 'atlas' });
    expect(result.verdict.verified).toBe(true);
    expect(result.finalStatus).toBe('verified');
    expect(getTask(taskId)?.status).toBe('verified');
  });

  it('7b. a valid command-output-match receipt (allowlisted `ls`) verifies', () => {
    const taskId = planTask('valid-command-receipt-task');
    assignHand(taskId, 'local-readonly', { actor: 'atlas' });

    writeFileSync(join(dir, 'ls-proof.txt'), 'x');
    submitReceipt(taskId, {
      taskId,
      handId: 'local-readonly',
      submittedBy: 'local-readonly',
      kind: 'command-output-match',
      command: `ls ${dir}`,
      expectedSubstring: 'ls-proof.txt',
      claimedResult: 'ls shows the proof file',
    });

    const result = verifyAndTransition(taskId, { actor: 'atlas' });
    expect(result.verdict.verified).toBe(true);
    expect(result.finalStatus).toBe('verified');
  });

  // ── 8. narrative / mismatched / stale-ref all rejected ────────────────────
  it('8. narrative-only, mismatched file-contains, and stale/wrong-ref receipts are all rejected', () => {
    const t1 = planTask('narrative-task');
    assignHand(t1, 'local-readonly', { actor: 'atlas' });
    submitReceipt(t1, {
      taskId: t1,
      handId: 'local-readonly',
      submittedBy: 'local-readonly',
      kind: 'narrative',
      claimedResult: 'i did it, trust me',
    });
    const r1 = verifyAndTransition(t1, { actor: 'atlas' });
    expect(r1.verdict.verified).toBe(false);
    expect(r1.finalStatus).toBe('rejected');

    const t2 = planTask('mismatched-task');
    assignHand(t2, 'local-readonly', { actor: 'atlas' });
    const filePath = join(dir, 'content.txt');
    writeFileSync(filePath, 'actual content');
    submitReceipt(t2, {
      taskId: t2,
      handId: 'local-readonly',
      submittedBy: 'local-readonly',
      kind: 'file-contains',
      ref: filePath,
      expectedSubstring: 'this substring is not present',
      claimedResult: 'contains it',
    });
    const r2 = verifyAndTransition(t2, { actor: 'atlas' });
    expect(r2.verdict.verified).toBe(false);
    expect(r2.finalStatus).toBe('rejected');

    const t3 = planTask('stale-ref-task');
    assignHand(t3, 'local-readonly', { actor: 'atlas' });
    submitReceipt(t3, {
      taskId: t3,
      handId: 'local-readonly',
      submittedBy: 'local-readonly',
      kind: 'file-exists',
      ref: join(dir, 'does-not-exist.txt'),
      claimedResult: 'exists',
    });
    const r3 = verifyAndTransition(t3, { actor: 'atlas' });
    expect(r3.verdict.verified).toBe(false);
    expect(r3.finalStatus).toBe('rejected');
  });

  // ── 9. rejected task cannot reach closed without new evidence ─────────────
  it('9. a rejected task cannot be re-verified/closed by the hand adapter without new evidence', () => {
    const taskId = planTask('rejected-then-illegal-task');
    assignHand(taskId, 'local-readonly', { actor: 'atlas' });
    submitReceipt(taskId, {
      taskId,
      handId: 'local-readonly',
      submittedBy: 'local-readonly',
      kind: 'narrative',
      claimedResult: 'trust me',
    });
    verifyAndTransition(taskId, { actor: 'atlas' });
    expect(getTask(taskId)?.status).toBe('rejected');

    // Re-running verifyAndTransition with no new evidence must throw, never silently resolve.
    expect(() => verifyAndTransition(taskId, { actor: 'atlas' })).toThrow(HandAdapterError);
    expect(getTask(taskId)?.status).toBe('rejected');

    // Attempting to submit again without cycling back through delegated/in-progress hits
    // the underlying exec-graph illegal-transition guard (rejected -> evidence-submitted is not a legal edge).
    expect(() =>
      submitReceipt(taskId, {
        taskId,
        handId: 'local-readonly',
        submittedBy: 'local-readonly',
        kind: 'narrative',
        claimedResult: 'trust me again',
      }),
    ).toThrow();
  });

  // ── 10. refuter triggers for security/production/data-mutation/high-blast-radius ──
  describe('10. runRefuter triggers for every non-low riskClass', () => {
    const riskClasses = ['security', 'production', 'data-mutation', 'high-blast-radius'] as const;
    const receipt: Receipt = {
      taskId: 'tsk_test0000000000000001',
      handId: 'local-readonly',
      submittedBy: 'local-readonly',
      kind: 'narrative',
      claimedResult: 'x',
    };

    for (const riskClass of riskClasses) {
      it(`triggers for riskClass=${riskClass}`, () => {
        expect(needsRefuter(riskClass)).toBe(true);
        const result = runRefuter({ riskClass }, receipt, false);
        expect(result.triggered).toBe(true);
      });
    }
  });

  // ── 11. refuter suppressed for low-risk ────────────────────────────────────
  it('11. runRefuter is suppressed for riskClass=low', () => {
    const receipt: Receipt = {
      taskId: 'tsk_test0000000000000001',
      handId: 'local-readonly',
      submittedBy: 'local-readonly',
      kind: 'narrative',
      claimedResult: 'x',
    };
    expect(needsRefuter('low')).toBe(false);
    const result = runRefuter({ riskClass: 'low' }, receipt, false);
    expect(result.triggered).toBe(false);
    expect(result.passed).toBe(true);
  });

  // ── 12. timeout/abort -> blocked, never silent verified ────────────────────
  it('12. abortHandTask moves a delegated task to blocked, never verified', () => {
    const taskId = planTask('abort-task');
    assignHand(taskId, 'sonnet-foreground', { actor: 'atlas' });
    const aborted = abortHandTask(taskId, { actor: 'atlas', reason: 'simulated timeout' });
    expect(aborted.status).toBe('blocked');
    expect(getTask(taskId)?.status).toBe('blocked');
    expect(aborted.status).not.toBe('verified');

    // abortHandTask on a task that isn't delegated/in-progress is refused, not silently accepted.
    expect(() => abortHandTask(taskId, { actor: 'atlas', reason: 'again' })).toThrow(HandAdapterError);
  });

  // ── 13. duplicate receipt submission idempotent ─────────────────────────────
  it('13. submitReceipt is idempotent by receiptHash — duplicate submission, one evidence entry', () => {
    const taskId = planTask('idempotent-task');
    assignHand(taskId, 'local-readonly', { actor: 'atlas' });
    const receiptInput = {
      taskId,
      handId: 'local-readonly',
      submittedBy: 'local-readonly',
      kind: 'narrative' as const,
      claimedResult: 'done',
    };

    const first = submitReceipt(taskId, receiptInput);
    const countAfterFirst = first.evidence.filter((e) => e.kind === 'tool-receipt').length;
    expect(countAfterFirst).toBe(1);
    expect(first.status).toBe('evidence-submitted');

    const second = submitReceipt(taskId, receiptInput);
    const countAfterSecond = second.evidence.filter((e) => e.kind === 'tool-receipt').length;
    expect(countAfterSecond).toBe(1);
    expect(second.status).toBe('evidence-submitted');
  });

  // ── 14. secret path in receipt ref -> rejected 'protected path' ────────────
  it("14. a secret-looking ref is rejected as a 'protected path' (content is never read)", () => {
    const taskId = planTask('secret-ref-task');
    assignHand(taskId, 'local-readonly', { actor: 'atlas' });

    const secretPath = join(dir, '.env');
    // The secret file DOES contain the expected substring — if the guard didn't fire before
    // the read, this would verify TRUE. It must still come back false, proving the guard ran first.
    writeFileSync(secretPath, 'API_KEY=super-secret-value');
    submitReceipt(taskId, {
      taskId,
      handId: 'local-readonly',
      submittedBy: 'local-readonly',
      kind: 'file-contains',
      ref: secretPath,
      expectedSubstring: 'API_KEY',
      claimedResult: 'contains the key',
    });

    const result = verifyAndTransition(taskId, { actor: 'atlas' });
    expect(result.verdict.verified).toBe(false);
    expect(result.verdict.reason).toMatch(/protected path/);
    expect(result.finalStatus).toBe('rejected');

    // Direct unit check at the verifier level too.
    expect(
      verify({
        taskId: 'tsk_test0000000000000001',
        handId: 'local-readonly',
        submittedBy: 'local-readonly',
        kind: 'file-exists',
        ref: join(dir, 'id_rsa'),
        claimedResult: 'x',
      }).reason,
    ).toMatch(/protected path/);
  });

  // ── 15. /status reflects exact graph state for delegated+verified and rejected ──
  it('15. formatStatusMessage reflects hand owner + receipt state + verdict for verified and rejected tasks', () => {
    const t1 = planTask('status-verified-task');
    assignHand(t1, 'local-readonly', { actor: 'atlas' });
    const filePath = join(dir, 'status-proof.txt');
    writeFileSync(filePath, 'ok');
    submitReceipt(t1, {
      taskId: t1,
      handId: 'local-readonly',
      submittedBy: 'local-readonly',
      kind: 'file-exists',
      ref: filePath,
      claimedResult: 'exists',
    });
    verifyAndTransition(t1, { actor: 'atlas' });

    const t2 = planTask('status-rejected-task');
    assignHand(t2, 'sonnet-foreground', { actor: 'atlas' });
    submitReceipt(t2, {
      taskId: t2,
      handId: 'sonnet-foreground',
      submittedBy: 'sonnet-foreground',
      kind: 'narrative',
      claimedResult: 'trust me',
    });
    verifyAndTransition(t2, { actor: 'atlas' });

    expect(getTask(t1)?.status).toBe('verified');
    expect(getTask(t2)?.status).toBe('rejected');

    const summary = statusSummary();
    const tasks = listTasks();
    const message = formatStatusMessage(summary, tasks);

    expect(message).toContain(t1);
    expect(message).toContain('hand=local-readonly');
    expect(message).toContain('[verified]');
    expect(message).toContain('receipt=file-exists');

    expect(message).toContain(t2);
    expect(message).toContain('hand=sonnet-foreground');
    expect(message).toContain('[rejected]');
    expect(message).toContain('receipt=narrative');
  });
});

// ─── risk.ts — pure classifier, no exec-graph dir needed ────────────────────

describe('classifyRisk — deterministic keyword rules', () => {
  it('matches data-mutation before security/production when multiple keywords are present', () => {
    expect(classifyRisk({ objective: 'deploy write mutation to prod', allowedActions: [] })).toBe('data-mutation');
  });
  it('matches security', () => {
    expect(classifyRisk({ objective: 'rotate the credential', allowedActions: [] })).toBe('security');
  });
  it('matches production', () => {
    expect(classifyRisk({ objective: 'check the live cloud status', allowedActions: [] })).toBe('production');
  });
  it('defaults to low', () => {
    expect(classifyRisk({ objective: 'read a file and summarize it', allowedActions: ['read-file'] })).toBe('low');
  });
});
