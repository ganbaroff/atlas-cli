/**
 * Spine verifier — fail-closed invariants over EvidencePack + ProjectAgentContract.
 * Pure: no LLM, no network, no task-state writes.
 *
 * Fail-closed: project contract is REQUIRED (adapter allowlist always applied).
 * Effects must be explicitly linked to successful commands/tests/artifacts.
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

function indexById<T extends { id: string }>(items: T[]): Map<string, T> {
  return new Map(items.map((i) => [i.id, i]));
}

/**
 * Every actual effect must cite ≥1 prove-ref that exists and (for commands/tests)
 * completed successfully. Failed/skipped commands cannot prove effects.
 */
function checkEffectProofs(pack: EvidencePack): SpineVerifyResult | null {
  if (!pack.effectProofs || pack.effectProofs.length === 0) {
    return { verified: false, reason: 'narrative-only effect evidence: effectProofs required' };
  }

  const commands = indexById(pack.commandsRun);
  const tests = indexById(pack.testCommands);
  const artifacts = indexById(pack.artifacts);
  const actual = new Set(pack.actualEffects);
  const proven = new Set<string>();

  for (const proof of pack.effectProofs) {
    if (!actual.has(proof.effectId)) {
      return {
        verified: false,
        reason: `orphan effect proof: ${proof.effectId} not in actualEffects`,
      };
    }
    if (!proof.provenBy || proof.provenBy.length === 0) {
      return {
        verified: false,
        reason: `narrative-only effect evidence: ${proof.effectId} has empty provenBy`,
      };
    }

    for (const ref of proof.provenBy) {
      if (ref.kind === 'command') {
        const cmd = commands.get(ref.ref);
        if (!cmd) {
          return { verified: false, reason: `missing command reference: ${ref.ref}` };
        }
        if (cmd.skipped) {
          return {
            verified: false,
            reason: `skipped command cannot prove effect ${proof.effectId}: ${ref.ref}`,
          };
        }
        if (cmd.exitCode !== 0) {
          return {
            verified: false,
            reason: `failed command cannot prove effect ${proof.effectId}: ${ref.ref} (exit ${cmd.exitCode})`,
          };
        }
      } else if (ref.kind === 'test') {
        const t = tests.get(ref.ref);
        if (!t) {
          return { verified: false, reason: `missing test reference: ${ref.ref}` };
        }
        if (t.skipped) {
          return {
            verified: false,
            reason: `skipped test cannot prove effect ${proof.effectId}: ${ref.ref}`,
          };
        }
        if (t.exitCode !== 0) {
          return {
            verified: false,
            reason: `failed test cannot prove effect ${proof.effectId}: ${ref.ref} (exit ${t.exitCode})`,
          };
        }
      } else if (ref.kind === 'artifact') {
        const art = artifacts.get(ref.ref);
        if (!art) {
          return { verified: false, reason: `missing artifact reference: ${ref.ref}` };
        }
        if (art.kind === 'diff' && art.hash && art.hash.toLowerCase() !== pack.diffHash.toLowerCase()) {
          return {
            verified: false,
            reason: `artifact ${ref.ref} hash mismatch vs pack.diffHash`,
          };
        }
      }
    }
    proven.add(proof.effectId);
  }

  for (const effectId of pack.actualEffects) {
    if (!proven.has(effectId)) {
      return {
        verified: false,
        reason: `orphan declared effect: ${effectId} has no effectProof`,
      };
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

  if (pack.commandsRun.length === 0 && pack.testCommands.length === 0 && pack.artifacts.length === 0) {
    return { verified: false, reason: 'missing evidence: no commands, tests, or artifacts recorded' };
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

  const linkFail = checkEffectProofs(pack);
  if (linkFail) return linkFail;

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
