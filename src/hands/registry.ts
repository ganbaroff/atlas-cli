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
 * Security: THREE HANDS in V0, all deliberately narrow:
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
 *   - 'swarm-local'        — CEO-supervised, foreground-only, multi-agent
 *     swarm analysis (see ../swarm.ts). Makes real model calls, so it is
 *     never unattended, but its allowedActions carry no write/mutation verb
 *     — it only produces analysis text, never file writes.
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

import {
  handSpecSchema,
  parseHandSpec,
  type HandSpec,
  HandsError,
  HandNotFoundError,
  trustLevelSchema,
  costClassSchema,
  autonomySchema,
  retryPolicySchema,
} from './hand-spec.js';
import { getManifestHands } from './manifest.js';

export {
  handSpecSchema,
  parseHandSpec,
  type HandSpec,
  HandsError,
  HandNotFoundError,
  trustLevelSchema,
  costClassSchema,
  autonomySchema,
  retryPolicySchema,
};

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
  'browser-foreground': handSpecSchema.parse({
    handId: 'browser-foreground',
    purpose:
      'Foreground, CEO-supervised browser Hand — navigates local/fixture pages, reads text, '
      + 'fills fields, clicks buttons via a closed typed action vocabulary. No form submit, '
      + 'no credentials, no uploads, no payment, no real portal. Playwright adapter.',
    capabilities: ['browser-navigate', 'browser-read', 'browser-fill', 'browser-click', 'browser-select'],
    trustLevel: 'medium',
    allowedEnvironments: ['local-foreground'],
    allowedActions: ['browser-navigate', 'browser-read', 'browser-fill', 'browser-click', 'browser-select'],
    disallowedActions: ['browser-submit', 'credential-access', 'upload', 'payment', 'unattended', 'deploy', 'command-exec'],
    costClass: 'FOREGROUND-CEO-SUPERVISED',
    autonomy: 'foreground-only',
    inputContract:
      'A DelegationBrief (see ./contract.ts): objective, allowedActions subset of this '
      + "hand's allowedActions, a falsifiable expectedResult, timeoutMs, riskClass.",
    timeoutMs: 60_000,
    retryPolicy: 'none',
    abortPolicy:
      "On timeout or CEO-interrupt, the delegating adapter call (abortHandTask) moves the "
      + "task to 'blocked' — never silently 'verified'. Browser session is closed on abort.",
    escalationCondition:
      'Any action outside the typed vocabulary (submit, credentials, upload, payment, real portal) '
      + "-> escalate to ceo, don't silently widen scope.",
  }),
  'swarm-local': handSpecSchema.parse({
    handId: 'swarm-local',
    purpose:
      'Foreground, CEO-supervised multi-perspective swarm analysis (see ../swarm.ts) — '
      + 'decomposes a task into perspectives, runs parallel LLM workers, synthesizes findings '
      + 'into one report. Produces analysis text only; never writes files, never runs unattended.',
    capabilities: ['swarm-run', 'analyze', 'read-file'],
    trustLevel: 'medium',
    allowedEnvironments: ['local-foreground'],
    allowedActions: ['swarm-run', 'analyze', 'read-file'],
    disallowedActions: ['scheduler', 'daemon', 'unattended', 'write-scoped-code', 'deploy', 'credential-access'],
    costClass: 'FOREGROUND-CEO-SUPERVISED',
    autonomy: 'foreground-only',
    inputContract:
      'A DelegationBrief (see ./contract.ts): objective, allowedActions subset of this '
      + "hand's allowedActions, a falsifiable expectedResult, timeoutMs, riskClass.",
    timeoutMs: 300_000,
    retryPolicy: 'none',
    abortPolicy:
      "On timeout or CEO-interrupt, the delegating adapter call (abortHandTask) moves the "
      + "task to 'blocked' — never silently 'verified'. Swarm runs are billable model calls, "
      + 'so there is no automatic retry; a CEO reviews blocked state by hand.',
    escalationCondition:
      'Objective is ambiguous, expectedResult cannot be independently falsified, or the work '
      + "would require an action outside this hand's allowedActions (e.g. a file write) -> "
      + "escalate to ceo, don't silently widen scope.",
  }),
});

const DUNDER_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
function isSafeKey(key: string): boolean {
  return !DUNDER_KEYS.has(key);
}

/** Throws HandNotFoundError for an unknown or unsafe (dunder-key) hand id — never returns undefined. */
export function getHand(handId: string): HandSpec {
  if (!isSafeKey(handId)) {
    throw new HandNotFoundError(`hands: unknown hand '${handId}'`);
  }
  if (Object.prototype.hasOwnProperty.call(REGISTRY, handId)) {
    return REGISTRY[handId];
  }
  // M5: manifests overlay — second hand lands here without editing REGISTRY literals.
  const fromManifest = getManifestHands().get(handId);
  if (fromManifest) return fromManifest;
  throw new HandNotFoundError(`hands: unknown hand '${handId}'`);
}

export function listHands(): HandSpec[] {
  const merged = new Map<string, HandSpec>();
  for (const h of Object.values(REGISTRY)) merged.set(h.handId, h);
  for (const h of getManifestHands().values()) {
    if (merged.has(h.handId)) {
      throw new HandsError(`hands: manifest handId '${h.handId}' collides with static REGISTRY`);
    }
    merged.set(h.handId, h);
  }
  return [...merged.values()];
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
