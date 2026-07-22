import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import * as childProcess from 'node:child_process';

// node:child_process's execFileSync is a non-configurable builtin export —
// vi.spyOn() can't redefine it directly. Wrap it via vi.mock() (module-level,
// hoisted) instead: the real implementation still runs for every existing
// test that needs a genuine command executed (e.g. test 7b's `ls`), but the
// call becomes observable/assertable for test 17a's "never called" proof.
vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return { ...actual, execFileSync: vi.fn(actual.execFileSync) };
});

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
import { receiptSchema, type Receipt } from '../hands/contract.js';
import {
  assertHandAllowedInContext,
  assignHand,
  submitReceipt,
  verifyAndTransition,
  abortHandTask,
  HandContextError,
  HandAdapterError,
  ReceiptSecretError,
  ReceiptTaskMismatchError,
} from '../hands/exec-graph-adapter.js';
import {
  createGoal,
  createTask,
  importTask,
  moveTask,
  reassignOwner,
  getTask,
  listTasks,
  statusSummary,
  HandAuthorityError,
} from '../exec-graph/api.js';
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
    expect(listHands().map((h) => h.handId).sort()).toEqual(['browser-foreground', 'local-readonly', 'sonnet-foreground', 'swarm-local']);
  });

  // ── 2b. swarm-local hand: foreground-only, no write/mutation action ──────
  it('2b. swarm-local is registered as foreground-only with no write/mutation allowedAction', () => {
    const hand = getHand('swarm-local');
    expect(hand.handId).toBe('swarm-local');
    expect(hand.autonomy).toBe('foreground-only');
    const WRITE_MUTATION_RE = /write|mutat|delete|deploy|migrat/i;
    for (const action of hand.allowedActions) {
      expect(action).not.toMatch(WRITE_MUTATION_RE);
    }
    // Consistent with risk.ts: a swarm-local delegation must never auto-classify as data-mutation
    // purely from its own allowedActions (the objective text is a separate concern).
    expect(classifyRisk({ objective: 'run swarm analysis', allowedActions: hand.allowedActions })).not.toBe('data-mutation');
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

  it('7b. a valid command-output-match receipt (cross-platform `git ls-files`) verifies', () => {
    const taskId = planTask('valid-command-receipt-task');
    assignHand(taskId, 'local-readonly', { actor: 'atlas' });

    // git ls-files is a real cross-platform executable (not a shell builtin),
    // works identically on Unix and Windows. We use a tracked file from the repo.
    submitReceipt(taskId, {
      taskId,
      handId: 'local-readonly',
      submittedBy: 'local-readonly',
      kind: 'command-output-match',
      command: 'git ls-files package.json',
      expectedSubstring: 'package.json',
      claimedResult: 'git ls-files shows tracked file',
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

  // ── 16. HOLE 1 — generic exec-graph callers cannot bypass Hand authority ──
  describe('16. HandAuthorityError — adversarial-review Hole 1 regression', () => {
    it('16a. generic moveTask(...,"verified") on a hand-owned task throws HandAuthorityError; the same call with _viaVerifier:true succeeds', () => {
      const taskId = planTask('hole1a-fake-verify-task');
      assignHand(taskId, 'local-readonly', { actor: 'atlas' });
      moveTask({ taskId, to: 'in-progress', actor: 'atlas' });
      moveTask({ taskId, to: 'evidence-submitted', actor: 'atlas', evidenceRefs: ['fake-ref'] });
      expect(getTask(taskId)?.owner).toBe('hand:local-readonly');

      // The fake-verify bypass: a generic caller tries to skip verifyAndTransition entirely.
      expect(() => moveTask({ taskId, to: 'verified', actor: 'atlas', evidenceRefs: ['fake-ref'] }))
        .toThrow(HandAuthorityError);
      expect(getTask(taskId)?.status).toBe('evidence-submitted');

      // The identical call, but with the internal capability flag only exec-graph-adapter.ts sets, succeeds.
      const moved = moveTask({
        taskId,
        to: 'verified',
        actor: 'atlas',
        evidenceRefs: ['fake-ref'],
        _viaVerifier: true,
      });
      expect(moved.status).toBe('verified');
    });

    it('16b. generic reassignOwner(taskId, "hand:sonnet-foreground", ...) throws HandAuthorityError; the same call with _viaVerifier:true succeeds', () => {
      const goal = createGoal({ title: 'hole1b-goal', actor: 'atlas', ts: NOW });
      const { task } = createTask({
        goalId: goal.id,
        title: 'hole1b-task',
        actor: 'atlas',
        ts: NOW,
        idempotencyKey: 'exec-graph:hole1b-task',
      });

      // The unattended-escape bypass: a generic caller tries to fabricate hand: ownership,
      // skipping assertHandAllowedInContext entirely.
      expect(() =>
        reassignOwner(task.id, 'hand:sonnet-foreground', { actor: 'atlas', reason: 'trying to sneak in' }),
      ).toThrow(HandAuthorityError);
      expect(getTask(task.id)?.owner).toBe('atlas');

      const reassigned = reassignOwner(task.id, 'hand:sonnet-foreground', {
        actor: 'atlas',
        reason: 'legit via adapter flag',
        _viaVerifier: true,
      });
      expect(reassigned.owner).toBe('hand:sonnet-foreground');
    });

    it('16c. a full generic-CLI-style laundering attempt (reassign->hand then move->verified, neither carrying the flag) can never produce a hand-owned verified task', () => {
      const goal = createGoal({ title: 'hole1c-goal', actor: 'atlas', ts: NOW });
      const { task } = createTask({
        goalId: goal.id,
        title: 'hole1c-task',
        actor: 'atlas',
        ts: NOW,
        idempotencyKey: 'exec-graph:hole1c-task',
      });

      // Step 1 of the laundering attempt never lands — ownership stays 'atlas'.
      expect(() =>
        reassignOwner(task.id, 'hand:sonnet-foreground', { actor: 'atlas', reason: 'laundering attempt' }),
      ).toThrow(HandAuthorityError);
      expect(getTask(task.id)?.owner).toBe('atlas');

      // Step 2: walk the task to 'evidence-submitted' and attempt the generic verified move.
      // Because step 1 never created hand: ownership, this is just an ordinary atlas-owned
      // move (not the bypass) — the point is there is no way to combine the two steps to
      // land a hand:-owned task in 'verified' without ever touching exec-graph-adapter.ts.
      moveTask({ taskId: task.id, to: 'accepted', actor: 'atlas' });
      moveTask({ taskId: task.id, to: 'planned', actor: 'atlas' });
      moveTask({ taskId: task.id, to: 'in-progress', actor: 'atlas' });
      moveTask({ taskId: task.id, to: 'evidence-submitted', actor: 'atlas', evidenceRefs: ['x'] });
      const verified = moveTask({ taskId: task.id, to: 'verified', actor: 'atlas', evidenceRefs: ['x'], _viaVerifier: true });
      expect(verified.owner).toBe('atlas');
      expect(verified.owner).not.toMatch(/^hand:/);

      // And directly confirming the combined attack surface: no sequence of generic calls
      // without the flag can ever produce (owner starts with 'hand:', status 'verified').
      expect(() =>
        reassignOwner(task.id, 'hand:sonnet-foreground', { actor: 'atlas', reason: 'post-hoc relabel attempt' }),
      ).toThrow(HandAuthorityError);
      expect(getTask(task.id)?.owner).toBe('atlas');
    });

    it('non-hand-owned tasks also require verifier path to reach verified/rejected', () => {
      const goal = createGoal({ title: 'unaffected-goal', actor: 'atlas', ts: NOW });
      const { task } = createTask({
        goalId: goal.id,
        title: 'unaffected-task',
        actor: 'atlas',
        ts: NOW,
        idempotencyKey: 'exec-graph:unaffected-task',
      });
      moveTask({ taskId: task.id, to: 'accepted', actor: 'atlas' });
      moveTask({ taskId: task.id, to: 'planned', actor: 'atlas' });
      moveTask({ taskId: task.id, to: 'in-progress', actor: 'atlas' });
      moveTask({ taskId: task.id, to: 'evidence-submitted', actor: 'atlas', evidenceRefs: ['x'] });
      const verified = moveTask({ taskId: task.id, to: 'verified', actor: 'atlas', evidenceRefs: ['x'], _viaVerifier: true });
      expect(verified.status).toBe('verified');
    });

    it('non-hand-owned task also throws HandAuthorityError on generic moveTask to verified without _viaVerifier', () => {
      const goal = createGoal({ title: 'no-self-promote-goal', actor: 'atlas', ts: NOW });
      const { task } = createTask({
        goalId: goal.id,
        title: 'no-self-promote-task',
        actor: 'atlas',
        ts: NOW,
        idempotencyKey: 'exec-graph:no-self-promote-task',
      });
      moveTask({ taskId: task.id, to: 'accepted', actor: 'atlas' });
      moveTask({ taskId: task.id, to: 'planned', actor: 'atlas' });
      moveTask({ taskId: task.id, to: 'in-progress', actor: 'atlas' });
      moveTask({ taskId: task.id, to: 'evidence-submitted', actor: 'atlas', evidenceRefs: ['x'] });
      // Without _viaVerifier, even atlas-owned tasks cannot self-promote
      expect(() =>
        moveTask({ taskId: task.id, to: 'verified', actor: 'atlas', evidenceRefs: ['x'] }),
      ).toThrow(HandAuthorityError);
    });
  });

  // ── 20. HOLE 5 — createTask/importTask reject 'hand:' owner at creation ──
  describe("20. HandAuthorityError — cold-reader review: createTask/importTask reject 'hand:' owner", () => {
    it("20a. createTask with owner 'hand:sonnet-foreground' throws HandAuthorityError; a normal owner still succeeds", () => {
      const goal = createGoal({ title: 'hole5a-goal', actor: 'atlas', ts: NOW });

      expect(() =>
        createTask({
          goalId: goal.id,
          title: 'hole5a-fake-hand-task',
          owner: 'hand:sonnet-foreground',
          actor: 'atlas',
          ts: NOW,
          idempotencyKey: 'exec-graph:hole5a-fake-hand-task',
        }),
      ).toThrow(HandAuthorityError);

      const { task, created } = createTask({
        goalId: goal.id,
        title: 'hole5a-normal-task',
        owner: 'atlas',
        actor: 'atlas',
        ts: NOW,
        idempotencyKey: 'exec-graph:hole5a-normal-task',
      });
      expect(created).toBe(true);
      expect(task.owner).toBe('atlas');
    });

    it("20b. importTask with owner 'hand:x' throws HandAuthorityError; a normal owner still succeeds", () => {
      const goal = createGoal({ title: 'hole5b-goal', actor: 'atlas', ts: NOW });

      expect(() =>
        importTask({
          goalId: goal.id,
          title: 'hole5b-fake-hand-import',
          sourceKind: 'volaura-work-queue',
          sourceRef: 'wq-hole5b-evil',
          owner: 'hand:x',
          actor: 'atlas',
          ts: NOW,
        }),
      ).toThrow(HandAuthorityError);

      const { task, created } = importTask({
        goalId: goal.id,
        title: 'hole5b-normal-import',
        sourceKind: 'volaura-work-queue',
        sourceRef: 'wq-hole5b-ok',
        owner: 'ceo',
        actor: 'atlas',
        ts: NOW,
      });
      expect(created).toBe(true);
      expect(task.owner).toBe('ceo');
    });

    it('20c. regression — the legitimate delegation path (create normal, then assignHand) still works end-to-end', () => {
      const taskId = planTask('hole5c-legit-delegation-task');
      expect(getTask(taskId)?.owner).toBe('atlas');

      const delegated = assignHand(taskId, 'sonnet-foreground', { actor: 'atlas' });
      expect(delegated.owner).toBe('hand:sonnet-foreground');
      expect(delegated.status).toBe('delegated');
      expect(getTask(taskId)?.owner).toBe('hand:sonnet-foreground');
    });
  });

  // ── 17. HOLE 2 — secret leakage guards ─────────────────────────────────────
  describe('17. adversarial-review Hole 2 regression — secrets never reach the verifier or the ledger', () => {
    it('17a. command-output-match with a command citing a protected path is rejected before execFileSync runs', () => {
      const mockedExec = vi.mocked(childProcess.execFileSync);
      mockedExec.mockClear();

      const result = verify({
        taskId: 'tsk_test0000000000000001',
        handId: 'local-readonly',
        submittedBy: 'local-readonly',
        kind: 'command-output-match',
        command: 'git show HEAD:apps/api/.env',
        expectedSubstring: 'SECRET',
        claimedResult: 'x',
      });
      expect(result.verified).toBe(false);
      expect(result.reason).toMatch(/protected path/);
      // Proves the guard returned BEFORE the process was ever spawned — not just that the
      // verdict happens to be false.
      expect(mockedExec).not.toHaveBeenCalled();
    });

    it('17a-inj. shell metacharacters in command are rejected before execFileSync runs', () => {
      const mockedExec = vi.mocked(childProcess.execFileSync);

      // Each payload starts with an allowlisted prefix but appends a shell metacharacter injection
      const injectionPayloads = [
        'dir . & echo INJECTED',           // & (cmd.exe chain)
        'dir . && echo INJECTED',          // && (bash/cmd chain)
        'git status | cat /etc/passwd',     // | (pipe)
        'git log ; rm -rf /',               // ; (semicolon chain)
        'git status $(whoami)',             // $() (command substitution)
        'git log `whoami`',                 // `` (backtick substitution)
        'git status > /tmp/exfil.txt',      // > (redirect out)
        'git status < /dev/null',           // < (redirect in)
      ];

      for (const payload of injectionPayloads) {
        mockedExec.mockClear();
        const result = verify({
          taskId: 'tsk_test0000000000000001',
          handId: 'local-readonly',
          submittedBy: 'local-readonly',
          kind: 'command-output-match',
          command: payload,
          expectedSubstring: 'INJECTED',
          claimedResult: 'x',
        });
        expect(result.verified).toBe(false);
        expect(result.reason).toMatch(/not in read-only verifier allowlist/);
        // Process must never be spawned for any injection payload
        expect(mockedExec).not.toHaveBeenCalled();
      }
    });

    it('17b. submitReceipt rejects a receipt whose claimedResult contains secret-shaped content (obviously-fake literal)', () => {
      const taskId = planTask('hole2b-secret-receipt-task');
      assignHand(taskId, 'local-readonly', { actor: 'atlas' });
      const before = getTask(taskId);

      expect(() =>
        submitReceipt(taskId, {
          taskId,
          handId: 'local-readonly',
          submittedBy: 'local-readonly',
          kind: 'narrative',
          // Obviously-fake literal (not a real credential) — just exercises the ghp_ shape.
          claimedResult: `confirmed ghp_${'0123456789abcdefghij'}`,
        }),
      ).toThrow(ReceiptSecretError);

      // Ledger/task state unchanged — no evidence entry, no transition landed.
      expect(getTask(taskId)).toEqual(before);
    });

    it('17c. extended PROTECTED_PATH_RE (via verify()) also catches service-account and id_ed25519 refs', () => {
      expect(
        verify({
          taskId: 'tsk_test0000000000000001',
          handId: 'local-readonly',
          submittedBy: 'local-readonly',
          kind: 'file-exists',
          ref: join(dir, 'gcp-service-account.json'),
          claimedResult: 'x',
        }).reason,
      ).toMatch(/protected path/);

      expect(
        verify({
          taskId: 'tsk_test0000000000000001',
          handId: 'local-readonly',
          submittedBy: 'local-readonly',
          kind: 'file-exists',
          ref: join(dir, 'id_ed25519'),
          claimedResult: 'x',
        }).reason,
      ).toMatch(/protected path/);
    });
  });

  // ── 18. HOLE 3 — degenerate expectedSubstring rejected at the schema level ──
  it('18. receiptSchema rejects a whitespace-only expectedSubstring for file-contains/command-output-match; a real >=3-char one is accepted', () => {
    const fileContainsBase = {
      taskId: 'tsk_test0000000000000001',
      handId: 'local-readonly',
      submittedBy: 'local-readonly',
      kind: 'file-contains' as const,
      ref: '/tmp/whatever.txt',
      claimedResult: 'x',
    };
    expect(() => receiptSchema.parse({ ...fileContainsBase, expectedSubstring: '   ' })).toThrow();
    expect(receiptSchema.parse({ ...fileContainsBase, expectedSubstring: 'abc' }).expectedSubstring).toBe('abc');

    const commandBase = {
      taskId: 'tsk_test0000000000000001',
      handId: 'local-readonly',
      submittedBy: 'local-readonly',
      kind: 'command-output-match' as const,
      command: 'git status',
      claimedResult: 'x',
    };
    expect(() => receiptSchema.parse({ ...commandBase, expectedSubstring: '  ' })).toThrow();
    expect(receiptSchema.parse({ ...commandBase, expectedSubstring: 'ok!' }).expectedSubstring).toBe('ok!');
  });

  // ── 19. HOLE 4 — cross-task receipt reuse ──────────────────────────────────
  it('19. submitReceipt rejects a receipt whose taskId does not match the task it is being submitted to', () => {
    const taskId = planTask('hole4-target-task');
    const otherTaskId = planTask('hole4-other-task');
    assignHand(taskId, 'local-readonly', { actor: 'atlas' });
    const before = getTask(taskId);

    expect(() =>
      submitReceipt(taskId, {
        taskId: otherTaskId, // mismatched on purpose — reused from a different task
        handId: 'local-readonly',
        submittedBy: 'local-readonly',
        kind: 'narrative',
        claimedResult: 'reused receipt from a different task',
      }),
    ).toThrow(ReceiptTaskMismatchError);

    // Unchanged — no evidence entry, no transition landed for either task.
    expect(getTask(taskId)).toEqual(before);
    expect(getTask(otherTaskId)?.status).toBe('planned');
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
