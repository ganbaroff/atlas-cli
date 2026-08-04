/**
 * Spine verifier — fail-closed invariants over EvidencePack + ProjectAgentContract.
 * Pure: no LLM, no network, no task-state writes.
 *
 * Fail-closed: project contract is REQUIRED (adapter allowlist always applied).
 * Effects must be explicitly linked to successful commands/tests/artifacts.
 */
import { computeEvidenceHash, parseEvidencePack, type EvidencePack } from './evidence-pack-contract.js';
import type { ProjectAgentContract } from './project-agent-contract.js';

export interface SpineVerifyResult {
  verified: boolean;
  reason: string;
  /** Always SPINE_VERIFIER_ID — stamped by the verifier itself, never caller-supplied. */
  verifierId: string;
}

export interface SpineVerifyOptions {
  /** Required for fail-closed adapter allowlist + spend checks. */
  project: ProjectAgentContract;
}

const PERSONAL_MEMORY_EFFECT = /personal.?memory|memory\/atlas|memory\\atlas|write-personal-memory/i;

/** Independent verifier identities only — never the executor adapter id. */
const INDEPENDENT_VERIFIER_RE = /^(spine-verifier|hand-verifier|independent)([@./:].*)?$/i;

/**
 * The verifier's own identity constant. Callers cannot inject a verifierId — every
 * SpineVerifyResult returned by verifyEvidencePack is stamped with exactly this value.
 * Also used as the "self" side of the structural independence check: a pack whose
 * executorIdentity resolves to this id is rejected fail-closed (an executor cannot claim
 * to literally be the verifier).
 */
export const SPINE_VERIFIER_ID = 'spine-verifier';

function reject(reason: string): SpineVerifyResult {
  return { verified: false, reason, verifierId: SPINE_VERIFIER_ID };
}

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

/** Internal failure shape for the sub-checks below — verifyEvidencePack stamps verifierId. */
type SpineCheckFailure = { verified: false; reason: string } | null;

function checkCommandList(
  label: string,
  commands: EvidencePack['commandsRun'],
): SpineCheckFailure {
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
function checkEffectProofs(pack: EvidencePack): SpineCheckFailure {
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
    return reject('missing project contract (fail-closed)');
  }

  let pack: EvidencePack;
  try {
    pack = parseEvidencePack(input);
  } catch (e) {
    return reject(`incomplete evidence: ${e instanceof Error ? e.message : String(e)}`);
  }

  if (pack.commandsRun.length === 0 && pack.testCommands.length === 0 && pack.artifacts.length === 0) {
    return reject('missing evidence: no commands, tests, or artifacts recorded');
  }

  // Structural independence: the verifier computes this itself against its OWN identity
  // constant. Nothing on the input pack (including the now-advisory-only verifierResult
  // field) can influence this check — an executor cannot become the verifier by claiming
  // a matching id/label anywhere in the submitted pack.
  try {
    assertIndependentVerifier(pack.executorIdentity, SPINE_VERIFIER_ID);
  } catch (e) {
    return reject(e instanceof Error ? e.message : 'self-certification rejected');
  }

  const declared = new Set(pack.declaredEffects);
  const undeclared = pack.actualEffects.filter((e) => !declared.has(e));
  if (undeclared.length > 0) {
    return reject(`scope violation: undeclared effects ${undeclared.join(', ')}`);
  }

  const linkFail = checkEffectProofs(pack);
  if (linkFail) return reject(linkFail.reason);

  const cmdFail = checkCommandList('commands', pack.commandsRun);
  if (cmdFail) return reject(cmdFail.reason);
  const testFail = checkCommandList('tests', pack.testCommands);
  if (testFail) return reject(testFail.reason);

  // Evidence integrity binding: recompute the commitment hash over the SAME
  // evidence-bearing fields the collector hashed at collection time. Any substitution or
  // tampering of commandsRun/testCommands/effects/effectProofs/artifacts/diffHash after
  // collection changes the recomputed hash and is rejected fail-closed. Missing hash is
  // also fail-closed (defense in depth — schema already requires the field).
  if (!pack.collectedEvidenceHash) {
    return reject('evidence hash missing (fail-closed)');
  }
  const recomputedHash = computeEvidenceHash(pack);
  if (recomputedHash.toLowerCase() !== pack.collectedEvidenceHash.toLowerCase()) {
    return reject('evidence hash mismatch (fail-closed): submitted pack does not match collected evidence');
  }

  // verificationRequirements enforcement
  const reqs = opts.project.verificationRequirements.map((r) => r.toLowerCase());
  if (reqs.some((r) => r.includes('test')) && pack.testCommands.length === 0) {
    return reject('verificationRequirements demand tests; none recorded');
  }
  if (reqs.some((r) => r.includes('diff')) && !pack.diffHash) {
    return reject('verificationRequirements demand diff-hash');
  }

  if (!pack.rollbackState.available || !pack.rollbackState.method.trim()) {
    return reject('missing rollback information');
  }

  for (const effect of pack.actualEffects) {
    if (PERSONAL_MEMORY_EFFECT.test(effect)) {
      return reject('personal memory write through project adapter prohibited');
    }
  }

  const allowed = new Set(opts.project.executorAllowlist);
  const adapterId = adapterIdFromIdentity(pack.executorIdentity);
  if (!allowed.has(adapterId)) {
    return reject(`unknown adapter not on project allowlist: ${adapterId}`);
  }

  if (pack.costRecord.paid && !opts.project.modelSpendPolicy.allowPaid) {
    return reject('paid spend forbidden by project modelSpendPolicy');
  }

  // NOTE: pack.verifierResult (caller-supplied) is intentionally NEVER read here. The
  // verifier's own computation above (structural independence + evidence hash + every
  // fail-closed check) is the sole authority for the verdict. A caller/reviewer claiming
  // verified:true in the submitted pack has zero effect on this return value.
  return { verified: true, reason: 'evidence-complete', verifierId: SPINE_VERIFIER_ID };
}
