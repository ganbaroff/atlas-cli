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
 * Security: ALL product hands load from JSON manifests in ./manifests/ (M5 factory).
 * Static REGISTRY is intentionally empty — new hands register via manifest files only.
 *   - 'sonnet-foreground'  — CEO-supervised, foreground-only, can write scoped code.
 *   - 'local-readonly'     — FREE, read-only, unattended-capable.
 *   - 'browser-foreground' — Playwright fixture/local pages only.
 *   - 'swarm-local'        — multi-perspective swarm analysis (see ../swarm.ts).
 *   - 'file-search'        — read-only file search.
 *   No openmanus/voice/cloud/paid providers — V0 is deliberately narrow.
 *   `isSafeKey()` rejects dunder-key lookups defense-in-depth against prototype
 *   pollution, mirroring `exec-graph/ledger.ts`'s `isSafeKey()`.
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

export const REGISTRY: Readonly<Record<string, HandSpec>> = Object.freeze({});

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
