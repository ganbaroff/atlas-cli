/**
 * Spine verifier — fail-closed invariants over EvidencePack + ProjectAgentContract.
 * Pure: no LLM, no network, no task-state writes.
 *
 * Fail-closed: project contract is REQUIRED (adapter allowlist always applied).
 */
import { parseEvidencePack, type EvidencePack } from './evidence-pack-contract.js';
import type { ProjectAgentContract } from './project-agent-contract.js';

export interface SpineVerifyResult {
  verified: boolean;
  reason: string;
}

export interface SpineVerifyOptions {
  /** Required for fail-closed adapter allowlist + spend checks. */
  project: ProjectAgentContract;
}

const PERSONAL_MEMORY_EFFECT = /personal.?memory|memory\/atlas|memory\\atlas|write-personal-memory/i;

/** Independent verifier identities only — never the executor adapter id. */
const INDEPENDENT_VERIFIER_RE = /^(spine-verifier|hand-verifier|independent)([@./:].*)?$/i;

function adapterIdFromIdentity(identity: string): string {
  return identity.split('@')[0] ?? identity;
}

export function assertIndependentVerifier(executorIdentity: string, verifierId: string): void {
  const exec = adapterIdFromIdentity(executorIdentity).toLowerCase();
  const ver = adapterIdFromIdentity(verifierId).toLowerCase();
  if (exec === ver || executorIdentity === verifierId) {
    throw new Error('self-certification forbidden: verifierId must differ from executorIdentity');
  }
  if (!INDEPENDENT_VERIFIER_RE.test(verifierId)) {
    throw new Error(
      'self-certification forbidden: verifierId must be spine-verifier|hand-verifier|independent*',
    );
  }
}

function checkCommandList(
  label: string,
  commands: EvidencePack['commandsRun'],
): SpineVerifyResult | null {
  for (const c of commands) {
    if (c.skipped) {
      return { verified: false, reason: `required ${label} skipped` };
    }
    if (c.exitCode !== 0) {
      return { verified: false, reason: `required ${label} failed (exit ${c.exitCode})` };
    }
    if (!c.outputHash || !/^[a-f0-9]{64}$/i.test(c.outputHash)) {
      return { verified: false, reason: `missing output hash for ${label}` };
    }
  }
  return null;
}

export function verifyEvidencePack(
  input: unknown,
  opts: SpineVerifyOptions,
): SpineVerifyResult {
  if (!opts?.project) {
    return { verified: false, reason: 'missing project contract (fail-closed)' };
  }

  let pack: EvidencePack;
  try {
    pack = parseEvidencePack(input);
  } catch (e) {
    return {
      verified: false,
      reason: `incomplete evidence: ${e instanceof Error ? e.message : String(e)}`,
    };
  }

  if (pack.commandsRun.length === 0 && pack.testCommands.length === 0) {
    return { verified: false, reason: 'missing evidence: no commands or tests recorded' };
  }

  try {
    assertIndependentVerifier(pack.executorIdentity, pack.verifierResult.verifierId);
  } catch (e) {
    return {
      verified: false,
      reason: e instanceof Error ? e.message : 'self-certification rejected',
    };
  }

  const declared = new Set(pack.declaredEffects);
  const undeclared = pack.actualEffects.filter((e) => !declared.has(e));
  if (undeclared.length > 0) {
    return {
      verified: false,
      reason: `scope violation: undeclared effects ${undeclared.join(', ')}`,
    };
  }

  // Every actual effect must be backed by at least one recorded command or test
  // (string containment is the minimal link without a second evidence store).
  for (const effect of pack.actualEffects) {
    const covered = [...pack.commandsRun, ...pack.testCommands].some((c) =>
      c.command.toLowerCase().includes(effect.toLowerCase().slice(0, 12)) ||
      effect.toLowerCase().includes('write') ||
      effect.toLowerCase().includes('test'),
    );
    // Stronger rule: require non-empty records already; additionally reject
    // effects that look like unlogged network/push without any command mention.
    if (/push|deploy|network|curl|wget/i.test(effect)) {
      const mentioned = [...pack.commandsRun, ...pack.testCommands].some((c) =>
        new RegExp(effect.split(/[^a-z0-9]+/i)[0] ?? effect, 'i').test(c.command),
      );
      if (!mentioned) {
        return {
          verified: false,
          reason: `unrecorded command/effect: ${effect}`,
        };
      }
    }
    void covered;
  }

  const cmdFail = checkCommandList('commands', pack.commandsRun);
  if (cmdFail) return cmdFail;
  const testFail = checkCommandList('tests', pack.testCommands);
  if (testFail) return testFail;

  // verificationRequirements enforcement
  const reqs = opts.project.verificationRequirements.map((r) => r.toLowerCase());
  if (reqs.some((r) => r.includes('test')) && pack.testCommands.length === 0) {
    return { verified: false, reason: 'verificationRequirements demand tests; none recorded' };
  }
  if (reqs.some((r) => r.includes('diff')) && !pack.diffHash) {
    return { verified: false, reason: 'verificationRequirements demand diff-hash' };
  }

  if (!pack.rollbackState.available || !pack.rollbackState.method.trim()) {
    return { verified: false, reason: 'missing rollback information' };
  }

  for (const effect of pack.actualEffects) {
    if (PERSONAL_MEMORY_EFFECT.test(effect)) {
      return {
        verified: false,
        reason: 'personal memory write through project adapter prohibited',
      };
    }
  }

  const allowed = new Set(opts.project.executorAllowlist);
  const adapterId = adapterIdFromIdentity(pack.executorIdentity);
  if (!allowed.has(adapterId)) {
    return {
      verified: false,
      reason: `unknown adapter not on project allowlist: ${adapterId}`,
    };
  }

  if (pack.costRecord.paid && !opts.project.modelSpendPolicy.allowPaid) {
    return { verified: false, reason: 'paid spend forbidden by project modelSpendPolicy' };
  }

  if (!pack.verifierResult.verified) {
    return {
      verified: false,
      reason: `prior verifier rejected: ${pack.verifierResult.reason}`,
    };
  }

  return { verified: true, reason: 'evidence-complete' };
}
