/**
 * hands/registry.ts — Hand Contract V0: the static Hand registry.
 *
 * Purpose: descriptive CONFIG only — like ../atlas/policy.ts's policy.yaml
 * read-model, but static-in-code for V0 rather than file-loaded. A HandSpec
 * describes what a delegation target IS ALLOWED to do; it is NEVER task
 * state.
 *
 * Authority boundary: exec-graph (src/exec-graph/*) remains the ONLY task
 * authority — nothing in this file reads or writes state/exec-graph/. This
 * registry is consulted (read-only) by ./exec-graph-adapter.ts, the one
 * module allowed to cross into exec-graph; registry.ts itself has zero
 * authority over task state.
 *
 * Inputs/outputs: `getHand(handId: string) -> HandSpec` (throws
 * HandNotFoundError if unknown/unsafe); `listHands() -> HandSpec[]`;
 * `validateRegistry(entries? = REGISTRY values) -> HandSpec[]` (schema
 * self-check, throws zod ZodError on a malformed entry). No other inputs.
 *
 * State read/written: none. `REGISTRY` is a frozen in-memory literal built
 * once at module load via `handSpecSchema.parse()` — no filesystem, no
 * network, no `state/` directory access anywhere in this file.
 *
 * Failure behavior: `getHand()` throws `HandNotFoundError` for an unknown
 * id OR an unsafe dunder key (`__proto__`/`constructor`/`prototype`) —
 * never returns `undefined`, so callers can't accidentally treat a missing
 * hand as a falsy-but-present value. `parseHandSpec()`/`validateRegistry()`
 * throw on schema violation; this module never silently coerces a bad spec.
 *
 * Security: EXACTLY TWO HANDS in V0, both deliberately narrow:
 *   - 'sonnet-foreground'  — CEO-supervised, foreground-only, can write
 *     scoped code. Because 'write-scoped-code' is in its allowedActions,
 *     ./risk.ts's classifyRisk() (fed hand.allowedActions as the
 *     "capabilities" half of a delegation brief — see exec-graph-adapter.ts)
 *     will ALWAYS classify a sonnet-foreground delegation as at least
 *     'data-mutation' risk, regardless of the task's own wording. This is
 *     intentional, not incidental: risk is derived from what the hand CAN
 *     do, not just what the task claims it will do, so a sonnet-foreground
 *     delegation always gets refuter scrutiny (see ./risk.ts, ./refuter.ts).
 *   - 'local-readonly'     — FREE, read-only, unattended-capable. No write
 *     action anywhere in its allowlist, so it classifies 'low' risk by
 *     default and the refuter is suppressed for it (see ./risk.ts).
 *   No openmanus/browser/voice/cloud/paid providers are registered here — V0
 *   is deliberately narrow; widening the registry is a follow-up mission,
 *   not this one. `isSafeKey()` rejects dunder-key lookups defense-in-depth
 *   against prototype pollution, mirroring `exec-graph/ledger.ts`'s
 *   `isSafeKey()`.
 *
 * Tests: src/__tests__/hands.test.ts — schema validation (handSpecSchema /
 * validateRegistry), dunder-key rejection, getHand()/listHands() behavior,
 * and (describe block 6) the structural test asserting this file's source
 * never cites the exec-graph API module's import path.
 */

import { z } from 'zod';

export const trustLevelSchema = z.enum(['low', 'medium', 'high']);
export const costClassSchema = z.enum(['FREE', 'FOREGROUND-CEO-SUPERVISED', 'PAID-APPROVAL-ONLY']);
export const autonomySchema = z.enum(['foreground-only', 'read-only-unattended']);
export const retryPolicySchema = z.enum(['none', 'once']);

export const handSpecSchema = z.object({
  handId: z.string().min(1),
  purpose: z.string().min(1),
  capabilities: z.array(z.string().min(1)).min(1),
  trustLevel: trustLevelSchema,
  allowedEnvironments: z.array(z.string().min(1)).min(1),
  allowedActions: z.array(z.string().min(1)).min(1),
  disallowedActions: z.array(z.string().min(1)),
  costClass: costClassSchema,
  autonomy: autonomySchema,
  inputContract: z.string().min(1),
  timeoutMs: z.number().int().positive(),
  retryPolicy: retryPolicySchema,
  abortPolicy: z.string().min(1),
  escalationCondition: z.string().min(1),
});
export type HandSpec = z.infer<typeof handSpecSchema>;

export function parseHandSpec(input: unknown): HandSpec {
  return handSpecSchema.parse(input);
}

// ── Typed errors (mirrors exec-graph/transitions.ts's base+subclass style) ─

export class HandsError extends Error {}

/** getHand() called with an id that isn't in REGISTRY (or is an unsafe key). */
export class HandNotFoundError extends HandsError {}

// ── The registry ────────────────────────────────────────────────────────

export const REGISTRY: Readonly<Record<string, HandSpec>> = Object.freeze({
  'sonnet-foreground': handSpecSchema.parse({
    handId: 'sonnet-foreground',
    purpose:
      'Foreground, CEO-supervised Sonnet/Opus coding session — reads, greps, runs tests, '
      + 'and makes scoped code writes under direct human observation. No unattended '
      + 'execution, no deploy, no credential access.',
    capabilities: ['read-file', 'grep', 'run-tests', 'git-readonly', 'write-scoped-code'],
    trustLevel: 'medium',
    allowedEnvironments: ['local-foreground'],
    allowedActions: ['read-file', 'grep', 'run-tests', 'git-readonly', 'write-scoped-code'],
    disallowedActions: ['scheduler', 'daemon', 'unattended', 'deploy', 'credential-access'],
    costClass: 'FOREGROUND-CEO-SUPERVISED',
    autonomy: 'foreground-only',
    inputContract:
      'A DelegationBrief (see ./contract.ts): objective, allowedActions subset of this '
      + "hand's allowedActions, a falsifiable expectedResult, timeoutMs, riskClass.",
    timeoutMs: 900_000,
    retryPolicy: 'once',
    abortPolicy:
      "On timeout or CEO-interrupt, the delegating adapter call (abortHandTask) moves the "
      + "task to 'blocked' — never silently 'verified'. No partial-write auto-rollback in V0; "
      + 'a CEO reviews blocked state by hand.',
    escalationCondition:
      'Objective is ambiguous, expectedResult cannot be independently falsified, or the work '
      + "would require an action outside this hand's allowedActions -> escalate to ceo, don't "
      + 'silently widen scope.',
  }),
  'local-readonly': handSpecSchema.parse({
    handId: 'local-readonly',
    purpose:
      'Free, read-only, unattended-capable local inspection hand — file read, grep, read-only '
      + 'git, read-only shell commands. No writes, no deploys, no mutations, no credentials, ever.',
    capabilities: ['read-file', 'grep', 'git-readonly', 'command-readonly'],
    trustLevel: 'low',
    allowedEnvironments: ['local-foreground', 'local-unattended'],
    allowedActions: ['read-file', 'grep', 'git-readonly', 'command-readonly'],
    disallowedActions: ['write', 'deploy', 'mutation', 'credential-access'],
    costClass: 'FREE',
    autonomy: 'read-only-unattended',
    inputContract:
      'A DelegationBrief (see ./contract.ts): objective, allowedActions subset of this '
      + "hand's allowedActions, a falsifiable expectedResult, timeoutMs, riskClass.",
    timeoutMs: 120_000,
    retryPolicy: 'none',
    abortPolicy:
      "On timeout, the delegating adapter call (abortHandTask) moves the task to 'blocked' — "
      + "never silently 'verified'. Read-only work has no side effects to roll back.",
    escalationCondition:
      'Objective implies any write/mutating/credential action -> escalate to ceo; this hand '
      + 'must never be asked to do more than read.',
  }),
});

const DUNDER_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
function isSafeKey(key: string): boolean {
  return !DUNDER_KEYS.has(key);
}

/** Throws HandNotFoundError for an unknown or unsafe (dunder-key) hand id — never returns undefined. */
export function getHand(handId: string): HandSpec {
  if (!isSafeKey(handId) || !Object.prototype.hasOwnProperty.call(REGISTRY, handId)) {
    throw new HandNotFoundError(`hands: unknown hand '${handId}'`);
  }
  return REGISTRY[handId];
}

export function listHands(): HandSpec[] {
  return Object.values(REGISTRY);
}

/**
 * Schema-validate a set of HandSpec entries — defaults to the built-in
 * REGISTRY (a startup self-check that should always pass, since REGISTRY is
 * already built via handSpecSchema.parse() above), but accepts an explicit
 * `entries` array so a test can feed it one malformed entry and assert the
 * schema rejects it.
 */
export function validateRegistry(entries: unknown[] = Object.values(REGISTRY)): HandSpec[] {
  return entries.map((entry) => parseHandSpec(entry));
}
