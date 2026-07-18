/**
 * swarm-exec/completion-policy.ts — deterministic, no-LLM completion gate for a swarm run.
 *
 * WHAT THIS IS: `evaluateCompletion(input) -> CompletionVerdict`. A pure
 * function that decides whether a swarm run is honestly 'done', merely
 * 'partial', or 'failed' — no model call, no network, no I/O, no clock/
 * random. Same input always yields the same verdict (see the idempotence
 * test in ../__tests__/swarm-completion-policy.test.ts).
 *
 * Invariant 1 — a failed provider never counts as OK: `ResponderResult.ok`
 * is the CALLER's claim and is never trusted. OK is re-derived from the
 * evidence itself: `error` must be unset/empty AND `output` must be a
 * non-empty trimmed string AND `provider` must be a non-empty string. A
 * responder carrying a truthy `error` (a 401, a timeout, any provider
 * failure) is NEVER OK regardless of what `ok` says — this is the lock that
 * stops a mislabeled/optimistic `ok: true` from a failed call turning into
 * a false 'done'.
 *
 * Invariant 2 — fail-closed on missing policy: with no policy (or a
 * structurally invalid one — missing booleans, non-integer counts, etc.)
 * there is no gate to satisfy, so the run can never be 'done'. It is
 * 'failed' with reason 'no_policy_fail_closed', not 'partial' and not a
 * silent pass-through. Responder counts are still computed and returned on
 * this path (and on every other return path) so a caller never gets a
 * verdict without the raw evidence behind it.
 *
 * Gate order: rules run in a fixed sequence (dedup -> validate policy ->
 * count -> zero-OK check -> failure budget -> jidoka -> required-responders
 * -> evidence tokens -> evaluator -> promotion -> done) and the FIRST
 * failing gate wins the `reason` — later gates are never evaluated once an
 * earlier one has already decided the verdict. This mirrors ../hands/
 * verifier.ts's style: one pure function, a switch/if chain over fixed
 * gates, every branch returns the same shape, never throws.
 */

export type Completion = 'done' | 'partial' | 'failed';

export interface ResponderResult {
  id: number; // responder/subtask id
  perspective?: string;
  provider: string; // label; NOTE a failed responder may still carry a provider label
  ok: boolean; // caller's claim; must be re-derived, not trusted (see rules)
  output?: string; // synthesized/worker output
  error?: string; // present iff the responder failed (provider error, timeout, etc.)
}

export interface CompletionPolicy {
  requiredResponders: number; // min count of OK responders required for 'done'
  failureBudget: number; // max tolerated failed responders (inclusive)
  requireEvidenceTokens: boolean; // if true, >=1 evidence token required for 'done'
  requireEvaluator: boolean; // if true, evaluatorPassed must be === true for 'done'
  requirePromotion: boolean; // if true, promotionPassed must be === true for 'done'
}

export interface CompletionInput {
  responders: ResponderResult[];
  policy?: CompletionPolicy | null; // missing/invalid => FAIL CLOSED
  evidenceTokens?: string[];
  evaluatorPassed?: boolean | null;
  promotionPassed?: boolean | null;
  jidokaViolation?: string | null; // non-empty => cannot be 'done'
}

export interface CompletionVerdict {
  completion: Completion;
  reason: string; // machine-readable snake_case terminal reason
  respondersTotal: number;
  respondersOk: number;
  respondersFailed: number;
}

/** A responder counts as OK iff its evidence proves it, never because `ok` says so. */
function isResponderOk(r: ResponderResult): boolean {
  if (r.error !== undefined && r.error !== '') return false;
  if (typeof r.output !== 'string' || r.output.trim().length === 0) return false;
  if (typeof r.provider !== 'string' || r.provider.length === 0) return false;
  return true;
}

/** Dedup by id, keeping the first occurrence — a repeated id is one responder, not two. */
function dedupById(responders: ResponderResult[]): ResponderResult[] {
  const seen = new Set<number>();
  const out: ResponderResult[] = [];
  for (const r of responders) {
    if (seen.has(r.id)) continue;
    seen.add(r.id);
    out.push(r);
  }
  return out;
}

function isValidPolicy(policy: unknown): policy is CompletionPolicy {
  if (policy === null || policy === undefined || typeof policy !== 'object') return false;
  const p = policy as Record<string, unknown>;
  if (!Number.isInteger(p['requiredResponders']) || (p['requiredResponders'] as number) < 1) return false;
  if (!Number.isInteger(p['failureBudget']) || (p['failureBudget'] as number) < 0) return false;
  if (typeof p['requireEvidenceTokens'] !== 'boolean') return false;
  if (typeof p['requireEvaluator'] !== 'boolean') return false;
  if (typeof p['requirePromotion'] !== 'boolean') return false;
  return true;
}

/**
 * Deterministic, no-LLM decision of whether a swarm run is honestly
 * complete. Never throws — every branch returns a CompletionVerdict.
 */
export function evaluateCompletion(input: CompletionInput): CompletionVerdict {
  const deduped = dedupById(input.responders ?? []);
  const respondersTotal = deduped.length;
  const respondersOk = deduped.filter(isResponderOk).length;
  const respondersFailed = respondersTotal - respondersOk;
  const counts = { respondersTotal, respondersOk, respondersFailed };

  if (!isValidPolicy(input.policy)) {
    return { completion: 'failed', reason: 'no_policy_fail_closed', ...counts };
  }
  const policy = input.policy as CompletionPolicy;

  if (respondersOk === 0) {
    return { completion: 'failed', reason: 'no_responders_ok', ...counts };
  }

  if (respondersFailed > policy.failureBudget) {
    return { completion: 'failed', reason: 'failure_budget_exceeded', ...counts };
  }

  if (typeof input.jidokaViolation === 'string' && input.jidokaViolation.length > 0) {
    return {
      completion: respondersOk > 0 ? 'partial' : 'failed',
      reason: 'jidoka_violation',
      ...counts,
    };
  }

  if (respondersOk < policy.requiredResponders) {
    return { completion: 'partial', reason: 'insufficient_responders', ...counts };
  }

  if (policy.requireEvidenceTokens && (!input.evidenceTokens || input.evidenceTokens.length === 0)) {
    return { completion: 'partial', reason: 'no_evidence_tokens', ...counts };
  }

  if (policy.requireEvaluator && input.evaluatorPassed !== true) {
    return { completion: 'partial', reason: 'evaluator_not_passed', ...counts };
  }

  if (policy.requirePromotion && input.promotionPassed !== true) {
    return { completion: 'partial', reason: 'promotion_not_passed', ...counts };
  }

  return { completion: 'done', reason: 'all_gates_passed', ...counts };
}
