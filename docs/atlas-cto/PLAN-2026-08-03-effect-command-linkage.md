# PLAN — First Supervised Proof: Effect↔Command Linkage (DEBT-CS-001)

**Proof ID:** `proof_2026_08_03_effect_command_linkage`  
**Branch:** `codex/atlas-proof-effect-command-linkage`  
**Base:** `7a43a49`  
**Worktree:** `ANUS/.worktrees/atlas-proof-effect-command-linkage`

## Current weakness

`verifyEvidencePack` treats effect↔command coverage as soft heuristics (`includes` / keyword `write|test` / fragile `RegExp` on effect tokens). An `actualEffect` can verify without an explicit link to a recorded command or artifact (DEBT-CS-001). Fragile RegExp also feeds DEBT-CS-003.

## Proposed schema change (extend EvidencePack only)

1. **`commandRunSchema` / test entries:** require stable `id: string` (min 1).
2. **`artifacts`:** optional array `{ id, kind: 'diff'|'file'|'output', hash?: sha256 }` — explicit prove targets.
3. **`effectProofs`:** required non-empty array:
   - `{ effectId: string, provenBy: [{ kind: 'command'|'test'|'artifact', ref: string }, ...] }` with `provenBy.min(1)`.
4. Keep `declaredEffects` / `actualEffects` as **stable string IDs** (no second evidence store).

## Compatibility impact

- Semantic packs remain representable by adding `id` on commands/tests + `effectProofs` (+ optional `artifacts`).
- Packs lacking IDs/proofs fail closed at parse or verify (intentional).
- No new module, router, task graph, or memory authority.
- Soft heuristic / fragile effect RegExp removed from verifier (CS-001 closed; CS-003 mitigated for this path).

## Verifier changes

Fail closed when:
- any `actualEffects[]` entry lacks an `effectProofs` row for that `effectId`;
- any `effectProofs.effectId` not in `actualEffects` (orphan proof) OR proof refs unknown effect;
- any `provenBy.ref` missing from commands / tests / artifacts by `id`;
- linked command/test has `exitCode !== 0` or `skipped === true`;
- `provenBy` empty (schema) or narrative-only (no commands/tests/artifacts and no proofs).
Pass when every actual effect has ≥1 valid successful prove-ref; one command may prove many effects; many refs may prove one effect.

## Tests required (focused)

- valid effect→command link  
- missing command reference  
- orphan declared/actual effect (no proof)  
- failed command linked to successful effect  
- skipped command linked to effect  
- narrative-only effect evidence  
- one command → multiple effects  
- multiple commands → one effect  
- complete valid pack still verifies  

## Rollback

Discard worktree / delete branch `codex/atlas-proof-effect-command-linkage`. Canonical tip untouched.

## Files allowed

- `src/core-spine/evidence-pack-contract.ts`
- `src/core-spine/spine-verifier.ts`
- `src/__tests__/core-spine.test.ts`
- `src/core-spine/index.ts` (exports only if needed)
- `docs/atlas-cto/*` proof/CHG/debt notes only if required for evidence

## Files forbidden

- Anything outside Core Spine + focused tests + proof docs  
- Runners, Hermes, Telegram, browser, deploy, push, new repos, authority/router/memory modules
