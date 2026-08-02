/**
 * Core Execution Spine — focused contract tests (TDD).
 * No external executors. No runner enablement.
 */
import { describe, it, expect } from 'vitest';
import {
  parseExecutorAdapterContract,
  ExecutorAdapterContractError,
} from '../core-spine/executor-adapter-contract.js';
import {
  parseProjectAgentContract,
  ProjectAgentContractError,
} from '../core-spine/project-agent-contract.js';
import {
  parseEvidencePack,
  EvidencePackError,
} from '../core-spine/evidence-pack-contract.js';
import {
  mapSpineStageToTaskStatus,
  assertSpineStageRepresentable,
  SPINE_STAGE_TO_TASK_STATUS,
} from '../core-spine/lifecycle-binding.js';
import {
  verifyEvidencePack,
  assertIndependentVerifier,
} from '../core-spine/spine-verifier.js';

const validAdapter = () => ({
  adapterId: 'adapter.human-cursor',
  version: '0.1.0',
  capabilities: ['code-edit', 'test-run', 'diff'],
  requiredPermissions: ['git-worktree-write', 'run-tests'],
  allowedPaths: ['src/**', 'tests/**'],
  allowedCommands: ['npm test', 'git status', 'git diff'],
  networkPolicy: 'deny' as const,
  spendPolicy: { allowPaid: false, maxTokens: 0 },
  inputTaskContract: {
    taskId: 'tsk_core_spine_demo',
    objective: 'Add a unit test for evidence pack parse',
    declaredEffects: ['write-test-file'],
  },
  cancellation: { supported: true, signal: 'cooperative' as const },
  timeoutMs: 3_600_000,
});

const validProject = () => ({
  projectId: 'prj_jobhunt_ksa',
  name: 'JobHunt-KSA',
  repositoryBoundaries: ['C:/Projects/JobHunt-KSA'],
  allowedReads: ['**/*'],
  allowedWrites: ['src/**', 'tests/**'],
  forbiddenPaths: ['.env', '**/*.pem', '**/credentials*'],
  forbiddenActions: ['push', 'deploy', 'production-write'],
  projectMemoryBoundary: 'project-local-only',
  personalMemoryWrite: 'prohibited' as const,
  executorAllowlist: ['adapter.human-cursor'],
  modelSpendPolicy: { allowPaid: false },
  verificationRequirements: ['diff-hash', 'tests-exit-0', 'independent-verifier'],
  rollback: { required: true, method: 'git-worktree-discard' },
  escalation: ['ceo'],
  emergencyStop: 'ATLAS_PAUSE or control pause',
});

const validPack = (over: Record<string, unknown> = {}) => ({
  taskId: 'tsk_core_spine_demo',
  changeId: 'chg_2026_08_03_core_spine',
  projectId: 'prj_jobhunt_ksa',
  baseCommit: '073f1e5b8947bea50af9d27d51730e6cec2fea74',
  executorIdentity: 'adapter.human-cursor@0.1.0',
  declaredEffects: ['write-test-file'],
  actualEffects: ['write-test-file'],
  diffHash: 'a'.repeat(64),
  commandsRun: [
    { command: 'git diff --stat', exitCode: 0, outputHash: 'c'.repeat(64) },
  ],
  testCommands: [{ command: 'npm test', exitCode: 0, outputHash: 'b'.repeat(64) }],
  costRecord: { provider: 'none', tokens: 0, paid: false },
  verifierResult: { verified: true, reason: 'evidence-complete', verifierId: 'spine-verifier' },
  rollbackState: { available: true, method: 'git-worktree-discard', proven: false },
  ceoDecision: 'pending' as const,
  ...over,
});

describe('core-spine executor adapter contract', () => {
  it('accepts a valid executor contract', () => {
    const c = parseExecutorAdapterContract(validAdapter());
    expect(c.adapterId).toBe('adapter.human-cursor');
    expect(c.networkPolicy).toBe('deny');
  });

  it('rejects unknown / empty permissions fail-closed', () => {
    expect(() =>
      parseExecutorAdapterContract({ ...validAdapter(), requiredPermissions: [] }),
    ).toThrow(ExecutorAdapterContractError);
  });

  it('rejects missing adapter identity', () => {
    const bad = { ...validAdapter(), adapterId: '' };
    expect(() => parseExecutorAdapterContract(bad)).toThrow();
  });
});

describe('core-spine project agent contract', () => {
  it('accepts a valid project contract', () => {
    const c = parseProjectAgentContract(validProject());
    expect(c.personalMemoryWrite).toBe('prohibited');
  });

  it('rejects personal memory write permission', () => {
    expect(() =>
      parseProjectAgentContract({
        ...validProject(),
        personalMemoryWrite: 'allowed',
      }),
    ).toThrow(ProjectAgentContractError);
  });

  it('rejects allowedWrites that target personal Atlas memory paths', () => {
    expect(() =>
      parseProjectAgentContract({
        ...validProject(),
        allowedWrites: ['src/**', 'memory/atlas/**'],
      }),
    ).toThrow(ProjectAgentContractError);
  });

  it('rejects missing repository boundaries', () => {
    expect(() =>
      parseProjectAgentContract({ ...validProject(), repositoryBoundaries: [] }),
    ).toThrow();
  });
});

describe('core-spine evidence pack', () => {
  it('accepts a complete evidence pack', () => {
    const p = parseEvidencePack(validPack());
    expect(p.diffHash).toHaveLength(64);
  });

  it('rejects incomplete evidence (missing diff hash)', () => {
    expect(() => parseEvidencePack(validPack({ diffHash: '' }))).toThrow(EvidencePackError);
  });

  it('rejects narrative-only success without commands/tests', () => {
    expect(() =>
      parseEvidencePack(
        validPack({
          commandsRun: [],
          testCommands: [],
          verifierResult: { verified: true, reason: 'looks good', verifierId: 'executor-self' },
        }),
      ),
    ).toThrow();
  });
});

describe('core-spine lifecycle binding', () => {
  it('maps spine stages onto existing exec-graph statuses', () => {
    expect(mapSpineStageToTaskStatus('proposed')).toBe('proposed');
    expect(mapSpineStageToTaskStatus('authorized')).toBe('accepted');
    expect(mapSpineStageToTaskStatus('isolated')).toBe('planned');
    expect(mapSpineStageToTaskStatus('executing')).toBe('in-progress');
    expect(mapSpineStageToTaskStatus('evidence_submitted')).toBe('evidence-submitted');
    expect(mapSpineStageToTaskStatus('independently_verified')).toBe('verified');
    expect(mapSpineStageToTaskStatus('rejected')).toBe('rejected');
    expect(mapSpineStageToTaskStatus('closed')).toBe('closed');
    expect(mapSpineStageToTaskStatus('rolled_back')).toBe('rejected');
  });

  it('exposes every spine stage as representable', () => {
    for (const stage of Object.keys(SPINE_STAGE_TO_TASK_STATUS)) {
      expect(() => assertSpineStageRepresentable(stage as keyof typeof SPINE_STAGE_TO_TASK_STATUS)).not.toThrow();
    }
  });
});

describe('core-spine verification invariants', () => {
  const project = () => parseProjectAgentContract(validProject());

  it('rejects missing project contract fail-closed', () => {
    const r = verifyEvidencePack(validPack(), undefined as unknown as { project: never });
    expect(r.verified).toBe(false);
    expect(r.reason).toMatch(/project/i);
  });

  it('rejects missing evidence', () => {
    const r = verifyEvidencePack(
      validPack({
        commandsRun: [],
        testCommands: [],
      }),
      { project: project() },
    );
    expect(r.verified).toBe(false);
    expect(r.reason).toMatch(/missing|incomplete|evidence/i);
  });

  it('rejects executor self-certification', () => {
    const r = verifyEvidencePack(
      validPack({
        verifierResult: {
          verified: true,
          reason: 'I tested it',
          verifierId: 'adapter.human-cursor@0.1.0',
        },
      }),
      { project: project() },
    );
    expect(r.verified).toBe(false);
    expect(r.reason).toMatch(/self-cert/i);
  });

  it('rejects forged verifier that is not an independent id', () => {
    const r = verifyEvidencePack(
      validPack({
        verifierResult: {
          verified: true,
          reason: 'ok',
          verifierId: 'totally-not-executor',
        },
      }),
      { project: project() },
    );
    expect(r.verified).toBe(false);
    expect(r.reason).toMatch(/self-cert|independent/i);
  });

  it('rejects scope violation (actual effects outside declared)', () => {
    const r = verifyEvidencePack(
      validPack({
        declaredEffects: ['write-test-file'],
        actualEffects: ['write-test-file', 'push-origin'],
      }),
      { project: project() },
    );
    expect(r.verified).toBe(false);
    expect(r.reason).toMatch(/scope|unrecorded/i);
  });

  it('rejects failed or skipped required tests', () => {
    expect(
      verifyEvidencePack(
        validPack({
          testCommands: [{ command: 'npm test', exitCode: 1, outputHash: 'b'.repeat(64) }],
        }),
        { project: project() },
      ).verified,
    ).toBe(false);
    expect(
      verifyEvidencePack(
        validPack({
          testCommands: [
            { command: 'npm test', exitCode: 0, outputHash: 'b'.repeat(64), skipped: true },
          ],
        }),
        { project: project() },
      ).verified,
    ).toBe(false);
  });

  it('rejects failed commandsRun', () => {
    const r = verifyEvidencePack(
      validPack({
        commandsRun: [{ command: 'git diff', exitCode: 2, outputHash: 'c'.repeat(64) }],
      }),
      { project: project() },
    );
    expect(r.verified).toBe(false);
    expect(r.reason).toMatch(/commands.*failed/i);
  });

  it('rejects missing rollback information', () => {
    const r = verifyEvidencePack(
      validPack({
        rollbackState: { available: false, method: '', proven: false },
      }),
      { project: project() },
    );
    expect(r.verified).toBe(false);
    expect(r.reason).toMatch(/rollback/i);
  });

  it('rejects personal memory writes through project adapter', () => {
    const r = verifyEvidencePack(
      validPack({
        declaredEffects: ['write-test-file', 'write-personal-memory:atlas'],
        actualEffects: ['write-test-file', 'write-personal-memory:atlas'],
      }),
      { project: project() },
    );
    expect(r.verified).toBe(false);
    expect(r.reason).toMatch(/personal.?memory/i);
  });

  it('rejects unknown adapter identity fail-closed', () => {
    const r = verifyEvidencePack(validPack({ executorIdentity: 'adapter.unknown@9.9.9' }), {
      project: project(),
    });
    expect(r.verified).toBe(false);
    expect(r.reason).toMatch(/unknown.?adapter|allowlist/i);
  });

  it('rejects paid spend when project forbids it', () => {
    const r = verifyEvidencePack(
      validPack({ costRecord: { provider: 'openai', tokens: 10, paid: true } }),
      { project: project() },
    );
    expect(r.verified).toBe(false);
    expect(r.reason).toMatch(/paid/i);
  });

  it('rejects when independent verifier id equals executor', () => {
    expect(() =>
      assertIndependentVerifier('adapter.human-cursor@0.1.0', 'adapter.human-cursor@0.1.0'),
    ).toThrow();
  });

  it('accepts a pack that satisfies all invariants', () => {
    const r = verifyEvidencePack(validPack(), { project: project() });
    expect(r.verified).toBe(true);
  });
});
